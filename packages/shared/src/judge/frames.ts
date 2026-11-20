// What the attempt judge sees (planning README D10: "12–16 frames clustered at the end of the
// attempt plus one landing crop"). One sampler for the phone (apps/mobile/src/attempt), the
// server's limits and prompt labels (apps/server/src/judge) and the eval (scripts/judge-eval.ts),
// so the three always look at the same instants of a clip.
//
//   12 frames, each ≤ 1280 px (the clip's own size): LEAD_IN_FRAMES (4) spread over the clip before the landing window
//   (the release and the flight), then 8 packed into its last LANDING_WINDOW_MS (~1.2 s: the
//   landing and where the bottle comes to rest), the last one FRAME_END_GUARD_MS before the end.
//   + 1 landing crop: the last frame again, taken from the full-resolution still, cropped to its
//   middle LANDING_CROP_FRACTION (80 %) and at most 1024 px (native pixels for the 720p judge-cam
//   clip, so the taped cap is ~2.5x as many pixels across as in a 512 px frame). It is sent last,
//   marked `landing_crop: true` in CameraEvidence.frames, and is also ≤ 200 KB.
//
// Older uploads stay valid: 8..12 frames with no crop (8 "u4d4" frames from an earlier phone
// build, scripts/cp1-drive.ts --frames 8..12). The server labels every frame inside the landing
// window as a landing frame, so an 8-frame upload's dense last second is labelled too.
// Pure TS (no Node or RN APIs): it runs on the phone, the server and in scripts.

/** Frames the phone sends per attempt (the landing crop comes on top). */
export const JUDGE_FRAMES = 12;
/** The server's limits on regular frames per upload (the landing crop is not counted). */
export const MIN_JUDGE_FRAMES = 8;
export const MAX_JUDGE_FRAMES = 12;
/** At most one landing crop per upload, always the last image. */
export const MAX_LANDING_CROPS = 1;
/** Images per upload at most: the frames plus the crop. */
export const MAX_UPLOAD_IMAGES = MAX_JUDGE_FRAMES + MAX_LANDING_CROPS;
/** Frames spread over the clip before the landing window. */
export const LEAD_IN_FRAMES = 4;
/** The landing window: the last ~1.2 s of the clip. */
export const LANDING_WINDOW_MS = 1200;
/** Never sample the very last ms: thumbnailers often fail at the exact end. */
export const FRAME_END_GUARD_MS = 80;
/**
 * Longest side of a regular frame: 1280, the clip's own resolution (720 x 1280), so a frame is
 * never scaled down. It was 512 and then 768 to keep the upload small; at those sizes a paper
 * ball thrown from across a room is a dot four to twelve pixels wide, the judge described real
 * makes as "seems to drop toward the bin", and the object tracker (SAM 3.1) never found the ball
 * at all, in the air or lying in plain view on the floor. The phones are on Wi-Fi: what matters
 * is that the ball can be seen. Each JPEG still fits the 200 KB a frame may weigh (the encoder
 * steps the quality down before it ever shrinks the picture).
 */
export const FRAME_MAX_PX = 1280;
/** Longest side of the landing crop. */
export const LANDING_CROP_MAX_PX = 1024;
/** The crop keeps the middle 80 % of the still in each direction. */
export const LANDING_CROP_FRACTION = 0.8;
/**
 * Per JPEG, the landing crop included (API-CONTRACT §2.9; = the DB's attempt_frames_size CHECK,
 * octet_length(bytes) ≤ 204800).
 */
export const MAX_FRAME_BYTES = 200 * 1024;

/** A requested frame count, clamped to the server's 8..12. */
export function judgeFrameCount(n: number = JUDGE_FRAMES): number {
  const r = Number.isFinite(n) ? Math.round(n) : JUDGE_FRAMES;
  return Math.min(MAX_JUDGE_FRAMES, Math.max(MIN_JUDGE_FRAMES, r));
}

/** The last instant sampled (ms): just before the end of the clip. */
export const lastSampleMs = (durationMs: number): number =>
  Math.max(1, Math.round(durationMs) - FRAME_END_GUARD_MS);

