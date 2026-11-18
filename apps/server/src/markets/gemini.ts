// Gemini Prediction Markets public REST client (API-CONTRACT §7.3; ARCHITECTURE §… "Gemini";
// no key, no trading). Shapes are from real responses recorded on 2026-11-18
// (test/fixtures/gemini-*.json). Only the fields we read are parsed, tolerantly: Gemini adds
// keys freely, and a strike's `value` key is ABSENT (not null) until the window opens.
//
//   discovery   GET /v1/prediction-markets/events?status=active&category=Crypto&limit=200
//   refresh     GET /v1/prediction-markets/events/{eventTicker}
//   strike      GET /v1/prediction-markets/events/{eventTicker}/strike   (fallback)
//   BTC price   GET /v1/pubticker/btcusd   (display only: the Lukka index is WS-only)
//
// Every call has a 2 s deadline (§1.7 "Gemini REST 2 s"). `fetch` is injectable for tests.
import { z } from 'zod/v4';
import type { GeminiMarketSnapshot, GeminiStrike } from '@youre-on/shared/gemini';

export const GEMINI_API = 'https://api.gemini.com';
export const BTC5M_SERIES = 'BTC05M';
export const GEMINI_TIMEOUT_MS = 2_000;

const Str = z.string();
const NullishStr = z.string().nullish();

const RawStrike = z.object({
  type: z.string(),
  value: z.union([z.string(), z.number()]).nullish(),
  availableAt: NullishStr,
});

export const RawContract = z.object({
  id: Str,
  label: Str,
  status: Str,
  instrumentSymbol: Str,
  marketState: NullishStr,
  effectiveDate: Str,
  expiryDate: Str,
  strike: RawStrike.nullish(),
  prices: z
    .object({
      bestBid: NullishStr,
      bestAsk: NullishStr,
      lastTradePrice: NullishStr,
    })
    .nullish(),
});
export type RawContract = z.infer<typeof RawContract>;

export const RawEvent = z.object({
  ticker: Str,
  title: Str,
  status: Str,
  series: NullishStr,
  startTime: NullishStr,
  expiryDate: NullishStr,
  contracts: z.array(RawContract).default([]),
});
export type RawEvent = z.infer<typeof RawEvent>;

export const RawEventList = z.object({ data: z.array(z.unknown()) });

export const RawTicker = z.object({ last: Str, bid: NullishStr, ask: NullishStr });

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'http' | 'shape' | 'network',
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GeminiClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface GeminiClient {
  listActiveCrypto(): Promise<RawEvent[]>;
  getEvent(eventTicker: string): Promise<RawEvent>;
  getStrike(eventTicker: string): Promise<z.infer<typeof RawStrike>>;
  getBtcUsd(): Promise<string>;
}

export function createGeminiClient(o: GeminiClientOptions = {}): GeminiClient {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl ?? GEMINI_API;
  const timeoutMs = o.timeoutMs ?? GEMINI_TIMEOUT_MS;

  async function getJson(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(base + path, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new GeminiError(`gemini ${path}: timeout`, 'timeout');
      throw new GeminiError(`gemini ${path}: ${String(err)}`, 'network');
    }
    if (!res.ok) throw new GeminiError(`gemini ${path}: HTTP ${res.status}`, 'http');
    try {
      return await res.json();
    } catch {
      throw new GeminiError(`gemini ${path}: non-JSON body`, 'shape');
    }
  }

  function parse<T extends z.ZodType>(schema: T, raw: unknown, what: string): z.infer<T> {
    const r = schema.safeParse(raw);
    if (!r.success) throw new GeminiError(`gemini ${what}: unexpected shape`, 'shape');
    return r.data;
  }

  return {
    async listActiveCrypto() {
      const raw = await getJson(
        '/v1/prediction-markets/events?status=active&category=Crypto&limit=200',
      );
      const list = parse(RawEventList, raw, 'events');
      // One odd event must not hide the BTC contract: drop entries that don't parse.
      return list.data.flatMap((e) => {
        const r = RawEvent.safeParse(e);
        return r.success ? [r.data] : [];
      });
    },
    async getEvent(ticker) {
      return parse(
        RawEvent,
        await getJson(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`),
        'event',
      );
    },
    async getStrike(ticker) {
      return parse(
        RawStrike,
        await getJson(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}/strike`),
        'strike',
      );
    },
    async getBtcUsd() {
      return parse(RawTicker, await getJson('/v1/pubticker/btcusd'), 'ticker').last;
    },
  };
}

