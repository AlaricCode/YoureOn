/**
 * Fixed-window per-key rate limiter (RATE_LIMITED, §12.8). In-memory.
 */
import type { Clock } from './clock.js';

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly clock: Clock,
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Records a hit; false if `key` is over the limit in the current window. */
  hit(key: string): boolean {
    const now = this.clock.nowMs();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

/** Counts failures per key in a fixed window; `blocked` once `limit` failures were recorded. */
export class FailureCounter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly clock: Clock,
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  private current(key: string): { start: number; count: number } | null {
    const w = this.windows.get(key);
    if (!w || this.clock.nowMs() - w.start >= this.windowMs) return null;
    return w;
  }

  blocked(key: string): boolean {
    return (this.current(key)?.count ?? 0) >= this.limit;
  }

  fail(key: string): void {
    const w = this.current(key);
    if (w) w.count++;
    else this.windows.set(key, { start: this.clock.nowMs(), count: 1 });
    if (this.windows.size > 10_000) {
      const now = this.clock.nowMs();
      for (const [k, x] of this.windows) if (now - x.start >= this.windowMs) this.windows.delete(k);
    }
  }
}
