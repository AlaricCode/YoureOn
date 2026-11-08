/** Seeded random round-trip: canonical program → toYaml → parseYaml must reproduce it (§2.9). */
import { describe, expect, it } from 'vitest';
import { canonicalize, conditionRows, parseYaml, readback, toYaml, validateProgram } from '../src/lang/index.js';
import type { Cmp, Expr, LegExpr, Program, Ref } from '../src/types.js';
import { CREATOR, CTX2, FRIEND, NAMES } from './lang-fixtures.js';

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CMPS: Cmp[] = ['>=', '>', '<=', '<', '==', '!='];

function gen(rnd: () => number): { program: Program } {
  const int = (n: number): number => Math.floor(rnd() * n);
  const pickOf = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const mover = (): Ref => ({ e: pickOf(['ball', 'can', 'anyone', 'me']) });
  const target = (): Ref => pickOf<Ref>([{ e: 'can' }, { e: 'can', sub: 'opening' }, { e: 'can', sub: 'interior' }, { e: 'area' }, { e: 'anyone' }, { e: 'ball' }]);
  const frames = (): number => 1 + int(400);
  const leaf = (): Expr => {
    switch (int(16)) {
      case 0:
        return { op: pickOf(['overlaps', 'inside', 'above', 'below', 'touches'] as const), a: mover(), b: target() };
      case 1:
        return { op: pickOf(['behind', 'beyond', 'crosses'] as const), a: mover(), b: { e: 'mark' } };
      case 2:
        return { op: pickOf(['enters', 'leaves'] as const), a: mover(), b: pickOf<Ref>([{ e: 'area' }, { e: 'can' }, { e: 'can', sub: 'interior' }]) };
      case 3:
        return { op: 'disappears_into', a: mover(), b: pickOf<Ref>([{ e: 'area' }, { e: 'can', sub: 'opening' }]) };
      case 4:
        return { op: 'released_by', a: mover(), b: { e: pickOf(['anyone', 'me']) } };
      case 5:
        return { op: 'near', a: mover(), b: target(), dist: int(14144) };
      case 6:
        return { op: pickOf(['moving', 'present', 'intact'] as const), a: mover() };
      case 7:
        return { op: 'standing', a: { e: pickOf(['anyone', 'me']) } };
      case 8:
        return { op: 'at_rest', a: mover(), frames: frames() };
      case 9:
        return { op: 'speed', a: mover(), cmp: pickOf(CMPS), value: int(100001) };
      case 10:
        return { op: 'direction', a: mover(), dir: pickOf(['up', 'down', 'left', 'right'] as const) };
      case 11:
        return { op: 'rep_count', a: { e: pickOf(['anyone', 'me']) }, cmp: pickOf(CMPS), value: int(1001) };
      default:
        return { op: 'present', a: mover() };
    }
  };
  const expr = (depth: number): Expr => {
    if (depth <= 1 || rnd() < 0.3) return leaf();
    switch (int(6)) {
      case 0:
        return { op: 'and', args: [expr(depth - 1), expr(depth - 1)] };
      case 1:
        return { op: 'or', args: [expr(depth - 1), expr(depth - 1)] };
      case 2:
        return { op: 'not', arg: expr(depth - 1) };
      case 3:
        return { op: 'then_within', frames: frames(), first: expr(depth - 1), then: expr(depth - 1) };
      case 4:
        return { op: 'for_duration', frames: frames(), arg: expr(depth - 1) };
      default:
        return { op: 'before', frames: frames(), arg: expr(depth - 1) };
    }
  };
  const nLegs = 1 + int(3);
  const legs = Array.from({ length: nLegs }, (_, i) => {
    const success = expr(4);
    const useVa = rnd() < 0.3;
    const leg: Program['legs'][number] = {
      id: i + 1,
      actor_bound: false,
      attempt_window_frames: 1 + int(36000),
      success,
      rule: useVa
        ? { kind: 'count', cmp: pickOf(['>=', '>'] as const), k: 1 + int(3), attempts: 3 + int(5) }
        : pickOf<Program['legs'][number]['rule']>([
            { kind: 'exists' },
            { kind: 'holds', frames: 1 + int(1200) },
            { kind: 'before', frames: 1 + int(1200) },
            { kind: 'count', cmp: '>=', k: 1 + int(3), attempts: 0 },
          ])!,
    };
    if (useVa) leg.valid_attempt = expr(3);
    return leg;
  });
  // fix actor_bound to the recomputed value
  const mentionsMe = (e: Expr | undefined): boolean => (e ? JSON.stringify(e).includes('"e":"me"') : false);
  for (const l of legs) {
    l.actor_bound = mentionsMe(l.success) || mentionsMe(l.valid_attempt);
    if (l.actor_bound && l.rule!.kind === 'count') l.rule = { ...l.rule!, k: 1, cmp: '>=' } as typeof l.rule;
  }
  let cond: LegExpr = { op: 'leg', id: 1 };
  for (let i = 2; i <= nLegs; i++) {
    const r = int(3);
    const next: LegExpr = rnd() < 0.3 ? { op: 'not', arg: { op: 'leg', id: i } } : { op: 'leg', id: i };
    cond = r === 0 ? { op: 'or', args: [cond, next] } : { op: 'and', args: [cond, next] };
  }
  const program: Program = {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [
      { name: 'ball', kind: 'object', phrase: 'tennis ball' },
      { name: 'can', kind: 'object', phrase: "dad's can" },
      { name: 'area', kind: 'region', shape: 'zone' },
      { name: 'mark', kind: 'region', shape: 'line' },
      { name: 'anyone', kind: 'person_any' },
      { name: 'me', kind: 'person', participant: 1 },
    ],
    legs,
    outcome: { if_true: rnd() < 0.5 ? 0 : 1, condition: cond, else: 0 },
    stake_each: 10_000 + int(1_000_000_000),
    time_limit_s: 120 + int(3480),
  };
  program.outcome.else = program.outcome.if_true === 0 ? 1 : 0;
  return { program };
}

describe('seeded round trip', () => {
  it('toYaml → parseYaml reproduces 500 random valid programs', () => {
    const rnd = prng(1);
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const { program } = gen(rnd);
      const { errors } = validateProgram(program, CTX2);
      // Skip the few random programs that exceed checkpoint/size limits.
      if (errors.length > 0) {
        expect(errors.every((e) => ['CHECKPOINT_LIMIT', 'LIMIT', 'BAD_RULE'].includes(e.code)), JSON.stringify(errors)).toBe(true);
        continue;
      }
      expect(canonicalize(program)).toStrictEqual(program);
      const y = toYaml(program);
      const r = parseYaml(y, CTX2);
      if (!r.ok) throw new Error(`${y}\n${JSON.stringify(r.errors)}`);
      expect(r.program).toStrictEqual(program);
      expect(toYaml(r.program)).toBe(y);
      expect(readback(program, { names: NAMES }).length).toBeGreaterThan(3);
      expect(conditionRows(program, {}).length).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });
});
