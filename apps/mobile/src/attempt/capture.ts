// Native half of the judge cam: clip file -> sampled JPEGs -> bytes, as ./frames capturePlan
// and shotTransform say (planning D10): 12 stills from expo-video-thumbnails (full resolution),
// each scaled by expo-image-manipulator to ≤ 512 px, then the landing crop, cut from the last
// still at full resolution (≤ 1024 px). Every JPEG stays ≤ 200 KB (lower quality if needed).
// A crop that fails to render is dropped and the 12 frames still go. App code only (needs a
// device); the plan, sizes and hashing it follows are pure (./frames, tested in node).
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';

import {
  capturePlan,
  JPEG_QUALITY,
  MAX_FRAME_BYTES,
  shotTransform,
  type CapturedFrame,
  type ShotKind,
} from './frames';

async function bytesOf(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

interface Still {
  uri: string;
  width: number;
  height: number;
}

/** One still at `tMs`; the one the crop is cut from is saved at full quality (no double loss). */
async function still(clipUri: string, tMs: number, quality: number): Promise<Still> {
  const t = await VideoThumbnails.getThumbnailAsync(clipUri, { time: tMs, quality });
  return { uri: t.uri, width: t.width, height: t.height };
}

async function encode(s: Still, kind: ShotKind): Promise<Uint8Array> {
  const tf = shotTransform(kind, s.width, s.height);
  if (!tf.crop && !tf.resize) {
    const bytes = await bytesOf(s.uri);
    if (bytes.length <= MAX_FRAME_BYTES) return bytes;
  }
  const ctx = ImageManipulator.manipulate(s.uri);
  if (tf.crop) ctx.crop(tf.crop);
  if (tf.resize) ctx.resize(tf.resize);
  const img = await ctx.renderAsync();
  let q = JPEG_QUALITY;
  let saved = await img.saveAsync({ compress: q, format: SaveFormat.JPEG });
  let bytes = await bytesOf(saved.uri);
  // Keep under the per-frame cap.
  while (bytes.length > MAX_FRAME_BYTES && q > 0.4) {
    q -= 0.15;
    saved = await img.saveAsync({ compress: q, format: SaveFormat.JPEG });
    bytes = await bytesOf(saved.uri);
  }
  return bytes;
}

export async function extractFrames(
  clipUri: string,
  durationMs: number,
  n?: number,
): Promise<CapturedFrame[]> {
  const plan = capturePlan(durationMs, n);
  const lastFrame = plan.filter((s) => s.kind === 'frame').length - 1;
  const out: CapturedFrame[] = [];
  let last: Still | null = null;
  for (const [i, shot] of plan.entries()) {
    if (shot.kind === 'frame') {
      const s = await still(clipUri, shot.t_ms, i === lastFrame ? 1 : JPEG_QUALITY);
      if (i === lastFrame) last = s;
      out.push({ t_ms: shot.t_ms, jpeg: await encode(s, 'frame') });
      continue;
    }
    // The landing crop, from the last frame's full-resolution still.
    try {
      const s = last ?? (await still(clipUri, shot.t_ms, 1));
      out.push({ t_ms: shot.t_ms, jpeg: await encode(s, 'landing_crop'), landing_crop: true });
    } catch (e) {
      console.warn('[yo] landing crop skipped', e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

export const readClip = bytesOf;
