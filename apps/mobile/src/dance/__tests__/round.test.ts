// The judge-cam round state machine and its schedules (DANCE-OFF §6.2).
import { describe, expect, it } from 'vitest';

import {
  attemptCountIn,
  ATTEMPT_WAIT_MS,
  beatAt,
  cameraWanted,
  countInBeatIndex,
  countInLabel,
  countInSchedule,
  danceProgress,
  FRAMING_GRACE_MS,
  FRAMING_STABLE_MS,
  framingProgress,
  GO_LABEL_MS,
  initialRound,
  recordingPhase,
  ROUND_TAIL_MS,
  roundConfig,
  roundReducer,
  routineBeatTimes,
  snapshotSchedule,
  SNAPSHOT_COUNT,
  SNAPSHOT_LAG_MS,
  type RoundEvent,
  type RoundState,
} from '../model/round';
import { WAVE_POP } from './helpers';

const cfg = roundConfig(WAVE_POP); // 120 bpm: 500 ms beats, 15 s
const run = (events: RoundEvent[], from: RoundState = initialRound()) =>
  events.reduce((s, e) => roundReducer(s, e, cfg), from);
const ok = (at: number): RoundEvent => ({ type: 'framing', at, ok: true, reason: 'ok' });
const bad = (at: number): RoundEvent => ({ type: 'framing', at, ok: false, reason: 'need_two' });
const okFrames = (from: number, to: number, step = 33) => {
  const out: RoundEvent[] = [];
  for (let t = from; t <= to; t += step) out.push(ok(t));
  return out;
};

/** framing held for a second → ready. */
const ready = () => run([...okFrames(0, 990), ok(FRAMING_STABLE_MS)]);

describe('framing → ready', () => {
  it('starts framing, with no reason yet', () => {
    const s = initialRound();
    expect(s.phase).toBe('framing');
    expect(s.framingReason).toBeNull();
    expect(s.run).toBe(0);
  });

  it('is ready only after framing passed for a full second', () => {
    expect(run(okFrames(0, 990)).phase).toBe('framing');
    expect(ready().phase).toBe('ready');
  });

  it('a tick also completes the hold (frames may be sparse)', () => {
    const s = run([ok(0), ok(200), { type: 'tick', at: 1_000 }]);
    // 800 ms since the last good frame is past the grace: the hold broke.
    expect(s.phase).toBe('framing');
    const t = run([...okFrames(0, 900, 100), { type: 'tick', at: 1_000 }]);
    expect(t.phase).toBe('ready');
  });

  it('a dropout shorter than the grace does not restart the hold', () => {
    const s = run([
      ...okFrames(0, 495),
      bad(520),
      bad(560 + FRAMING_GRACE_MS - 100),
      ...okFrames(733, 1_000),
      ok(1_000),
    ]);
    expect(s.okSince).toBe(0);
    expect(s.phase).toBe('ready');
  });

  it('a longer dropout restarts it', () => {
    const s = run([...okFrames(0, 495), bad(520), bad(495 + FRAMING_GRACE_MS + 10), ok(833)]);
    expect(s.okSince).toBe(833);
    expect(s.phase).toBe('framing');
    expect(run([ok(1_833)], s).phase).toBe('ready');
  });

  it('ready falls back to framing when framing breaks', () => {
    const s = run([bad(1_100), bad(1_000 + FRAMING_GRACE_MS + 50)], ready());
    expect(s.phase).toBe('framing');
    expect(s.framingReason).toBe('need_two');
  });

  it('keeps the latest reason for the copy', () => {
    const s = run([{ type: 'framing', at: 0, ok: false, reason: 'feet' }]);
    expect(s.framingReason).toBe('feet');
  });

  it('reports the hold progress', () => {
    const s = run([ok(0)]);
    expect(framingProgress(s, 500)).toBeCloseTo(0.5);
    expect(framingProgress(s, 5_000)).toBe(1);
    expect(framingProgress(initialRound(), 500)).toBe(0);
    expect(framingProgress(ready(), 0)).toBe(1);
  });
});

