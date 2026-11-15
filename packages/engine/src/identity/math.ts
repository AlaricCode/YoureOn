/** Integer helpers for identity consensus code (§0.4). */

/** floor(sqrt(n)) for n ≥ 0 by integer Newton's method (bigint). */
export function isqrtBig(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of negative');
  if (n < 2n) return n;
  // initial guess ≥ sqrt(n): 2^ceil(bits/2)
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Truncating division of non-negative safe integers (asserts operands). */
export function idiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b <= 0) {
    throw new RangeError(`idiv requires a ≥ 0, b > 0 safe integers (got ${a}, ${b})`);
  }
  return Math.trunc(a / b);
}

/** floor(a · num / den) for non-negative safe integers, exact via bigint. */
export function mulDiv(a: number, num: number, den: number): number {
  if (!Number.isSafeInteger(a) || a < 0) throw new RangeError(`mulDiv operand ${a}`);
  return Number((BigInt(a) * BigInt(num)) / BigInt(den));
}
