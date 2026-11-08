/**
 * Liveness heuristics for enrollment (`POST /enroll/face`) and pay
 * (`POST /pay/scan`). Without a head-pose model the backend checks what it
 * can verify from the uploads themselves:
 *   1. every frame is a JPEG (SOI … EOI markers) within size limits;
 *   2. the prompted frames differ from the neutral frame and from each other
 *      (a replayed still photo fails);
 *   3. every frame shows the same person: the cosine between each frame's
 *      quantized embedding and the neutral frame's is ≥ τ_face (§8.3).
 * A pose sidecar can tighten (2) later; the API shape does not change.
 */
import { createHash } from 'node:crypto';
import { cosineBps, quantizeEmbedding, TAU_FACE_BPS } from '@verdict/engine';

export const MAX_JPEG_BYTES = 2 * 1024 * 1024;

export type LivenessFailure = 'not_jpeg' | 'too_large' | 'replayed_frame' | 'identity_changed';

export interface LivenessResult {
  ok: boolean;
  reason: LivenessFailure | null;
  /** per frame (index ≥ 1): cos_bps against frame 0 */
  consistency_bps: number[];
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
}

/** Throws nothing: shape problems are reported as a failed check. */
export function checkJpegs(frames: Uint8Array[]): LivenessFailure | null {
  for (const f of frames) {
    if (f.length > MAX_JPEG_BYTES) return 'too_large';
    if (!isJpeg(f)) return 'not_jpeg';
  }
  return null;
}

/**
 * `frames[0]` is neutral, `frames[1..]` follow the prompts. `embeddings`
 * are the provider's float embeddings for the same frames, in order.
 */
export function checkLiveness(frames: Uint8Array[], embeddings: number[][]): LivenessResult {
  const shape = checkJpegs(frames);
  if (shape) return { ok: false, reason: shape, consistency_bps: [] };
  const hashes = frames.map((f) => createHash('sha256').update(f).digest('hex'));
  if (new Set(hashes).size !== hashes.length) return { ok: false, reason: 'replayed_frame', consistency_bps: [] };
  const q = embeddings.map((e) => quantizeEmbedding(e));
  const consistency = q.slice(1).map((o) => cosineBps(q[0]!, o));
  if (consistency.some((c) => c < TAU_FACE_BPS)) return { ok: false, reason: 'identity_changed', consistency_bps: consistency };
  return { ok: true, reason: null, consistency_bps: consistency };
}
