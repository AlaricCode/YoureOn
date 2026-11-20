// Judge-cam evidence (TASKS D3-M1, API-CONTRACT §2.9, SCHEMAS §4): which instants to sample,
// how each still becomes a JPEG, the per-frame sha256s, and the CameraEvidence record the frames
// upload carries. Pure TS: the native capture (expo-camera recordAsync, expo-video-thumbnails,
// expo-image-manipulator) is in ./capture.ts and follows capturePlan / shotTransform here.
//
// Planning D10, through the shared sampler (packages/shared/src/judge/frames, which the server
// and scripts/judge-eval.ts use too): 12 frames, 4 spread over the clip and 8 in its last ~1.2 s
// (the landing), each ≤ 768 px, then one landing crop: the last still again, its middle 80 % at
// full resolution (≤ 1024 px), flagged `landing_crop` and sent last.
import { bytesToHex } from '@noble/hashes/utils.js';
import { CameraEvidence, type EvidenceFrame } from '@youre-on/shared/evidence';
import {
  FRAME_MAX_PX,
  JUDGE_FRAMES,
  LANDING_CROP_MAX_PX,
  MAX_FRAME_BYTES,
  MAX_JUDGE_FRAMES,
  MIN_JUDGE_FRAMES,
  fitSize,
  judgeFrameCount,
  judgeFramesProblem,
  landingCropPlan,
  lastSampleMs,
} from '@youre-on/shared/judge/frames';
import type { Party } from '@youre-on/shared/primitives';

import { sha256 } from '../wallet/noble';

export {
  FRAME_MAX_PX,
  LANDING_CROP_MAX_PX,
  /** Max JPEG size per frame, the landing crop included (API-CONTRACT §2.9). */
  MAX_FRAME_BYTES,
};
export const DEFAULT_FRAMES = JUDGE_FRAMES;
export const MIN_FRAMES = MIN_JUDGE_FRAMES;
export const MAX_FRAMES = MAX_JUDGE_FRAMES;
export const JPEG_QUALITY = 0.8;

/** Frames spread over the clip before the action window. */
export const LEAD_FRAMES = 3;
/** The action window: the end of the clip the other frames are spread over, at most this long… */
export const ACTION_WINDOW_MS = 2700;
/** …and at most this share of a shorter clip. */
export const ACTION_WINDOW_SHARE = 0.75;

/**
 * The instants to sample: strictly increasing, all inside the clip. LEAD_FRAMES over the start,
 * the rest evenly over the clip's last ACTION_WINDOW_MS (340 ms apart at most), the last one just
 * before the end.
 *
 * The shared sampler (judgeFrameTimesMs) packs 8 frames into the last 1.2 s, which only shows a
 * throw when the clip is stopped the moment the object lands. On real throws whoever filmed
 * stopped a second or two later: the whole flight fell into the half-second gap before those 8
 * frames, and the judge was shown a release and then an empty floor ("it is never seen again",
 * a retake). The window is wide enough to hold the release, the flight and the landing.
 */
export function frameTimesMs(durationMs: number, n = DEFAULT_FRAMES): number[] {
  const count = judgeFrameCount(n);
  const end = lastSampleMs(durationMs);
  const span = Math.min(ACTION_WINDOW_MS, end * ACTION_WINDOW_SHARE);
  const start = end - span;
  const lead = Math.min(LEAD_FRAMES, count - 1);
  const rest = count - lead;
  const out: number[] = [];
  for (let i = 0; i < lead; i++) out.push(Math.round((start * i) / lead));
  // from the window's first instant to its last, both sampled
  for (let i = 0; i < rest; i++) out.push(Math.round(start + (span * i) / Math.max(1, rest - 1)));
  for (let i = 1; i < out.length; i++)
    if ((out[i] as number) <= (out[i - 1] as number)) out[i] = (out[i - 1] as number) + 1;
  return out;
}

export type ShotKind = 'frame' | 'landing_crop';

/** One image capture.ts makes from the clip. */
export interface Shot {
  t_ms: number;
  kind: ShotKind;
}

/** The stills for one clip: one per frame time, then (with `crop`) the crop of the last one. */
export function capturePlan(durationMs: number, n = DEFAULT_FRAMES, crop = true): Shot[] {
  const times = frameTimesMs(durationMs, n);
  const shots: Shot[] = times.map((t_ms) => ({ t_ms, kind: 'frame' }));
  if (crop) shots.push({ t_ms: times.at(-1) as number, kind: 'landing_crop' });
  return shots;
}

/** What expo-image-manipulator does to a full-resolution still: crop (or not), then resize. */
export interface ShotTransform {
  crop: { originX: number; originY: number; width: number; height: number } | null;
  /** null: already small enough (never scaled up). */
  resize: { width: number; height: number } | null;
}

export function shotTransform(kind: ShotKind, width: number, height: number): ShotTransform {
  if (kind === 'landing_crop') {
    const p = landingCropPlan(width, height);
    const crop = { originX: p.originX, originY: p.originY, width: p.width, height: p.height };
    const same = p.outWidth === p.width && p.outHeight === p.height;
    return { crop, resize: same ? null : { width: p.outWidth, height: p.outHeight } };
  }
  const out = fitSize(width, height, FRAME_MAX_PX);
  return { crop: null, resize: out.width === width && out.height === height ? null : out };
}

