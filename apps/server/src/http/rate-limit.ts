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

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Takes one token from `name:key`, or throws 429 RATE_LIMITED with Retry-After. */
  take(name: string, key: string, spec: BucketSpec): void {
    const k = `${name}\u0000${key}`;
    const now = this.now();
    const rate = spec.limit / spec.windowMs;
    const b = this.buckets.get(k) ?? { tokens: spec.limit, updated: now };
    b.tokens = Math.min(spec.limit, b.tokens + (now - b.updated) * rate);
    b.updated = now;
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
    if (this.buckets.size > 50_000) this.sweep(now, spec.windowMs);
  }

  private sweep(now: number, windowMs: number) {
    for (const [k, b] of this.buckets) if (now - b.updated > windowMs) this.buckets.delete(k);
  }
}