/** How long the landing window is for a clip: 1.2 s, or 60 % of a clip under ~2 s. */
export function landingWindowMs(durationMs: number): number {
  return Math.min(LANDING_WINDOW_MS, lastSampleMs(durationMs) * 0.6);
}

/** Frames at or after this offset (ms from clip start) show the landing. */
export function landingStartMs(durationMs: number): number {
  return lastSampleMs(durationMs) - landingWindowMs(durationMs);
}

/** Is a frame at `tMs` of a clip `durationMs` long inside the landing window? */
export const isLandingFrame = (tMs: number, durationMs: number): boolean =>
  tMs >= landingStartMs(durationMs);

/**
 * The instants (ms from clip start) to sample: LEAD_IN_FRAMES uniform over the clip before the
 * landing window, the rest evenly over the window, ending FRAME_END_GUARD_MS before the end.
 * Strictly increasing, even for very short clips.
 */
export function judgeFrameTimesMs(durationMs: number, n: number = JUDGE_FRAMES): number[] {
  const count = judgeFrameCount(n);
  const end = lastSampleMs(durationMs);
  const span = landingWindowMs(durationMs);
  const start = end - span;
  const lead = Math.min(LEAD_IN_FRAMES, count - 1);
  const landing = count - lead;
  const out: number[] = [];
  for (let i = 0; i < lead; i++) out.push(Math.round((start * i) / lead));
  for (let i = 1; i <= landing; i++) out.push(Math.round(start + (span * i) / landing));
  for (let i = 1; i < out.length; i++)
    if ((out[i] as number) <= (out[i - 1] as number)) out[i] = (out[i - 1] as number) + 1;
  return out;
}

/** A frame's output size: the still scaled down (never up) to fit `maxPx` on its long side. */
export function fitSize(
  width: number,
  height: number,
  maxPx: number = FRAME_MAX_PX,
): { width: number; height: number } {
  const scale = Math.min(1, maxPx / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface LandingCropPlan {
  /** The crop rectangle in the full-resolution still (pixels). */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** The JPEG's size after the crop (≤ LANDING_CROP_MAX_PX on its long side). */
  outWidth: number;
  outHeight: number;
}

/**
 * The landing crop of a `width` x `height` still: its middle LANDING_CROP_FRACTION, centred,
 * then scaled down to LANDING_CROP_MAX_PX if still larger. 1280x720 -> 1024x576 at native pixels.
 */
export function landingCropPlan(width: number, height: number): LandingCropPlan {
  const w = Math.max(1, Math.round(width * LANDING_CROP_FRACTION));
  const h = Math.max(1, Math.round(height * LANDING_CROP_FRACTION));
  const out = fitSize(w, h, LANDING_CROP_MAX_PX);
  return {
    originX: Math.max(0, Math.floor((width - w) / 2)),
    originY: Math.max(0, Math.floor((height - h) / 2)),
    width: w,
    height: h,
    outWidth: out.width,
    outHeight: out.height,
  };
}

/** The frames of one upload, as CameraEvidence.frames lists them (the crop flag only). */
export interface FrameMeta {
  landing_crop?: boolean | undefined;
}

/**
 * Why an upload's frame list breaks the D10 limits, or null when it is fine: 8..12 regular
 * frames, at most one landing crop, and the crop last.
 */
export function judgeFramesProblem(
  frames: readonly FrameMeta[],
): { path: string; message: string } | null {
  const crops = frames.filter((f) => f.landing_crop === true).length;
  const regular = frames.length - crops;
  if (regular < MIN_JUDGE_FRAMES || regular > MAX_JUDGE_FRAMES)
    return {
      path: 'frame',
      message: `send ${MIN_JUDGE_FRAMES} to ${MAX_JUDGE_FRAMES} frames (got ${regular})`,
    };
  if (crops > MAX_LANDING_CROPS)
    return { path: 'evidence.frames', message: `at most ${MAX_LANDING_CROPS} landing crop` };
  if (crops === 1 && frames.at(-1)?.landing_crop !== true)
    return {
      path: `evidence.frames.${frames.findIndex((f) => f.landing_crop === true)}.landing_crop`,
      message: 'the landing crop must be the last frame',
    };
  return null;
}
