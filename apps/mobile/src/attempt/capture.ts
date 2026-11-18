// Native half of the judge cam: clip file -> sampled JPEGs -> bytes, as ./frames capturePlan
// and shotTransform say (planning D10): 12 stills from expo-video-thumbnails (full resolution),
// each scaled by expo-image-manipulator to ≤ 512 px, then the landing crop, cut from the last
// still at full resolution (≤ 1024 px). Every JPEG stays ≤ 200 KB: lower quality, then a smaller
// size if needed (./frames encodeSteps). A crop that fails to render, or that is still over the
// cap at the smallest step, is dropped and the 12 frames still go; nothing over the cap is ever
// sent (./frames runCapturePlan). App code only (needs a device); the plan, sizes, steps and
// hashing it follows are pure (./frames, tested in node).
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';

import {
  capturePlan,
  encodeSteps,
  fitsFrameCap,
  fitUnderCap,
  JPEG_QUALITY,
  runCapturePlan,
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

/** The shot as a JPEG under the cap (quality, then size, steps down), or null if none fits. */
async function encode(s: Still, kind: ShotKind): Promise<Uint8Array | null> {
  const tf = shotTransform(kind, s.width, s.height);
  if (!tf.crop && !tf.resize) {
    const bytes = await bytesOf(s.uri);
    if (fitsFrameCap(bytes)) return bytes;
  }
  // The size the crop (or the whole still) has before any resize.
  const base = tf.crop
    ? { width: tf.crop.width, height: tf.crop.height }
    : { width: s.width, height: s.height };
  const rendered = new Map<string, ImageRef>();
  return fitUnderCap(encodeSteps(tf.resize ?? base), async (step) => {
    const k = `${step.width}x${step.height}`;
    let img = rendered.get(k);
    if (!img) {
      const ctx = ImageManipulator.manipulate(s.uri);
      if (tf.crop) ctx.crop(tf.crop);
      if (step.width !== base.width || step.height !== base.height)
        ctx.resize({ width: step.width, height: step.height });
      img = await ctx.renderAsync();
      rendered.set(k, img);
    }
    const saved = await img.saveAsync({ compress: step.quality, format: SaveFormat.JPEG });
    return bytesOf(saved.uri);
  });
}

export async function extractFrames(
  clipUri: string,
  durationMs: number,
  n?: number,
): Promise<CapturedFrame[]> {
  const plan = capturePlan(durationMs, n);
  const lastFrame = plan.filter((s) => s.kind === 'frame').length - 1;
  let last: Still | null = null;
  return runCapturePlan(
    plan,
    async (shot, i) => {
      if (shot.kind === 'frame') {
        const s = await still(clipUri, shot.t_ms, i === lastFrame ? 1 : JPEG_QUALITY);
        if (i === lastFrame) last = s;
        return encode(s, 'frame');
      }
      // The landing crop, from the last frame's full-resolution still.
      return encode(last ?? (await still(clipUri, shot.t_ms, 1)), 'landing_crop');
    },
    (message) => console.warn('[yo]', message),
  );
}

export const readClip = bytesOf;
