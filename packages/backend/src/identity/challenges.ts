/**
 * Short-lived challenges (§12.3): enrollment (face prompts + voice phrases),
 * pay (one face prompt) and "I accept" (two random words). Stored in the
 * `challenges` collection, bound to the requesting user, single purpose.
 */
import { randomInt } from 'node:crypto';
import { ApiError } from '../errors.js';
import { COLLECTIONS } from '../persistence/records.js';
import type { Collection, JsonStore } from '../persistence/store.js';
import type { Clock } from '../util/clock.js';
import { uuid } from '../util/ids.js';

export type FacePrompt = 'left' | 'right' | 'up' | 'down';
export const FACE_PROMPTS: readonly FacePrompt[] = ['left', 'right', 'up', 'down'];

export const ENROLL_CHALLENGE_TTL_MS = 10 * 60_000;
export const PAY_CHALLENGE_TTL_MS = 2 * 60_000;
export const ACCEPT_CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Plain lowercase words (they survive the §12.3 transcript normalization
 * `[^a-z ]` unchanged) that are easy to say and hard to confuse.
 */
export const CHALLENGE_WORDS: readonly string[] = [
  'amber', 'anchor', 'apple', 'arrow', 'banjo', 'basil', 'beacon', 'birch', 'bison', 'canyon',
  'cedar', 'cobalt', 'comet', 'copper', 'coral', 'cosmos', 'crystal', 'dolphin', 'ember', 'falcon',
  'fennel', 'forest', 'garnet', 'ginger', 'glacier', 'granite', 'harbor', 'hazel', 'island', 'jasper',
  'juniper', 'kettle', 'lantern', 'lemon', 'lilac', 'linen', 'magnet', 'maple', 'marble', 'meadow',
  'mango', 'nectar', 'nickel', 'olive', 'orbit', 'orchid', 'otter', 'pebble', 'pepper', 'pillow',
  'planet', 'pumpkin', 'quartz', 'rabbit', 'raven', 'ribbon', 'river', 'rocket', 'saddle', 'salmon',
  'silver', 'sparrow', 'spruce', 'summit', 'thunder', 'tiger', 'timber', 'tulip', 'velvet', 'walnut',
  'willow', 'winter', 'zebra', 'zephyr',
];

export function randomWords(n: number, pool: readonly string[] = CHALLENGE_WORDS): string[] {
  const out: string[] = [];
  while (out.length < n) {
    const w = pool[randomInt(0, pool.length)]!;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** n distinct face prompts in random order. */
export function randomFacePrompts(n: number): FacePrompt[] {
  return randomWords(n, FACE_PROMPTS) as FacePrompt[];
}

/** Three distinct enrollment phrases of three words each. */
export function randomVoicePhrases(): string[] {
  const words = randomWords(9);
  return [0, 1, 2].map((i) => words.slice(i * 3, i * 3 + 3).join(' '));
}

export type ChallengeData =
  | { kind: 'enroll'; face_prompts: FacePrompt[]; voice_phrases: string[] }
  | { kind: 'pay'; face_prompt: FacePrompt }
  | { kind: 'accept'; draft_id: string; program_hash: string; words: [string, string]; phrase: string };

export interface ChallengeRecord {
  id: string;
  user_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  used: boolean;
  data: ChallengeData;
}

export class ChallengeStore {
  readonly col: Collection<ChallengeRecord>;

  constructor(
    store: JsonStore,
    private readonly clock: Clock,
  ) {
    this.col = store.collection<ChallengeRecord>(COLLECTIONS.challenges);
  }

  issue(userId: string, data: ChallengeData, ttlMs: number): ChallengeRecord {
    this.sweep();
    const now = this.clock.nowMs();
    const rec: ChallengeRecord = { id: uuid(), user_id: userId, created_at_ms: now, expires_at_ms: now + ttlMs, used: false, data };
    this.col.set(rec.id, rec);
    return rec;
  }

  /**
   * Returns the caller's live challenge of `kind`. Unknown, foreign, used or
   * expired challenges are all CHALLENGE_EXPIRED (the app re-requests one).
   */
  require<K extends ChallengeData['kind']>(id: unknown, userId: string, kind: K): ChallengeRecord & { data: Extract<ChallengeData, { kind: K }> } {
    if (typeof id !== 'string') throw new ApiError('CHALLENGE_EXPIRED', 'missing challenge_id');
    const rec = this.col.get(id);
    if (!rec || rec.user_id !== userId || rec.data.kind !== kind) throw new ApiError('CHALLENGE_EXPIRED', `unknown challenge ${id}`);
    if (rec.used) throw new ApiError('CHALLENGE_EXPIRED', 'challenge already used');
    if (this.clock.nowMs() > rec.expires_at_ms) throw new ApiError('CHALLENGE_EXPIRED', 'challenge expired');
    return rec as ChallengeRecord & { data: Extract<ChallengeData, { kind: K }> };
  }

  markUsed(id: string): void {
    if (this.col.has(id)) this.col.update(id, (c) => ({ ...c, used: true }));
  }

  /** Drops challenges that expired more than an hour ago. */
  sweep(): void {
    const cutoff = this.clock.nowMs() - 3_600_000;
    for (const c of this.col.filter((c) => c.expires_at_ms < cutoff)) this.col.delete(c.id);
  }
}
