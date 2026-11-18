// Synthetic SAM /segment replies for the camera-check tests: shapes are drawn into a W x H mask,
// encoded with the service's RLE convention, and measured with the same code the evaluator uses,
// so box_xyxy / mask_area / components agree with the mask exactly as the real service's do.
import { encodeRle, mainBlob } from '../../src/checks/rle';
import { CheckSpec, canonicalizeCheckSpec } from '../../src/checks/spec';
import type { ReportMeta } from '../../src/checks/evaluate';
import { judgeFrameTimesMs } from '../../src/judge/frames';

/** Portrait like the real frames (288x512), halved to keep the tests fast. */
export const W = 144;
export const H = 256;
export const N = 12;
export const DUR = 3000;
export const TIMES = judgeFrameTimesMs(DUR, N);
export const END = [9, 10, 11];

type Fill = (x: number, y: number) => boolean;
export interface Obj {
  id: number;
  score: number;
  box_xyxy: number[] | null;
  box_all_xyxy: number[] | null;
  components: number;
  mask_area: number;
  mask_rle?: { size: [number, number]; counts: number[] };
}

/** Axis-aligned box [x0, x1) x [y0, y1). */
export const rect =
  (x0: number, y0: number, x1: number, y1: number): Fill =>
  (x, y) =>
    x >= x0 && x < x1 && y >= y0 && y < y1;
/** A len x wid bar centred at (cx, cy), its long axis `deg` from vertical. */
export const bar =
  (cx: number, cy: number, len: number, wid: number, deg: number): Fill =>
  (x, y) => {
    const t = (deg * Math.PI) / 180;
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const u = dx * Math.sin(t) + dy * Math.cos(t);
    const v = dx * Math.cos(t) - dy * Math.sin(t);
    return Math.abs(u) <= len / 2 && Math.abs(v) <= wid / 2;
  };
export const union =
  (...fs: Fill[]): Fill =>
  (x, y) =>
    fs.some((f) => f(x, y));

const cache = new Map<string, Omit<Obj, 'id' | 'score'>>();
/** One detection of `fill`; `key` memoizes the (slow) rasterization. */
export function det(fill: Fill, score = 0.95, id = 0, key?: string): Obj {
  let base = key === undefined ? undefined : cache.get(key);
  if (base === undefined) {
    const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fill(x, y)) data[y * W + x] = 1;
    const s = mainBlob({ width: W, height: H, data });
    base =
      s === null
        ? { box_xyxy: null, box_all_xyxy: null, components: 0, mask_area: 0 }
        : {
            box_xyxy: [...s.box],
            box_all_xyxy: [...s.box],
            components: s.components,
            mask_area: s.maskArea,
            mask_rle: encodeRle({ width: W, height: H, data }),
          };
    if (key !== undefined) cache.set(key, base);
  }
  return { id, score, ...base };
}
/** A box detection, memoized by its coordinates. */
export const box = (x0: number, y0: number, x1: number, y1: number, score = 0.95, id = 0): Obj =>
  det(rect(x0, y0, x1, y1), score, id, `r${x0},${y0},${x1},${y1}`);

/** The same objects on every frame, or per frame via a function. */
export const frames = (f: Obj[] | ((i: number) => Obj[]), n = N): Obj[][] =>
  Array.from({ length: n }, (_, i) => (typeof f === 'function' ? f(i) : f));

/** A /segment reply: prompt -> per-frame objects. */
export function reply(per: Record<string, Obj[][]>): unknown {
  return {
    model: 'facebook/sam3.1 (sam3.1_multiplex.pt)',
    rev: 'test',
    results: Object.entries(per).map(([prompt, fs]) => ({
      prompt,
      prompt_frame: 0,
      frames: fs.map((objects, index) => ({ index, objects })),
      tracks: [],
    })),
  };
}

export const META: ReportMeta = {
  terms_hash: 'a'.repeat(64),
  frame_hashes: Array.from({ length: N }, () => 'b'.repeat(64)),
  created_at: '2026-11-18T00:00:00.000Z',
};

/** Canonicalize then parse, as the server does before hashing. */
export function spec(
  entities: [string, string, number][],
  assertions: [string, Record<string, unknown>][],
): CheckSpec {
  return CheckSpec.parse(
    canonicalizeCheckSpec({
      predicates: 'p1',
      entities: entities.map(([key, prompt, count]) => ({ key, prompt, count })),
      assertions: assertions.map(([role, test]) => ({ role, test })),
    } as CheckSpec),
  );
}
