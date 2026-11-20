// Where the dancer is in a routine's reference clip, and how far to slide the clip so they are
// in the middle of the screen. A clip cut from wider footage can have its dancer well off centre
// (bye-bye-shuffle's is about 70% of the way across the frame); the routine's own pose track
// says where, so nothing is hand-tuned per clip. Pure, tested.
import { JOINT_COUNT } from '@youre-on/shared/dance/joints';
import { POSE_C_SCALE, POSE_XY_SCALE } from '@youre-on/shared/dance/pose';
import type { RoutineData } from '@youre-on/shared/dance/routine';

import { containRect, type Size } from './overlay';

/** A joint counts when the tracker was at least this sure of it. */
const MIN_CONFIDENCE = 0.2;
/**
 * Hands, feet and hair reach about this far (a fraction of the frame's width) past the outermost
 * joint. Measured on bye-bye-shuffle: the silhouette starts at 0.17, its leftmost joint at 0.25.
 */
export const REACH_MARGIN = 0.09;

/** The dancer across the whole routine, as fractions of the clip's width (unmirrored). */
export type Framing = {
  /** Where they usually are: the median of each frame's middle. */
  readonly centerX: number;
  /** The furthest left and right any joint ever goes. */
  readonly minX: number;
  readonly maxX: number;
};

type Frames = Pick<RoutineData, 'frames'>;
const CACHE = new WeakMap<Frames['frames'], Framing | null>();

/** The dancer's framing from the routine's pose track, or null when no frame has a sure joint. */
export function routineFraming(routine: Frames): Framing | null {
  const cached = CACHE.get(routine.frames);
  if (cached !== undefined) return cached;
  let minX = Infinity;
  let maxX = -Infinity;
  const middles: number[] = [];
  for (const f of routine.frames) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < JOINT_COUNT; j++) {
      if (f.k[j * 3 + 2]! / POSE_C_SCALE < MIN_CONFIDENCE) continue;
      const x = f.k[j * 3]! / POSE_XY_SCALE;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (hi < lo) continue;
    if (lo < minX) minX = lo;
    if (hi > maxX) maxX = hi;
    middles.push((lo + hi) / 2);
  }
  let framing: Framing | null = null;
  if (middles.length > 0) {
    middles.sort((a, b) => a - b);
    const m = middles.length >> 1;
    const centerX = middles.length % 2 ? middles[m]! : (middles[m - 1]! + middles[m]!) / 2;
    framing = { centerX, minX, maxX };
  }
  CACHE.set(routine.frames, framing);
  return framing;
}

/**
 * How far to slide the clip's picture to the LEFT (a fraction of its width; negative: to the
 * right) so the dancer's usual place is the middle, without ever sliding their furthest reach
 * out of the picture: a clip that fills the screen's width loses the strip it is slid by.
 */
export function clipSlide(framing: Framing | null): number {
  if (!framing) return 0;
  const left = Math.max(0, framing.minX - REACH_MARGIN);
  const right = Math.max(0, 1 - framing.maxX - REACH_MARGIN);
  return Math.min(left, Math.max(-right, framing.centerX - 0.5));
}

/**
 * The same for the MIRRORED clip as it is drawn (contain-fit in `view`): points to move it to
 * the RIGHT. Mirrored, a dancer on the clip's right is on the screen's left.
 */
export function mirroredClipShift(
  routine: Frames & Pick<RoutineData, 'w' | 'h'>,
  view: Size,
): number {
  if (!(view.width > 0) || !(view.height > 0)) return 0;
  const drawn = containRect(view, { width: routine.w, height: routine.h });
  return Math.round(clipSlide(routineFraming(routine)) * drawn.width);
}
