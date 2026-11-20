// Turns a photo into face embeddings (TASKS D1-M3 / D3-M3 / D4-M1).
//
// The real embedder (`createDeviceEmbedder`) runs, per photo:
//   1. an upright copy: the photo is redrawn with its EXIF orientation applied and the long side
//      capped at 1280 (STILL_MAX_SIDE), so the detector, the pixels and the landmarks all share
//      one coordinate space (the ML Kit wrapper does not apply EXIF orientation itself);
//   2. ML Kit face detection on that copy (bbox, pose, five landmarks);
//   3. per face asked for: the 112x112 ArcFace alignment from the landmarks (or a bbox crop with
//      margin), RGB, (x - 127.5) / 127.5, NHWC (src/face/pipeline.ts);
//   4. w600k_mbf on the tensor and on its mirror image (react-native-fast-tflite, one run at a
//      time), summed and L2-normalized.
// The native steps sit behind `EmbedderNatives` (src/face/native.ts on the phone; fakes in
// tests), so the whole orchestration runs in Node. Photos never leave the phone: only the
// final 512 floats do.
//
// `createPreviewEmbedder()` is NOT a face embedding: a fixed vector plus a little pose-dependent
// noise, so the enrollment flow can be tried in the offline preview. Screens tag themselves
// "Preview" while it is in use.
import { FACE_MODEL } from '../face/model';
import {
  alignTransform,
  combineEmbeddings,
  flipInput,
  scaleFace,
  STILL_MAX_SIDE,
  warpToInput,
  type RawImage,
} from '../face/pipeline';
import type { DetectedFace } from './flow';

/** One photo, opened: the faces in it and an embed() bound to its pixels. */
export interface FaceStill {
  /** Faces found, in the still's own pixel coordinates (width x height). */
  readonly faces: readonly DetectedFace[];
  readonly width: number;
  readonly height: number;
  /** The L2-normalized 512-d embedding of one of `faces`. */
  embed(face: DetectedFace): Promise<Float32Array>;
  /** Frees the pixels and deletes any temporary copy. Idempotent. */
  close(): void;
}

export interface FaceEmbedder {
  /** True for the stand-in; the screens tag themselves "Preview". */
  readonly preview: boolean;
  /** Opens the photo at `photoUrl` (file://). The caller must close() the still. */
  open(photoUrl: string): Promise<FaceStill>;
  /** Loads the model and runs it once, so the first real scan does not pay for it. */
  prewarm?: (() => Promise<void>) | undefined;
}

// ---------------------------------------------------------------------------------------
// The device embedder
// ---------------------------------------------------------------------------------------

/** The upright copy of a photo (step 1). */
export interface UprightStill {
  /** file:// URL of the upright JPEG the detector reads. */
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** Raw 8-bit pixels of the same upright image (any byte order). */
  pixels(): Promise<RawImage>;
  /** Deletes the copy. */
  release(): void;
}

/** The native steps (src/face/native.ts). */
export interface EmbedderNatives {
  loadUpright(photoUrl: string, maxSide: number): Promise<UprightStill>;
  /** ML Kit on a file:// image. */
  detect(url: string): readonly DetectedFace[];
  /** One model run on a 1x112x112x3 tensor; resolves a fresh copy of the 512 outputs. */
  run(input: Float32Array): Promise<Float32Array>;
  warmUp?: (() => Promise<void>) | undefined;
}

export class FaceOrientationError extends Error {
  constructor(detail: string) {
    super(`face detector and pixels disagree on orientation (${detail})`);
    this.name = 'FaceOrientationError';
  }
}

/** Puts a detector face into the still's pixel space (they normally already agree). */
function toStillSpace(face: DetectedFace, still: { width: number; height: number }): DetectedFace {
  const fw = face.frameWidth;
  const fh = face.frameHeight ?? (fw * still.height) / still.width;
  if (!(fw > 0 && fh > 0)) return face;
  const swapped =
    still.width !== still.height &&
    Math.abs(fw - still.height) < 1 &&
    Math.abs(fh - still.width) < 1 &&
    Math.abs(fw - still.width) >= 1;
  if (swapped) throw new FaceOrientationError(`${fw}x${fh} vs ${still.width}x${still.height}`);
  const s = scaleFace(face, still.width / fw, still.height / fh);
  return s === face ? face : { ...s, frameWidth: still.width, frameHeight: still.height };
}

