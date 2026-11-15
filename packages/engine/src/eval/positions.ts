/**
 * Absolute frame → position in F (binary search; F is strictly ascending).
 */
import type { FrameSpace } from './frames.js';

/** Position of absolute frame `f` in F, or -1 if f ∉ F. */
export function posOfAbs(fs: FrameSpace, f: number): number {
  let lo = 0;
  let hi = fs.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = fs.abs[mid]!;
    if (v === f) return mid;
    if (v < f) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
