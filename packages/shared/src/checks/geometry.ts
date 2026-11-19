// Box geometry for the camera checks (design final.md §2-§3). Boxes are xyxy, x1/y1 exclusive.
import type { Box } from './rle';

export const bw = (b: Box): number => b[2] - b[0];
export const bh = (b: Box): number => b[3] - b[1];
export const bcx = (b: Box): number => (b[0] + b[2]) / 2;
export const bcy = (b: Box): number => (b[1] + b[3]) / 2;
export const barea = (b: Box): number => Math.max(0, bw(b)) * Math.max(0, bh(b));
export const bdiag = (b: Box): number => Math.hypot(bw(b), bh(b));
/** h / w; Infinity for a zero-width box. */
export const aspect = (b: Box): number => (bw(b) > 0 ? bh(b) / bw(b) : Infinity);
/** max(x/y, y/x): 1 when equal. */
export const ratio = (x: number, y: number): number =>
  x > 0 && y > 0 ? Math.max(x / y, y / x) : Infinity;

export const shiftBox = (b: Box, dx: number, dy: number): Box => [
  b[0] + dx,
  b[1] + dy,
  b[2] + dx,
  b[3] + dy,
];

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = barea(a) + barea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** §2 box gap: max(dx, dy), 0 when the boxes intersect or touch. */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, b[0] - a[2], a[0] - b[2]);
  const dy = Math.max(0, b[1] - a[3], a[1] - b[3]);
  return Math.max(dx, dy);
}

/** Length of the overlap of [a0, a1) and [b0, b1). */
export const overlap1d = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export function unionBox(bs: readonly Box[]): Box {
  return [
    Math.min(...bs.map((b) => b[0])),
    Math.min(...bs.map((b) => b[1])),
    Math.max(...bs.map((b) => b[2])),
    Math.max(...bs.map((b) => b[3])),
  ];
}

/** All permutations of 0..n-1 (n <= MAX_ENTITY_COUNT = 6, so at most 720). */
export function permutations(n: number): number[][] {
  if (n <= 1) return [Array.from({ length: n }, (_, i) => i)];
  const out: number[][] = [];
  for (const p of permutations(n - 1))
    for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}
