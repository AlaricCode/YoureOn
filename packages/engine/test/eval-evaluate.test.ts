import { describe, expect, it } from 'vitest';
import {
  CREATOR,
  FRIEND,
  THIRD,
  paperBallBuffer,
  paperBallCalibration,
  paperBallProgram,
  paperBallScene,
  q,
} from './eval-fixtures.js';
import { evaluate, evaluateProgram, evaluateSession, evalCost } from '../src/eval/index.js';
import { decodeProgram, encodeCalibration, encodeProgram, encodeTrackBin, isEngineError } from '../src/encode/index.js';
import { marketHash } from '../src/hash/index.js';
import type { Program, SessionTracks, TrackBufferData } from '../src/types.js';
import { MAX_EVAL_COST } from '../src/constants.js';

const VERIFIED_41 = [{ participant: 1, frame: 3 }];

describe('evaluate: paper-ball shot (§15.1)', () => {
  const p = paperBallProgram();
  const c = paperBallCalibration();

  it('pass: success on the first attempt, verified checkpoint', () => {
    const buf = paperBallBuffer(paperBallScene(40, [{ t: 0, make: true }]));
    const r = evaluateProgram(p, c, buf, VERIFIED_41);
    expect(r).toMatchObject({
      status: 'ok',
      reason: 0,
      preruling: 1,
      winner_mask: 2,
      leg_results: [1],
      leg_causes: [[]],
      decisive_frames: [[3, 7]],
      attempts: [{ leg: 0, frame: 3, success_frame: 7 }],
      checkpoints: [{ participant: 1, frame: 3 }],
      n_checkpoints: 1,
    });
    expect(r.cost).toBe(40 * 25);
  });

  it('missing biometric verification ⇒ Unknown (IDENTITY) ⇒ panel', () => {
    const buf = paperBallBuffer(paperBallScene(40, [{ t: 0, make: true }]));
    const r = evaluateProgram(p, c, buf, []);
    expect(r).toMatchObject({ status: 'needs_panel', reason: 10, preruling: 3, winner_mask: 0, leg_results: [2], leg_causes: [['IDENTITY']] });
    expect(r.checkpoints).toEqual([{ participant: 1, frame: 3 }]);
  });

  it('low id_conf at the checkpoint ⇒ IDENTITY', () => {
    const buf = paperBallBuffer(paperBallScene(40, [{ t: 0, make: true }], 59));
    expect(evaluateProgram(p, c, buf, VERIFIED_41).leg_causes).toEqual([['IDENTITY']]);
    const ok = paperBallBuffer(paperBallScene(40, [{ t: 0, make: true }], 60));
    expect(evaluateProgram(p, c, ok, VERIFIED_41).leg_results).toEqual([1]);
  });

  it('fail: three misses ⇒ False, no checkpoints, side 0 wins', () => {
    const buf = paperBallBuffer(paperBallScene(100, [{ t: 0, make: false }, { t: 25, make: false }, { t: 50, make: false }]));
    const r = evaluateProgram(p, c, buf, []);
    expect(r).toMatchObject({ status: 'ok', winner_mask: 1, leg_results: [0], checkpoints: [], n_checkpoints: 0 });
    expect(r.attempts.map((a) => [a.frame, a.success_frame])).toEqual([[3, null], [28, null], [53, null]]);
    expect(r.decisive_frames).toEqual([[3, 28, 53]]);
  });

  it('only the first N attempts count (make on the 4th throw ⇒ False)', () => {
    const throws = [0, 25, 50].map((t) => ({ t, make: false })).concat([{ t: 75, make: true }]);
    const r = evaluateProgram(p, c, paperBallBuffer(paperBallScene(110, throws)), [{ participant: 1, frame: 78 }]);
    expect(r.leg_results).toEqual([0]);
    expect(r.attempts).toHaveLength(3);
  });

  it('make on the 2nd attempt: checkpoint at that attempt frame', () => {
    const r = evaluateProgram(p, c, paperBallBuffer(paperBallScene(70, [{ t: 0, make: false }, { t: 30, make: true }])), [
      { participant: 1, frame: 33 },
    ]);
    expect(r).toMatchObject({ leg_results: [1], winner_mask: 2, checkpoints: [{ participant: 1, frame: 33 }] });
    expect(r.decisive_frames).toEqual([[3, 33, 37]]);
  });

  it('camera motion ⇒ MOTION', () => {
    const buf = paperBallBuffer(paperBallScene(40, [{ t: 0, make: true }]), undefined, 0b11);
    const r = evaluateProgram(p, c, buf, VERIFIED_41);
    expect(r).toMatchObject({ status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['MOTION']] });
  });

  it('low confidence at a decisive frame ⇒ CONF', () => {
    const cols = paperBallScene(40, [{ t: 0, make: true }]);
    cols[1]![7] = { ...cols[1]![7]!, conf: 49 };
    const r = evaluateProgram(p, c, paperBallBuffer(cols), VERIFIED_41);
    expect(r.leg_causes).toEqual([['CONF']]);
    cols[1]![7] = { ...cols[1]![7]!, conf: 50 };
    expect(evaluateProgram(p, c, paperBallBuffer(cols), VERIFIED_41).leg_results).toEqual([1]);
  });

  it('cross-check failure ⇒ reason 12; window unavailable ⇒ reason 13 (early, no causes)', () => {
    const cols = paperBallScene(40, [{ t: 0, make: true }]);
    const r12 = evaluateProgram(p, c, paperBallBuffer(cols, undefined, 0), VERIFIED_41);
    expect(r12).toMatchObject({ status: 'needs_panel', reason: 12, preruling: 3, winner_mask: 0, leg_results: [2], leg_causes: [[]], checkpoints: [], n_checkpoints: 0 });
    const empty: TrackBufferData = { ...paperBallBuffer(cols, undefined, 0b1010), segments: [] };
    const r13 = evaluateProgram(p, c, empty, VERIFIED_41);
    expect(r13).toMatchObject({ status: 'needs_panel', reason: 13, leg_results: [2], leg_causes: [[]] });
    // bit3 wins over a missing bit1
    expect(evaluateProgram(p, c, { ...empty, flags: 0b1000 }, []).reason).toBe(13);
  });

  it('multi-segment buffer gives the same result as the full window', () => {
    const cols = paperBallScene(200, [{ t: 0, make: false }, { t: 120, make: true }]);
    const multi = paperBallBuffer(cols, [[0, 30], [100, 50]]);
    const r = evaluateProgram(p, c, multi, [{ participant: 1, frame: 123 }]);
    expect(r).toMatchObject({ leg_results: [1], winner_mask: 2, checkpoints: [{ participant: 1, frame: 123 }] });
    expect(r.cost).toBe(80 * 25);
  });

  it('cost cap: cost > MAX_EVAL_COST ⇒ reason 13; maxCost option overrides', () => {
    const n = Math.floor(MAX_EVAL_COST / 25) + 1; // 656 frames
    const cols = paperBallScene(n, [{ t: 0, make: true }]);
    const pb = encodeProgram(p);
    const cb = encodeCalibration(c, p);
    const tb = encodeTrackBin(paperBallBuffer(cols));
    const r = evaluate(pb, cb, tb, VERIFIED_41);
    expect(r).toMatchObject({ status: 'needs_panel', reason: 13, leg_results: [2], leg_causes: [[]], cost: n * 25 });
    expect(evaluate(pb, cb, tb, VERIFIED_41, { maxCost: Infinity }).leg_results).toEqual([1]);
    // exactly at the cap is allowed
    const at = paperBallScene(655, [{ t: 0, make: true }]);
    expect(evaluate(pb, cb, encodeTrackBin(paperBallBuffer(at)), VERIFIED_41).cost).toBe(16375);
    expect(evaluate(pb, cb, encodeTrackBin(paperBallBuffer(at)), VERIFIED_41).status).toBe('ok');
  });

  it('evalCost = |F| × Σ weights', () => {
    expect(evalCost(decodeProgram(encodeProgram(p)), 10)).toBe(250);
  });

  it('decode errors propagate as EngineError', () => {
    const pb = encodeProgram(p);
    const bad = pb.slice();
    bad[0] = 0;
    try {
      evaluate(bad, new Uint8Array(), new Uint8Array(), []);
      expect.unreachable();
    } catch (e) {
      expect(isEngineError(e, 'MalformedProgram')).toBe(true);
    }
  });

  it('evaluateSession matches evaluateProgram on a single full segment', () => {
    const cols = paperBallScene(60, [{ t: 0, make: false }, { t: 25, make: true }]);
    const session: SessionTracks = {
      fps: 10,
      n_frames: 60,
      model_hash: '00'.repeat(32),
      flags: 0b10,
      tracks: [
        { entity: 'shooter', entity_idx: 0, participant_idx: 1, ref_h: 6000, frames: cols[0]! },
        { entity: 'ball', entity_idx: 1, participant_idx: null, ref_h: 200, frames: cols[1]! },
        { entity: 'can', entity_idx: 2, participant_idx: null, ref_h: 3200, frames: cols[2]! },
      ],
    };
    const v = [{ participant: 1, frame: 28 }];
    const a = evaluateSession(p, c, session, v);
    const b = evaluateProgram(p, c, paperBallBuffer(cols), v);
    expect(a).toEqual(b);
  });

  it('evaluateSession ignores the cost cap and the frame cap', () => {
    const n = 1500; // > MAX_EVAL_FRAMES, ≤ LIMIT + TAIL (1820)
    const cols = paperBallScene(n, [{ t: 1400, make: true }]);
    const session: SessionTracks = {
      fps: 10,
      n_frames: n,
      model_hash: '00'.repeat(32),
      flags: 0b10,
      tracks: [0, 1, 2].map((i) => ({ entity: String(i), entity_idx: i, participant_idx: i === 0 ? 1 : null, ref_h: 0, frames: cols[i]! })),
    };
    const r = evaluateSession(p, c, session, [{ participant: 1, frame: 1403 }]);
    expect(r).toMatchObject({ status: 'ok', leg_results: [1], cost: n * 25 });
  });
});

