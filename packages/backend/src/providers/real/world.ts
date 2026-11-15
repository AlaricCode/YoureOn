/**
 * GEMINI_PROVIDER=live: public, keyless Gemini prediction-market REST/WS
 * (free, no spend guard). GEMINI_HEDGE=live: Gemini demo environment via OAuth
 * (spend guard).
 *
 * Paths (verified against the live API, 2026-11-08; they live only here):
 *   REST  {GEMINI_BASE_URL}/v1/prediction-markets/events[?limit&offset&status&search]
 *         {GEMINI_BASE_URL}/v1/prediction-markets/events/{ticker}
 *   WS    wss://{host}/v1/marketdata/{instrumentSymbol}?top_of_book=true&trades=true
 *         → {"type":"update","events":[{"type":"change","side":"bid"|"ask","price","remaining"},
 *                                      {"type":"trade","price",…}]}
 * Normalization (§11.1) is in geminiNormalize.ts.
 */
import { WebSocket } from 'ws';
import { assertSpendAllowed } from '../../config/spend.js';
import type { Config } from '../../config/load.js';
import { ApiError } from '../../errors.js';
import type { Clock } from '../../util/clock.js';
import { systemClock } from '../../util/clock.js';
import type { GeminiProvider, HedgeProvider, WorldEvent, WorldPrice } from '../types.js';
import { normalizeEvent, priceOf, probBpsFromPrices } from './geminiNormalize.js';

export { probBpsFromPrices } from './geminiNormalize.js';

export const GEMINI_EVENTS_PATH = '/v1/prediction-markets/events';
export const GEMINI_HTTP_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Minimal WebSocket surface used by the price stream (injectable for tests). */
export interface PriceSocket {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'close', fn: () => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  close(): void;
}

export interface LiveGeminiOptions {
  fetch?: typeof fetch;
  openSocket?: (url: string) => PriceSocket;
  clock?: Clock;
  log?: { warn: (o: unknown, msg?: string) => void };
}

/** Top-of-book state of one contract fed by WS updates. */
export class TopOfBook {
  bid: number | null = null;
  ask: number | null = null;
  last: number | null = null;

  /** Applies one WS message; returns true if the book changed. */
  apply(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    if (m['type'] !== 'update' || !Array.isArray(m['events'])) return false;
    let changed = false;
    for (const e of m['events'] as Record<string, unknown>[]) {
      if (!e || typeof e !== 'object') continue;
      const price = priceOf(e['price']);
      if (e['type'] === 'change') {
        const remaining = Number(e['remaining']);
        const v = Number.isFinite(remaining) && remaining <= 0 ? null : price;
        if (e['side'] === 'bid') {
          changed ||= this.bid !== v;
          this.bid = v;
        } else if (e['side'] === 'ask') {
          changed ||= this.ask !== v;
          this.ask = v;
        }
      } else if (e['type'] === 'trade' && price !== null) {
        changed ||= this.last !== price;
        this.last = price;
      }
    }
    return changed;
  }

  probBps(): number | null {
    return probBpsFromPrices(this.bid, this.ask, this.last);
  }
}

export class LiveGemini implements GeminiProvider {
  readonly name = 'live';
  private readonly fetchFn: typeof fetch;
  private readonly openSocket: (url: string) => PriceSocket;
  private readonly clock: Clock;

  constructor(
    readonly baseUrl: string,
    private readonly opts: LiveGeminiOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.openSocket = opts.openSocket ?? ((url) => new WebSocket(url) as unknown as PriceSocket);
    this.clock = opts.clock ?? systemClock;
  }

  private async getJson(path: string): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(GEMINI_HTTP_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  async listEvents(q: string | null, limit: number): Promise<WorldEvent[]> {
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, limit))), status: 'active' });
    if (q && q.trim()) params.set('search', q.trim());
    const { status, body } = await this.getJson(`${GEMINI_EVENTS_PATH}?${params}`);
    if (status !== 200) throw new Error(`gemini: list events HTTP ${status}`);
    const data = body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : [];
    const now = this.clock.nowMs();
    return data.map((e) => normalizeEvent(e, now)).filter((e): e is WorldEvent => e !== null);
  }

  async getEvent(id: string): Promise<WorldEvent | null> {
    const { status, body } = await this.getJson(`${GEMINI_EVENTS_PATH}/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`gemini: get event HTTP ${status}`);
    return normalizeEvent(body, this.clock.nowMs());
  }

  /** WS URL for a contract's top of book (https → wss on the configured host). */
  marketDataUrl(symbol: string): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    u.pathname = `/v1/marketdata/${encodeURIComponent(symbol)}`;
    u.search = 'top_of_book=true&trades=true';
    return u.toString();
  }

  subscribePrices(eventId: string, onPrice: (p: WorldPrice) => void): () => void {
    let closed = false;
    const sockets = new Set<PriceSocket>();
    const timers = new Set<NodeJS.Timeout>();

    const connect = (contractId: string, attempt: number) => {
      if (closed) return;
      const book = new TopOfBook();
      let ws: PriceSocket;
      try {
        ws = this.openSocket(this.marketDataUrl(contractId));
      } catch (e) {
        this.opts.log?.warn({ err: e, contractId }, 'gemini ws open failed');
        return retry(contractId, attempt);
      }
      sockets.add(ws);
      ws.on('message', (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!book.apply(msg)) return;
        const p = book.probBps();
        if (p !== null) onPrice({ event_id: eventId, contract_id: contractId, prob_bps: p, at_ms: this.clock.nowMs() });
      });
      ws.on('error', (e) => this.opts.log?.warn({ err: e.message, contractId }, 'gemini ws error'));
      ws.on('close', () => {
        sockets.delete(ws);
        retry(contractId, attempt + 1);
      });
    };
    const retry = (contractId: string, attempt: number) => {
      if (closed) return;
      const t = setTimeout(() => {
        timers.delete(t);
        connect(contractId, attempt);
      }, Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 5)));
      t.unref?.();
      timers.add(t);
    };

    void this.getEvent(eventId)
      .then((ev) => {
        if (!ev || closed) return;
        for (const c of ev.contracts) connect(c.id, 0);
      })
      .catch((e: unknown) => this.opts.log?.warn({ err: e, eventId }, 'gemini price subscription failed'));

    return () => {
      closed = true;
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.close();
      sockets.clear();
    };
  }
}

export class LiveHedge implements HedgeProvider {
  readonly name = 'live';
  constructor(cfg: Pick<Config, 'allowSpend'>) {
    assertSpendAllowed(cfg, 'GEMINI_HEDGE=live');
  }
  async placeOrder(): Promise<{ order_id: string; status: string }> {
    // §11.6: refuses unless ALLOW_SPEND=1 *and* the demo OAuth config are present; §13 defines no OAuth vars yet.
    throw new ApiError('SPEND_DISABLED', 'GEMINI_HEDGE=live requires the Gemini demo OAuth configuration');
  }
}
