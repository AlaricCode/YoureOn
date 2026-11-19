// Two phones, one instant (DANCE-OFF §6.2): the server's go_at → each phone's round clock, the
// recorder's count-in, the display's phases, and the clip's drift check.
import { getRoutine } from '@youre-on/shared/dance/routine';
import { describe, expect, it } from 'vitest';

import {
  COUNT_IN_BEATS,
  countInLabel,
  initialRound,
  roundConfig,
  roundReducer,
} from '../model/round';
import {
  CLIP_DRIFT_MAX_MS,
  clipDriftMs,
  clipPositionSec,
  displayPhase,
  RECORDER_MIN_LEAD_MS,
  recorderCountIn,
  roundTimeline,
  serverIsoToLocalMs,
  serverToLocalMs,
  type ClockReading,
} from '../model/schedule';

const LONG = getRoutine('bye-bye-shuffle')!;
const SHORT = getRoutine('wave-pop')!;
const GO_AT_ISO = '2026-11-21T18:07:00.000Z';
const GO_AT = Date.parse(GO_AT_ISO);

/**
 * A phone at true server time `serverNow`: its wall clock is `wallSkew` ms off the server's, its
 * offset estimate is off by `syncError` ms, and its monotonic clock reads an arbitrary origin.
 */
const phone = (
  serverNow: number,
  wallSkew: number,
  syncError: number,
  monoOrigin: number,
): ClockReading => ({
  // offset = server − wall, as Clock.sync estimates it (wrong by syncError).
  offsetMs: -wallSkew + syncError,
  wallNow: serverNow + wallSkew,
  monoNow: monoOrigin + (serverNow - GO_AT),
});

describe('server go_at → this phone’s round clock', () => {
  it('maps a server instant through the offset onto the monotonic clock', () => {
    // Wall clock 4 s ahead of the server (offset −4000), round clock at 10 000 now.
    const c: ClockReading = { offsetMs: -4_000, wallNow: GO_AT + 4_000 - 2_500, monoNow: 10_000 };
    // go_at is 2.5 s away on the server's clock: 12 500 on the round clock.
    expect(serverToLocalMs(GO_AT, c)).toBe(12_500);
    expect(serverIsoToLocalMs(GO_AT_ISO, c)).toBe(12_500);
    expect(serverIsoToLocalMs('not a time', c)).toBeNull();
  });

  it('is the same instant on two phones with different wall clocks and round clocks', () => {
    // 2.6 s before go_at on the server. The recorder's wall clock is 37 s fast, the display's
    // 1.2 s slow; their monotonic clocks started at unrelated times.
    const serverNow = GO_AT - 2_600;
    const rec = phone(serverNow, 37_000, 0, 5_000_000);
    const dis = phone(serverNow, -1_200, 0, 42);
    const recGo = serverToLocalMs(GO_AT, rec);
    const disGo = serverToLocalMs(GO_AT, dis);
    // Each lands 2.6 s from its own "now": the same physical instant.
    expect(recGo - rec.monoNow).toBe(2_600);
    expect(disGo - dis.monoNow).toBe(2_600);
  });

  it('disagrees by exactly the difference of the two phones’ clock-sync errors', () => {
    const serverNow = GO_AT - 3_000;
    const rec = phone(serverNow, 500, 40, 1_000);
    const dis = phone(serverNow, -800, -25, 9_000);
    const recLead = serverToLocalMs(GO_AT, rec) - rec.monoNow;
    const disLead = serverToLocalMs(GO_AT, dis) - dis.monoNow;
    // An offset that overestimates the server's lead by e makes go_at land e ms early.
    expect(recLead).toBe(3_000 - 40);
    expect(disLead).toBe(3_000 + 25);
    expect(Math.abs(recLead - disLead)).toBe(65);
  });

  it('the timeline: the count-in from go_at, t0 three beats later, the end one routine later', () => {
    const cfg = roundConfig(LONG);
    const tl = roundTimeline(12_500, cfg);
    expect(tl.countInAt).toBe(12_500);
    expect(tl.goAt).toBeCloseTo(12_500 + COUNT_IN_BEATS * (60_000 / 172.6), 9);
    expect(tl.endAt).toBeCloseTo(tl.goAt + 32_600, 9);
    // Both phones build it from the same go_at and the same routine: the same t0 on each clock.
    const short = roundTimeline(0, roundConfig(SHORT));
    expect(short.goAt).toBe(COUNT_IN_BEATS * (60_000 / SHORT.bpm));
  });
});

