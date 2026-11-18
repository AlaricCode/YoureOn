// Turns one photo into a 512-d face embedding, for enrollment (3 stills) and for the face scan.
//
// `createModelEmbedder()` is the real one (TASKS D1-M3, D4-M1): decode the still with Nitro Image,
// resize it to an upright working copy (resizing bakes in the EXIF orientation, so the detector's
// box lines up), crop a square around the face box, resize to 112 × 112, convert to the model's
// float input (../face/preprocess.ts) and run w600k_mbf on fast-tflite (../face/loadModel.ts).
// It returns the L2-normalised embedding (unit length), ready to average, seal or send.
//
// `createPreviewEmbedder()` is NOT a face embedding: a fixed vector plus a little pose noise, so
// the app preview can walk the flow without the model. Screens tag themselves "Preview" with it.
//
// Native modules are imported lazily, inside embed(), so importing this file never pulls the
// .tflite into a bundle that does not use it.
import type { Image } from 'react-native-nitro-image';

import { copyEmbeddingOutput, FACE_MODEL, l2NormalizeInPlace } from '../face/model';
import { FACE_SIDE, faceCropRect, toModelInput, uprightPlan } from '../face/preprocess';
import type { DetectedFace } from './flow';

export interface FaceEmbedder {
  /** True for the stand-in; the screens tag themselves "Preview". */
  readonly preview: boolean;
  /** The face embedding for the face in the photo at `photoUrl` (file://). */
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

export interface ModelEmbedderOptions {
  /**
   * Flip the crop left-right before embedding. Set it for a camera whose stills come out
   * mirrored, so enrollment (front camera) and scans (back camera) see faces the same way.
   * Check on the phones (docs/qa-device.md); unset = use the still as it is.
   */
  mirror?: boolean;
  /** QA hook: receives each 112 × 112 crop, e.g. to show it on the diagnostics screen. */
  onCrop?: (crop: Image) => void;
}

const fileUrlToPath = (url: string): string =>
  decodeURIComponent(url.startsWith('file://') ? url.slice('file://'.length) : url);

/** The real embedder. One inference at a time: fast-tflite must not run concurrently (FINDINGS §7). */
export function createModelEmbedder(opts: ModelEmbedderOptions = {}): FaceEmbedder {
  let queue: Promise<unknown> = Promise.resolve();

  const embedOnce = async (photoUrl: string, face: DetectedFace): Promise<Float32Array> => {
    const [{ Images }, { loadFaceModel }] = await Promise.all([
      import('react-native-nitro-image'),
      import('../face/loadModel'),
    ]);
    const photo = await Images.loadFromFileAsync(fileUrlToPath(photoUrl));
    const plan = uprightPlan(photo, face);
    if (!plan) {
      throw new Error(
        `photo ${photo.width}×${photo.height} does not match the detector frame ` +
          `${face.frameWidth}×${face.frameHeight}`,
      );
    }
    const upright = await photo.resizeAsync(plan.width, plan.height);
    const r = faceCropRect(
      {
        x: face.bounds.x * plan.sx,
        y: face.bounds.y * plan.sy,
        width: face.bounds.width * plan.sx,
        height: face.bounds.height * plan.sy,
      },
      upright,
    );
    const square = await upright.cropAsync(r.x0, r.y0, r.x1, r.y1);
    let crop = await square.resizeAsync(FACE_SIDE, FACE_SIDE);
    if (opts.mirror) crop = await crop.mirrorHorizontallyAsync();
    opts.onCrop?.(crop);
    const px = await crop.toRawPixelDataAsync();
    const input = toModelInput(new Uint8Array(px.buffer), px.width, px.height, px.pixelFormat);
    const { model } = await loadFaceModel();
    const outputs = await model.run([input.buffer as ArrayBuffer]);
    const first = outputs[0];
    if (!first) throw new Error('model returned no outputs');
    const embedding = copyEmbeddingOutput(first);
    l2NormalizeInPlace(embedding);
    return embedding;
  };

  return {
    preview: false,
    embed(photoUrl, face) {
      const run = () => embedOnce(photoUrl, face);
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    },
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