// ---------------------------------------------------------------------------

function towerProgram(frames = 100, timeLimit = 30): Program {
  return {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [
      { name: 'tower', kind: 'object', phrase: 'cup tower' },
      { name: 'fan', kind: 'object', phrase: 'fan' },
    ],
    legs: [{ id: 1, actor_bound: false, attempt_window_frames: 50, success: { op: 'intact', a: { e: 'tower' } }, rule: { kind: 'holds', frames } }],
    outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
    stake_each: 2000000,
    time_limit_s: timeLimit,
  };
}

function towerBuf(col: (ReturnType<typeof q> | null)[], segs: [number, number][] = [[0, col.length]]): TrackBufferData {
  return {
    flags: 0b10,
    model_hash: '00'.repeat(32),
    tracks: [{ entity_idx: 0, participant_idx: null, ref_h: 1000 }],
    segments: segs.map(([s, n]) => ({ frame_start: s, frames: col.slice(s, s + n).map((r) => [r]) })),
  };
}

describe('evaluate: cup tower holds (§15.2)', () => {
  const p = towerProgram();
  const c = { version: 1 as const, scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' as const }, entity_refs: [] }, regions: [] };
  const tall = q(4000, 2000, 5000, 3000);
  const short = q(4000, 2500, 5000, 3000);

  it('pass ⇒ creator side wins, winner_mask 1', () => {
    const r = evaluateProgram(p, c, towerBuf(new Array(105).fill(tall)), []);
    expect(r).toMatchObject({ status: 'ok', winner_mask: 1, leg_results: [1], decisive_frames: [[]], checkpoints: [] });
  });

  it('present but short ⇒ False, decisive = first failing frame', () => {
    const col = new Array(105).fill(tall);
    col[60] = short;
    const r = evaluateProgram(p, c, towerBuf(col), []);
    expect(r).toMatchObject({ status: 'ok', winner_mask: 2, leg_results: [0], decisive_frames: [[60]] });
  });

  it('absent at the first failing frame ⇒ OCCLUSION', () => {
    const col = new Array(105).fill(tall);
    col[60] = null;
    col[61] = short;
    const r = evaluateProgram(p, c, towerBuf(col), []);
    expect(r).toMatchObject({ status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['OCCLUSION']] });
  });

  it('recording ends before frame D ⇒ COVERAGE', () => {
    const r = evaluateProgram(p, c, towerBuf(new Array(99).fill(tall)), []);
    expect(r).toMatchObject({ leg_results: [2], leg_causes: [['COVERAGE']] });
    // a gap in the middle is also missing coverage
    const col = new Array(105).fill(tall);
    const r2 = evaluateProgram(p, c, towerBuf(col, [[0, 50], [51, 54]]), []);
    expect(r2.leg_causes).toEqual([['COVERAGE']]);
  });

  it('COVERAGE takes precedence over OCCLUSION', () => {
    const col = new Array(80).fill(tall);
    col[10] = null;
    expect(evaluateProgram(p, c, towerBuf(col), []).leg_causes).toEqual([['COVERAGE']]);
  });

  it('MOTION takes precedence over everything', () => {
    const buf = { ...towerBuf(new Array(50).fill(tall)), flags: 0b11 };
    expect(evaluateProgram(p, c, buf, []).leg_causes).toEqual([['MOTION']]);
  });
});

