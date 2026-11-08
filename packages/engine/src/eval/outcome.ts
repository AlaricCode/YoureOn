/**
 * Outcome and pre-ruling (§3.10).
 */
import type { DecodedCond, DecodedProgram, LegValue } from '../types.js';
import { EvalInvariantError } from './math.js';

/** Kleene three-valued AND / OR / NOT over 0 False, 1 True, 2 Unknown. */
export function kAnd(x: LegValue, y: LegValue): LegValue {
  if (x === 0 || y === 0) return 0;
  if (x === 1 && y === 1) return 1;
  return 2;
}
export function kOr(x: LegValue, y: LegValue): LegValue {
  if (x === 1 || y === 1) return 1;
  if (x === 0 && y === 0) return 0;
  return 2;
}
export function kNot(x: LegValue): LegValue {
  return x === 2 ? 2 : x === 1 ? 0 : 1;
}

/** Evaluate a decoded condition over leg values (indexed by leg id). */
export function evalCond(c: DecodedCond, valueOfLegId: (id: number) => LegValue): LegValue {
  switch (c.code) {
    case 0x01:
      return kAnd(evalCond(c.left, valueOfLegId), evalCond(c.right, valueOfLegId));
    case 0x02:
      return kOr(evalCond(c.left, valueOfLegId), evalCond(c.right, valueOfLegId));
    case 0x03:
      return kNot(evalCond(c.arg, valueOfLegId));
    case 0x50:
      return valueOfLegId(c.leg_id);
    case 0x51:
      // `yes` (ai_judged only) is never evaluated by the interpreter.
      return 2;
  }
}

/** Side of participant i (bit i of side_b_mask). */
export function sideOf(p: DecodedProgram, i: number): 0 | 1 {
  return ((p.side_b_mask >> i) & 1) as 0 | 1;
}

/** `winner_mask`: bit i set iff `sides[i] == winning side`. */
export function winnerMask(p: DecodedProgram, winningSide: 0 | 1): number {
  let m = 0;
  for (let i = 0; i < p.P; i++) if (sideOf(p, i) === winningSide) m |= 1 << i;
  return m;
}

/** Map of leg id → leg value, from per-leg values in program order. */
export function legValueLookup(p: DecodedProgram, values: readonly LegValue[]): (id: number) => LegValue {
  const byId = new Map<number, LegValue>();
  p.legs.forEach((l, i) => byId.set(l.id, values[i]!));
  return (id) => {
    const v = byId.get(id);
    if (v === undefined) throw new EvalInvariantError(`condition references missing leg id ${id}`);
    return v;
  };
}
