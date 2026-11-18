// The BTC 5-minute market relay (API-CONTRACT §2.13, §7.3). One poller serves every client:
// GET /v1/markets/btc5m/* read its state and never proxy a Gemini call per request (Gemini
// allows 120 req/min with no headers). REST polling stands in for the §7.3 WebSocket: every
// `pollMs` (2 s) it refreshes the current event (prices, status) and the BTC/USD ticker; every
// `discoveryMs` (60 s), and at every contract expiry, it re-discovers the current contract, so a
// 5-minute rollover is picked up on the first poll after expiry. Budget at the defaults:
// ~30 event + ~30 ticker + 1 discovery (+ the strike fallback) per minute.
//
// Strike: latched per eventTicker on the first non-null value (event body first, then the
// /strike fallback once `availableAt` has passed); never quoted without it (STRIKE_PENDING).
import { FAIR, fairStakes, type FairRefusal, type FairStakesResult } from '@youre-on/shared/gemini';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import type { MicroUsdc } from '@youre-on/shared/money';
import type { Logger } from '../log';
import type { FeedMode, RoutedClient } from './replay';
import {
  btcContract,
  cleanDecimal,
  nextWindowStart,
  pickCurrent,
  toSnapshot,
  toStrike,
  type GeminiClient,
  type RawContract,
  type RawEvent,
} from './gemini';

export const MARKET_POLL_MS = 2_000;
/** While Gemini keeps failing, the poll backs off (doubling from pollMs) up to this. */
export const MARKET_BACKOFF_MAX_MS = 16_000;
export const MARKET_DISCOVERY_MS = 60_000;
/** §2.13 recommended_lock_by = window start + 90 s. */
export const RECOMMENDED_LOCK_AFTER_START_MS = 90_000;
/** Index ticks kept for the stage chart (≈ 10 min at 0.5 Hz). */
export const RING_SIZE = 300;
/** The per-side amount used to decide `refusal` / `lockable` in MarketCurrent ($5). */
export const NOMINAL_AMOUNT = '5000000' as MicroUsdc;

const STAKE_REASONS: readonly FairRefusal[] = ['STAKE_ABOVE_MAX', 'STAKE_BELOW_MIN'];

/** §2.13 MarketCurrent. `window` is null while no BTC05M contract is live. */
export interface MarketCurrent {
  market: GeminiMarketSnapshot | null;
  window: { start: string; expiry: string } | null;
  strike_known: boolean;
  lockable: boolean;
  lockable_until: string | null;
  recommended_lock_by: string | null;
  refusal: FairRefusal | null;
  next_window_start: string | null;
}

export interface MarketServiceOptions {
  client: GeminiClient;
  now: () => number;
  log: Logger;
  pollMs?: number;
  discoveryMs?: number;
}

/** fairStakes, but a malformed price (> 6 dp) refuses instead of throwing. */
export function safeFairStakes(
  snap: GeminiMarketSnapshot,
  amount: MicroUsdc,
  side: 'YES' | 'NO',
  nowMs: number,
): FairStakesResult {
  try {
    return fairStakes(snap, amount, side, nowMs);
  } catch {
    return { ok: false, reason: 'NO_TWO_SIDED_QUOTE' };
  }
}

export class MarketService {
  private cur: { event: RawEvent; contract: RawContract } | null = null;
  private events: RawEvent[] = [];
  private lastDiscoveryAt = Number.NEGATIVE_INFINITY;
  private lastStrikeTryAt = Number.NEGATIVE_INFINITY;
  private readonly strikes = new Map<string, string>();
  private indexPrice: string | null = null;
  private snap: GeminiMarketSnapshot | null = null;
  private inFlight: Promise<GeminiMarketSnapshot | null> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private readonly listeners = new Set<(s: GeminiMarketSnapshot) => void>();
  readonly ring: Array<{ t: string; price: string }> = [];
  /** Diagnostics (GET /v1/demo/health later). */
  lastOkAt: number | null = null;
  lastError: string | null = null;
  rollovers = 0;
  /** Polls failed in a row (0 after a success): drives the backoff and the log volume. */
  failures = 0;

  readonly pollMs: number;
  readonly discoveryMs: number;

