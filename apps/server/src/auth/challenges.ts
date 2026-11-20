// Login/signup challenges: 32-byte nonce, 60 s, single use, bound to the device_pubkey it was
// issued for. In-process (one Fly machine): a restart only costs the phone one new challenge, so
// nothing here has to survive one.
// Spec: docs/planning/API-CONTRACT.md §1.3.
import { randomUUID } from 'node:crypto';
import { AUTH_CHALLENGE_TTL_MS } from '@youre-on/shared/api';
import { randomB64Url } from '../crypto';

export interface Challenge {
  challenge_id: string;
  nonce: string;
  device_pubkey: string;
  expires_at: number;
}

export type ConsumeResult =
  { ok: true; challenge: Challenge } | { ok: false; reason: 'unknown' | 'expired' };

export class ChallengeStore {
  private readonly map = new Map<string, Challenge>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = AUTH_CHALLENGE_TTL_MS,
    private readonly maxEntries = 50_000,
  ) {}

  issue(device_pubkey: string): Challenge {
    const now = this.now();
    this.sweep(now);
    const ch: Challenge = {
      challenge_id: randomUUID(),
      nonce: randomB64Url(32),
      device_pubkey,
      expires_at: now + this.ttlMs,
    };
    this.map.set(ch.challenge_id, ch);
    return ch;
  }

  /** Single use: the challenge is deleted whatever happens next (no retries on one nonce). */
  consume(challenge_id: string): ConsumeResult {
    const ch = this.map.get(challenge_id);
    if (!ch) return { ok: false, reason: 'unknown' };
    this.map.delete(challenge_id);
    if (this.now() > ch.expires_at) return { ok: false, reason: 'expired' };
    return { ok: true, challenge: ch };
  }

  /**
   * Consumes the newest challenge issued for `device_pubkey` (demo-claim bodies may omit
   * challenge_id). Same single-use / expiry rules as consume().
   */
  consumeLatestFor(device_pubkey: string): ConsumeResult {
    let latest: Challenge | undefined;
    for (const ch of this.map.values()) if (ch.device_pubkey === device_pubkey) latest = ch;
    return latest ? this.consume(latest.challenge_id) : { ok: false, reason: 'unknown' };
  }

  get size() {
    return this.map.size;
  }

  private sweep(now: number) {
    for (const [id, ch] of this.map) {
      if (ch.expires_at >= now && this.map.size < this.maxEntries) break;
      this.map.delete(id);
    }
  }
}
