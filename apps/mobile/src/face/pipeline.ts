// The pure half of the on-device face embedder (TASKS D1-M3 / D4-M1): from a
// detected face in an upright still to the model's input tensor, and from the model's outputs to
// the final embedding. No native modules, so vitest runs all of it in Node.
//
//   still (upright, long side <= 1280) + detector face (bbox, 5 landmarks)
//     -> alignTransform: the similarity transform that maps the face's eyes, nose and mouth
//        corners onto InsightFace's 112x112 ArcFace template (least squares, no reflection);
//        with no eye landmarks, a square bbox crop with margin instead
//     -> warpToInput: bilinear inverse warp straight from the raw pixels (any 8-bit RGB/BGR/
//        RGBA/BGRA/ARGB/ABGR/X layout) into a 1x112x112x3 NHWC float32 tensor, RGB, normalized
//        (x - 127.5) / 127.5 as w600k_mbf expects; outside the image is 0 (cv2 borderValue)
//     -> the model runs on that tensor and on its mirror image (flipInput); combineEmbeddings
//        sums the two outputs and L2-normalizes, which makes the embedding mirror-invariant
//        (front-camera selfies vs back-camera scans) and steadier
import { FACE_INPUT_FLOATS, FACE_MODEL } from './model';

export const INPUT_SIZE = 112;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The detector's landmark names (react-native-vision-camera-face-detector `Landmarks`). */
export type LandmarkName =
  | 'LEFT_EYE'
  | 'RIGHT_EYE'
  | 'NOSE_BASE'
  | 'MOUTH_LEFT'
  | 'MOUTH_RIGHT'
  | 'LEFT_CHEEK'
  | 'RIGHT_CHEEK'
  | 'LEFT_EAR'
  | 'RIGHT_EAR'
  | 'MOUTH_BOTTOM';

export type Landmarks = Partial<Readonly<Record<LandmarkName, Point>>>;

/**
 * InsightFace `arcface_dst`: where the five points sit in a 112x112 aligned face, in image
 * order (the image-left eye first, whatever the subject's left is).
 */
export const ARCFACE_TEMPLATE: readonly [Point, Point, Point, Point, Point] = [
  { x: 38.2946, y: 51.6963 }, // eye, image-left
  { x: 73.5318, y: 51.5014 }, // eye, image-right
  { x: 56.0252, y: 71.7366 }, // nose tip
  { x: 41.5493, y: 92.3655 }, // mouth corner, image-left
  { x: 70.7299, y: 92.2041 }, // mouth corner, image-right
];

/**
 * Without eye landmarks, a square crop around the bbox centre, this many times the bbox's
 * larger side, approximates the ArcFace framing (an ML Kit box is about 2.4 inter-eye distances
 * wide; the template's eyes are 35 px apart in 112 px).
 */
export const BBOX_CROP_SCALE = 1.33;

/** A 2x3 affine matrix [a, b, c, d, e, f]: x' = a·x + b·y + c, y' = d·x + e·y + f. */
export type Affine = readonly [number, number, number, number, number, number];

export const applyAffine = (m: Affine, p: Point): Point => ({
  x: m[0] * p.x + m[1] * p.y + m[2],
  y: m[3] * p.x + m[4] * p.y + m[5],
});

export function invertAffine(m: Affine): Affine {
  const det = m[0] * m[4] - m[1] * m[3];
  if (!(Math.abs(det) > 1e-12)) throw new Error('affine transform is not invertible');
  const a = m[4] / det;
  const b = -m[1] / det;
  const d = -m[3] / det;
  const e = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}

/**
 * The least-squares similarity transform (uniform scale, rotation, translation; no reflection)
 * mapping `src[i]` onto `dst[i]`, as skimage SimilarityTransform / Umeyama in 2-D. Needs at
 * least two distinct points.
 */
export function similarityTransform(src: readonly Point[], dst: readonly Point[]): Affine {
  if (src.length !== dst.length || src.length < 2) throw new Error('need >= 2 point pairs');
  const n = src.length;
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i]!.x;
    sy += src[i]!.y;
    dx += dst[i]!.x;
    dy += dst[i]!.y;
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;
  let num1 = 0; // Σ p·q
  let num2 = 0; // Σ p×q
  let den = 0; // Σ |p|²
  for (let i = 0; i < n; i++) {
    const px = src[i]!.x - sx;
    const py = src[i]!.y - sy;
    const qx = dst[i]!.x - dx;
    const qy = dst[i]!.y - dy;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
  }
  if (!(den > 1e-9)) throw new Error('landmarks are degenerate');
  const a = num1 / den;
  const b = num2 / den;
  // [a -b; b a] · p + t
  return [a, -b, dx - (a * sx - b * sy), b, a, dy - (b * sx + a * sy)];
}

/** Maps the square crop around `box` (BBOX_CROP_SCALE x its larger side) onto 112x112. */
export function bboxTransform(box: Box, scale = BBOX_CROP_SCALE): Affine {
  const side = Math.max(box.width, box.height) * scale;
  if (!(side > 0)) throw new Error('empty face box');
  const s = INPUT_SIZE / side;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [s, 0, INPUT_SIZE / 2 - s * cx, 0, s, INPUT_SIZE / 2 - s * cy];
}

