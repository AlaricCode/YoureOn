/**
 * Deterministic byte/number stream seeded by bytes: sha256(seed ‖ u32 counter)
 * blocks. Used by mocks (identity embeddings, detector layouts, price walks).
 * Not for secrets.
 */
import { createHash } from 'node:crypto';

export class HashPrng {
  private block = new Uint8Array(0);
  private pos = 0;
  private counter = 0;
  private readonly seed: Uint8Array;

  constructor(seed: Uint8Array | string) {
    this.seed = typeof seed === 'string' ? new TextEncoder().encode(seed) : Uint8Array.from(seed);
  }

  private refill(): void {
    const c = Buffer.alloc(4);
    c.writeUInt32LE(this.counter++ >>> 0);
    this.block = new Uint8Array(createHash('sha256').update(this.seed).update(c).digest());
    this.pos = 0;
  }

  /** Uniform u32. */
  u32(): number {
    if (this.pos + 4 > this.block.length) this.refill();
    const b = this.block;
    const v = (b[this.pos]! | (b[this.pos + 1]! << 8) | (b[this.pos + 2]! << 16) | (b[this.pos + 3]! << 24)) >>> 0;
    this.pos += 4;
    return v;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** Standard normal (Box–Muller). */
  normal(): number {
    let u = this.float();
    if (u === 0) u = 1e-12;
    const v = this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export function l2normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n);
}
