// The reference routine as a moving skeleton (DANCE-OFF §2: the phone renders the reference as a
// mirrored animated skeleton while `media.video` is null). The routine's frames are quantized at
// ~15 fps; the display runs at 30, so poses are interpolated linearly between the two frames
// around t. Pure, tested.
import { JOINT_COUNT, KEYPOINT_LEN } from '@youre-on/shared/dance/joints';
import { POSE_C_SCALE, POSE_XY_SCALE } from '@youre-on/shared/dance/pose';
import type { RoutineData } from '@youre-on/shared/dance/routine';

/** Index of the last frame with t ≤ tMs (0 before the first). */
export function frameIndexAt(frames: readonly { t: number }[], tMs: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  if (hi <= 0 || tMs <= frames[0]!.t) return 0;
  if (tMs >= frames[hi]!.t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.t <= tMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The reference pose at `tMs` since t0 as a raw person (floats in [0, 1], unmirrored), clamped to
 * the routine's first / last frame. A joint missing in either neighbour stays missing.
 */
export function referencePoseAt(
  routine: Pick<RoutineData, 'frames'>,
  tMs: number,
  out: number[] = new Array<number>(KEYPOINT_LEN).fill(0),
): number[] {
  const frames = routine.frames;
  if (frames.length === 0) return out.fill(0);
  const i = frameIndexAt(frames, tMs);
  const f0 = frames[i]!;
  const f1 = frames[Math.min(frames.length - 1, i + 1)]!;
  const span = f1.t - f0.t;
  const u = span > 0 ? Math.max(0, Math.min(1, (tMs - f0.t) / span)) : 0;
  for (let j = 0; j < JOINT_COUNT; j++) {
    const c0 = f0.k[j * 3 + 2]!;
    const c1 = f1.k[j * 3 + 2]!;
    const both = c0 > 0 && c1 > 0;
    const w = both ? u : 0;
    out[j * 3] = (f0.k[j * 3]! + (f1.k[j * 3]! - f0.k[j * 3]!) * w) / POSE_XY_SCALE;
    out[j * 3 + 1] = (f0.k[j * 3 + 1]! + (f1.k[j * 3 + 1]! - f0.k[j * 3 + 1]!) * w) / POSE_XY_SCALE;
    out[j * 3 + 2] = (both ? Math.min(c0, c1) : c0) / POSE_C_SCALE;
  }
  return out;
}

/** The key move whose beat is closest after `tMs` within `windowMs` (the "next move" cue). */
export function upcomingKeyMove(
  routine: Pick<RoutineData, 'key_moves'>,
  tMs: number,
  windowMs = 1_500,
): { id: string; name: string; t: number } | null {
  for (const m of routine.key_moves) {
    if (m.t >= tMs) return m.t - tMs <= windowMs ? m : null;
  }
  return null;
}