/**
 * The five template points the detector gave us, paired with their template positions. The two
 * eyes (and the two mouth corners) are ordered by x in the image, so the subject-vs-image
 * left/right naming and any mirroring do not matter. Null unless both eyes are present.
 */
export function landmarkPairs(lm: Landmarks | undefined): { src: Point[]; dst: Point[] } | null {
  const le = lm?.LEFT_EYE;
  const re = lm?.RIGHT_EYE;
  if (!le || !re) return null;
  const [e0, e1] = le.x <= re.x ? [le, re] : [re, le];
  const src: Point[] = [e0, e1];
  const dst: Point[] = [ARCFACE_TEMPLATE[0], ARCFACE_TEMPLATE[1]];
  if (lm.NOSE_BASE) {
    src.push(lm.NOSE_BASE);
    dst.push(ARCFACE_TEMPLATE[2]);
  }
  const ml = lm.MOUTH_LEFT;
  const mr = lm.MOUTH_RIGHT;
  if (ml && mr) {
    const [m0, m1] = ml.x <= mr.x ? [ml, mr] : [mr, ml];
    src.push(m0, m1);
    dst.push(ARCFACE_TEMPLATE[3], ARCFACE_TEMPLATE[4]);
  }
  return { src, dst };
}

export interface AlignInput {
  readonly bounds: Box;
  readonly landmarks?: Landmarks | undefined;
}

/** Image -> 112x112 template transform for one face: landmarks when usable, else the bbox. */
export function alignTransform(face: AlignInput): { m: Affine; method: 'landmarks' | 'bbox' } {
  const pairs = landmarkPairs(face.landmarks);
  if (pairs) {
    try {
      return { m: similarityTransform(pairs.src, pairs.dst), method: 'landmarks' };
    } catch {
      // degenerate landmarks (all on one point): fall through to the box
    }
  }
  return { m: bboxTransform(face.bounds), method: 'bbox' };
}