  constructor(private readonly o: MarketServiceOptions) {
    this.pollMs = o.pollMs ?? MARKET_POLL_MS;
    this.discoveryMs = o.discoveryMs ?? MARKET_DISCOVERY_MS;
  }

  get snapshot(): GeminiMarketSnapshot | null {
    return this.snap;
  }

  /** The REST client (the settlement keeper fetches a bet's own event with it). */
  get client(): GeminiClient {
    return this.o.client;
  }

  /** 'live' or 'replay' with a routed client (markets/replay.ts); null for a plain client. */
  get feed(): FeedMode | null {
    const c = this.o.client as Partial<RoutedClient>;
    return typeof c.setMode === 'function' ? (c.mode ?? null) : null;
  }

  /**
   * Switches a routed client's feed and forgets the current contract, its quote and the chart,
   * so the next poll re-discovers. Bets keep settling from the feed they were quoted on (the
   * routed client routes ticker-scoped calls by ticker). False for a plain client.
   */
  setFeed(mode: FeedMode): boolean {
    const c = this.o.client as Partial<RoutedClient>;
    if (typeof c.setMode !== 'function') return false;
    c.setMode(mode);
    this.cur = null;
    this.events = [];
    this.snap = null;
    this.lastDiscoveryAt = Number.NEGATIVE_INFINITY;
    this.ring.length = 0;
    this.o.log.info('markets.feed', { mode });
    return true;
  }

