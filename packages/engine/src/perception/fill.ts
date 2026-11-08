/**
 * §6.2 occlusion fill: interior gaps of ≤ OCCLUSION_FILL_FRAMES absent frames
 * between two present frames `p < n` of the same bound track are filled by
 * integer linear interpolation; `conf = min(conf_p, conf_n)`; `fill`, `pose`
 * and `id_conf` are copied from `p`.
 */
import { OCCLUSION_FILL_FRAMES } from '../constants.js';
import type { QFrame } from '../types.js';
import { isPresent } from './geometry.js';

/** `v_p + (v_n - v_p)*(f-p)/(n-p)` with non-negative operands before truncating division. */
export function interpCoord(vp: number, vn: number, num: number, den: number): number {
  return vn >= vp ? vp + Math.floor(((vn - vp) * num) / den) : vp - Math.floor(((vp - vn) * num) / den);
}

/**
 * Fill occlusion gaps in place-free fashion (returns a new array).
 * `source[f]` is the raw track the record at f came from (or that the entity
 * was bound to at f), `null` when unbound; gaps are filled only when `p`, `n`
 * and every frame in between belong to the same track (a re-bind or a binding
 * gap is never bridged).
 */
export function occlusionFill(
  frames: readonly (QFrame | null)[],
  source: readonly (number | null)[],
  maxGap: number = OCCLUSION_FILL_FRAMES,
): (QFrame | null)[] {
  const out = frames.slice();
  let p = -1;
  for (let f = 0; f < frames.length; f++) {
    if (!isPresent(frames[f])) continue;
    if (p >= 0) {
      const gap = f - p - 1;
      const sp = source[p];
      if (gap >= 1 && gap <= maxGap && sp != null && source[f] === sp) {
        let sameBinding = true;
        for (let g = p + 1; g < f; g++) {
          const sg = source[g];
          if (sg != null && sg !== sp) sameBinding = false;
        }
        if (sameBinding) {
          const a = frames[p]!;
          const b = frames[f]!;
          const den = f - p;
          for (let g = p + 1; g < f; g++) {
            const num = g - p;
            out[g] = {
              x0: interpCoord(a.x0, b.x0, num, den),
              y0: interpCoord(a.y0, b.y0, num, den),
              x1: interpCoord(a.x1, b.x1, num, den),
              y1: interpCoord(a.y1, b.y1, num, den),
              conf: Math.min(a.conf, b.conf),
              fill: a.fill,
              id_conf: a.id_conf,
              pose: a.pose,
            };
          }
        }
      }
    }
    p = f;
  }
  return out;
}