describe('start → count-in → dancing → scoring', () => {
  it('Start only works when ready (or forced, for calibration)', () => {
    expect(run([{ type: 'start', at: 10 }]).phase).toBe('framing');
    expect(run([{ type: 'start', at: 10, force: true }]).phase).toBe('starting');
    const s = run([{ type: 'start', at: 1_100 }], ready());
    expect(s.phase).toBe('starting');
    expect(s.startedAt).toBe(1_100);
  });

  it('the attempt starts the count-in; GO is three beats later', () => {
    const s = run(
      [
        { type: 'start', at: 1_100 },
        { type: 'attempt', at: 2_000, attemptNo: 1 },
      ],
      ready(),
    );
    expect(s.phase).toBe('countIn');
    expect(s.attemptNo).toBe(1);
    expect(s.countInAt).toBe(2_000);
    expect(s.goAt).toBe(2_000 + 3 * 500);
  });

  it('a forced attempt (started on another phone) counts in straight from framing', () => {
    // Nobody framed yet, or framing held: either way the judge cam counts in on its own.
    for (const from of [initialRound(), ready()]) {
      const s = run([{ type: 'attempt', at: 2_000, attemptNo: 1, force: true }], from);
      expect(s.phase).toBe('countIn');
      expect(s.attemptNo).toBe(1);
      expect(s.countInAt).toBe(2_000);
      expect(s.startedAt).toBe(2_000);
      expect(s.goAt).toBe(2_000 + 3 * 500);
    }
    // Still never mid-round or after it.
    const counting = run([{ type: 'attempt', at: 2_000, attemptNo: 1, force: true }]);
    expect(run([{ type: 'attempt', at: 2_500, attemptNo: 2, force: true }], counting)).toBe(
      counting,
    );
    const failed = run(
      [
        { type: 'start', at: 1_100 },
        { type: 'start_failed', message: 'x' },
      ],
      ready(),
    );
    expect(failed.phase).toBe('failed');
    expect(run([{ type: 'attempt', at: 2_000, attemptNo: 1, force: true }], failed)).toBe(failed);
  });

  it('runs the routine plus the tail, then scores', () => {
    const counting = run(
      [
        { type: 'start', at: 1_100 },
        { type: 'attempt', at: 2_000, attemptNo: 1 },
      ],
      ready(),
    );
    expect(run([{ type: 'tick', at: 3_499 }], counting).phase).toBe('countIn');
    const dancing = run([{ type: 'tick', at: 3_500 }], counting);
    expect(dancing.phase).toBe('dancing');
    const end = 3_500 + 15_000 + ROUND_TAIL_MS;
    expect(run([{ type: 'tick', at: end - 1 }], dancing).phase).toBe('dancing');
    const scoring = run([{ type: 'tick', at: end }], dancing);
    expect(scoring.phase).toBe('scoring');
    expect(scoring.stopAt).toBe(end);
  });

  it('a refused start fails; so does an attempt that never comes', () => {
    const starting = run([{ type: 'start', at: 1_100 }], ready());
    const refused = run([{ type: 'start_failed', message: 'nope' }], starting);
    expect(refused.phase).toBe('failed');
    expect(refused.error).toBe('start_failed');
    expect(refused.canRetryUpload).toBe(false);
    expect(run([{ type: 'tick', at: 1_100 + ATTEMPT_WAIT_MS }], starting).phase).toBe('starting');
    const late = run([{ type: 'tick', at: 1_101 + ATTEMPT_WAIT_MS }], starting);
    expect(late.error).toBe('no_attempt');
  });

  it('a startRound refusal mid-round fails as a camera problem', () => {
    const dancing = run(
      [
        { type: 'start', at: 1_100 },
        { type: 'attempt', at: 2_000, attemptNo: 1 },
        { type: 'tick', at: 3_500 },
      ],
      ready(),
    );
    const s = run([{ type: 'round_failed', message: 'not running' }], dancing);
    expect(s.phase).toBe('failed');
    expect(s.error).toBe('camera');
    expect(s.message).toBe('not running');
  });

  it('ignores events out of order', () => {
    const s = ready();
    expect(run([{ type: 'attempt', at: 1, attemptNo: 1 }], s)).toBe(s);
    expect(run([{ type: 'scored', ok: true }], s)).toBe(s);
    expect(run([{ type: 'uploaded' }], s)).toBe(s);
    expect(run([{ type: 'round_failed', message: 'x' }], s)).toBe(s);
  });
});

