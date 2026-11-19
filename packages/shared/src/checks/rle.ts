// Mask measurements for the camera checks (design final.md §2). Pure TS: the SAM service sends
// plain masks and every measurement the predicates use is computed here, so the service stays
// challenge-agnostic and re-evaluation from a stored reply is reproducible.
//
// RLE: the service's rle() (services/sam3/modal_app.py) — uncompressed COCO, column-major,
// size [h, w], counts alternate zeros/ones runs and always start with a zeros run (0 when the
// first pixel is set).

export interface Rle {
  size: readonly [number, number] | readonly number[];
  counts: readonly number[];
}

/** A decoded mask in row-major order: data[y * width + x] is 1 inside. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decode the service's RLE; throws if the runs do not cover exactly h*w pixels. */
export function decodeRle(r: Rle): Mask {
  const [height, width] = r.size as [number, number];
  const total = height * width;
  const data = new Uint8Array(total);
  let p = 0;
  for (let i = 0; i < r.counts.length; i++) {
    const n = r.counts[i] as number;
    if (!Number.isInteger(n) || n < 0 || p + n > total) throw new Error('rle: bad run');
    if (i % 2 === 1)
      for (let q = p; q < p + n; q++) data[(q % height) * width + Math.floor(q / height)] = 1;
    p += n;
  }
  if (p !== total) throw new Error(`rle: runs cover ${p} of ${total} pixels`);
  return { width, height, data };
}

/** Encode a row-major mask the way the service does (tests build synthetic replies with this). */
export function encodeRle(m: Mask): { size: [number, number]; counts: number[] } {
  const counts: number[] = [];
  let cur = 0;
  let run = 0;
  for (let x = 0; x < m.width; x++)
    for (let y = 0; y < m.height; y++) {
      const v = m.data[y * m.width + x] as number;
      if (v === cur) run++;
      else {
        counts.push(run);
        cur = v;
        run = 1;
      }
    }
  counts.push(run);
  return { size: [m.height, m.width], counts };
}

/** xyxy, x1/y1 exclusive (the service's box_xyxy convention). */
export type Box = readonly [number, number, number, number];

/** §2: the main blob's measurements. */
export interface BlobStats {
  /** Pixels in the whole mask (all components). */
  maskArea: number;
  /** Pixels in the largest 4-connected component. */
  mainArea: number;
  components: number;
  /** The main blob's box: equals the service's box_xyxy. */
  box: Box;
  /** Principal axis of the main blob from image vertical, 0..90 degrees. */
  tiltDeg: number;
  /** sqrt(lambda1 / lambda2) of the main blob's second moments (>= 1; capped at ELONG_CAP). */
  elong: number;
}

/** A one-pixel-wide line has lambda2 = 0; report a large finite value so it stays JSON. */
export const ELONG_CAP = 99;

/**
 * Largest 4-connected component, as scipy.ndimage.label's default structure does. Labels are
 * assigned in row-major scan order and ties go to the first label (np.argmax), so the box matches
 * the service's box_xyxy exactly. null for an empty mask.
 */
export function mainBlob(m: Mask): BlobStats | null {
  const { width: w, height: h, data } = m;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best: {
    n: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    sx: number;
    sy: number;
    sxx: number;
    syy: number;
    sxy: number;
  } | null = null;
  let components = 0;
  let maskArea = 0;
  for (let start = 0; start < w * h; start++) {
    if (data[start] !== 1 || seen[start] === 1) continue;
    components++;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const c = { n: 0, x0: w, y0: h, x1: -1, y1: -1, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    while (top > 0) {
      const p = stack[--top] as number;
      const x = p % w;
      const y = (p - x) / w;
      c.n++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      c.sx += x;
      c.sy += y;
      c.sxx += x * x;
      c.syy += y * y;
      c.sxy += x * y;
      const push = (q: number) => {
        if (data[q] === 1 && seen[q] !== 1) {
          seen[q] = 1;
          stack[top++] = q;
        }
      };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    maskArea += c.n;
    if (best === null || c.n > best.n) best = c;
  }
  if (best === null) return null;
  const n = best.n;
  const mx = best.sx / n;
  const my = best.sy / n;
  const a = best.sxx / n - mx * mx; // var x
  const c = best.syy / n - my * my; // var y
  const b = best.sxy / n - mx * my; // cov xy
  const half = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const l1 = (a + c) / 2 + half;
  const l2 = (a + c) / 2 - half;
  // Major axis at theta from the x axis; its angle from vertical is 90 - |theta|.
  const theta = (0.5 * Math.atan2(2 * b, a - c) * 180) / Math.PI;
  const tiltDeg = n < 2 || half === 0 ? 0 : 90 - Math.abs(theta);
  const elong = l2 <= 1e-12 ? ELONG_CAP : Math.min(ELONG_CAP, Math.sqrt(l1 / l2));
  return {
    maskArea,
    mainArea: n,
    components,
    box: [best.x0, best.y0, best.x1 + 1, best.y1 + 1],
    tiltDeg,
    elong,
  };
}
