// The REPLAY feed for Beat 6 (ARCHITECTURE §7.1 row 6 / §7.2 `gemini_fallback`): when Gemini's
// prediction-markets API is down or has no usable book at pitch time, the relay can serve ONE
// RECORDED real round (replay-data.ts: BTC05M2611180240, line 64389.6, settled "no") shifted onto
// the current 5-minute window, so the whole closer (quote, lock, countdown, settlement, payout on
// devnet) still runs on real Gemini numbers. It is never mistaken for live data:
//   - every ticker and symbol is prefixed REPLAY- (REPLAY-BTC05M2611190045, REPLAY-GEMI-…-UP),
//     so Terms.market, the stage and the phones show it (and the terms_hash commits to it);
//   - the event title says REPLAY; the settlement record's source_url is replay://gemini/…;
//   - the settlement reason says it is a replay (shared/settlement.ts).
// Timeline per window W: the recorded bodies with every timestamp moved by (W.start − 02:35:00),
// active until expiry, then "closed" without a side, then settled at expiry + 5.521 s (as
// recorded). The BTC/USD ticker walks from above the line to the recorded settlement value, so
// the chart moves and ends where Gemini settled.
//
// createRoutedClient(): the relay's client. Ticker-scoped calls (getEvent / getEventRaw /
// getStrike) go to the replay for REPLAY- tickers and to Gemini otherwise, whatever the mode, so
// a bet settles from the feed it was quoted on; discovery and the BTC ticker follow the mode
// (POST /v1/demo/gemini or MARKETS_FEED=replay).
import { isReplayTicker, REPLAY_TICKER_PREFIX } from '@youre-on/shared/judge/market-terms';
import { GeminiError, RawEvent, type GeminiClient, type RawEventResponse } from './gemini';
import { REPLAY_RECORDING as R } from './replay-data';

export { isReplayTicker };
export const REPLAY_PREFIX = REPLAY_TICKER_PREFIX;

