// Judge-cam evidence (TASKS D3-M1, API-CONTRACT §2.9, SCHEMAS §4): which instants to sample,
// the per-frame sha256s, and the CameraEvidence record the frames upload carries. Pure TS: the
// native capture (expo-camera recordAsync, expo-video-thumbnails, expo-image-manipulator) is in
// ./capture.ts and hands its bytes here.
import { bytesToHex } from '@noble/hashes/utils.js';
import { CameraEvidence, type EvidenceFrame } from '@youre-on/shared/evidence';
import type { Party } from '@youre-on/shared/primitives';

import { sha256 } from '../wallet/noble';

export const DEFAULT_FRAMES = 8;
export const MIN_FRAMES = 8;
export const MAX_FRAMES = 12;
/** Max JPEG size per frame (API-CONTRACT §2.9). */
export const MAX_FRAME_BYTES = 200 * 1024;
export const FRAME_MAX_PX = 512;
export const JPEG_QUALITY = 0.8;
/** Never sample the very last ms: thumbnailers often fail at the exact end. */
const END_GUARD_MS = 80;

/**
 * "u4d4" (FINDINGS §3.3): half the frames uniform over the first 60 % of the clip, half dense
 * over the last second, so the landing is always in frame. Strictly increasing, all in range.
 */
export function frameTimesMs(durationMs: number, n = DEFAULT_FRAMES): number[] {
  const count = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(n)));
  const end = Math.max(1, durationMs - END_GUARD_MS);
  const dense = Math.floor(count / 2);
  const uniform = count - dense;
  const denseSpan = Math.min(1000, end * 0.4);
  const denseStart = end - denseSpan;
  const out: number[] = [];
  for (let i = 0; i < uniform; i++) out.push(Math.round((denseStart * i) / uniform));
  for (let i = 1; i <= dense; i++) out.push(Math.round(denseStart + (denseSpan * i) / dense));
  // Strictly increasing even for very short clips.
  for (let i = 1; i < out.length; i++) if ((out[i] as number) <= (out[i - 1] as number)) out[i] = (out[i - 1] as number) + 1;
  return out;
}

export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

export function hashFrames(frames: readonly { t_ms: number; jpeg: Uint8Array }[]): EvidenceFrame[] {
  return frames.map((f, index) => ({ index, t_ms: Math.max(0, Math.round(f.t_ms)), sha256: sha256Hex(f.jpeg) }));
}

export function buildEvidence(a: {
  bet_id: string;
  attempt_no: number;
  clip: Uint8Array;
  mime: 'video/mp4' | 'video/quicktime';
  duration_ms: number;
  recorded_by: Party;
  recorded_at: string;
  frames: readonly { t_ms: number; jpeg: Uint8Array }[];
}): CameraEvidence {
  for (const f of a.frames)
    if (f.jpeg.length === 0 || f.jpeg.length > MAX_FRAME_BYTES) throw new Error(`frame size ${f.jpeg.length} out of range`);
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
