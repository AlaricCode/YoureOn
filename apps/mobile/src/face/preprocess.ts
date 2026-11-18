// The pure half of the on-device embedder (TASKS D1-M3, D4-M1): where to crop, and how pixels
// become the model's input. The native half (decode, resize, crop, run) is enroll/embedder.ts.
// Pure TS, so the arithmetic is tested in node.
//
//   photo ─▶ upright copy, longer side ≤ 1280 px ─▶ square crop around the face box ─▶ 112 × 112
//         ─▶ RGB float32 NHWC, (v − 127.5) / 127.5 ─▶ w600k_mbf ─▶ 512 floats ─▶ L2-normalise
//
// InsightFace's ArcFace models take RGB scaled to [-1, 1] (input_mean = input_std = 127.5).
import { FACE_INPUT_FLOATS, FACE_MODEL } from './model';

/** Side of the model input (112). */
export const FACE_SIDE = FACE_MODEL.inputShape[1];

/** Longer side of the upright working copy (ARCHITECTURE §3.1 captures at 960 × 1280). */
export const WORKING_MAX_SIDE = 1280;

/**
 * Crop side as a multiple of the detector's face box (its larger side). ML Kit's box runs from
 * the brows to the chin; ArcFace was trained on aligned crops with some forehead and jaw, so a
 * little margin helps. Tune on the phones (docs/qa-device.md).
 */
export const FACE_CROP_SCALE = 1.15;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UprightPlan {
  /** Size to resize the decoded photo to; resizing also bakes in its EXIF orientation. */
  width: number;
  height: number;
  /** Detector coordinates → working-copy coordinates. */
  sx: number;
  sy: number;
}

/**
 * Plans the upright working copy. The detector reports boxes in the photo's upright frame
 * (frameWidth × frameHeight); the decoded image reports its upright size. They must describe the
 * same picture (same aspect within 2 %), or the crop would land on the wrong spot: null then.
 */
export function uprightPlan(
  image: { width: number; height: number },
  frame: { frameWidth: number; frameHeight: number },
  maxSide = WORKING_MAX_SIDE,
): UprightPlan | null {
  const { width: iw, height: ih } = image;
  const { frameWidth: fw, frameHeight: fh } = frame;
  if (!(iw > 0 && ih > 0 && fw > 0 && fh > 0)) return null;
  if (Math.abs(iw / ih - fw / fh) / (fw / fh) > 0.02) return null;
  const k = Math.min(1, maxSide / Math.max(iw, ih));
  const width = Math.max(1, Math.round(iw * k));
  const height = Math.max(1, Math.round(ih * k));
  return { width, height, sx: width / fw, sy: height / fh };
}

/**
 * The square to crop around a face box, in working-copy pixels: centred on the box, side =
 * `scale` × the box's larger side, shifted (then if need be shrunk) to stay inside the image.
 * Returns integer [x0, y0, x1, y1) with x1 − x0 = y1 − y0 ≥ 1.
 */
export function faceCropRect(
  box: Box,
  image: { width: number; height: number },
  scale = FACE_CROP_SCALE,
): { x0: number; y0: number; x1: number; y1: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let side = Math.max(box.width, box.height) * scale;
  side = Math.max(1, Math.min(side, image.width, image.height));
  let x0 = cx - side / 2;
  let y0 = cy - side / 2;
  x0 = Math.min(Math.max(0, x0), image.width - side);
  y0 = Math.min(Math.max(0, y0), image.height - side);
  const s = Math.max(1, Math.floor(side));
  const ix = Math.max(0, Math.min(Math.round(x0), image.width - s));
  const iy = Math.max(0, Math.min(Math.round(y0), image.height - s));
  return { x0: ix, y0: iy, x1: ix + s, y1: iy + s };
}

/** Byte offsets of R, G, B within one pixel, and bytes per pixel, for each Nitro pixel format. */
export function channelLayout(
  format: string,
): { r: number; g: number; b: number; stride: number } | null {
  switch (format) {
    case 'RGBA':
    case 'RGBX':
      return { r: 0, g: 1, b: 2, stride: 4 };
    case 'BGRA':
    case 'BGRX':
      return { r: 2, g: 1, b: 0, stride: 4 };
    case 'ARGB':
    case 'XRGB':
      return { r: 1, g: 2, b: 3, stride: 4 };
    case 'ABGR':
    case 'XBGR':
      return { r: 3, g: 2, b: 1, stride: 4 };
    case 'RGB':
      return { r: 0, g: 1, b: 2, stride: 3 };
    case 'BGR':
      return { r: 2, g: 1, b: 0, stride: 3 };
    default:
      return null;
  }
}

/**
 * 112 × 112 pixels → the model's input: float32 NHWC, RGB, (v − 127.5) / 127.5. Rows may be
 * padded (`bytesPerRow`); the decoder's pixel format decides the channel order.
 */
export function toModelInput(
  bytes: Uint8Array,
  width: number,
  height: number,
  format: string,
  bytesPerRow?: number,
): Float32Array {
  if (width !== FACE_SIDE || height !== FACE_SIDE) {
    throw new Error(`model input must be ${FACE_SIDE}×${FACE_SIDE}, got ${width}×${height}`);
  }
  const layout = channelLayout(format);
  if (!layout) throw new Error(`unsupported pixel format ${format}`);
  const row = bytesPerRow ?? width * layout.stride;
  if (bytes.length < row * (height - 1) + width * layout.stride) {
    throw new Error(`pixel buffer too small: ${bytes.length} bytes`);
  }
  const out = new Float32Array(FACE_INPUT_FLOATS);
  let o = 0;
  for (let y = 0; y < height; y++) {
    let p = y * row;
    for (let x = 0; x < width; x++, p += layout.stride) {
      out[o++] = ((bytes[p + layout.r] as number) - 127.5) / 127.5;
      out[o++] = ((bytes[p + layout.g] as number) - 127.5) / 127.5;
      out[o++] = ((bytes[p + layout.b] as number) - 127.5) / 127.5;
    }
  }
  return out;
}
