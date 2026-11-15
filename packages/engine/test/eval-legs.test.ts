import { describe, expect, it } from 'vitest';
import { CREATOR, FRIEND, THIRD, q } from './eval-fixtures.js';
import { evaluateProgram } from '../src/eval/index.js';
import { evaluateDecoded } from '../src/eval/core.js';
import { evalCond, kAnd, kNot, kOr, winnerMask } from '../src/eval/outcome.js';
import { mergeCheckpoints } from '../src/eval/identity.js';
import { decodeProgram, encodeProgram } from '../src/encode/index.js';
import type { Calibration, LegValue, Program, QFrame, Rule, TrackBufferData } from '../src/types.js';

const CAL: Calibration = { version: 1, scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' }, entity_refs: [] }, regions: [] };
const BOX = q(1000, 1000, 2000, 2000);

/** Two objects a, b; leg: valid_attempt = present(a), success = present(b). */
function abProgram(rule: Rule, W = 5, withVa = true): Program {
  return {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [
      { name: 'a', kind: 'object', phrase: 'a' },
      { name: 'b', kind: 'object', phrase: 'b' },
    ],
    legs: [
      {
        id: 1,
        actor_bound: false,
        attempt_window_frames: W,
        ...(withVa ? { valid_attempt: { op: 'present' as const, a: { e: 'a' } } } : {}),
        success: { op: 'present', a: { e: 'b' } },
        rule,
      },
    ],
    outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
    stake_each: 10000,
    time_limit_s: 60,
  };
}

/** Records for tracks a and b ('1' = present); an empty `a` means only b is tracked (no valid_attempt). */
function abBuf(a: string, b: string, conf: (f: number) => number = () => 90): TrackBufferData {
  const onlyB = a === '';
  const frames: (QFrame | null)[][] = [];
  for (let f = 0; f < b.length; f++) {
    const rb = b[f] === '1' ? { ...BOX, conf: conf(f) } : null;
    frames.push(onlyB ? [rb] : [a[f] === '1' ? { ...BOX, conf: conf(f) } : null, rb]);
  }
  const tb = { entity_idx: 1, participant_idx: null, ref_h: 0 };
  return {
    flags: 0b10,
    model_hash: '00'.repeat(32),
    tracks: onlyB ? [tb] : [{ entity_idx: 0, participant_idx: null, ref_h: 0 }, tb],
    segments: [{ frame_start: 0, frames }],
  };
}

describe('count with attempts (§3.7)', () => {
  const rule: Rule = { kind: 'count', cmp: '>=', k: 2, attempts: 3 };

  it('attempt windows end at the next attempt (overlap) or after W frames', () => {
    const a = '100100000010000000';
    const b = '000010000000000010';
    const r = evaluateProgram(abProgram(rule), CAL, abBuf(a, b), []);
    expect(r.attempts).toEqual([
      { leg: 0, frame: 0, success_frame: null },
      { leg: 0, frame: 3, success_frame: 4 },
      { leg: 0, frame: 10, success_frame: null },
    ]);
    expect(r).toMatchObject({ leg_results: [0], decisive_frames: [[0, 3, 4, 10]] });
  });

  it('success rising in a previous attempt window does not count for the next one', () => {
    // b rises at 2, inside attempt 1's window [0, 3); attempt 2 at 3 needs its own rising edge
    const r = evaluateProgram(abProgram(rule), CAL, abBuf('1001000000', '0011111111'), []);
    expect(r.attempts.map((x) => x.success_frame)).toEqual([2, null]);
    expect(r.leg_results).toEqual([0]);
  });

  it('a level success that stays true across attempts counts only once', () => {
    const r = evaluateProgram(abProgram(rule), CAL, abBuf('1010100000', '0111111111'), []);
    expect(r.attempts.map((x) => x.success_frame)).toEqual([1, null, null]);
  });

  it('success at the attempt frame itself counts; decisive frames are deduplicated', () => {
    const r = evaluateProgram(abProgram({ kind: 'count', cmp: '>=', k: 1, attempts: 1 }), CAL, abBuf('1000', '1000'), []);
    expect(r).toMatchObject({ leg_results: [1], decisive_frames: [[0]], attempts: [{ leg: 0, frame: 0, success_frame: 0 }] });
  });

  it('the window W is exclusive (s < a + W)', () => {
    const p = abProgram({ kind: 'count', cmp: '>=', k: 1, attempts: 1 }, 3);
    expect(evaluateProgram(p, CAL, abBuf('100000', '000100'), []).leg_results).toEqual([0]);
    expect(evaluateProgram(p, CAL, abBuf('100000', '001000'), []).leg_results).toEqual([1]);
  });

  it('CONF is checked at every decisive frame for entities in valid_attempt and success', () => {
    const r = evaluateProgram(abProgram(rule), CAL, abBuf('100100000010000000', '000010000000000010', (f) => (f === 10 ? 40 : 90)), []);
    expect(r).toMatchObject({ leg_results: [2], leg_causes: [['CONF']] });
    // a low-confidence frame that is not decisive does not matter
    const r2 = evaluateProgram(abProgram(rule), CAL, abBuf('100100000010000000', '000010000000000010', (f) => (f === 11 ? 40 : 90)), []);
    expect(r2.leg_causes).toEqual([[]]);
  });
});

describe('exists / never / before / count (§3.7)', () => {
  it('exists and never are complementary with the same decisive frame', () => {
    const ex = evaluateProgram(abProgram({ kind: 'exists' }, 5, false), CAL, abBuf('', '0011'), []);
    expect(ex).toMatchObject({ leg_results: [1], decisive_frames: [[2]] });
    const nv = evaluateProgram(abProgram({ kind: 'never' }, 5, false), CAL, abBuf('', '0011'), []);
    expect(nv).toMatchObject({ leg_results: [0], decisive_frames: [[2]] });
    const nv2 = evaluateProgram(abProgram({ kind: 'never' }, 5, false), CAL, abBuf('', '0000'), []);
    expect(nv2).toMatchObject({ leg_results: [1], decisive_frames: [[]] });
  });

  it('count without attempts uses every comparison', () => {
    const b = '0101010'; // 3 rising edges
    const res = (cmp: Extract<Rule, { kind: 'count' }>['cmp'], k: number): LegValue[] =>
      evaluateProgram(abProgram({ kind: 'count', cmp, k, attempts: 0 }, 5, false), CAL, abBuf('', b), []).leg_results;
    expect(res('>=', 3)).toEqual([1]);
    expect(res('>', 3)).toEqual([0]);
    expect(res('==', 3)).toEqual([1]);
    expect(res('!=', 3)).toEqual([0]);
    expect(res('<', 4)).toEqual([1]);
    expect(res('<=', 2)).toEqual([0]);
  });

  it('frames ≥ LIMIT are ignored by rules', () => {
    const p = abProgram({ kind: 'exists' }, 5, false);
    p.time_limit_s = 1; // LIMIT = 10
    const b = '0000000000' + '1111111111';
    const r = evaluateProgram(p, CAL, abBuf('', b), []);
    expect(r.leg_results).toEqual([0]);
  });
});

describe('identity guard: more than MAX_CHECKPOINTS', () => {
  function flickerProgram(): Program {
    return {
      version: 2,
      kind: 'rules',
      participants: [CREATOR, FRIEND],
      sides: [0, 1],
      entities: [{ name: 'me', kind: 'person', participant: 1 }],
      legs: [{ id: 1, actor_bound: true, attempt_window_frames: 50, success: { op: 'present', a: { e: 'me' } }, rule: { kind: 'count', cmp: '>=', k: 8, attempts: 0 } }],
      outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
      stake_each: 10000,
      time_limit_s: 60,
    };
  }
  function flickerBuf(n: number): TrackBufferData {
    const frames: (QFrame | null)[][] = [];
    for (let f = 0; f < 2 * n; f++) frames.push([f % 2 === 0 ? { ...BOX, id_conf: 90 } : null]);
    return { flags: 0b10, model_hash: '00'.repeat(32), tracks: [{ entity_idx: 0, participant_idx: 1, ref_h: 0 }], segments: [{ frame_start: 0, frames }] };
  }
  const verifiedAll = Array.from({ length: 20 }, (_, i) => ({ participant: 1, frame: 2 * i }));

  it('8 checkpoints pass', () => {
    const r = evaluateProgram(flickerProgram(), CAL, flickerBuf(10), verifiedAll);
    expect(r).toMatchObject({ leg_results: [1], n_checkpoints: 8, winner_mask: 2 });
  });

  it('9 checkpoints ⇒ empty list and IDENTITY on every actor-bound leg', () => {
    const dp = decodeProgram(encodeProgram(flickerProgram()));
    dp.legs[0]!.rule_k = 9; // beyond the static bound (validation would reject)
    const r = evaluateDecoded(dp, { scene_hash: '00'.repeat(32), regions: [] }, flickerBuf(10), verifiedAll);
    expect(r).toMatchObject({ status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['IDENTITY']], checkpoints: [], n_checkpoints: 0 });
  });
});

