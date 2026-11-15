/**
 * Mock identity embedder (§13 IDENTITY_PROVIDER=mock): the embedding is a
 * deterministic unit vector from sha256(user_id ‖ modality) (seeded PRNG),
 * perturbed by ≤ 5% noise derived from the input bytes. The service decides
 * whose face/voice the bytes depict (`subject_user_id`); in mock huddle scans
 * each face crop resolves to the next not-yet-confirmed joined member.
 */
import { createHash } from 'node:crypto';
import { FACE_DIM, VOICE_DIM } from '@verdict/engine';
import { HashPrng, l2normalize } from '../../util/prng.js';
import type { IdentityProvider, IdentitySubject } from '../types.js';

export const MOCK_NOISE_MAX = 0.05;

export function mockBaseEmbedding(userId: string, modality: 'face' | 'voice'): number[] {
  const seed = createHash('sha256').update(userId).update(modality).digest();
  const prng = new HashPrng(seed);
  const dim = modality === 'face' ? FACE_DIM : VOICE_DIM;
  return l2normalize(Array.from({ length: dim }, () => prng.normal()));
}

export function mockEmbedding(userId: string, modality: 'face' | 'voice', input: Uint8Array): number[] {
  const base = mockBaseEmbedding(userId, modality);
  const prng = new HashPrng(createHash('sha256').update(input).digest());
  const noise = l2normalize(base.map(() => prng.normal()));
  const scale = MOCK_NOISE_MAX * prng.float();
  return l2normalize(base.map((x, i) => x + scale * noise[i]!));
}

export class MockIdentity implements IdentityProvider {
  readonly name = 'mock';

  async embedFace(jpeg: Uint8Array, ctx?: IdentitySubject): Promise<number[]> {
    return mockEmbedding(subject(ctx), 'face', jpeg);
  }

  async embedVoice(wav: Uint8Array, ctx?: IdentitySubject): Promise<number[]> {
    return mockEmbedding(subject(ctx), 'voice', wav);
  }
}

/** Without a subject the bytes are treated as an unknown person (matches nobody). */
function subject(ctx?: IdentitySubject): string {
  return ctx?.subject_user_id ?? 'unknown-person';
}
