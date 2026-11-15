import { describe, expect, it } from 'vitest';
import { extractDecisiveWindows, simulate, type ExtractAttempt } from '../src/perception/index.js';
import { clampAndMerge } from '../src/perception/windows.js';
import { evaluateProgram, evaluateSession } from '../src/eval/index.js';
import { buildPayload, encodeCalibration, encodeProgram, encodeTrackBin } from '../src/encode/index.js';
import {
  AI_JUDGED_TRACK_FLAGS,
  MAX_BUFFER_PAYLOAD,
  MAX_EVAL_COST,
  MAX_EVAL_FRAMES,
  MAX_SEGMENTS,
  TAIL_FRAMES,
} from '../src/constants.js';
import type { Calibration, MockScenario, Program, QFrame, SessionTracks, TrackBufferData } from '../src/types.js';
import { CREATOR, EXAMPLES, FRIEND, cupTower, cupTowerCalibration, paperBall, paperBallCalibration } from './perception-fixtures.js';

const sealed = (s: SessionTracks): SessionTracks => ({ ...s, flags: s.flags | 0b10 });

function checkPostCondition(p: Program, c: Calibration | null, s: SessionTracks, buf: TrackBufferData): void {
  const full = evaluateSession(p, c, s, []);
  const verified = full.checkpoints;
  const fullV = evaluateSession(p, c, s, verified);
  const r = evaluateProgram(p, c, buf, verified);
  expect(r.leg_results).toEqual(fullV.leg_results);
  expect(r.winner_mask).toBe(fullV.winner_mask);
  expect(r.checkpoints).toEqual(fullV.checkpoints);
  expect(r.cost).toBeLessThanOrEqual(MAX_EVAL_COST);
  expect(buf.segments.length).toBeGreaterThan(0);
  expect(buf.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
  expect(buf.segments.reduce((n, sg) => n + sg.frames.length, 0)).toBeLessThanOrEqual(MAX_EVAL_FRAMES);
  const payload = buildPayload(encodeProgram(p), encodeCalibration(c, p), encodeTrackBin(buf));
  expect(payload.length).toBeLessThanOrEqual(MAX_BUFFER_PAYLOAD);
  const last = buf.segments[buf.segments.length - 1]!;
  expect(last.frame_start + last.frames.length).toBeLessThanOrEqual(p.time_limit_s * 10 + TAIL_FRAMES);
}

function extractWithCheckpoints(p: Program, c: Calibration | null, s: SessionTracks, trace?: ExtractAttempt[]): TrackBufferData | null {
  const verified = evaluateSession(p, c, s, []).checkpoints;
  return extractDecisiveWindows(p, c, s, verified, trace);
}

/** Insert `k` frames at `at`, copying every track's record at `at` except `blank` entities (absent). */
function insertFrames(s: SessionTracks, at: number, k: number, blank: string[]): SessionTracks {
  return {
    ...s,
    n_frames: s.n_frames + k,
    tracks: s.tracks.map((t) => {
      const filler: (QFrame | null)[] = Array.from({ length: k }, () => (blank.includes(t.entity) ? null : t.frames[at] ?? null));
      return { ...t, frames: [...t.frames.slice(0, at), ...filler, ...t.frames.slice(at)] };
    }),
  };
}

describe('clampAndMerge', () => {
  it('clamps to [0, end) and merges gaps < 10 frames only', () => {
    expect(clampAndMerge([{ lo: -20, hi: 5 }], 100)).toEqual([{ lo: 0, hi: 5 }]);
    expect(clampAndMerge([{ lo: 90, hi: 130 }], 100)).toEqual([{ lo: 90, hi: 99 }]);
    expect(clampAndMerge([{ lo: 120, hi: 130 }], 100)).toEqual([]);
    // gap of 9 uncovered frames (11..19) merges; gap of 10 (11..20) does not.
    expect(clampAndMerge([{ lo: 0, hi: 10 }, { lo: 20, hi: 30 }], 100)).toEqual([{ lo: 0, hi: 30 }]);
    expect(clampAndMerge([{ lo: 0, hi: 10 }, { lo: 21, hi: 30 }], 100)).toEqual([{ lo: 0, hi: 10 }, { lo: 21, hi: 30 }]);
    expect(clampAndMerge([{ lo: 50, hi: 60 }, { lo: 0, hi: 70 }, { lo: 55, hi: 58 }], 100)).toEqual([{ lo: 0, hi: 70 }]);
  });
});

describe('extractDecisiveWindows (§6.5)', () => {
  it('§15.2: holds(10s) passes with exactly frames [0, 105) — 1,260 B of records', () => {
    const p = cupTower();
    const s = sealed(simulate(p, cupTowerCalibration, 'pass', 1).a);
    const buf = extractWithCheckpoints(p, cupTowerCalibration, s)!;
    expect(buf.segments).toHaveLength(1);
    expect(buf.segments[0]!.frame_start).toBe(0);
    expect(buf.segments[0]!.frames).toHaveLength(105);
    expect(buf.tracks).toEqual([{ entity_idx: 0, participant_idx: null, ref_h: s.tracks[0]!.ref_h }]);
    checkPostCondition(p, cupTowerCalibration, s, buf);
  });

  it('§15.1: windows around attempts and the success, track table = entities 0,1,2', () => {
    const p = paperBall();
    const s = sealed(simulate(p, paperBallCalibration, 'pass', 1).a);
    const buf = extractWithCheckpoints(p, paperBallCalibration, s)!;
    expect(buf.tracks.map((t) => [t.entity_idx, t.participant_idx])).toEqual([
      [0, 1],
      [1, null],
      [2, null],
    ]);
    const full = evaluateSession(p, paperBallCalibration, s, []);
    const covered = (f: number) => buf.segments.some((sg) => f >= sg.frame_start && f < sg.frame_start + sg.frames.length);
    for (const f of full.decisive_frames[0]!) {
      expect(covered(f - 20)).toBe(true);
      expect(covered(f + 20)).toBe(true);
    }
    checkPostCondition(p, paperBallCalibration, s, buf);
  });

  it('produces a multi-segment buffer when attempts are far apart', () => {
    const p = paperBall();
    const base = sealed(simulate(p, paperBallCalibration, 'pass', 1).a);
    const s = insertFrames(base, 50, 300, ['ball']);
    const buf = extractWithCheckpoints(p, paperBallCalibration, s)!;
    expect(buf.segments.length).toBe(2);
    expect(buf.segments[1]!.frame_start).toBeGreaterThan(300);
    checkPostCondition(p, paperBallCalibration, s, buf);
  });

  it('widens the windows when the first plan does not reproduce the result', () => {
    const p: Program = {
      ...cupTower(),
      legs: [
        {
          id: 1,
          actor_bound: false,
          attempt_window_frames: 50,
          success: { op: 'for_duration', frames: 30, arg: { op: 'present', a: { e: 'tower' } } },
          rule: { kind: 'before', frames: 135 },
        },
      ],
    };
    const s = sealed(simulate(cupTower(), cupTowerCalibration, 'pass', 1).a);
    const late: SessionTracks = { ...s, tracks: s.tracks.map((t) => ({ ...t, frames: t.frames.map((r, f) => (f < 100 ? null : r)) })) };
    expect(evaluateSession(p, cupTowerCalibration, late, []).decisive_frames).toEqual([[129]]);
    const trace: ExtractAttempt[] = [];
    const buf = extractWithCheckpoints(p, cupTowerCalibration, late, trace)!;
    expect(trace.map((t) => t.ok)).toEqual([false, true]);
    expect(trace[0]!.reason).toBe('result differs from full session');
    expect(trace[0]!.windows).toEqual([{ lo: 109, hi: 149 }]);
    expect(trace[1]!.windows).toEqual([{ lo: 89, hi: 169 }]);
    checkPostCondition(p, cupTowerCalibration, late, buf);
  });

  it('an event within 1 s of the time limit keeps its look-ahead in the tail frames', () => {
    const base = sealed(simulate(paperBall(), paperBallCalibration, 'pass', 1).a);
    const full180 = evaluateSession(paperBall(), paperBallCalibration, base, []);
    const [, a2, s2] = full180.decisive_frames[0]!;
    // Shift so the success lands 2 frames before LIMIT = 70 (7 s), with disappears_into
    // looking 10 frames ahead into the tail.
    const shift = 68 - s2!;
    const s = shift > 0 ? insertFrames(base, 0, shift, ['ball']) : base;
    const p7 = { ...paperBall(), time_limit_s: 7 };
    const cps = evaluateSession(p7, paperBallCalibration, s, []).checkpoints;
    const r7 = evaluateSession(p7, paperBallCalibration, s, cps);
    expect(r7.leg_results).toEqual([1]);
    expect(r7.attempts[1]!.success_frame).toBe(68);
    const buf = extractWithCheckpoints(p7, paperBallCalibration, s)!;
    const last = buf.segments[buf.segments.length - 1]!;
    expect(last.frame_start + last.frames.length).toBe(90); // clamped to LIMIT + TAIL_FRAMES
    checkPostCondition(p7, paperBallCalibration, s, buf);

    // Push the success past the limit while the attempt stays inside: leg False.
    const later = insertFrames(s, 0, 5, ['ball']);
    expect(a2! + shift + 5).toBeLessThan(70);
    const rLate = evaluateSession(p7, paperBallCalibration, later, []);
    expect(rLate.leg_results).toEqual([0]);
    const bufLate = extractWithCheckpoints(p7, paperBallCalibration, later)!;
    checkPostCondition(p7, paperBallCalibration, later, bufLate);
  });

  it('returns null when nothing fits: widening ×3, then full coverage (paper-ball oversize)', () => {
    const p = paperBall();
    const s = sealed(simulate(p, paperBallCalibration, 'oversize', 1).a);
    const trace: ExtractAttempt[] = [];
    expect(extractWithCheckpoints(p, paperBallCalibration, s, trace)).toBeNull();
    expect(trace).toHaveLength(5);
    expect(trace.every((t) => !t.ok)).toBe(true);
    expect(trace[4]!.windows).toEqual([{ lo: 0, hi: Math.min(s.n_frames, 1820) - 1 }]);
  });

  it('a session already flagged window_unavailable yields null', () => {
    const p = cupTower();
    const s = simulate(p, cupTowerCalibration, 'pass', 1).a;
    expect(extractDecisiveWindows(p, cupTowerCalibration, { ...s, flags: 0b1010 }, [])).toBeNull();
  });

  it('ai_judged gets the minimal track_bin; market has none', () => {
    const ai: Program = {
      version: 2, kind: 'ai_judged', participants: [CREATOR, FRIEND], sides: [0, 1], entities: [], legs: [],
      question: 'Does Sam finish the wing?', outcome: { if_true: 1, condition: { op: 'yes' }, else: 0 }, stake_each: 3000000, time_limit_s: 120,
    };
    const empty: SessionTracks = { fps: 10, n_frames: 0, model_hash: '11'.repeat(32), flags: 0, tracks: [] };
    const buf = extractDecisiveWindows(ai, null, empty, [])!;
    expect(buf).toEqual({ flags: AI_JUDGED_TRACK_FLAGS, model_hash: '11'.repeat(32), tracks: [], segments: [] });
    expect(encodeTrackBin(buf).length).toBe(44);
    const market = { ...ai, kind: 'market' as const };
    expect(extractDecisiveWindows(market, null, empty, [])).toBeNull();
  });

  it('empty sessions yield null', () => {
    const p = cupTower();
    const s = simulate(p, cupTowerCalibration, 'pass', 1).a;
    expect(extractDecisiveWindows(p, cupTowerCalibration, { ...s, n_frames: 0, tracks: s.tracks.map((t) => ({ ...t, frames: [] })) }, [])).toBeNull();
  });

  const scenarios: MockScenario[] = ['pass', 'fail', 'motion', 'low_conf', 'no_identity', 'occlusion'];
  for (const ex of EXAMPLES) {
    for (const sc of scenarios) {
      it(`post-condition holds: ${ex.name} / ${sc}`, () => {
        const s = sealed(simulate(ex.program, ex.calibration, sc, 3).a);
        const buf = extractWithCheckpoints(ex.program, ex.calibration, s);
        expect(buf).not.toBeNull();
        checkPostCondition(ex.program, ex.calibration, s, buf!);
      });
    }
  }

  it('push-ups fail: before(D) raw False covers [0, D)', () => {
    const ex = EXAMPLES[2];
    const s = sealed(simulate(ex.program, ex.calibration, 'fail', 1).a);
    const buf = extractWithCheckpoints(ex.program, ex.calibration, s)!;
    expect(buf.segments[0]!.frame_start).toBe(0);
    expect(buf.segments[0]!.frames.length).toBeGreaterThanOrEqual(600);
  });
});
