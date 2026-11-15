/**
 * Read-back coverage (§2.8): programs that use every expression and rule
 * template, and a check that the union of all vectors' `readback` lines
 * exercises every template.
 */
import type { Expr, Program } from '../../src/types.js';
import { THIRD, FOURTH, CREATOR, FRIEND, box, buffer, calib, makeVector, prog, ref, rep, type VectorJson } from './common.js';

const s = (frames: number) => frames;

function allTemplatesProgram(): Program {
  const ball = ref('ball');
  const cup = ref('cup');
  const runner = ref('runner');
  const and = (x: Expr, y: Expr): Expr => ({ op: 'and', args: [x, y] });
  const or = (x: Expr, y: Expr): Expr => ({ op: 'or', args: [x, y] });
  return prog({
    entities: [
      { name: 'runner', kind: 'person_any' },
      { name: 'ball', kind: 'object', phrase: 'tennis ball' },
      { name: 'cup', kind: 'object', phrase: 'red cup' },
      { name: 'mark', kind: 'region', shape: 'line' },
      { name: 'pad', kind: 'region', shape: 'zone' },
    ],
    legs: [
      {
        success: or(
          and({ op: 'overlaps', a: ball, b: cup }, { op: 'inside', a: ball, b: ref('cup', 'interior') }),
          and({ op: 'above', a: ball, b: cup }, { op: 'below', a: ball, b: ref('pad') }),
        ),
        rule: { kind: 'exists' },
      },
      { success: or({ op: 'behind', a: runner, b: ref('mark') }, { op: 'beyond', a: runner, b: ref('mark') }), rule: { kind: 'never' } },
      { success: and({ op: 'near', a: ball, b: cup, dist: 300 }, { op: 'moving', a: ball }), rule: { kind: 'count', cmp: '<=', k: 2, attempts: 0 } },
      {
        valid_attempt: { op: 'standing', a: runner },
        success: { op: 'then_within', frames: s(20), first: { op: 'enters', a: ball, b: ref('pad') }, then: { op: 'leaves', a: ball, b: ref('pad') } },
        rule: { kind: 'count', cmp: '>', k: 1, attempts: 3 },
        attempt_window_frames: 75,
      },
      { success: and({ op: 'present', a: ball }, { op: 'intact', a: cup }), rule: { kind: 'holds', frames: 50 } },
      {
        success: and({ op: 'at_rest', a: ball, frames: 15 }, { op: 'not', arg: { op: 'speed', a: ball, cmp: '>', value: 400 } }),
        rule: { kind: 'before', frames: 900 },
      },
      {
        success: { op: 'before', frames: 200, arg: { op: 'for_duration', frames: 10, arg: { op: 'direction', a: ball, dir: 'up' } } },
        rule: { kind: 'count', cmp: '!=', k: 0, attempts: 0 },
      },
      {
        success: or(
          or({ op: 'disappears_into', a: ball, b: ref('cup', 'opening') }, { op: 'touches', a: ball, b: cup }),
          or(
            and({ op: 'crosses', a: ball, b: ref('mark') }, { op: 'released_by', a: ball, b: runner }),
            { op: 'rep_count', a: runner, cmp: '==', value: 5 },
          ),
        ),
        rule: { kind: 'count', cmp: '<', k: 3, attempts: 0 },
      },
    ],
    outcome: {
      if_true: 1,
      condition: {
        op: 'or',
        args: [
          { op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'not', arg: { op: 'leg', id: 2 } }] },
          { op: 'and', args: [{ op: 'leg', id: 3 }, { op: 'or', args: [{ op: 'leg', id: 4 }, { op: 'leg', id: 5 }] }] },
        ],
      },
      else: 0,
    },
    time_limit_s: 120,
    stake_each: 1_250_000,
  });
}

