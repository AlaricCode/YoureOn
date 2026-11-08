/**
 * Injectable wall clock (Unix ms). The mock chain and keeper use a
 * ManualClock in tests so every deadline (§9.9) can be exercised instantly.
 */
export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

export class ManualClock implements Clock {
  private t: number;
  private readonly listeners = new Set<(nowMs: number) => void>();

  constructor(startMs = 1_700_000_000_000) {
    this.t = startMs;
  }

  nowMs(): number {
    return this.t;
  }

  set(ms: number): void {
    if (ms < this.t) throw new Error('ManualClock cannot go backwards');
    this.t = ms;
    for (const l of this.listeners) l(this.t);
  }

  advance(ms: number): void {
    this.set(this.t + ms);
  }

  /** Called after every advance/set (the mock chain's "tick", §12.6). */
  onTick(l: (nowMs: number) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const nowSeconds = (c: Clock): bigint => BigInt(Math.floor(c.nowMs() / 1000));