const WINDOW_MS = 300_000;
const REC_EXPIRY = Date.parse(R.expiry);
type RecContract = { resolvedAt?: string; settlementValue?: string; strike?: { value?: string } };
const REC_SETTLED = (R.settled as { contracts: RecContract[] }).contracts[0]!;
/** Recorded resolvedAt − expiry (5.521 s for the shipped round). */
export const REPLAY_SETTLES_AFTER_MS = Math.max(
  1_000,
  Date.parse(REC_SETTLED.resolvedAt ?? R.expiry) - REC_EXPIRY,
);
/** The recorded line and settlement value: the replayed BTC/USD crosses from one to the other. */
const REC_LINE = Number(REC_SETTLED.strike?.value ?? R.strike.value);
const REC_SETTLE = Number(REC_SETTLED.settlementValue ?? REC_LINE);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const pad = (n: number) => String(n).padStart(2, '0');
/** Gemini's ticker clock: yymmddhhmm (UTC) of the expiry. */
function tickerClock(expiryMs: number): string {
  const d = new Date(expiryMs);
  return `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}
export const replayTicker = (expiryMs: number) => `${REPLAY_PREFIX}BTC05M${tickerClock(expiryMs)}`;
export const replaySymbol = (expiryMs: number) =>
  `${REPLAY_PREFIX}GEMI-BTC05M${tickerClock(expiryMs)}-UP`;

/** The expiry a replay ticker names, or null. */
export function replayExpiry(ticker: string): number | null {
  const m = /^REPLAY-BTC05M(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ticker);
  if (!m) return null;
  const [, yy, mo, dd, hh, mi] = m.map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(2000 + yy, mo - 1, dd, hh, mi);
  return Number.isFinite(t) ? t : null;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Every ISO timestamp moved by `offsetMs`. */
function shiftTimes(v: Json, offsetMs: number): Json {
  if (typeof v === 'string')
    return ISO.test(v) ? new Date(Date.parse(v) + offsetMs).toISOString() : v;
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, offsetMs));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftTimes(x, offsetMs)]));
  return v;
}

/** A recorded event body moved onto the window that expires at `expiryMs`, relabelled REPLAY. */
function relabel(body: unknown, recordedExpiryMs: number, expiryMs: number): Json {
  const e = shiftTimes(structuredClone(body) as Json, expiryMs - recordedExpiryMs) as Record<
    string,
    Json
  >;
  e.ticker = replayTicker(expiryMs);
  e.title = `REPLAY of a recorded Gemini round: ${String(e.title)}`;
  e.isLive = false;
  if (Array.isArray(e.contracts))
    e.contracts = e.contracts.map((c) => ({
      ...(c as Record<string, Json>),
      instrumentSymbol: replaySymbol(expiryMs),
    }));
  return e;
}

/** The event body of the replayed window expiring at `expiryMs`, as of `nowMs`. */
export function replayEventBody(expiryMs: number, nowMs: number): Json {
  if (nowMs < expiryMs) return relabel(R.active, REC_EXPIRY, expiryMs);
  const settled = relabel(R.settled, REC_EXPIRY, expiryMs) as Record<string, Json>;
  if (nowMs >= expiryMs + REPLAY_SETTLES_AFTER_MS) return settled;
  // between expiry and the recorded resolvedAt: closed, no side yet
  settled.status = 'closed';
  delete settled.resolvedAt;
  delete settled.settlement;
  settled.contracts = (settled.contracts as Record<string, Json>[]).map((c) => {
    const { resolutionSide: _s, settlementValue: _v, resolvedAt: _r, ...rest } = c;
    return { ...rest, status: 'closed' };
  });
  return settled;
}

const windowOf = (nowMs: number) => {
  const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  return { start, expiry: start + WINDOW_MS };
};

/**
 * The replay's BTC/USD: from the other side of the line at the window start (mirrored) to
 * Gemini's recorded settlement value at expiry, with a small wiggle (deterministic in time), so
 * the chart crosses the line and ends exactly where Gemini settled.
 */
export function replayBtcUsd(nowMs: number): string {
  const w = windowOf(nowMs);
  const p = (nowMs - w.start) / WINDOW_MS;
  const to = REC_SETTLE;
  const from = 2 * REC_LINE - to;
  const wiggle = 4 * Math.sin(nowMs / 7_000) + 2 * Math.sin(nowMs / 2_300);
  return (from + (to - from) * p + wiggle * (1 - p)).toFixed(2);
}

const ofTicker = (ticker: string): number => {
  const e = replayExpiry(ticker);
  if (e === null) throw new GeminiError(`replay: no such event ${ticker}`, 'http');
  return e;
};

/** The REPLAY GeminiClient over `now` (the server clock). */
export function createReplayClient(o: { now: () => number }): GeminiClient {
  const event = (ticker: string): Json => replayEventBody(ofTicker(ticker), o.now());
  return {
    async listActiveCrypto() {
      const w = windowOf(o.now());
      return [
        relabel(R.listed, REC_EXPIRY, w.expiry),
        relabel(R.next_listed, REC_EXPIRY + WINDOW_MS, w.expiry + WINDOW_MS),
      ].map((e) => RawEvent.parse(e));
    },
    async getEvent(ticker) {
      return RawEvent.parse(event(ticker));
    },
    async getEventRaw(ticker): Promise<RawEventResponse> {
      const body = event(ticker);
      return {
        event: RawEvent.parse(body),
        url: `replay://gemini/v1/prediction-markets/events/${encodeURIComponent(ticker)}`,
        bytes: new TextEncoder().encode(JSON.stringify(body)),
      };
    },
    async getStrike(ticker) {
      const expiry = ofTicker(ticker);
      return shiftTimes(structuredClone(R.strike) as Json, expiry - REC_EXPIRY) as {
        type: string;
        value?: string;
        availableAt?: string;
      };
    },
    async getBtcUsd() {
      return replayBtcUsd(o.now());
    },
  };
}

export type FeedMode = 'live' | 'replay';

export interface RoutedClient extends GeminiClient {
  readonly mode: FeedMode;
  setMode(mode: FeedMode): void;
}

/** See the header: ticker-scoped calls by ticker, discovery and BTC/USD by mode. */
export function createRoutedClient(o: {
  live: GeminiClient;
  replay: GeminiClient;
  mode?: FeedMode;
}): RoutedClient {
  let mode: FeedMode = o.mode ?? 'live';
  const by = (ticker: string) => (isReplayTicker(ticker) ? o.replay : o.live);
  const feed = () => (mode === 'replay' ? o.replay : o.live);
  return {
    get mode() {
      return mode;
    },
    setMode(m) {
      mode = m;
    },
    listActiveCrypto: () => feed().listActiveCrypto(),
    getEvent: (t) => by(t).getEvent(t),
    getEventRaw: (t) => by(t).getEventRaw(t),
    getStrike: (t) => by(t).getStrike(t),
    getBtcUsd: () => feed().getBtcUsd(),
  };
}