describe('the recorder’s count-in', () => {
  const beat = 60_000 / 172.6;

  it('starts on go_at while t0 can still be met: in step with the display', () => {
    // POST /attempts answered 300 ms after the server stamped go_at = now + 3 s.
    expect(recorderCountIn(10_000, 7_300, beat)).toEqual({ countInAt: 10_000, synced: true });
    // Already inside the count-in (a slow attempt.started): it joins mid-count, still in step.
    const t0 = 10_000 + COUNT_IN_BEATS * beat;
    expect(recorderCountIn(10_000, t0 - RECORDER_MIN_LEAD_MS, beat)).toEqual({
      countInAt: 10_000,
      synced: true,
    });
  });

  it('counts in from now when go_at is gone or too close to t0 (and says it is not in step)', () => {
    const t0 = 10_000 + COUNT_IN_BEATS * beat;
    expect(recorderCountIn(10_000, t0 - RECORDER_MIN_LEAD_MS + 1, beat)).toEqual({
      countInAt: t0 - RECORDER_MIN_LEAD_MS + 1,
      synced: false,
    });
    // "Dance again" on an attempt whose go_at is long past.
    expect(recorderCountIn(10_000, 60_000, beat)).toEqual({ countInAt: 60_000, synced: false });
    // The calibration screen: no attempt, no go_at.
    expect(recorderCountIn(null, 5_000, beat)).toEqual({ countInAt: 5_000, synced: false });
    expect(recorderCountIn(Number.NaN, 5_000, beat)).toEqual({ countInAt: 5_000, synced: false });
  });

  it('the round reducer counts in from that instant: t0 = go_at + 3 beats, a pure function of it', () => {
    const cfg = roundConfig(LONG);
    const starting = roundReducer(initialRound(), { type: 'start', at: 1_000, force: true }, cfg);
    const plan = recorderCountIn(10_000, 7_300, cfg.beatMs);
    const s = roundReducer(
      starting,
      { type: 'attempt', at: 7_300, attemptNo: 1, countInAt: plan.countInAt },
      cfg,
    );
    expect(s.phase).toBe('countIn');
    expect(s.countInAt).toBe(10_000);
    expect(s.goAt).toBe(roundTimeline(10_000, cfg).goAt);
    // Whenever the attempt arrived, the same go_at gives the same t0.
    const later = roundReducer(
      starting,
      { type: 'attempt', at: 9_000, attemptNo: 1, countInAt: 10_000 },
      cfg,
    );
    expect(later.goAt).toBe(s.goAt);
    // Waiting for go_at: no numeral yet; then 3, 2, 1 on the beat; dancing at t0.
    expect(countInLabel(s, 9_999, cfg.beatMs)).toBeNull();
    expect(countInLabel(s, 10_000, cfg.beatMs)).toBe('3');
    expect(countInLabel(s, 10_000 + 1.5 * cfg.beatMs, cfg.beatMs)).toBe('2');
    expect(countInLabel(s, 10_000 + 2.5 * cfg.beatMs, cfg.beatMs)).toBe('1');
    expect(roundReducer(s, { type: 'tick', at: s.goAt! - 1 }, cfg).phase).toBe('countIn');
    expect(roundReducer(s, { type: 'tick', at: s.goAt! }, cfg).phase).toBe('dancing');
  });
});

describe('the display phone', () => {
  const tl = roundTimeline(10_000, roundConfig(SHORT));

  it('waits, counts in, plays the routine, then is done', () => {
    expect(displayPhase(null, 0)).toBe('waiting');
    expect(displayPhase(tl, 9_999)).toBe('waiting');
    expect(displayPhase(tl, 10_000)).toBe('countIn');
    expect(displayPhase(tl, tl.goAt - 1)).toBe('countIn');
    expect(displayPhase(tl, tl.goAt)).toBe('playing');
    expect(displayPhase(tl, tl.endAt - 1)).toBe('playing');
    expect(displayPhase(tl, tl.endAt)).toBe('done');
  });

  it('the clip position: 0 until t0, then the time since it (a late display seeks in)', () => {
    expect(clipPositionSec(5_000, 4_000)).toBe(0);
    expect(clipPositionSec(5_000, 5_000)).toBe(0);
    expect(clipPositionSec(5_000, 7_250)).toBe(2.25);
  });

  it('the drift check: nothing before t0, + when the clip runs ahead of the clock', () => {
    expect(clipDriftMs(5_000, 4_999, 0)).toBeNull();
    expect(clipDriftMs(5_000, 7_000, 2.0)).toBe(0);
    expect(clipDriftMs(5_000, 7_000, 2.2)).toBeCloseTo(200, 9);
    expect(clipDriftMs(5_000, 7_000, 1.9)).toBeCloseTo(-100, 9);
    expect(CLIP_DRIFT_MAX_MS).toBeGreaterThanOrEqual(100);
  });
});