function readbackAll(): VectorJson {
  const p = allTemplatesProgram();
  const c = calib(
    [
      { entity: 'mark', shape: 'line', points: [[5000, 0], [5000, 10000]], behind_sign: -1 },
      { entity: 'pad', shape: 'zone', points: [[1000, 8000], [4000, 8000], [4000, 9500], [1000, 9500]] },
    ],
    [{ entity: 'cup', label: 'Red Cup', bbox: [6000, 6000, 7000, 7500] }],
  );
  return makeVector({
    name: 'readback_all_templates',
    description:
      'Every §2.8 expression template and the exists / never / count / count-with-attempts / holds / before rule templates, durations "1.5s" / "1m 30s" / "2m", in one 8-leg program over a short buffer (only ball and cup tracked frames present)',
    covers: ['readback_templates'],
    program: p,
    calibration: c,
    buffer: buffer(p, { cols: { ball: rep(box(6500, 5000, 100), 12), cup: rep({ x0: 6000, y0: 6000, x1: 7000, y1: 7500, conf: 90, fill: 0, id_conf: 0, pose: 0 }, 12) } }),
  });
}

function readbackFourParticipants(): VectorJson {
  const p = prog({
    participants: [CREATOR, FRIEND, THIRD, FOURTH],
    sides: [0, 1, 0, 1],
    entities: [{ name: 'ball', kind: 'object', phrase: 'ball' }],
    legs: [{ success: { op: 'present', a: ref('ball') }, rule: { kind: 'exists' } }],
    outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
    stake_each: 10_000,
    time_limit_s: 75,
  });
  return makeVector({
    name: 'readback_four_participants',
    description: '4 participants on two sides (side names joined), $0.01 stake, 1m 15s limit; winner_mask over 4 participants (sides [0,1,0,1], side 1 wins ⇒ 0b1010)',
    covers: ['readback_templates', 'winner_mask_multi'],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { ball: [null, box(5000, 5000)] } }),
    intent: { leg_results: [1], winner_mask: 0b1010 },
  });
}

/** Template → pattern over read-back lines (§2.8). */
export const READBACK_TEMPLATES: Record<string, RegExp> = {
  overlaps: / overlaps /,
  inside: / is inside /,
  above: / is above /,
  below: / is below /,
  behind: / is behind /,
  beyond: / is past /,
  near: / is near /,
  moving: / is moving/,
  present: / is visible/,
  intact: / stays standing/,
  standing: / is standing/,
  at_rest: / stays still for \d/,
  speed: / moves (at least|more than|at most|fewer than|exactly|not exactly) \d/,
  direction: / moves (up|down|left|right)/,
  rep_count: / does .* \d+ reps/,
  enters: / enters /,
  leaves: / leaves /,
  disappears_into: / goes into /,
  touches: / touches /,
  crosses: / crosses /,
  released_by: / releases /,
  and: / and /,
  or: / or /,
  not: /not: /,
  then_within: /, then within \d/,
  for_duration: / for \d/,
  before: / before \d/,
  opening: /the opening of /,
  interior: /the inside of /,
  line: /the line/,
  zone: /the zone/,
  never: /^Never: /,
  count_without_attempts: /, (at least|more than|at most|fewer than|exactly|not exactly) \d+ times$/,
  count_valid_attempt: /^Counts if: /,
  count_success: /^Wins an attempt if: /,
  count_needs: /^Needs .* of \d+ attempts$/,
  holds: / for \S+ straight$/,
  before_rule: / within \d/,
  market_leg: / resolves (yes|no)$/,
  ai_judged: /^Question: /,
  outcome: / win if .*; otherwise .* win$/,
  outcome_not: / win if .*not leg \d/,
  stake_each: /^\$\d+\.\d\d each$/,
  stakes_market: /^Stakes \$/,
  limit: /^Time limit /,
  duration_decimal: /\d\.\ds/,
  duration_minutes: /\dm \d+s/,
};

/** Throws unless every template matches at least one read-back line of some vector. */
export function assertReadbackCoverage(vs: VectorJson[]): void {
  const lines = vs.flatMap((v) => (v.readback as string[] | undefined) ?? []);
  const missing = Object.entries(READBACK_TEMPLATES)
    .filter(([, re]) => !lines.some((l) => re.test(l)))
    .map(([k]) => k);
  if (missing.length) throw new Error(`read-back templates not covered by any vector: ${missing.join(', ')}`);
}

export function readbackVectors(): VectorJson[] {
  return [readbackAll(), readbackFourParticipants()];
}
