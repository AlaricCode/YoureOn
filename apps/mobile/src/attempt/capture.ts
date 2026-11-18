// Native half of the judge cam: clip file -> sampled JPEG frames (expo-video-thumbnails at
// quality 0.8, then expo-image-manipulator down to <= 512 px) -> bytes. App code only (needs a
// device); the sampling and hashing it feeds are pure (./frames, tested in node).
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { FRAME_MAX_PX, JPEG_QUALITY, MAX_FRAME_BYTES, frameTimesMs } from './frames';

async function bytesOf(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

async function oneFrame(clipUri: string, tMs: number): Promise<Uint8Array> {
  const thumb = await VideoThumbnails.getThumbnailAsync(clipUri, {
    time: tMs,
    quality: JPEG_QUALITY,
  });
  const big = Math.max(thumb.width, thumb.height);
  const uri = thumb.uri;
  if (big > FRAME_MAX_PX) {
    const ctx = ImageManipulator.manipulate(thumb.uri);
    ctx.resize(thumb.width >= thumb.height ? { width: FRAME_MAX_PX } : { height: FRAME_MAX_PX });
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
  return bytesOf(uri);
}

export async function extractFrames(
  clipUri: string,
  durationMs: number,
  n?: number,
): Promise<{ t_ms: number; jpeg: Uint8Array }[]> {
  const times = frameTimesMs(durationMs, n);
  const out: { t_ms: number; jpeg: Uint8Array }[] = [];
  for (const t of times) out.push({ t_ms: t, jpeg: await oneFrame(clipUri, t) });
  return out;
}

export const readClip = bytesOf;
