/**
 * Integer box geometry used by perception post-processing (§3.3, §6.2, §6.3).
 *
 * Perception code is not consensus code, but everything here is integer and
 * deterministic so that both hosts and every re-run agree bit-for-bit.
 */
import { COORD_MAX, PRESENCE_MIN } from '../constants.js';
import type { QFrame } from '../types.js';

/** A normalized box `(x0, y0, x1, y1)`. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boxOf(r: Box): Box {
  return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
}

export function boxFromArray(b: readonly [number, number, number, number]): Box {
  return { x0: b[0], y0: b[1], x1: b[2], y1: b[3] };
}

/** `area(B) = (x1-x0)*(y1-y0)`, 0 for degenerate boxes. */
export function area(b: Box): number {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  return w > 0 && h > 0 ? w * h : 0;
}

/** Intersection area of two boxes (0 if empty: `ix0 >= ix1 || iy0 >= iy1`). */
export function interArea(a: Box, b: Box): number {
  const ix0 = Math.max(a.x0, b.x0);
  const iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1);
  const iy1 = Math.min(a.y1, b.y1);
  if (ix0 >= ix1 || iy0 >= iy1) return 0;
  return (ix1 - ix0) * (iy1 - iy0);
}

/**
 * `IoU_bps = floor(area(inter)*10000 / (area(A)+area(B)-area(inter)))` (§6.3).
 * Returns `null` when the union is 0 (callers decide; cross-check treats it as agree).
 * Areas are ≤ 10^8, so the product ≤ 10^12 is exact in a double.
 */
export function iouBps(a: Box, b: Box): number | null {
  const i = interArea(a, b);
  const u = area(a) + area(b) - i;
  if (u <= 0) return null;
  return Math.floor((i * 10000) / u);
}

/** Center `(floor((x0+x1)/2), floor((y0+y1)/2))` (§2.2). */
export function center(b: Box): [number, number] {
  return [Math.floor((b.x0 + b.x1) / 2), Math.floor((b.y0 + b.y1) / 2)];
}

/** Inclusive point-in-rect (§3.3). */
export function ptInRect(p: readonly [number, number], r: Box): boolean {
  return r.x0 <= p[0] && p[0] <= r.x1 && r.y0 <= p[1] && p[1] <= r.y1;
}

function clampCoord(v: number): number {
  return v < 0 ? 0 : v > COORD_MAX ? COORD_MAX : v;
}

/** `expand(B, pct)` with truncating division, clamped to [0, 10000] (§3.3). */
export function expand(b: Box, pct: number): Box {
  const ex = Math.floor(((b.x1 - b.x0) * pct) / 100);
  const ey = Math.floor(((b.y1 - b.y0) * pct) / 100);
  return {
    x0: clampCoord(b.x0 - ex),
    y0: clampCoord(b.y0 - ey),
    x1: clampCoord(b.x1 + ex),
    y1: clampCoord(b.y1 + ey),
  };
}

/** `side(L, P)` = sign of the cross product (§3.3). */
export function side(a: readonly [number, number], b: readonly [number, number], p: readonly [number, number]): -1 | 0 | 1 {
  const v = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** A record is "present" iff it exists and `conf >= PRESENCE_MIN` (§3.2). */
export function isPresent(r: QFrame | null | undefined): r is QFrame {
  return r != null && r.conf >= PRESENCE_MIN;
}

/** Copy of a QFrame (records are treated as immutable values). */
export function cloneFrame(r: QFrame): QFrame {
  return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, conf: r.conf, fill: r.fill, id_conf: r.id_conf, pose: r.pose };
}