// ---------------------------------------------------------------------------

function pushupProgram(cmp: '>=' | '>' = '>=', value = 3, rule: Program['legs'][0]['rule'] = { kind: 'before', frames: 600 }): Program {
  return {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [{ name: 'me', kind: 'person', participant: 0 }],
    legs: [{ id: 1, actor_bound: true, attempt_window_frames: 50, success: { op: 'rep_count', a: { e: 'me' }, cmp, value }, rule }],
    outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
    stake_each: 10000000,
    time_limit_s: 90,
  };
}

function repsBuf(poses: number[], idConf = 90): TrackBufferData {
  return {
    flags: 0b10,
    model_hash: '00'.repeat(32),
    tracks: [{ entity_idx: 0, participant_idx: 0, ref_h: 0 }],
    segments: [{ frame_start: 0, frames: poses.map((pose) => [q(1000, 1000, 3000, 9000, { pose, id_conf: idConf })]) }],
  };
}

const EMPTY_CAL = { version: 1 as const, scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' as const }, entity_refs: [] }, regions: [] };

describe('evaluate: push-ups (§15.3)', () => {
  // L H L H L H ⇒ reps 1 at 1, 2 at 3, 3 at 5
  const poses = [2, 4, 2, 4, 2, 4, 1, 1];

  it('success before D: checkpoint at the first frame with ≥ k reps', () => {
    const r = evaluateProgram(pushupProgram(), EMPTY_CAL, repsBuf(poses), [{ participant: 0, frame: 5 }]);
    expect(r).toMatchObject({ status: 'ok', winner_mask: 1, leg_results: [1], decisive_frames: [[5]], checkpoints: [{ participant: 0, frame: 5 }] });
  });

  it('before(D) excludes frames ≥ D', () => {
    const r = evaluateProgram(pushupProgram('>=', 3, { kind: 'before', frames: 5 }), EMPTY_CAL, repsBuf(poses), []);
    expect(r).toMatchObject({ leg_results: [0], winner_mask: 2, checkpoints: [] });
  });

  it('exists rule with a level success that stays true counts once (rising)', () => {
    const p = pushupProgram('>=', 1, { kind: 'count', cmp: '>=', k: 2, attempts: 0 });
    // reps ≥ 1 from frame 1 onwards, continuously ⇒ one rising edge
    const r = evaluateProgram(p, EMPTY_CAL, repsBuf(poses), []);
    expect(r).toMatchObject({ leg_results: [0], decisive_frames: [[1]] });
  });

  it('count without attempts: anchors are the first k\' rising frames', () => {
    const p = pushupProgram('>=', 1, { kind: 'count', cmp: '>', k: 1, attempts: 0 });
    // presence drops make the level signal rise twice
    const buf = repsBuf(poses);
    buf.segments[0]!.frames[3] = [null];
    const r = evaluateProgram(p, EMPTY_CAL, buf, [{ participant: 0, frame: 1 }, { participant: 0, frame: 4 }]);
    expect(r).toMatchObject({ leg_results: [1], decisive_frames: [[1, 4]], checkpoints: [{ participant: 0, frame: 1 }, { participant: 0, frame: 4 }] });
  });

  it('rising at absolute frame 0 counts', () => {
    const p: Program = { ...pushupProgram(), legs: [{ ...pushupProgram().legs[0]!, success: { op: 'present', a: { e: 'me' } }, rule: { kind: 'count', cmp: '>=', k: 1, attempts: 0 } }] };
    const r = evaluateProgram(p, EMPTY_CAL, repsBuf([0, 0]), [{ participant: 0, frame: 0 }]);
    expect(r).toMatchObject({ leg_results: [1], decisive_frames: [[0]], checkpoints: [{ participant: 0, frame: 0 }] });
  });
});

// ---------------------------------------------------------------------------

describe('evaluate: events near the time limit (tail frames)', () => {
  it('signals use tail frames for look-ahead but rules only see F_R', () => {
    const p = paperBallProgram();
    p.time_limit_s = 3; // LIMIT = 30, frames < 50
    const c = paperBallCalibration();
    // throw at t=22: attempt at 25, entry at 29 (< 30) needs look-ahead to 39 (tail)
    const cols = paperBallScene(50, [{ t: 22, make: true }]);
    const r = evaluateProgram(p, c, paperBallBuffer(cols), [{ participant: 1, frame: 25 }]);
    expect(r).toMatchObject({ leg_results: [1], decisive_frames: [[25, 29]] });
    // throw at t=24: entry at 31 ≥ LIMIT ⇒ no success
    const late = evaluateProgram(p, c, paperBallBuffer(paperBallScene(50, [{ t: 24, make: true }])), []);
    expect(late).toMatchObject({ leg_results: [0], attempts: [{ leg: 0, frame: 27, success_frame: null }] });
  });
});

// ---------------------------------------------------------------------------

describe('evaluate: other kinds (§3.11)', () => {
  it('ai_judged ⇒ needs_panel reason 11 regardless of track flags', () => {
    const p: Program = {
      version: 2,
      kind: 'ai_judged',
      participants: [CREATOR, FRIEND],
      sides: [0, 1],
      entities: [],
      legs: [],
      question: 'Does Sam finish the wing?',
      outcome: { if_true: 1, condition: { op: 'yes' }, else: 0 },
      stake_each: 3000000,
      time_limit_s: 120,
    };
    const buf: TrackBufferData = { flags: 0b1, model_hash: '00'.repeat(32), tracks: [], segments: [] };
    const r = evaluateProgram(p, null, buf, []);
    expect(r).toEqual({
      status: 'needs_panel',
      reason: 11,
      preruling: 3,
      winner_mask: 0,
      leg_results: [],
      leg_causes: [],
      decisive_frames: [],
      attempts: [],
      checkpoints: [],
      n_checkpoints: 0,
      cost: 0,
    });
  });

  function marketProgram(): Program {
    const leg = (id: number, event_id: string, side: 'yes' | 'no') => ({
      id,
      actor_bound: false,
      attempt_window_frames: 0,
      market: { venue: 'gemini' as const, event_id, contract_id: 'c1', side, prob_bps: 5000 },
    });
    return {
      version: 2,
      kind: 'market',
      participants: [CREATOR, FRIEND, THIRD],
      sides: [0, 1, 1],
      entities: [],
      legs: [leg(1, 'e1', 'yes'), leg(2, 'e2', 'no')],
      outcome: { if_true: 0, condition: { op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'leg', id: 2 }] }, else: 1 },
      stakes: [1000000, 500000, 500000],
      time_limit_s: 86400,
    };
  }

  it('market: resolved legs, Kleene condition, winner mask over 3 participants', () => {
    const p = marketProgram();
    const h1 = marketHash('e1', 'c1');
    const h2 = marketHash('e2', 'c1');
    expect(evaluateProgram(p, null, [{ market_hash: h1, result: 1 }, { market_hash: h2, result: 0 }], [])).toMatchObject({
      status: 'ok',
      winner_mask: 0b001,
      leg_results: [1, 1],
      leg_causes: [[], []],
    });
    expect(evaluateProgram(p, null, [{ market_hash: h1, result: 0 }, { market_hash: h2, result: 2 }], [])).toMatchObject({
      status: 'ok',
      winner_mask: 0b110,
      leg_results: [0, 2],
      leg_causes: [[], ['VOID']],
    });
  });

  it('market: void or missing entry ⇒ Unknown (VOID) ⇒ panel when the condition is Unknown', () => {
    const p = marketProgram();
    const r = evaluateProgram(p, null, [{ market_hash: marketHash('e1', 'c1'), result: 1 }], []);
    expect(r).toMatchObject({ status: 'needs_panel', reason: 10, preruling: 3, winner_mask: 0, leg_results: [1, 2], leg_causes: [[], ['VOID']] });
  });
});
