// Synthetic dancers for the dance tests: the reference pose at a time, shrunk uniformly (so limb
// directions do not change) and moved left or right, as two people side by side in one frame.
import { getRoutine, type RoutineData } from '@youre-on/shared/dance/routine';

import { referencePoseAt } from '../model/reference';
import type { PoseInput } from '../model/pipeline';

export const WAVE_POP: RoutineData = getRoutine('wave-pop')!;

/** A raw person scaled by `s` about the image centre and shifted by `dx` (normalized x). */
export function place(k: readonly number[], s: number, dx: number): number[] {
  const out = k.slice();
  for (let j = 0; j < 19; j++) {
    out[j * 3] = 0.5 + (k[j * 3]! - 0.5) * s + dx;
    out[j * 3 + 1] = 0.5 + (k[j * 3 + 1]! - 0.5) * s;
  }
  return out;
}

/** The left player (A) dancing the routine at `tMs`. */
export const leftDancer = (r: RoutineData, tMs: number): number[] =>
  place(referencePoseAt(r, tMs), 0.5, -0.22);

/** The right player (B) holding the routine's first pose (standing still). */
export const rightStill = (r: RoutineData): number[] => place(referencePoseAt(r, 0), 0.5, 0.22);

/** A native onPoses frame with these people. */
export const frame = (t: number, ts: number, people: number[][]): PoseInput => ({
  t,
  ts,
  w: 720,
  h: 1280,
  fps: 30,
  people: people.map((k) => ({ k })),
});
