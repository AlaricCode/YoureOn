// Turns one enrollment photo into a 512-d face embedding.
//
// The real pipeline is TASKS D1-M3 (FINDINGS §3.2): still → resize → landmarks → warp to
// 112×112 → w600k_mbf (src/face/loadModel.ts). It is not built yet. Until it lands, the enroll
// screens run with `createPreviewEmbedder()`, which is NOT a face embedding: it returns a fixed
// vector plus a little pose-dependent noise, so the flow (prompts, checks, the request) can be
// tried end to end against the preview face API. Screens show a "Preview" tag while it is in use.
import { FACE_MODEL } from '../face/model';
import type { DetectedFace } from './flow';

export interface FaceEmbedder {
  /** True for the stand-in; the screens tag themselves "Preview". */
  readonly preview: boolean;
  /** Raw model output for the face in the photo at `photoUrl` (file://). */
  embed(photoUrl: string, face: DetectedFace): Promise<Float32Array>;
}

/** Deterministic xorshift32, so tests are repeatable. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 0xffffffff) * 2 - 1;
  };
}

export function createPreviewEmbedder(seed = 0x5e6ad2): FaceEmbedder {
  const base = new Float32Array(FACE_MODEL.dim);
  const r = rng(seed);
  for (let i = 0; i < base.length; i++) base[i] = r();
  return {
    preview: true,
    async embed(_photoUrl, face) {
      const noise = rng(seed ^ Math.round((face.yawAngle + 90) * 1000));
      const out = new Float32Array(FACE_MODEL.dim);
      for (let i = 0; i < out.length; i++) out[i] = (base[i] as number) + 0.35 * noise();
      return out;
    },
  };
}