describe('outcome (§3.10)', () => {
  it('Kleene tables', () => {
    const vals: LegValue[] = [0, 1, 2];
    const and = vals.map((x) => vals.map((y) => kAnd(x, y)));
    const or = vals.map((x) => vals.map((y) => kOr(x, y)));
    expect(and).toEqual([[0, 0, 0], [0, 1, 2], [0, 2, 2]]);
    expect(or).toEqual([[0, 1, 2], [1, 1, 1], [2, 1, 2]]);
    expect(vals.map(kNot)).toEqual([1, 0, 2]);
  });

  it('evalCond over leg ids', () => {
    const v = (id: number): LegValue => (id === 1 ? 1 : id === 2 ? 2 : 0);
    expect(evalCond({ code: 0x02, left: { code: 0x50, leg_id: 1 }, right: { code: 0x50, leg_id: 2 } }, v)).toBe(1);
    expect(evalCond({ code: 0x01, left: { code: 0x50, leg_id: 3 }, right: { code: 0x50, leg_id: 2 } }, v)).toBe(0);
    expect(evalCond({ code: 0x03, arg: { code: 0x50, leg_id: 2 } }, v)).toBe(2);
  });

  it('winner mask from side_b_mask', () => {
    const p = { ...decodeProgram(encodeProgram(abProgram({ kind: 'exists' }, 5, false))), P: 3, side_b_mask: 0b110 };
    expect(winnerMask(p, 0)).toBe(0b001);
    expect(winnerMask(p, 1)).toBe(0b110);
  });

  it('three participants, condition false ⇒ else side', () => {
    const p = abProgram({ kind: 'exists' }, 5, false);
    p.participants = [CREATOR, FRIEND, THIRD];
    p.sides = [0, 1, 0];
    const r = evaluateProgram(p, CAL, abBuf('', '000'), []);
    expect(r).toMatchObject({ status: 'ok', winner_mask: 0b010 });
  });

  it('checkpoint merge sorts by (frame, participant) and dedups', () => {
    expect(mergeCheckpoints([[{ participant: 2, frame: 5 }, { participant: 1, frame: 5 }], [{ participant: 1, frame: 5 }, { participant: 0, frame: 9 }]])).toEqual([
      { participant: 1, frame: 5 },
      { participant: 2, frame: 5 },
      { participant: 0, frame: 9 },
    ]);
  });
});
