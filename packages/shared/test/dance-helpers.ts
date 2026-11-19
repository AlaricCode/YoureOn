// Synthetic Dance Off players for the scorer / tracker tests: a seeded PRNG, the reference pose at
// any time, limb-angle perturbation (slow per-limb offsets, like an amateur's consistent errors,
// plus per-frame keypoint jitter, like Vision's), lag, mirroring and side placement.
import {
  dequantizePerson,
  JOINT,
  JOINT_COUNT,
  KEYPOINT_LEN,
  mirrorKeypoints,
  quantizePerson,
  type PoseSeries,
  type RoutineData,
} from '../src';

/** Tiny deterministic PRNG (32-bit LCG, Numerical Recipes constants). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Standard normal from two uniforms (Box–Muller). */
export function gauss(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The reference pose (floats) at time t, linearly interpolated between routine frames. */
export function refPoseAt(r: RoutineData, t: number): number[] {
  const f = r.frames;
  if (t <= f[0]!.t) return dequantizePerson(f[0]!.k);
  if (t >= f[f.length - 1]!.t) return dequantizePerson(f[f.length - 1]!.k);
  let i = 0;
  while (f[i + 1]!.t < t) i++;
  const a = dequantizePerson(f[i]!.k);
  const b = dequantizePerson(f[i + 1]!.k);
  const u = (t - f[i]!.t) / (f[i + 1]!.t - f[i]!.t);
  return a.map((v, j) => v + (b[j]! - v) * u);
}

/** Rotate point j about (cx, cy) by θ (aspect space). */
function rot(x: number[], y: number[], js: number[], cx: number, cy: number, th: number) {
  const c = Math.cos(th);
  const s = Math.sin(th);
  for (const j of js) {
    const dx = x[j]! - cx;
    const dy = y[j]! - cy;
    x[j] = cx + dx * c - dy * s;
    y[j] = cy + dx * s + dy * c;
  }
}

/** Limb angle offsets (radians): [torso, lUA, lFA, rUA, rFA, lTh, lSh, rTh, rSh]. */
export type Offsets = number[];

/** Applies limb-angle offsets (rigid rotations down each chain), a shift and keypoint jitter. */
export function perturb(
  k: readonly number[],
  aspect: number,
  off: Offsets,
  jitter: number,
  shiftX: number,
  rng: () => number,
): number[] {
  const x = new Array<number>(JOINT_COUNT);
  const y = new Array<number>(JOINT_COUNT);
  for (let j = 0; j < JOINT_COUNT; j++) {
    x[j] = k[j * 3]! * aspect;
    y[j] = k[j * 3 + 1]!;
  }
  const J = JOINT;
  const mhx = (x[J.leftHip]! + x[J.rightHip]!) / 2;
  const mhy = (y[J.leftHip]! + y[J.rightHip]!) / 2;
  const upper = [
    J.nose,
    J.leftEye,
    J.rightEye,
    J.leftEar,
    J.rightEar,
    J.neck,
    J.leftShoulder,
    J.rightShoulder,
    J.leftElbow,
    J.rightElbow,
    J.leftWrist,
    J.rightWrist,
  ];
  rot(x, y, upper, mhx, mhy, off[0]!);
  rot(x, y, [J.leftElbow, J.leftWrist], x[J.leftShoulder]!, y[J.leftShoulder]!, off[1]!);
  rot(x, y, [J.leftWrist], x[J.leftElbow]!, y[J.leftElbow]!, off[2]!);
  rot(x, y, [J.rightElbow, J.rightWrist], x[J.rightShoulder]!, y[J.rightShoulder]!, off[3]!);
  rot(x, y, [J.rightWrist], x[J.rightElbow]!, y[J.rightElbow]!, off[4]!);
  rot(x, y, [J.leftKnee, J.leftAnkle], x[J.leftHip]!, y[J.leftHip]!, off[5]!);
  rot(x, y, [J.leftAnkle], x[J.leftKnee]!, y[J.leftKnee]!, off[6]!);
  rot(x, y, [J.rightKnee, J.rightAnkle], x[J.rightHip]!, y[J.rightHip]!, off[7]!);
  rot(x, y, [J.rightAnkle], x[J.rightKnee]!, y[J.rightKnee]!, off[8]!);
  const out = new Array<number>(KEYPOINT_LEN);
  for (let j = 0; j < JOINT_COUNT; j++) {
    out[j * 3] = x[j]! / aspect + shiftX + jitter * gauss(rng);
    out[j * 3 + 1] = y[j]! + jitter * gauss(rng);
    out[j * 3 + 2] = Math.min(1, 0.85 + 0.1 * rng());
  }
  return out;
}

export interface PlayerOpts {
  /** Mean reaction lag, ms (positive = late). */
  lagMs?: number;
  /** Slow lag wobble amplitude, ms. */
  lagWobbleMs?: number;
  /** Slow per-limb angle error amplitude, degrees. */
  angleDeg?: number;
  /** Per-frame keypoint jitter (normalized units). */
  jitter?: number;
  fps?: number;
  /** Copies the screen like a mirror (flip + L/R swap). */
  mirror?: boolean;
  /** Holds the routine's opening pose the whole time. */
  stand?: boolean;
  /** Dances until this time, then holds still. */
  untilMs?: number;
  /** Seen only until this time (walked out). */
  visibleUntilMs?: number;
  /** Share of frames Vision misses at random. */
  dropout?: number;
  /** Image-x shift (A stands left: negative). */
  shiftX?: number;
  /** Dances this routine instead (wrong routine). */
  dances?: RoutineData;
}

export interface PlayerFrame {
  t: number;
  k: number[] | null;
}

/** One synthetic player's frames over [0, 15000] ms. */
export function makePlayer(r: RoutineData, o: PlayerOpts, rng: () => number): PlayerFrame[] {
  const fps = o.fps ?? 20;
  const aspect = r.w / r.h;
  const amp = ((o.angleDeg ?? 0) * Math.PI) / 180;
  const limbs = Array.from({ length: 9 }, () => ({
    a1: amp * (0.5 + 0.5 * rng()),
    p1: 1500 + 2500 * rng(),
    f1: 2 * Math.PI * rng(),
    a2: amp * 0.4 * rng(),
    p2: 700 + 900 * rng(),
    f2: 2 * Math.PI * rng(),
  }));
  const wob = { p: 2000 + 2000 * rng(), f: 2 * Math.PI * rng() };
  const src = o.dances ?? r;
  const out: PlayerFrame[] = [];
  for (let i = 0; ; i++) {
    const t = Math.round((i * 1000) / fps);
    if (t > r.duration_ms) break;
    if (o.visibleUntilMs !== undefined && t > o.visibleUntilMs) {
      out.push({ t, k: null });
      continue;
    }
    if (o.dropout && rng() < o.dropout) {
      out.push({ t, k: null });
      continue;
    }
    const lag = (o.lagMs ?? 0) + (o.lagWobbleMs ?? 0) * Math.sin((2 * Math.PI * t) / wob.p + wob.f);
    let st = t - lag;
    if (o.stand) st = 0;
    if (o.untilMs !== undefined && t > o.untilMs) st = o.untilMs - lag;
    const base = refPoseAt(src, st);
    const off = limbs.map(
      (l) =>
        l.a1 * Math.sin((2 * Math.PI * t) / l.p1 + l.f1) +
        l.a2 * Math.sin((2 * Math.PI * t) / l.p2 + l.f2),
    );
    let k = perturb(base, aspect, off, o.jitter ?? 0.002, 0, rng);
    if (o.mirror) k = mirrorKeypoints(k);
    if (o.shiftX) for (let j = 0; j < JOINT_COUNT; j++) k[j * 3] = k[j * 3]! + o.shiftX;
    out.push({ t, k: k.map((v, idx) => (idx % 3 === 2 ? v : Math.min(1, Math.max(0, v)))) });
  }
  return out;
}

/** Zips two players (same fps) into a quantized PoseSeries. */
export function seriesOf(
  r: RoutineData,
  a: PlayerFrame[],
  b: PlayerFrame[],
  extra: Partial<Pick<PoseSeries, 'sync_offset_ms' | 'fps_cap'>> = {},
): PoseSeries {
  const n = Math.max(a.length, b.length);
  const frames: PoseSeries['frames'] = [];
  for (let i = 0; i < n; i++) {
    const fa = a[i];
    const fb = b[i];
    const t = (fa ?? fb)!.t;
    const qa = fa?.k ? quantizePerson(fa.k) : null;
    const qb = fb?.k ? quantizePerson(fb.k) : null;
    frames.push({ t, n: (qa ? 1 : 0) + (qb ? 1 : 0), a: qa, b: qb });
  }
  return {
    schema_version: 1,
    w: r.w,
    h: r.h,
    fps_cap: extra.fps_cap ?? 30,
    sync_offset_ms: extra.sync_offset_ms ?? 0,
    frames,
  };
}

/** The routine against itself (both players). */
export const selfSeries = (r: RoutineData): PoseSeries => ({
  schema_version: 1,
  w: r.w,
  h: r.h,
  fps_cap: 30,
  sync_offset_ms: 0,
  frames: r.frames.map((f) => ({ t: f.t, n: 2, a: [...f.k], b: [...f.k] })),
});
