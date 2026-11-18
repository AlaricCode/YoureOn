// In-process token buckets, API-CONTRACT §1.7 (one machine). 429 RATE_LIMITED + Retry-After.
import { HttpError } from '../errors';

export interface BucketSpec {
  /** Tokens per window. */
  limit: number;
  windowMs: number;
}

/** §1.7 buckets this module knows; other streams add theirs by name. */
export const BUCKETS = {
  auth: { limit: 10, windowMs: 60_000 },
  default: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, BucketSpec>;

interface Bucket {
  tokens: number;
  updated: number;
}

/** Hard cap on live buckets: past it the least recently used ones go (a key flood can't OOM us). */
export const MAX_BUCKETS = 50_000;

export class RateLimiter {
  /** Insertion order = least recently used first (take() re-inserts the key it touches). */
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxBuckets: number = MAX_BUCKETS,
  ) {}

  /** Live buckets (tests). */
  get size(): number {
    return this.buckets.size;
  }

  /** Takes one token from `name:key`, or throws 429 RATE_LIMITED with Retry-After. */
  take(name: string, key: string, spec: BucketSpec): void {
    const k = `${name}\u0000${key}`;
    const now = this.now();
    const rate = spec.limit / spec.windowMs;
    const b = this.buckets.get(k) ?? { tokens: spec.limit, updated: now };
    b.tokens = Math.min(spec.limit, b.tokens + (now - b.updated) * rate);
    b.updated = now;
    this.buckets.delete(k);
    if (b.tokens < 1) {
      this.buckets.set(k, b);
      const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
      throw new HttpError(
        'RATE_LIMITED',
        undefined,
        { bucket: name },
        {
          headers: { 'Retry-After': String(retryAfter) },
        },
      );
    }
    b.tokens -= 1;
    this.buckets.set(k, b);
    if (this.buckets.size > this.maxBuckets) this.sweep(now, spec.windowMs);
  }

  private sweep(now: number, windowMs: number) {
    for (const [k, b] of this.buckets) if (now - b.updated > windowMs) this.buckets.delete(k);
    // Still over the cap (a flood of fresh keys): drop the least recently used ones, down to
    // 90 % so the next few new keys don't each pay for a full sweep.
    const keep = Math.floor(this.maxBuckets * 0.9);
    for (const k of this.buckets.keys()) {
      if (this.buckets.size <= keep) break;
      this.buckets.delete(k);
    }
  }
}