/** One sampled JPEG; the landing crop carries the flag. */
export interface CapturedFrame {
  t_ms: number;
  jpeg: Uint8Array;
  landing_crop?: boolean | undefined;
}

/** One way capture.ts saves a shot: a JPEG quality at an output size. */
export interface EncodeStep {
  quality: number;
  width: number;
  height: number;
}

/** JPEG qualities tried at the shot's full output size, best first. */
export const JPEG_QUALITIES = [JPEG_QUALITY, 0.65, 0.5, 0.35] as const;
/** Then smaller sizes (of the long side), at the lower qualities: 1024 -> 768 -> 512 px. */
const SMALLER_SIZES = [0.75, 0.5] as const;
const SMALLER_QUALITIES = [0.5, 0.35] as const;

/**
 * The encodings to try for a shot whose output is `out`, in order, until one is under
 * MAX_FRAME_BYTES: every quality at full size, then a step down in size (never up).
 */
export function encodeSteps(out: { width: number; height: number }): EncodeStep[] {
  const steps: EncodeStep[] = JPEG_QUALITIES.map((quality) => ({ quality, ...out }));
  const long = Math.max(out.width, out.height, 1);
  for (const f of SMALLER_SIZES) {
    const size = fitSize(out.width, out.height, Math.max(1, Math.round(long * f)));
    for (const quality of SMALLER_QUALITIES) steps.push({ quality, ...size });
  }
  return steps;
}

/** A JPEG the server takes: not empty, at most MAX_FRAME_BYTES (API-CONTRACT §2.9). */
export const fitsFrameCap = (jpeg: Uint8Array | null | undefined): jpeg is Uint8Array =>
  !!jpeg && jpeg.length > 0 && jpeg.length <= MAX_FRAME_BYTES;

/**
 * Saves the shot with each step in turn and returns the first JPEG under the cap, or null when
 * even the smallest is over it (the caller drops the shot: the server would refuse the whole
 * upload for one oversized image).
 */
export async function fitUnderCap(
  steps: readonly EncodeStep[],
  save: (step: EncodeStep) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  for (const step of steps) {
    const jpeg = await save(step);
    if (fitsFrameCap(jpeg)) return jpeg;
  }
  return null;
}

/**
 * Runs a capturePlan: `shoot` makes one shot's JPEG (null: none fits under the cap). The crop is
 * extra: one that throws or does not fit is dropped and the frames still go. A frame that does
 * not fit is dropped too (8..12 frames are accepted; buildEvidence refuses fewer); a frame that
 * throws fails the capture. Nothing returned is over the server's cap.
 */
export async function runCapturePlan(
  plan: readonly Shot[],
  shoot: (shot: Shot, index: number) => Promise<Uint8Array | null>,
  warn: (message: string) => void = () => undefined,
): Promise<CapturedFrame[]> {
  const out: CapturedFrame[] = [];
  for (const [i, shot] of plan.entries()) {
    if (shot.kind === 'frame') {
      const jpeg = await shoot(shot, i);
      if (fitsFrameCap(jpeg)) out.push({ t_ms: shot.t_ms, jpeg });
      else warn(`frame ${i} dropped: no JPEG under ${MAX_FRAME_BYTES} bytes`);
      continue;
    }
    try {
      const jpeg = await shoot(shot, i);
      if (fitsFrameCap(jpeg)) out.push({ t_ms: shot.t_ms, jpeg, landing_crop: true });
      else warn(`landing crop dropped: no JPEG under ${MAX_FRAME_BYTES} bytes`);
    } catch (e) {
      warn(`landing crop skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

export function hashFrames(frames: readonly CapturedFrame[]): EvidenceFrame[] {
  return frames.map((f, index) => ({
    index,
    t_ms: Math.max(0, Math.round(f.t_ms)),
    sha256: sha256Hex(f.jpeg),
    ...(f.landing_crop ? { landing_crop: true as const } : {}),
  }));
}

export function buildEvidence(a: {
  bet_id: string;
  attempt_no: number;
  clip: Uint8Array;
  mime: 'video/mp4' | 'video/quicktime';
  duration_ms: number;
  recorded_by: Party;
  recorded_at: string;
  frames: readonly CapturedFrame[];
}): CameraEvidence {
  for (const f of a.frames)
    if (f.jpeg.length === 0 || f.jpeg.length > MAX_FRAME_BYTES)
      throw new Error(`frame size ${f.jpeg.length} out of range`);
  // The server's D10 limits, checked here so a short extraction fails on the phone, not as a 422.
  const problem = judgeFramesProblem(a.frames);
  if (problem) throw new Error(problem.message);
  return CameraEvidence.parse({
    schema_version: 1,
    kind: 'camera',
    bet_id: a.bet_id,
    attempt_no: a.attempt_no,
    clip_sha256: sha256Hex(a.clip),
    clip_bytes: a.clip.length,
    mime: a.mime,
    duration_ms: Math.max(1, Math.round(a.duration_ms)),
    recorded_by: a.recorded_by,
    recorded_at: a.recorded_at,
    frames: hashFrames(a.frames),
  });
}

export const mimeForUri = (uri: string): 'video/mp4' | 'video/quicktime' =>
  /\.mp4($|\?)/i.test(uri) ? 'video/mp4' : 'video/quicktime';
