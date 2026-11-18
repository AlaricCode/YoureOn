// The sparkline's geometry (ui/parts Sparkline draws it with react-native-svg). Pure TS, so it is
// tested in Node: the SVG path for a series, its end point, and which way it went.

/** Fewer points than this draw nothing: two points are only a ruler line, not a trend. */
export const SPARK_MIN_POINTS = 3;

export type SparkGeometry = {
  /** SVG path data ("M x y C ..."), or '' for too few points. */
  readonly d: string;
  /** The last point, where the end dot sits. */
  readonly end: { readonly x: number; readonly y: number } | null;
};

type Pt = { x: number; y: number };

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Monotone cubic tangents (Fritsch-Carlson): a smooth curve through every point that never
 * overshoots between two of them (no fake peaks or dips in the balance).
 */
function tangents(p: readonly Pt[]): number[] {
  const n = p.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = p[i] as Pt;
    const b = p[i + 1] as Pt;
    d.push((b.y - a.y) / (b.x - a.x));
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = d[0] as number;
  m[n - 1] = d[n - 2] as number;
  for (let i = 1; i < n - 1; i++) {
    const d0 = d[i - 1] as number;
    const d1 = d[i] as number;
    m[i] = d0 * d1 <= 0 ? 0 : (d0 + d1) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const di = d[i] as number;
    if (di === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] as number) / di;
    const b = (m[i + 1] as number) / di;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * di;
      m[i + 1] = t * b * di;
    }
  }
  return m;
}

/**
 * Lays `points` out left to right across `width`, lowest value at the bottom of `height`, as a
 * monotone-cubic smoothed path. `pad` keeps the stroke and the end dot inside the box (top,
 * bottom and right, where the dot sits); `padLeft` (default `pad`) is the left inset, so the
 * line can start right on the page margin. A flat series draws a flat line in the middle. Fewer
 * than SPARK_MIN_POINTS, or no room, draws nothing.
 */
export function sparkGeometry(
  points: readonly number[],
  width: number,
  height: number,
  pad = 4,
  padLeft = pad,
): SparkGeometry {
  const finite = points.filter((p) => Number.isFinite(p));
  if (finite.length < SPARK_MIN_POINTS || width <= padLeft + pad || height <= 2 * pad)
    return { d: '', end: null };
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const span = hi - lo;
  const w = width - padLeft - pad;
  const h = height - 2 * pad;
  const xy: Pt[] = finite.map((p, i) => ({
    x: padLeft + (w * i) / (finite.length - 1),
    y: span === 0 ? pad + h / 2 : pad + h - ((p - lo) / span) * h,
  }));
  const m = tangents(xy);
  const first = xy[0] as Pt;
  let d = `M${round(first.x)} ${round(first.y)}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const a = xy[i] as Pt;
    const b = xy[i + 1] as Pt;
    const dx = (b.x - a.x) / 3;
    const c1 = { x: a.x + dx, y: a.y + (m[i] as number) * dx };
    const c2 = { x: b.x - dx, y: b.y - (m[i + 1] as number) * dx };
    d += ` C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(b.x)} ${round(b.y)}`;
  }
  const last = xy[xy.length - 1] as Pt;
  return { d, end: { x: round(last.x), y: round(last.y) } };
}

/** +1 if the series ended above where it started, -1 below, 0 flat (or too short). */
export function sparkDirection(points: readonly number[]): -1 | 0 | 1 {
  if (points.length < 2) return 0;
  const first = points[0] as number;
  const last = points[points.length - 1] as number;
  return last > first ? 1 : last < first ? -1 : 0;
}
