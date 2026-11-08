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