export function createDeviceEmbedder(
  natives: EmbedderNatives,
  opts: { maxSide?: number } = {},
): FaceEmbedder {
  // fast-tflite must never run one model concurrently: one run at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f, f);
    chain = p.catch(() => undefined);
    return p;
  };
  const warmUp = natives.warmUp;

  return {
    preview: false,
    prewarm: warmUp ? () => serial(warmUp) : undefined,
    async open(photoUrl) {
      const still = await natives.loadUpright(photoUrl, opts.maxSide ?? STILL_MAX_SIDE);
      let faces: DetectedFace[];
      try {
        faces = natives.detect(still.url).map((f) => toStillSpace(f, still));
      } catch (e) {
        still.release();
        throw e;
      }
      let pixels: Promise<RawImage> | null = null;
      let closed = false;
      return {
        faces,
        width: still.width,
        height: still.height,
        async embed(face) {
          if (closed) throw new Error('the still is closed');
          pixels ??= still.pixels();
          const raw = await pixels;
          const f = scaleFace(face, raw.width / still.width, raw.height / still.height);
          const input = warpToInput(raw, alignTransform(f).m);
          const a = await serial(() => natives.run(input));
          const b = await serial(() => natives.run(flipInput(input)));
          return combineEmbeddings(a, b);
        },
        close() {
          if (closed) return;
          closed = true;
          pixels = null;
          still.release();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Loading the device embedder on first use
// ---------------------------------------------------------------------------------------

/**
 * A device embedder whose native half loads on first use. In the app `load` is
 * `() => import('../face/native').then((m) => m.getNativeEmbedder())`: Metro runs a module only
 * when it is first required, and import() requires it at call time, so nitro-image, the ML Kit
 * detector and fast-tflite (which create their native objects as their modules load) stay out
 * of app start. A native module that fails to start then fails only the scan or enrollment photo
 * that asked for it (both already show a rejected open() as "Try again"); the app, the room list
 * and Beats 2-4 keep working. A failed load is not cached, so a later try loads again.
 */
export function createLazyEmbedder(load: () => Promise<FaceEmbedder>): FaceEmbedder {
  let loading: Promise<FaceEmbedder> | null = null;
  const get = (): Promise<FaceEmbedder> => {
    // Promise.resolve().then(load): a load that throws synchronously still only rejects.
    loading ??= Promise.resolve()
      .then(load)
      .catch((e: unknown) => {
        loading = null;
        throw e;
      });
    return loading;
  };
  return {
    preview: false,
    open: async (photoUrl) => (await get()).open(photoUrl),
    prewarm: async () => {
      await (await get()).prewarm?.();
    },
  };
}

// ---------------------------------------------------------------------------------------
// The preview stand-in
// ---------------------------------------------------------------------------------------

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

/** The one face the stand-in reports when no detector is given (straight ahead, close). */
export const PREVIEW_FACE: DetectedFace = {
  yawAngle: 0,
  pitchAngle: 0,
  bounds: { x: 330, y: 480, width: 300, height: 300 },
  frameWidth: 960,
  frameHeight: 1280,
};

/**
 * The stand-in. `detect` is the real detector in the preview app (so the head-turn prompts
 * work on a phone), loaded on first use (a build without ML Kit, the simulator's, fails only the
 * capture), and a fixed face in tests.
 */
export function createPreviewEmbedder(
  seed = 0x5e6ad2,
  detect: (url: string) => readonly DetectedFace[] | Promise<readonly DetectedFace[]> = () => [
    PREVIEW_FACE,
  ],
): FaceEmbedder {
  const base = new Float32Array(FACE_MODEL.dim);
  const r = rng(seed);
  for (let i = 0; i < base.length; i++) base[i] = r();
  return {
    preview: true,
    async open(photoUrl) {
      const faces = await detect(photoUrl);
      return {
        faces,
        width: faces[0]?.frameWidth ?? PREVIEW_FACE.frameWidth,
        height: faces[0]?.frameHeight ?? PREVIEW_FACE.frameHeight ?? PREVIEW_FACE.frameWidth,
        async embed(face) {
          const noise = rng(seed ^ Math.round((face.yawAngle + 90) * 1000));
          const out = new Float32Array(FACE_MODEL.dim);
          for (let i = 0; i < out.length; i++) out[i] = (base[i] as number) + 0.35 * noise();
          return out;
        },
        close() {},
      };
    },
  };
}
