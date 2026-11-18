// scripts/lib/poll.ts: how scripts/cp1-drive.ts paces its waits under the server's rate limits
// (API-CONTRACT §1.7; MARKETS_BUCKET 60/min, the session bucket 120/min). Pure: no server.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_AFTER_MS,
  MARKET_POLL_MS,
  marketWaitMs,
  MAX_RETRY_AFTER_MS,
  MAX_SKIP_MS,
  retryAfterMs,
  SETTLE_FAST_POLL_MS,
  SETTLE_SLOW_POLL_MS,
  settlementPollMs,
  STRIKE_LATCH_MS,
} from '../../../scripts/lib/poll';
import { BUCKETS } from '../src/http/rate-limit';
import { MARKETS_BUCKET } from '../src/markets/routes';

const at = (iso: string) => Date.parse(iso);
// The 02:35-02:40 round: lockable until 02:38:00, the next one opens 02:40:00.
const ROUND = {
  lockable: false,
  lockable_until: '2026-11-18T02:38:00.000Z',
  next_window_start: '2026-11-18T02:40:00.000Z',
};

describe('cp1-drive polling pace', () => {
  it('a lockable window: go now', () => {
    expect(marketWaitMs({ ...ROUND, lockable: true }, at('2026-11-18T02:37:10Z'))).toBe(0);
  });

  it('not lockable YET (strike pending, a one-sided book): every 2.5 s, inside the markets bucket', () => {
    expect(marketWaitMs(ROUND, at('2026-11-18T02:35:01Z'))).toBe(MARKET_POLL_MS);
    // 24/min against 60/min refilled: the bucket never runs dry however long the wait
    expect(60_000 / MARKET_POLL_MS).toBeLessThan(MARKETS_BUCKET.limit / 2);
  });

  it('past the last lockable moment: asleep until the next window (+ its strike), in 60 s steps', () => {
    // 02:38:30: the next window opens in 90 s -> one 60 s step, then 33 s
    expect(marketWaitMs(ROUND, at('2026-11-18T02:38:30Z'))).toBe(MAX_SKIP_MS);
    expect(marketWaitMs(ROUND, at('2026-11-18T02:39:30Z'))).toBe(30_000 + STRIKE_LATCH_MS);
    // the window just opened, the relay has not latched its strike yet: poll
    expect(marketWaitMs(ROUND, at('2026-11-18T02:40:01Z'))).toBe(MARKET_POLL_MS);
    // no window open at all (between rounds), the next one known
    const none = {
      lockable: false,
      lockable_until: null,
      next_window_start: ROUND.next_window_start,
    };
    expect(marketWaitMs(none, at('2026-11-18T02:39:50Z'))).toBe(10_000 + STRIKE_LATCH_MS);
    // ... or not known: poll
    expect(marketWaitMs({ ...none, next_window_start: null }, at('2026-11-18T02:39:50Z'))).toBe(
      MARKET_POLL_MS,
    );
    // the whole dead stretch (02:38:00 -> 02:40:03) costs a handful of requests, not ~300
    let t = at('2026-11-18T02:38:00Z');
    let polls = 0;
    while (t < at('2026-11-18T02:40:03Z')) {
      t += marketWaitMs(ROUND, t);
      polls++;
    }
    expect(polls).toBeLessThanOrEqual(3);
  });

  it('waiting for the settlement: slow until expiry, 1/s while Gemini settles, inside the session bucket', () => {
    const expiry = at('2026-11-18T02:40:00Z');
    expect(settlementPollMs(expiry, at('2026-11-18T02:37:30Z'))).toBe(SETTLE_SLOW_POLL_MS);
    expect(settlementPollMs(expiry, at('2026-11-18T02:40:03Z'))).toBe(SETTLE_SLOW_POLL_MS);
    expect(settlementPollMs(expiry, at('2026-11-18T02:40:05Z'))).toBe(SETTLE_FAST_POLL_MS);
    expect(60_000 / SETTLE_FAST_POLL_MS).toBeLessThanOrEqual(BUCKETS.default.limit / 2);
  });

  it('Retry-After: seconds or an HTTP date, capped; absent or junk -> the default', () => {
    const now = at('2026-11-18T02:37:10Z');
    expect(retryAfterMs('3', now)).toBe(3_000);
    expect(retryAfterMs('0', now)).toBe(0);
    expect(retryAfterMs('600', now)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterMs(new Date(now + 4_000).toUTCString(), now)).toBe(4_000);
    expect(retryAfterMs(null, now)).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(retryAfterMs('soon', now)).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(retryAfterMs('-5', now)).toBe(DEFAULT_RETRY_AFTER_MS);
  });
});