describe('attemptCountIn: which attempt the screen counts in on', () => {
  const base = { phase: 'framing' as const, fresh: true, used: false, waiting: false };

  it('after our own Start: any attempt not used yet', () => {
    const w = { ...base, phase: 'starting' as const, waiting: true };
    expect(attemptCountIn(w)).toBe('count_in');
    // The open attempt given back by "Dance again" (seen before) still counts in.
    expect(attemptCountIn({ ...w, fresh: false })).toBe('count_in');
    expect(attemptCountIn({ ...w, used: true })).toBeNull();
    // Starting but not waiting: the Start effect itself takes the open attempt.
    expect(attemptCountIn({ ...w, waiting: false })).toBeNull();
  });

  it('while framing: a NEW attempt started on another phone, forced', () => {
    expect(attemptCountIn(base)).toBe('forced');
    expect(attemptCountIn({ ...base, phase: 'ready' })).toBe('forced');
    // Open at mount, or given back by "Dance again": wait for Start.
    expect(attemptCountIn({ ...base, fresh: false })).toBeNull();
    expect(attemptCountIn({ ...base, used: true })).toBeNull();
  });

  it('never mid-round, after it or after a failure', () => {
    for (const phase of ['countIn', 'dancing', 'scoring', 'result', 'failed'] as const)
      expect(attemptCountIn({ ...base, phase, waiting: true })).toBeNull();
  });
});

describe('result → upload', () => {
  const scoring = () =>
    run(
      [
        { type: 'start', at: 1_100 },
        { type: 'attempt', at: 2_000, attemptNo: 3 },
        { type: 'tick', at: 3_500 },
        { type: 'tick', at: 3_500 + 15_000 + ROUND_TAIL_MS },
      ],
      ready(),
    );

  it('result, uploading, submitted', () => {
    const result = run([{ type: 'scored', ok: true }], scoring());
    expect(result.phase).toBe('result');
    const uploading = run([{ type: 'upload' }], result);
    expect(uploading.phase).toBe('uploading');
    expect(run([{ type: 'uploaded' }], uploading).phase).toBe('submitted');
  });

  it('a failed upload can be sent again', () => {
    const failed = run(
      [{ type: 'scored', ok: true }, { type: 'upload' }, { type: 'upload_failed', message: '500' }],
      scoring(),
    );
    expect(failed.phase).toBe('failed');
    expect(failed.error).toBe('upload_failed');
    expect(failed.canRetryUpload).toBe(true);
    const again = run([{ type: 'upload' }], failed);
    expect(again.phase).toBe('uploading');
    expect(again.error).toBeNull();
  });

  it('no key frame: failed, nothing to re-send', () => {
    const s = run([{ type: 'scored', ok: false, message: 'no key frame' }], scoring());
    expect(s.phase).toBe('failed');
    expect(s.error).toBe('no_frames');
    expect(run([{ type: 'upload' }], s)).toBe(s);
  });

  it('reset starts a new round', () => {
    const s = run([{ type: 'reset' }], scoring());
    expect(s).toEqual(initialRound(1));
  });

  it('the camera stays on until the result; frames are recorded from the count-in', () => {
    expect(cameraWanted('framing')).toBe(true);
    expect(cameraWanted('scoring')).toBe(true);
    expect(cameraWanted('result')).toBe(false);
    expect(recordingPhase('countIn')).toBe(true);
    expect(recordingPhase('dancing')).toBe(true);
    expect(recordingPhase('scoring')).toBe(false);
  });
});

