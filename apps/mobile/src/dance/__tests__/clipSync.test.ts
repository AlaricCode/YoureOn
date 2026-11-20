// The reference clip is kept on the clock with speed, and seeked only when it is far off
// (model/clipSync). The regression these pin: correcting by seeking never converged, because a
// seek costs more than the tolerance it was trying to meet.
import { describe, expect, it } from 'vitest';

import {
  CLIP_RATE_CATCH_UP,
  CLIP_RATE_HOLD_BACK,
  CLIP_SEEK_BEYOND_MS,
  CLIP_SEEK_LEAD_MAX_MS,
  CLIP_SEEK_LEAD_MS,
  CLIP_SYNC_CHECK_MS,
  CLIP_SYNC_ENGAGE_MS,
  CLIP_SYNC_RELEASE_MS,
  clipNeedsSeek,
  clipRateFor,
  clipSeekTargetSec,
  nextSeekLeadMs,
} from '../model/clipSync';

/** A clip checked every CLIP_SYNC_CHECK_MS from `start` ms of drift: where it ends, and how. */
function run(start: number, seconds = 12) {
  let drift = start;
  let rate = 1;
  let changes = 0;
  let settledAfterMs: number | null = null;
  for (let t = 0; t < seconds * 1000; t += CLIP_SYNC_CHECK_MS) {
    const next = clipRateFor(drift, rate);
    if (next !== rate) changes += 1;
    rate = next;
    if (rate === 1 && settledAfterMs === null) settledAfterMs = t;
    if (rate !== 1) settledAfterMs = null;
    drift += (rate - 1) * CLIP_SYNC_CHECK_MS;
  }
  return { drift, rate, changes, settledAfterMs };
}

describe('clipRateFor', () => {
  it('leaves a clip that is on the clock alone', () => {
    for (const d of [0, 10, -10, CLIP_SYNC_ENGAGE_MS, -CLIP_SYNC_ENGAGE_MS])
      expect(clipRateFor(d, 1)).toBe(1);
    expect(clipRateFor(0)).toBe(1);
  });

  it('speeds a clip that is behind and slows one that is ahead', () => {
    expect(clipRateFor(-100, 1)).toBe(CLIP_RATE_CATCH_UP);
    expect(clipRateFor(100, 1)).toBe(CLIP_RATE_HOLD_BACK);
    expect(CLIP_RATE_CATCH_UP).toBeGreaterThan(1);
    expect(CLIP_RATE_CATCH_UP).toBeLessThanOrEqual(1.1);
    expect(CLIP_RATE_HOLD_BACK).toBeLessThan(1);
    expect(CLIP_RATE_HOLD_BACK).toBeGreaterThanOrEqual(0.9);
  });

  it('keeps correcting until the drift is gone, not just back inside the tolerance', () => {
    // still 40 ms behind: a clip at its own speed is left alone, one catching up keeps going
    expect(clipRateFor(-40, 1)).toBe(1);
    expect(clipRateFor(-40, CLIP_RATE_CATCH_UP)).toBe(CLIP_RATE_CATCH_UP);
    expect(clipRateFor(-CLIP_SYNC_RELEASE_MS, CLIP_RATE_CATCH_UP)).toBe(1);
    expect(clipRateFor(40, CLIP_RATE_HOLD_BACK)).toBe(CLIP_RATE_HOLD_BACK);
    expect(clipRateFor(CLIP_SYNC_RELEASE_MS, CLIP_RATE_HOLD_BACK)).toBe(1);
  });

  it('stops a correction that has crossed over, rather than reversing it', () => {
    expect(clipRateFor(5, CLIP_RATE_CATCH_UP)).toBe(1);
    expect(clipRateFor(-5, CLIP_RATE_HOLD_BACK)).toBe(1);
  });

  it('survives a bad reading', () => {
    expect(clipRateFor(Number.NaN, 1)).toBe(1);
    expect(clipRateFor(Number.NaN, CLIP_RATE_CATCH_UP)).toBe(1);
  });

  it('brings the drift measured on the simulator onto the clock with two changes of speed', () => {
    // The clip started about 200 ms behind; the old check seeked it every 2 s for the whole
    // routine, and a version that re-tuned the speed on every check hovered 100 ms behind.
    for (const start of [-203, -170, -400, 250, 590]) {
      const r = run(start);
      expect(Math.abs(r.drift)).toBeLessThanOrEqual(CLIP_SYNC_RELEASE_MS + 5);
      expect(r.rate).toBe(1);
      expect(r.changes).toBe(2);
      // inside 9 s, however it started
      expect(r.settledAfterMs).not.toBeNull();
      expect(r.settledAfterMs!).toBeLessThanOrEqual(9_000);
    }
    // the measured case: from 203 ms behind to on the clock in about 2.5 s
    expect(run(-203).settledAfterMs!).toBeLessThanOrEqual(3_000);
  });

  it('never touches the speed of a clip that stays inside the tolerance', () => {
    expect(run(-45).changes).toBe(0);
    expect(run(30).changes).toBe(0);
  });
});

describe('seeking', () => {
  it('is only for a clip that speed cannot bring back in time', () => {
    expect(clipNeedsSeek(CLIP_SEEK_BEYOND_MS)).toBe(false);
    expect(clipNeedsSeek(-CLIP_SEEK_BEYOND_MS)).toBe(false);
    expect(clipNeedsSeek(CLIP_SEEK_BEYOND_MS + 1)).toBe(true);
    expect(clipNeedsSeek(-3_000)).toBe(true);
  });

  it('aims ahead by what a seek costs, and never past the end', () => {
    // 5 s into a 32.6 s routine, a seek that costs 250 ms lands on the clock at 5.25 s
    expect(clipSeekTargetSec(1_000, 6_000, 250, 32_600)).toBeCloseTo(5.25, 6);
    expect(clipSeekTargetSec(1_000, 500, 0, 32_600)).toBe(0);
    expect(clipSeekTargetSec(1_000, 33_500, 250, 32_600)).toBeCloseTo(32.6, 6);
  });

  it('learns what a seek costs from where the last one settled', () => {
    // aimed 250 ms ahead, settled 400 ms behind: the seek really cost 650
    expect(nextSeekLeadMs(CLIP_SEEK_LEAD_MS, -400)).toBe(650);
    // settled 100 ms ahead: it cost 150
    expect(nextSeekLeadMs(CLIP_SEEK_LEAD_MS, 100)).toBe(150);
    expect(nextSeekLeadMs(100, 500)).toBe(0);
    expect(nextSeekLeadMs(1_500, -5_000)).toBe(CLIP_SEEK_LEAD_MAX_MS);
    expect(nextSeekLeadMs(300, Number.NaN)).toBe(300);
  });

  it('converges: the second seek lands inside what speed can fix', () => {
    // A slow device whose seek costs 1.1 s. First seek: lead 250, settles 850 behind (a second
    // seek is needed). Second: lead 1100, settles on the clock.
    const cost = 1_100;
    let lead = CLIP_SEEK_LEAD_MS;
    const first = lead - cost;
    expect(clipNeedsSeek(first)).toBe(true);
    lead = nextSeekLeadMs(lead, first);
    const second = lead - cost;
    expect(clipNeedsSeek(second)).toBe(false);
    expect(Math.abs(second)).toBeLessThanOrEqual(CLIP_SYNC_ENGAGE_MS);
  });
});
