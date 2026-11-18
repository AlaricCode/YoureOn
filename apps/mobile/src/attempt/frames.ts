// Judge-cam evidence (TASKS D3-M1, API-CONTRACT §2.9, SCHEMAS §4): which instants to sample,
// how each still becomes a JPEG, the per-frame sha256s, and the CameraEvidence record the frames
// upload carries. Pure TS: the native capture (expo-camera recordAsync, expo-video-thumbnails,
// expo-image-manipulator) is in ./capture.ts and follows capturePlan / shotTransform here.
//
// Planning D10, through the shared sampler (packages/shared/src/judge/frames, which the server
// and scripts/judge-eval.ts use too): 12 frames, 4 spread over the clip and 8 in its last ~1.2 s
// (the landing), each ≤ 512 px, then one landing crop: the last still again, its middle 80 % at
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
  judgeFramesProblem,
  judgeFrameTimesMs,
  landingCropPlan,
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

/** The instants to sample (planning D10): strictly increasing, all inside the clip. */
export function frameTimesMs(durationMs: number, n = DEFAULT_FRAMES): number[] {
  return judgeFrameTimesMs(durationMs, n);
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
