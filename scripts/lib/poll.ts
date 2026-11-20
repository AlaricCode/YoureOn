// Polling pace for scripts/cp1-drive.ts against a real server's rate limits (API-CONTRACT §1.7):
// GET /v1/markets/btc5m/* is 60/min per user (MARKETS_BUCKET) and every bearer request takes a
// token of the session's 120/min, so a 400 ms poll (~2 req/s with the round trip) drains the
// markets bucket in about a minute and the session one in a few, and the run dies on a 429. Pure
// functions (tested in apps/server/test/cp1-poll.test.ts); the clock is the server's.

/** GET /v1/markets/btc5m/current while the window is not lockable yet (~24/min). */
export const MARKET_POLL_MS = 2_500;
/** After the next window opens, the relay needs a poll or two (2 s each) to latch its strike. */
export const STRIKE_LATCH_MS = 3_000;
/** A skip-ahead sleep is cut into steps of at most this (a wrong clock costs one step). */
export const MAX_SKIP_MS = 60_000;
/** GET /v1/bets/:id before the contract's expiry (+ Gemini's ~6 s to settle) and after it. */
export const SETTLE_SLOW_POLL_MS = 3_000;
export const SETTLE_FAST_POLL_MS = 1_000;
/** Gemini settles 5.7-8.8 s after expiry (measured): poll fast from here on. */
export const SETTLE_FAST_AFTER_MS = 4_000;
/** A 429 without a usable Retry-After waits this; any Retry-After is capped at MAX_RETRY_AFTER_MS. */
export const DEFAULT_RETRY_AFTER_MS = 2_000;
export const MAX_RETRY_AFTER_MS = 30_000;

/** The fields of GET /v1/markets/btc5m/current the pace depends on (§2.13 MarketCurrent). */
export interface MarketCurrentPace {
  lockable: boolean;
  lockable_until: string | null;
  next_window_start: string | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How long to wait before asking /current again. Past this window's last lockable moment (or
 * with no window open) nothing changes until the next window opens and its strike is latched,
 * so sleep until then (in steps of MAX_SKIP_MS); otherwise (the strike is pending, the quote
 * one-sided) poll every MARKET_POLL_MS.
 */
export function marketWaitMs(cur: MarketCurrentPace, serverNowMs: number): number {
  if (cur.lockable) return 0;
  const until = cur.lockable_until === null ? null : Date.parse(cur.lockable_until);
  const next = cur.next_window_start === null ? null : Date.parse(cur.next_window_start);
  const over = until === null || !Number.isFinite(until) || serverNowMs >= until;
  if (over && next !== null && Number.isFinite(next) && next + STRIKE_LATCH_MS > serverNowMs)
    return clamp(next + STRIKE_LATCH_MS - serverNowMs, MARKET_POLL_MS, MAX_SKIP_MS);
  return MARKET_POLL_MS;
}

/** GET /v1/bets/:id while waiting for Gemini to settle a contract expiring at `expiryMs`. */
export function settlementPollMs(expiryMs: number, serverNowMs: number): number {
  return serverNowMs < expiryMs + SETTLE_FAST_AFTER_MS ? SETTLE_SLOW_POLL_MS : SETTLE_FAST_POLL_MS;
}

/**
 * A 429's Retry-After header (delta seconds or an HTTP date) -> ms to wait, capped; a missing or
 * unparseable one waits DEFAULT_RETRY_AFTER_MS.
 */
export function retryAfterMs(header: string | null, nowMs: number = Date.now()): number {
  if (header !== null && header.trim() !== '') {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return clamp(secs * 1000, 0, MAX_RETRY_AFTER_MS);
    // an HTTP-date ("Wed, 18 Nov 2026 02:37:14 GMT"), never a bare number
    const at = /[a-z]/i.test(header) ? Date.parse(header) : NaN;
    if (Number.isFinite(at)) return clamp(at - nowMs, 0, MAX_RETRY_AFTER_MS);
  }
  return DEFAULT_RETRY_AFTER_MS;
}
