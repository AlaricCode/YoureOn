// In-process idempotency cache, API-CONTRACT §1.6 / DATA-MODEL §8.6 (P0: one Fly machine;
// P1 moves this to the api_idempotency table). Key = (device_id, Idempotency-Key).
import { IDEMPOTENCY_TTL_MS } from '@youre-on/shared/api';

export interface StoredResponse {
  status: number;
  body: string;
  contentType: string | null;
}

type Entry =
  | { state: 'pending'; bodySha256: string; at: number }
  | { state: 'done'; bodySha256: string; at: number; response: StoredResponse };

export type IdempotencyLookup =
  | { kind: 'new' }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'mismatch' }
  | { kind: 'in_flight' };

export class IdempotencyCache {
  private readonly map = new Map<string, Entry>();
  constructor(
    private readonly opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  private get ttl() {
    return this.opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }
  private static key(deviceId: string, idemKey: string) {
    return `${deviceId}\u0000${idemKey}`;
  }

  /**
   * Looks up the key; on `new`, reserves it as pending (call `complete` or `release`).
   * `bodySha256` is the request fingerprint (requireSignedRequest hashes method + target + body).
   */
  begin(deviceId: string, idemKey: string, bodySha256: string): IdempotencyLookup {
    const k = IdempotencyCache.key(deviceId, idemKey);
    const now = this.now();
    const e = this.map.get(k);
    if (e && now - e.at <= this.ttl) {
      if (e.bodySha256 !== bodySha256) return { kind: 'mismatch' };
      if (e.state === 'pending') return { kind: 'in_flight' };
      return { kind: 'replay', response: e.response };
    }
    this.map.delete(k);
    this.map.set(k, { state: 'pending', bodySha256, at: now });
    this.evict(now);
    return { kind: 'new' };
  }

  complete(deviceId: string, idemKey: string, response: StoredResponse): void {
    const k = IdempotencyCache.key(deviceId, idemKey);
    const e = this.map.get(k);
    if (!e) return;
    this.map.set(k, { state: 'done', bodySha256: e.bodySha256, at: e.at, response });
  }

  /** Forget a pending key (the handler failed in a way that should not be replayed, e.g. 5xx). */
  release(deviceId: string, idemKey: string): void {
    const k = IdempotencyCache.key(deviceId, idemKey);
    if (this.map.get(k)?.state === 'pending') this.map.delete(k);
  }

  get size() {
    return this.map.size;
  }

  private evict(now: number) {
    const max = this.opts.maxEntries ?? 20_000;
    // Map iterates in insertion order: oldest first.
    for (const [k, e] of this.map) {
      if (this.map.size <= max && now - e.at <= this.ttl) break;
      this.map.delete(k);
    }
  }
}
