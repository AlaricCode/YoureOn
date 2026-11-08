/**
 * Integer-only arithmetic helpers for the evaluator (§0.4).
 *
 * Consensus code under `src/eval/**` never uses `/` on numbers, `Math.sqrt`,
 * `Math.round` or `Math.floor` on non-integers. All division goes through
 * `idiv`, square roots through the integer Newton `isqrt`.
 */
import type { CmpCode } from '../types.js';

/** Thrown on an internal invariant violation (a bug, never a data error). */
export class EvalInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalInvariantError';
  }
}

function assertSafeInt(x: number, what: string): void {
  if (!Number.isSafeInteger(x)) throw new EvalInvariantError(`${what} is not a safe integer: ${x}`);
}

/** Truncating integer division on non-negative operands (`a ≥ 0`, `b > 0`). */
export function idiv(a: number, b: number): number {
  assertSafeInt(a, 'idiv dividend');
  assertSafeInt(b, 'idiv divisor');
  if (a < 0) throw new EvalInvariantError(`idiv dividend negative: ${a}`);
  if (b <= 0) throw new EvalInvariantError(`idiv divisor not positive: ${b}`);
  const r = a % b;
  // (a - r) is an exact multiple of b and the quotient is a safe integer, so
  // the IEEE division below is exact.
  // eslint-disable-next-line no-restricted-syntax
  return (a - r) / b;
}

/** floor(sqrt(n)) for a non-negative safe integer, by integer Newton's method. */
export function isqrt(n: number): number {
  assertSafeInt(n, 'isqrt operand');
  if (n < 0) throw new EvalInvariantError(`isqrt of negative: ${n}`);
  if (n < 2) return n;
  let x = n;
  let y = idiv(x + 1, 2);
  while (y < x) {
    x = y;
    y = idiv(x + idiv(n, x), 2);
  }
  return x;
}

/** Sign of an integer: -1, 0 or +1. */
export function sign(x: number): -1 | 0 | 1 {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Absolute value of an integer. */
export function iabs(x: number): number {
  return x < 0 ? -x : x;
}

/** Apply a CMP code (§5.1: 0 >=, 1 >, 2 <=, 3 <, 4 ==, 5 !=). */
export function applyCmp(cmp: CmpCode | number, lhs: number, rhs: number): boolean {
  switch (cmp) {
    case 0:
      return lhs >= rhs;
    case 1:
      return lhs > rhs;
    case 2:
      return lhs <= rhs;
    case 3:
      return lhs < rhs;
    case 4:
      return lhs === rhs;
    case 5:
      return lhs !== rhs;
    default:
      throw new EvalInvariantError(`unknown CMP code ${cmp}`);
  }
}