  /** The relay's current contract, if it is `eventTicker` (raw fields the snapshot drops). */
  contractOf(eventTicker: string): { event: RawEvent; contract: RawContract } | null {
    return this.cur && this.cur.event.ticker === eventTicker ? this.cur : null;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Called after every refresh that produced a snapshot. Returns the unsubscribe function. */
  onSnapshot(fn: (s: GeminiMarketSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const loop = () => {
      if (!this.started) return;
      void this.refresh().finally(() => {
        if (!this.started) return;
        this.timer = setTimeout(loop, this.nextPollMs());
        this.timer.unref?.();
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => null);
  }

  /**
   * The delay before the next timer poll: pollMs, doubled per failure in a row up to
   * MARKET_BACKOFF_MAX_MS (an outage is not hammered at 0.5 Hz with a warn line each time).
   */
  nextPollMs(): number {
    if (this.failures === 0) return this.pollMs;
    return Math.min(MARKET_BACKOFF_MAX_MS, this.pollMs * 2 ** Math.min(this.failures, 8));
  }

  /** One poll; concurrent callers share it. Never throws (errors land in lastError). */
  refresh(): Promise<GeminiMarketSnapshot | null> {
    this.inFlight ??= this.doRefresh()
      .then((snap) => {
        if (this.failures > 0)
          this.o.log.info('markets.recovered', { after_failures: this.failures });
        this.failures = 0;
        return snap;
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.failures++;
        // the first failure and then every 10th: an outage logs a line a minute or so
        if (this.failures === 1 || this.failures % 10 === 0)
          this.o.log.warn('markets.refresh_failed', { err, failures: this.failures });
        return this.snap;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async doRefresh(): Promise<GeminiMarketSnapshot | null> {
    const now = this.o.now();
    const c = this.o.client;
    const expired = this.cur !== null && now >= Date.parse(this.cur.contract.expiryDate);
    const discover = this.cur === null || expired || now - this.lastDiscoveryAt >= this.discoveryMs;

    const index = c.getBtcUsd().then(
      (p) => cleanDecimal(p),
      () => null,
    );

    if (discover) {
      let events: RawEvent[];
      try {
        events = await c.listActiveCrypto();
      } catch (err) {
        if (expired) this.cur = null; // the old contract is over; don't keep quoting it
        throw err;
      }
      this.events = events;
      this.lastDiscoveryAt = now;
      const picked = pickCurrent(events, now);
      if (picked && picked.event.ticker !== this.cur?.event.ticker) {
        if (this.cur) this.rollovers++;
        this.o.log.info('markets.contract', {
          eventTicker: picked.event.ticker,
          instrumentSymbol: picked.contract.instrumentSymbol,
          expiry: picked.contract.expiryDate,
          rollover: this.cur?.event.ticker ?? null,
        });
        this.lastStrikeTryAt = Number.NEGATIVE_INFINITY;
      }
      this.cur = picked;
    } else if (this.cur) {
      const ev = await c.getEvent(this.cur.event.ticker);
      const contract =
        ev.contracts.find((x) => x.instrumentSymbol === this.cur!.contract.instrumentSymbol) ??
        btcContract(ev);
      if (contract) this.cur = { event: ev, contract };
    }

    const idx = await index;
    if (idx !== null) this.indexPrice = idx;

    const cur = this.cur;
    if (!cur) {
      this.snap = null;
      this.lastOkAt = now;
      this.lastError = null;
      return null;
    }

    const ticker = cur.event.ticker;
    const fromBody = toStrike(cur.contract.strike);
    if (fromBody.value !== null && !this.strikes.has(ticker))
      this.strikes.set(ticker, fromBody.value);
    if (
      !this.strikes.has(ticker) &&
      fromBody.availableAt !== null &&
      Date.parse(fromBody.availableAt) <= now &&
      now - this.lastStrikeTryAt >= this.pollMs
    ) {
      this.lastStrikeTryAt = now;
      try {
        const s = toStrike(await c.getStrike(ticker));
        if (s.value !== null) this.strikes.set(ticker, s.value);
      } catch (err) {
        this.o.log.warn('markets.strike_failed', { eventTicker: ticker, err });
      }
    }
    // keep the latch map small: only tickers still listed (plus the current one)
    if (this.strikes.size > 32) {
      for (const k of this.strikes.keys()) if (k !== ticker) this.strikes.delete(k);
    }

    const snap = toSnapshot(cur.event, cur.contract, {
      observedAtMs: this.o.now(),
      latchedStrike: this.strikes.get(ticker) ?? null,
      indexPrice: this.indexPrice,
    });
    this.snap = snap;
    if (this.indexPrice !== null) {
      this.ring.push({ t: snap.observedAt, price: this.indexPrice });
      if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    }
    this.lastOkAt = now;
    this.lastError = null;
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch (err) {
        this.o.log.warn('markets.listener_failed', { err });
      }
    }
    return snap;
  }

  /** §2.13 GET /v1/markets/btc5m/current, from relay state only. */
  current(nowMs: number = this.o.now()): MarketCurrent {
    const snap = this.snap;
    const cur = this.cur;
    const nextStart = nextWindowStart(
      this.events,
      cur ? Date.parse(cur.contract.expiryDate) : nowMs,
    );
    if (!snap || !cur) {
      return {
        market: null,
        window: null,
        strike_known: false,
        lockable: false,
        lockable_until: null,
        recommended_lock_by: null,
        refusal: 'MARKET_NOT_OPEN',
        next_window_start: nextStart,
      };
    }
    const start = Date.parse(cur.contract.effectiveDate);
    const expiry = Date.parse(snap.expiry);
    const r = safeFairStakes(snap, NOMINAL_AMOUNT, 'YES', nowMs);
    const refusal = r.ok || STAKE_REASONS.includes(r.reason) ? null : r.reason;
    const strikeKnown = snap.strike.value !== null;
    const lockableUntil = expiry - FAIR.MIN_TTE_MS;
    return {
      market: snap,
      window: { start: new Date(start).toISOString(), expiry: snap.expiry },
      strike_known: strikeKnown,
      lockable: strikeKnown && refusal === null && nowMs < lockableUntil,
      lockable_until: new Date(lockableUntil).toISOString(),
      recommended_lock_by: new Date(start + RECOMMENDED_LOCK_AFTER_START_MS).toISOString(),
      refusal,
      next_window_start: nextStart ?? snap.expiry,
    };
  }

  /**
   * §2.13 quote preview. A stale snapshot triggers one (shared) refresh before refusing with
   * QUOTE_STALE (§7.3 "a stale quote triggers a REST refetch").
   */
  async quote(
    amount: MicroUsdc,
    side: 'YES' | 'NO',
  ): Promise<{ result: FairStakesResult; snapshot: GeminiMarketSnapshot | null }> {
    let snap = this.snap;
    if (!snap || this.o.now() - Date.parse(snap.observedAt) > FAIR.STALE_MS) {
      snap = await this.refresh();
    }
    if (!snap) return { result: { ok: false, reason: 'MARKET_NOT_OPEN' }, snapshot: null };
    return { result: safeFairStakes(snap, amount, side, this.o.now()), snapshot: snap };
  }
}