describe('count-in', () => {
  it('three beats on the routine tempo, GO one beat after the last', () => {
    expect(countInSchedule(1_000, 500)).toEqual({
      beats: [
        { at: 1_000, label: '3' },
        { at: 1_500, label: '2' },
        { at: 2_000, label: '1' },
      ],
      goAt: 2_500,
    });
    const slow = countInSchedule(0, 60_000 / 112);
    expect(slow.goAt).toBeCloseTo((3 * 60_000) / 112);
  });

  it('labels the numeral by beat, then GO just after t0', () => {
    const s = { phase: 'countIn' as const, countInAt: 1_000, goAt: 2_500 };
    expect(countInLabel(s, 1_000, 500)).toBe('3');
    expect(countInLabel(s, 1_499, 500)).toBe('3');
    expect(countInLabel(s, 1_500, 500)).toBe('2');
    expect(countInLabel(s, 2_400, 500)).toBe('1');
    expect(countInLabel(s, 2_500, 500)).toBe('GO');
    const d = { phase: 'dancing' as const, countInAt: 1_000, goAt: 2_500 };
    expect(countInLabel(d, 2_500 + GO_LABEL_MS - 1, 500)).toBe('GO');
    expect(countInLabel(d, 2_500 + GO_LABEL_MS, 500)).toBeNull();
    expect(countInLabel({ phase: 'ready', countInAt: null, goAt: null }, 0, 500)).toBeNull();
  });

  it('beat index for the haptic', () => {
    expect(countInBeatIndex(1_000, 900, 500)).toBe(-1);
    expect(countInBeatIndex(1_000, 1_000, 500)).toBe(0);
    expect(countInBeatIndex(1_000, 2_200, 500)).toBe(2);
    expect(countInBeatIndex(1_000, 9_000, 500)).toBe(2);
  });
});

describe('routine beats and progress', () => {
  it('beats run from first_beat_ms to the end', () => {
    const beats = routineBeatTimes(WAVE_POP);
    expect(beats[0]).toBe(WAVE_POP.first_beat_ms);
    expect(beats[1]! - beats[0]!).toBe(500);
    expect(beats.at(-1)!).toBeLessThanOrEqual(15_000);
    expect(beats.length).toBe(Math.floor((15_000 - WAVE_POP.first_beat_ms) / 500) + 1);
  });

  it('beatAt gives the beat and how long ago it hit', () => {
    expect(beatAt(WAVE_POP, WAVE_POP.first_beat_ms - 1)).toBeNull();
    expect(beatAt(WAVE_POP, WAVE_POP.first_beat_ms + 760)).toEqual({ index: 1, sinceMs: 260 });
    expect(beatAt(WAVE_POP, 15_001)).toBeNull();
  });

  it('danceProgress', () => {
    const s = { phase: 'dancing' as const, goAt: 1_000 };
    expect(danceProgress(s, 1_000, 15_000)).toBe(0);
    expect(danceProgress(s, 8_500, 15_000)).toBeCloseTo(0.5);
    expect(danceProgress(s, 99_000, 15_000)).toBe(1);
    expect(danceProgress({ phase: 'scoring', goAt: 1_000 }, 0, 15_000)).toBe(1);
  });
});

describe('snapshot schedule', () => {
  it('four key moves spread over the routine, a touch after their beat', () => {
    const times = snapshotSchedule(WAVE_POP);
    expect(times).toHaveLength(SNAPSHOT_COUNT);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    const keyTimes = new Set(WAVE_POP.key_moves.map((m) => m.t + SNAPSHOT_LAG_MS));
    for (const t of times) {
      expect(keyTimes.has(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(WAVE_POP.duration_ms);
    }
    // Spread: one per quarter of the move list.
    expect(times[0]!).toBeLessThan(5_000);
    expect(times[3]!).toBeGreaterThan(10_000);
  });

  it('falls back to evenly spread times with too few key moves', () => {
    const r = { key_moves: [{ id: 'a', t: 1_000, name: 'A' }], duration_ms: 15_000 as const };
    expect(snapshotSchedule(r)).toEqual([1_875, 5_625, 9_375, 13_125]);
  });

  it('never schedules past the end', () => {
    const r = {
      key_moves: Array.from({ length: 8 }, (_, i) => ({ id: `k${i}`, t: 14_950, name: 'x' })),
      duration_ms: 15_000 as const,
    };
    expect(snapshotSchedule(r)).toEqual([14_999]);
  });
});