// ---- pure helpers -----------------------------------------------------------------------

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** "64379.76000" -> "64379.76"; numbers -> string; anything not a plain decimal -> null. */
export function cleanDecimal(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  let s = typeof v === 'number' ? String(v) : v.trim();
  if (!DECIMAL_RE.test(s)) return null;
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Any parseable timestamp -> Date#toISOString(), else null. */
export function isoOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const STRIKE_TYPES = new Set<GeminiStrike['type']>([
  'reference',
  'above',
  'spread',
  'over',
  'over_or_equal',
  'under',
  'under_or_equal',
]);

export function toStrike(raw: RawContract['strike']): GeminiStrike {
  const type = (raw?.type ?? 'reference') as GeminiStrike['type'];
  return {
    value: cleanDecimal(raw?.value),
    type: STRIKE_TYPES.has(type) ? type : 'reference',
    availableAt: isoOrNull(raw?.availableAt),
  };
}

/** The BTC 5-minute "Up" contract of an event (there is one; prefer the label). */
export function btcContract(e: RawEvent): RawContract | null {
  return e.contracts.find((c) => /^up$/i.test(c.label)) ?? e.contracts[0] ?? null;
}

/** §7.3: series BTC05M and `contract.effectiveDate <= now < contract.expiryDate`. */
export function pickCurrent(
  events: readonly RawEvent[],
  nowMs: number,
): { event: RawEvent; contract: RawContract } | null {
  let best: { event: RawEvent; contract: RawContract } | null = null;
  for (const event of events) {
    if (event.series !== BTC5M_SERIES) continue;
    const contract = btcContract(event);
    if (!contract) continue;
    const start = Date.parse(contract.effectiveDate);
    const end = Date.parse(contract.expiryDate);
    if (!(start <= nowMs && nowMs < end)) continue;
    if (!best || end < Date.parse(best.contract.expiryDate)) best = { event, contract };
  }
  return best;
}

/** The next BTC05M window after `afterMs` (for "next round opens at …"), or null. */
export function nextWindowStart(events: readonly RawEvent[], afterMs: number): string | null {
  let best: number | null = null;
  for (const e of events) {
    if (e.series !== BTC5M_SERIES) continue;
    const c = btcContract(e);
    if (!c) continue;
    const s = Date.parse(c.effectiveDate);
    if (s >= afterMs && (best === null || s < best)) best = s;
  }
  return best === null ? null : new Date(best).toISOString();
}

const STATUSES = new Set<GeminiMarketSnapshot['status']>([
  'approved',
  'active',
  'closed',
  'under_review',
  'settled',
  'invalid',
]);

/** A REST event + its BTC contract -> the shared GeminiMarketSnapshot (SCHEMAS §8). */
export function toSnapshot(
  event: RawEvent,
  contract: RawContract,
  o: { observedAtMs: number; latchedStrike: string | null; indexPrice: string | null },
): GeminiMarketSnapshot {
  const strike = toStrike(contract.strike);
  if (strike.value === null && o.latchedStrike !== null) strike.value = o.latchedStrike;
  const status = contract.status.toLowerCase() as GeminiMarketSnapshot['status'];
  const ms = contract.marketState?.toLowerCase();
  return {
    eventTicker: event.ticker,
    eventTitle: event.title,
    instrumentSymbol: contract.instrumentSymbol,
    contractLabel: contract.label,
    status: STATUSES.has(status) ? status : 'closed',
    marketState: ms === 'open' || ms === 'closed' ? ms : null,
    strike,
    expiry: isoOrNull(contract.expiryDate) ?? new Date(o.observedAtMs).toISOString(),
    bestBid: cleanDecimal(contract.prices?.bestBid),
    bestAsk: cleanDecimal(contract.prices?.bestAsk),
    lastTradePrice: cleanDecimal(contract.prices?.lastTradePrice),
    indexPrice: o.indexPrice,
    source: 'rest_event',
    exchangeTs: null,
    observedAt: new Date(o.observedAtMs).toISOString(),
  };
}
