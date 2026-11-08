/**
 * Seeded PRNG for the mock perception provider (§13). Deterministic: the same
 * seed always produces the same sequence. mulberry32 over a 32-bit state.
 */
export class Prng {
  private s: number;

  constructor(seed: number) {
    // Mix the seed so that small consecutive seeds diverge quickly.
    let x = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    this.s = (x ^ (x >>> 16)) >>> 0;
  }

  /** Next u32. */
  nextU32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform integer in `[lo, hi]` (inclusive). */
  int(lo: number, hi: number): number {
    if (hi < lo) throw new Error('Prng.int: empty range');
    return lo + (this.nextU32() % (hi - lo + 1));
  }

  /** One of -1, 0, +1. */
  sign3(): -1 | 0 | 1 {
    return (this.int(0, 2) - 1) as -1 | 0 | 1;
  }
}
