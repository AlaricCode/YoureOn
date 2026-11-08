/**
 * Geometry helpers (§3.3, §2.2 anchors, §2.3 derived sub-regions).
 * All coordinates are integers in 0..=10000; every product is bounded by
 * 2·10^8, so plain `number` arithmetic is exact.
 */
import type { Point, QFrame } from '../types.js';
import { COORD_MAX } from '../constants.js';
import { idiv, sign } from './math.js';

/** Axis-aligned box `(x0, y0, x1, y1)`, inclusive coordinates. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Pt {
  x: number;
  y: number;
}

export function boxOf(r: QFrame): Box {
  return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
}

/** `area(B) = (x1-x0)*(y1-y0)`. */
export function area(b: Box): number {
  return (b.x1 - b.x0) * (b.y1 - b.y0);
}

/** Intersection box, or null when empty (`ix0 >= ix1 || iy0 >= iy1`). */
export function inter(a: Box, b: Box): Box | null {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x0 >= x1 || y0 >= y1) return null;
  return { x0, y0, x1, y1 };
}

/** Inclusive point-in-rectangle test. */
export function ptInRect(p: Pt, r: Box): boolean {
  return r.x0 <= p.x && p.x <= r.x1 && r.y0 <= p.y && p.y <= r.y1;
}

/** `side(L, P)` with `L = (a, b)`: sign of the cross product. */
export function side(a: Pt, b: Pt, p: Pt): -1 | 0 | 1 {
  return sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
}

/** Even-odd point-in-polygon, exact integer arithmetic (§3.3). */
export function ptInPoly(p: Pt, v: readonly Pt[]): boolean {
  const n = v.length;
  let inside = false;
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const vi = v[i]!;
    const vj = v[j]!;
    if (vi.y > p.y !== vj.y > p.y) {
      const lhs = (p.x - vi.x) * (vj.y - vi.y);
      const rhs = (p.y - vi.y) * (vj.x - vi.x);
      const hit = vj.y - vi.y > 0 ? lhs < rhs : lhs > rhs;
      if (hit) inside = !inside;
    }
  }
  return inside;
}

/** Bounding box of a polygon. */
export function polyBBox(v: readonly Pt[]): Box {
  let x0 = COORD_MAX;
  let y0 = COORD_MAX;
  let x1 = 0;
  let y1 = 0;
  for (const p of v) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

function clampCoord(x: number): number {
  return x < 0 ? 0 : x > COORD_MAX ? COORD_MAX : x;
}

/** `expand(B, pct)`, each coordinate clamped to `[0, 10000]`. */
export function expand(b: Box, pct: number): Box {
  const ex = idiv((b.x1 - b.x0) * pct, 100);
  const ey = idiv((b.y1 - b.y0) * pct, 100);
  return {
    x0: clampCoord(b.x0 - ex),
    y0: clampCoord(b.y0 - ey),
    x1: clampCoord(b.x1 + ex),
    y1: clampCoord(b.y1 + ey),
  };
}

/** Center of any box: `(floor((x0+x1)/2), floor((y0+y1)/2))`. */
export function center(b: Box): Pt {
  return { x: idiv(b.x0 + b.x1, 2), y: idiv(b.y0 + b.y1, 2) };
}

/** Bottom-center (feet) of a person box: `(floor((x0+x1)/2), y1)`. */
export function bottomCenter(b: Box): Pt {
  return { x: idiv(b.x0 + b.x1, 2), y: b.y1 };
}

/** `.opening` rect: a band straddling the rim (§2.3). */
export function openingRect(b: Box): Box {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const dy = idiv(h, 10);
  return {
    x0: b.x0 + idiv(w, 10),
    y0: b.y0 - dy < 0 ? 0 : b.y0 - dy,
    x1: b.x1 - idiv(w, 10),
    y1: b.y0 + idiv(h, 5),
  };
}

/** `.interior` rect (§2.3). */
export function interiorRect(b: Box): Box {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  return {
    x0: b.x0 + idiv(w, 10),
    y0: b.y0 + idiv(h, 10),
    x1: b.x1 - idiv(w, 10),
    y1: b.y1 - idiv(h, 10),
  };
}

export function toPts(points: readonly Point[]): Pt[] {
  return points.map(([x, y]) => ({ x, y }));
}