/** Scales a face's coordinates by (sx, sy), e.g. from the detector's frame to the raw pixels. */
export function scaleFace<F extends AlignInput>(face: F, sx: number, sy: number): F {
  if (sx === 1 && sy === 1) return face;
  const p = (q: Point): Point => ({ x: q.x * sx, y: q.y * sy });
  const landmarks: Record<string, Point> | undefined = face.landmarks
    ? Object.fromEntries(Object.entries(face.landmarks).map(([k, v]) => [k, p(v as Point)]))
    : undefined;
  return {
    ...face,
    bounds: {
      x: face.bounds.x * sx,
      y: face.bounds.y * sy,
      width: face.bounds.width * sx,
      height: face.bounds.height * sy,
    },
    ...(landmarks ? { landmarks: landmarks as Landmarks } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// Pixels -> tensor
// ---------------------------------------------------------------------------------------

/** nitro-image `PixelFormat`: the literal byte order in memory. */
export type PixelFormat =
  'ARGB' | 'BGRA' | 'ABGR' | 'RGBA' | 'XRGB' | 'BGRX' | 'XBGR' | 'RGBX' | 'RGB' | 'BGR' | 'unknown';

export interface RawImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly format: PixelFormat;
}

/** Byte offsets of R, G and B inside one pixel, and the bytes per pixel. */
export function channelLayout(format: PixelFormat): {
  r: number;
  g: number;
  b: number;
  bpp: number;
} {
  switch (format) {
    case 'RGBA':
    case 'RGBX':
      return { r: 0, g: 1, b: 2, bpp: 4 };
    case 'BGRA':
    case 'BGRX':
      return { r: 2, g: 1, b: 0, bpp: 4 };
    case 'ARGB':
    case 'XRGB':
      return { r: 1, g: 2, b: 3, bpp: 4 };
    case 'ABGR':
    case 'XBGR':
      return { r: 3, g: 2, b: 1, bpp: 4 };
    case 'RGB':
      return { r: 0, g: 1, b: 2, bpp: 3 };
    case 'BGR':
      return { r: 2, g: 1, b: 0, bpp: 3 };
    case 'unknown':
      throw new Error('unknown pixel format');
  }
}

/** w600k_mbf input normalization (InsightFace ArcFace: mean 127.5, std 127.5). */
export const normalizePixel = (v: number): number => (v - 127.5) / 127.5;

/**
 * Bilinear inverse warp of `img` through `m` (image -> template) into a fresh NHWC RGB float32
 * tensor of 112x112x3, normalized. Pixel centres are at integer coordinates (cv2.warpAffine);
 * samples outside the image read as 0 before normalization (so -1 after).
 */
export function warpToInput(img: RawImage, m: Affine): Float32Array {
  const { r, g, b, bpp } = channelLayout(img.format);
  const { width: w, height: h, data } = img;
  if (!(w > 0 && h > 0)) throw new Error('empty image');
  const stride = Math.floor(data.length / h);
  if (stride < w * bpp) throw new Error(`pixel buffer too short for ${w}x${h} ${img.format}`);
  const inv = invertAffine(m);
  const out = new Float32Array(FACE_INPUT_FLOATS);
  /** Byte offset of pixel (x, y), or -1 outside the image. */
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? -1 : y * stride + x * bpp;
  const read = (i: number, c: number): number => (i < 0 ? 0 : (data[i + c] as number));
  let o = 0;
  for (let v = 0; v < INPUT_SIZE; v++) {
    for (let u = 0; u < INPUT_SIZE; u++) {
      const sx = inv[0] * u + inv[1] * v + inv[2];
      const sy = inv[3] * u + inv[4] * v + inv[5];
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = at(x0, y0);
      const i10 = at(x0 + 1, y0);
      const i01 = at(x0, y0 + 1);
      const i11 = at(x0 + 1, y0 + 1);
      const mix = (c: number) =>
        w00 * read(i00, c) + w10 * read(i10, c) + w01 * read(i01, c) + w11 * read(i11, c);
      out[o++] = normalizePixel(mix(r));
      out[o++] = normalizePixel(mix(g));
      out[o++] = normalizePixel(mix(b));
    }
  }
  return out;
}

/** The NHWC tensor mirrored left-right (a mirrored aligned face is still aligned). */
export function flipInput(input: Float32Array): Float32Array {
  if (input.length !== FACE_INPUT_FLOATS) throw new Error(`input has ${input.length} values`);
  const out = new Float32Array(input.length);
  for (let v = 0; v < INPUT_SIZE; v++) {
    for (let u = 0; u < INPUT_SIZE; u++) {
      const from = (v * INPUT_SIZE + (INPUT_SIZE - 1 - u)) * 3;
      const to = (v * INPUT_SIZE + u) * 3;
      out[to] = input[from] as number;
      out[to + 1] = input[from + 1] as number;
      out[to + 2] = input[from + 2] as number;
    }
  }
  return out;
}

/** Sum of the model outputs (original + mirrored), L2-normalized. */
export function combineEmbeddings(...outputs: readonly Float32Array[]): Float32Array {
  if (outputs.length === 0) throw new Error('no outputs');
  const out = new Float32Array(FACE_MODEL.dim);
  for (const o of outputs) {
    if (o.length !== FACE_MODEL.dim) throw new Error(`output has ${o.length} values`);
    for (let i = 0; i < out.length; i++) {
      const x = o[i] as number;
      if (!Number.isFinite(x)) throw new Error(`output value ${i} is not finite`);
      out[i] = (out[i] as number) + x;
    }
  }
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += (out[i] as number) * (out[i] as number);
  const norm = Math.sqrt(sum);
  if (!(norm > 0)) throw new Error('cannot normalise a zero vector');
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / norm;
  return out;
}

// ---------------------------------------------------------------------------------------
// Stills and faces
// ---------------------------------------------------------------------------------------

/** The still's size after the upright resize: the long side capped at `maxSide`, never upscaled. */
export function uprightSize(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  if (!(width > 0 && height > 0)) throw new Error('empty photo');
  const s = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** Long side of the stills the embedder works on (ARCHITECTURE §3.1: 960x1280). */
export const STILL_MAX_SIDE = 1280;

/** A scanned face must be at least this share of the still's width (about 1.4 m away). */
export const MIN_SCAN_FACE_SHARE = 0.08;
/** Faces at least this share of the largest one's area count as "someone you might mean". */
export const RIVAL_FACE_AREA_SHARE = 0.5;

export type ProbePick<F> =
  | { readonly ok: true; readonly face: F }
  | { readonly ok: false; readonly problem: 'no_face' | 'too_far' };

/**
 * Which face a scan is about: of the faces close to the largest one in size, the one nearest
 * the centre of the frame (you point the camera at the person you mean). A match only ever
 * addresses a challenge, and the card names the person before anything is sent.
 */
export function pickProbeFace<F extends { readonly bounds: Box }>(
  faces: readonly F[],
  frame: { readonly width: number; readonly height: number },
): ProbePick<F> {
  if (faces.length === 0) return { ok: false, problem: 'no_face' };
  const area = (f: F) => f.bounds.width * f.bounds.height;
  const largest = faces.reduce((a, f) => (area(f) > area(a) ? f : a));
  if (largest.bounds.width / frame.width < MIN_SCAN_FACE_SHARE) {
    return { ok: false, problem: 'too_far' };
  }
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  const dist = (f: F) =>
    Math.hypot(f.bounds.x + f.bounds.width / 2 - cx, f.bounds.y + f.bounds.height / 2 - cy);
  const rivals = faces.filter((f) => area(f) >= RIVAL_FACE_AREA_SHARE * area(largest));
  const face = rivals.reduce((a, f) => (dist(f) < dist(a) ? f : a));
  return { ok: true, face };
}

/** Distance between the eyes in pixels, if both are known (capture metadata for the server). */
export function eyeDistance(lm: Landmarks | undefined): number | null {
  const a = lm?.LEFT_EYE;
  const b = lm?.RIGHT_EYE;
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
}
