// DANCE-OFF §2: the quantized pose series the judge-cam phone records, hashes and uploads.
// Every value is an int (x, y in 0..10000, c in 0..1000), so no float is ever hashed, and the
// phone and the server both score the DEQUANTIZED values: bit-identical inputs on Hermes and V8.
import { z } from 'zod/v4';
import { hashJcs } from '../jcs';
import { JOINT_COUNT, KEYPOINT_LEN } from './joints';

export const POSE_SCHEMA_VERSION = 1 as const;
/** x and y are quantized to 0..POSE_XY_SCALE. */
export const POSE_XY_SCALE = 10_000;
/** c is quantized to 0..POSE_C_SCALE. */
export const POSE_C_SCALE = 1_000;
export const POSE_MAX_FRAMES = 700;
export const POSE_MAX_FPS = 30;
/** Frame times are ms since round t0 (count-in frames are negative). */
export const POSE_T_MIN_MS = -3_000;
export const POSE_T_MAX_MS = 20_000;
export const SYNC_OFFSET_MAX_MS = 500;

const Int = z.number().int();

/** One quantized person: [x, y, c] × 19 ints. */
export const PoseKeypoints = z
  .array(Int.min(0).max(POSE_XY_SCALE))
  .length(KEYPOINT_LEN)
  .refine((k) => {
    for (let j = 0; j < JOINT_COUNT; j++) if (k[j * 3 + 2]! > POSE_C_SCALE) return false;
    return true;
  }, `c must be 0..${POSE_C_SCALE}`);
export type PoseKeypoints = z.infer<typeof PoseKeypoints>;

export const PoseFrame = z.strictObject({
  /** ms since round t0 (the shared start instant), −3000..20000. */
  t: Int.min(POSE_T_MIN_MS).max(POSE_T_MAX_MS),
  /** People Vision saw in this frame (extra people are counted, never scored). */
  n: Int.min(0).max(32),
  /** Player A (left at round start), or null when not seen. */
  a: PoseKeypoints.nullable(),
  b: PoseKeypoints.nullable(),
});
export type PoseFrame = z.infer<typeof PoseFrame>;

/** Hashed and uploaded: pose_sha256 = hashJcs(PoseSeries). */
export const PoseSeries = z
  .strictObject({
    schema_version: z.literal(POSE_SCHEMA_VERSION),
    /** Upright image size, for aspect-correct vectors. */
    w: Int.min(1).max(8192),
    h: Int.min(1).max(8192),
    fps_cap: Int.min(1).max(POSE_MAX_FPS),
    /** The already-applied A/V offset (DANCE-OFF §4.4): the scorer subtracts it from every t. */
    sync_offset_ms: Int.min(-SYNC_OFFSET_MAX_MS).max(SYNC_OFFSET_MAX_MS),
    frames: z.array(PoseFrame).max(POSE_MAX_FRAMES),
  })
  .superRefine((s, ctx) => {
    for (let i = 1; i < s.frames.length; i++)
      if (s.frames[i]!.t < s.frames[i - 1]!.t) {
        ctx.addIssue({ code: 'custom', path: ['frames', i, 't'], message: 't must not decrease' });
        return;
      }
  });
export type PoseSeries = z.infer<typeof PoseSeries>;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
/** Math.round, with −0 normalized to 0 (JCS would print both as 0; this keeps === honest). */
const roundInt = (v: number): number => Math.round(v) + 0;

/**
 * Raw person (floats in [0, 1], from the native module) → quantized ints. Non-finite values
 * become 0; a joint with c = 0 keeps its (clamped) position, which the scorer never reads.
 */
export function quantizePerson(k: readonly number[]): number[] {
  if (k.length !== KEYPOINT_LEN) throw new Error(`a person has ${KEYPOINT_LEN} values`);
  const out = new Array<number>(KEYPOINT_LEN);
  for (let j = 0; j < JOINT_COUNT; j++) {
    const x = k[j * 3]!;
    const y = k[j * 3 + 1]!;
    const c = k[j * 3 + 2]!;
    out[j * 3] = roundInt(clamp01(Number.isFinite(x) ? x : 0) * POSE_XY_SCALE);
    out[j * 3 + 1] = roundInt(clamp01(Number.isFinite(y) ? y : 0) * POSE_XY_SCALE);
    out[j * 3 + 2] = roundInt(clamp01(Number.isFinite(c) ? c : 0) * POSE_C_SCALE);
  }
  return out;
}

/** Quantized ints → floats in [0, 1]. The scorer only ever reads these. */
export function dequantizePerson(q: readonly number[]): number[] {
  const out = new Array<number>(KEYPOINT_LEN);
  for (let j = 0; j < JOINT_COUNT; j++) {
    out[j * 3] = (q[j * 3] ?? 0) / POSE_XY_SCALE;
    out[j * 3 + 1] = (q[j * 3 + 1] ?? 0) / POSE_XY_SCALE;
    out[j * 3 + 2] = (q[j * 3 + 2] ?? 0) / POSE_C_SCALE;
  }
  return out;
}

/** pose_sha256 = sha256(JCS(series)). Callers parse with PoseSeries first (as for every record). */
export const poseSha256 = (series: PoseSeries): string => hashJcs(series);
