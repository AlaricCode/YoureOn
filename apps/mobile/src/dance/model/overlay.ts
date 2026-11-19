// Geometry for the dance display (DANCE-OFF §6.3): where a normalized keypoint lands on screen.
// The native preview layer is `resizeAspect` (contain), so the image sits letterboxed inside the
// view: one uniform scale, centred. Skeleton overlays use the same math, so the lines sit on the
// people. The reference panel draws the routine MIRRORED (x → 1 − x): players copy it like a
// mirror (§4.2). Pure, tested.
import { SKELETON_EDGES } from '@youre-on/shared/dance/joints';

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Joints below this confidence are not drawn (the scorer's MIN_CONF). */
export const DRAW_MIN_CONF = 0.3;

/** The image's rect inside a view, `resizeAspect` / contain: uniform scale, centred. */
export function containRect(view: Size, image: Size): Rect {
  if (view.width <= 0 || view.height <= 0 || image.width <= 0 || image.height <= 0)
    return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(view.width / image.width, view.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (view.width - width) / 2, y: (view.height - height) / 2, width, height };
}

/** A normalized image point (top-left origin) in view points; `mirrored` flips x. */
export function mapPoint(rect: Rect, x: number, y: number, mirrored = false): Point {
  const nx = mirrored ? 1 - x : x;
  return { x: rect.x + nx * rect.width, y: rect.y + y * rect.height };
}

const present = (k: readonly number[], j: number, minConf: number): boolean =>
  (k[j * 3 + 2] ?? 0) >= minConf;

/** The drawable bones of one person (both ends confident), in view points. */
export function skeletonSegments(
  k: readonly number[],
  rect: Rect,
  opts: { mirrored?: boolean; minConf?: number } = {},
): Segment[] {
  const minConf = opts.minConf ?? DRAW_MIN_CONF;
  const out: Segment[] = [];
  for (const [i, j] of SKELETON_EDGES) {
    if (!present(k, i, minConf) || !present(k, j, minConf)) continue;
    const p = mapPoint(rect, k[i * 3]!, k[i * 3 + 1]!, opts.mirrored);
    const q = mapPoint(rect, k[j * 3]!, k[j * 3 + 1]!, opts.mirrored);
    out.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });
  }
  return out;
}

/** Joint dots (hands, feet, elbows, knees), in view points. */
export function jointPoints(
  k: readonly number[],
  rect: Rect,
  joints: readonly number[],
  opts: { mirrored?: boolean; minConf?: number } = {},
): Point[] {
  const minConf = opts.minConf ?? DRAW_MIN_CONF;
  const out: Point[] = [];
  for (const j of joints) {
    if (!present(k, j, minConf)) continue;
    out.push(mapPoint(rect, k[j * 3]!, k[j * 3 + 1]!, opts.mirrored));
  }
  return out;
}

/**
 * A head disc at the nose (or between the ears / at the neck), sized from the shoulder width
 * (else the eye/ear spread), in view points. Null when there is nothing to place it on.
 */
export function headCircle(
  k: readonly number[],
  rect: Rect,
  opts: { mirrored?: boolean; minConf?: number } = {},
): (Point & { r: number }) | null {
  const minConf = opts.minConf ?? DRAW_MIN_CONF;
  const at = (j: number) => mapPoint(rect, k[j * 3]!, k[j * 3 + 1]!, opts.mirrored);
  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  // nose 0, leftEar 3, rightEar 4, neck 5, leftShoulder 6, rightShoulder 7
  const center = present(k, 0, minConf)
    ? at(0)
    : present(k, 3, minConf) && present(k, 4, minConf)
      ? { x: (at(3).x + at(4).x) / 2, y: (at(3).y + at(4).y) / 2 }
      : null;
  if (!center) return null;
  let r: number;
  if (present(k, 6, minConf) && present(k, 7, minConf)) r = dist(at(6), at(7)) * 0.32;
  else if (present(k, 3, minConf) && present(k, 4, minConf)) r = dist(at(3), at(4)) * 0.75;
  else r = rect.height * 0.025;
  return { ...center, r: Math.max(4, Math.min(rect.height * 0.08, r)) };
}

/**
 * The size of each of `count` side-by-side panels of aspect `aspect` (width / height) that fit
 * in `box` with `gap` between them: as large as possible, identical.
 */
export function fitPanels(box: Size, aspect: number, gap: number, count = 2): Size {
  if (box.width <= 0 || box.height <= 0 || aspect <= 0 || count <= 0)
    return { width: 0, height: 0 };
  const byWidth = (box.width - gap * (count - 1)) / count;
  const width = Math.max(0, Math.min(byWidth, box.height * aspect));
  return { width, height: width / aspect };
}

/** Where a player's popup sits inside the camera panel: A over the left half, B the right. */
export function popupAnchor(panel: Size, player: 'A' | 'B'): Point {
  return { x: panel.width * (player === 'A' ? 0.25 : 0.75), y: panel.height * 0.22 };
}
