// DANCE-OFF §4: the deterministic Dance Off scorer (scorer_version `dance-score@1`).
//
// Pure and deterministic: the phone (Hermes) scores live and at round end, the server (V8)
// recomputes the same numbers from the uploaded PoseSeries. To make both engines agree bit for
// bit it uses only + − × ÷ and Math.sqrt on DEQUANTIZED inputs (plus Math.pow in the display
// curve, and the exact Math.round / Math.floor / Math.abs / Math.min / Math.max), loops in one
// fixed order, and never reads Date or Math.random.
//
// Pipeline per player and per convention (identity, mirror):
//   1. limb unit vectors in aspect-correct space (x·w/h), joints below MIN_CONF skipped (§4.1)
//   2. per frame: best match against the reference frames in [t − 500, t + 200] ms, the limb
//      similarity times a lag penalty (§4.3, §4.4)
//   3. per frame: limb angular speeds vs the matched reference frame's, summed into the movement
//      overlap Σmin / Σmax (§4.5)
//   4. key moves: best similarity in [t − 200, t + 500] against the reference pose at t, gated on
//      the player's motion before it (§4.5, §4.6)
//   5. raw = KEY_WEIGHT · key + CONT_WEIGHT · continuous; the display curve → int tenths (§4.7)
// Each player keeps the convention with the higher raw (§4.2). The live scorer (createLiveScorer)
// runs steps 1–4 incrementally through the SAME functions, and its final() is scoreRound itself.
import type { Party } from '../primitives';
import {
  JOINT,
  JOINT_COUNT,
  KEYPOINT_LEN,
  LIMB_COUNT,
  LIMB_IDS,
  LIMB_SWAP,
  LIMBS,
  MID_HIP_POINT,
  NECK_POINT,
  POINT_COUNT,
  type LimbId,
} from './joints';
import {
  dequantizePerson,
  POSE_MAX_FPS,
  POSE_MAX_FRAMES,
  POSE_SCHEMA_VERSION,
  POSE_T_MAX_MS,
  POSE_T_MIN_MS,
  quantizePerson,
  SYNC_OFFSET_MAX_MS,
  type PoseFrame,
  type PoseSeries,
} from './pose';
import type { RoutineData } from './routine';

export const DANCE_SCORER_VERSION = 'dance-score@1' as const;

/**
 * Every weight and threshold of dance-score@1. Calibrated against the synthetic players in
 * packages/shared/test/dance-score.test.ts (self = 100.0, standing still ≈ 0, a decent amateur
 * 60–90, the better of two always wins). Changing any value is a new scorer_version.
 */
export const DANCE_SCORING = {
  /** §4.1: a joint below this confidence is skipped. */
  MIN_CONF: 0.3,
  /** §4.3 limb weights. */
  ARM_WEIGHT: 1.5,
  LEG_WEIGHT: 1.0,
  TORSO_WEIGHT: 0.8,
  /** §4.3: per-limb score = clamp((cos − COS_FLOOR) / (1 − COS_FLOOR), 0, 1). */
  COS_FLOOR: 0.75,
  /** §4.3: a frame whose present limb weight is below this share of the total is "no pose". */
  MIN_LIMB_WEIGHT_FRAC: 0.5,
  /** §4.4: reference window [t − LAG_BEHIND_MS, t + LAG_AHEAD_MS] (positive lag = player late). */
  LAG_BEHIND_MS: 500,
  LAG_AHEAD_MS: 200,
  /** §4.4: sim × (1 − LAG_PENALTY · max(0, |lag| − LAG_GRACE_MS) / LAG_SCALE_MS). */
  LAG_GRACE_MS: 150,
  LAG_PENALTY: 0.25,
  LAG_SCALE_MS: 500,
  /** §4.5: angular speed = |Δ unit vector| over ~SPEED_DT_MS (baseline frame within + TOL). */
  SPEED_DT_MS: 250,
  SPEED_TOL_MS: 150,
  /** §4.5: chord lengths below this are pose jitter, not movement. */
  SPEED_DEADZONE: 0.1,
  /** §4.6 key moves: player frames in [t − BEFORE, t + AFTER]. */
  KEY_WINDOW_BEFORE_MS: 200,
  KEY_WINDOW_AFTER_MS: 500,
  /** §4.5 motion gate: player's mean speed over the window ≥ KEY_MOTION_MIN × the reference's. */
  KEY_MOTION_WINDOW_MS: 750,
  KEY_MOTION_MIN: 0.3,
  /** §4.6 grades and points. */
  PERFECT_AT: 0.95,
  GOOD_AT: 0.82,
  PERFECT_POINTS: 100,
  GOOD_POINTS: 60,
  /** §4.6 raw = KEY_WEIGHT · key + CONT_WEIGHT · continuous. */
  KEY_WEIGHT: 0.7,
  CONT_WEIGHT: 0.3,
  /** §4.7 display = 100 · clamp((raw − RAW_FLOOR) / (RAW_CEIL − RAW_FLOOR), 0, 1) ^ CURVE_GAMMA. */
  RAW_FLOOR: 0.08,
  RAW_CEIL: 0.95,
  CURVE_GAMMA: 0.9,
  /** §4.8: |a − b| below this many tenths is too close to call. */
  TIE_MARGIN_X10: 20,
  /** §4.8: coverage = share of COVERAGE_BIN_MS bins of the routine with the player's pose. */
  COVERAGE_BIN_MS: 500,
  MIN_COVERAGE: 0.6,
  /** Coverage at or above this keeps the full continuous score; below it scales linearly. */
  FULL_COVERAGE: 0.85,
  /** Fewer in-window frames than this: failed 'no_frames'. */
  MIN_FRAMES: 30,
  /** §4.6 live meter (display only). */
  LIVE_EMA_ALPHA: 0.2,
  LIVE_MOVE_WINDOW_MS: 1000,
} as const;
export type DanceScoring = typeof DANCE_SCORING;

const S = DANCE_SCORING;
const EPS = 1e-9;

export type DanceConvention = 'identity' | 'mirror';
export const KeyMoveGrades = ['PERFECT', 'GOOD', 'MISS'] as const;
export type KeyMoveGrade = (typeof KeyMoveGrades)[number];
export type DanceFailure = 'coverage_a' | 'coverage_b' | 'no_frames';

/** Limb weights in LIMB_IDS order. */
export const LIMB_WEIGHTS: readonly number[] = LIMBS.map((l) =>
  l.group === 'arm' ? S.ARM_WEIGHT : l.group === 'leg' ? S.LEG_WEIGHT : S.TORSO_WEIGHT,
);
let totalWeight = 0;
for (let l = 0; l < LIMB_COUNT; l++) totalWeight += LIMB_WEIGHTS[l]!;
const TOTAL_WEIGHT = totalWeight;

// ---- §4.1 normalization ------------------------------------------------------------------

/** One pose's 9 limb unit vectors (aspect-correct), LIMB_IDS order. */
export interface LimbVectors {
  dx: number[];
  dy: number[];
  ok: boolean[];
  /** Σ weights of the present limbs. */
  weight: number;
}

/** Aspect-correct points (x·w/h, y) of the 19 joints + the 2 virtual points, with presence. */
function points(k: readonly number[], aspect: number): { x: number[]; y: number[]; ok: boolean[] } {
  const x = new Array<number>(POINT_COUNT).fill(0);
  const y = new Array<number>(POINT_COUNT).fill(0);
  const ok = new Array<boolean>(POINT_COUNT).fill(false);
  for (let j = 0; j < JOINT_COUNT; j++) {
    x[j] = k[j * 3]! * aspect;
    y[j] = k[j * 3 + 1]!;
    ok[j] = k[j * 3 + 2]! >= S.MIN_CONF;
  }
  const lh = JOINT.leftHip;
  const rh = JOINT.rightHip;
  if (ok[lh] && ok[rh]) {
    x[MID_HIP_POINT] = (x[lh]! + x[rh]!) / 2;
    y[MID_HIP_POINT] = (y[lh]! + y[rh]!) / 2;
    ok[MID_HIP_POINT] = true;
  } else if (ok[JOINT.root]) {
    x[MID_HIP_POINT] = x[JOINT.root]!;
    y[MID_HIP_POINT] = y[JOINT.root]!;
    ok[MID_HIP_POINT] = true;
  }
  const ls = JOINT.leftShoulder;
  const rs = JOINT.rightShoulder;
  if (ok[JOINT.neck]) {
    x[NECK_POINT] = x[JOINT.neck]!;
    y[NECK_POINT] = y[JOINT.neck]!;
    ok[NECK_POINT] = true;
  } else if (ok[ls] && ok[rs]) {
    x[NECK_POINT] = (x[ls]! + x[rs]!) / 2;
    y[NECK_POINT] = (y[ls]! + y[rs]!) / 2;
    ok[NECK_POINT] = true;
  }
  return { x, y, ok };
}

/**
 * §4.1: the pose hip-centred (mid hips, else root) and scaled by the torso length |mid-shoulders
 * − mid-hips|, in aspect-correct space; null without a hip centre or a torso. For drawing and
 * debugging: limb DIRECTIONS (all the scorer compares) are invariant under this translation and
 * uniform scale, so limbVectors reads the aspect-correct points directly.
 */
export function normalizePose(
  k: readonly number[],
  w: number,
  h: number,
): { x: number[]; y: number[]; ok: boolean[]; scale: number } | null {
  const p = points(k, w / h);
  const ls = JOINT.leftShoulder;
  const rs = JOINT.rightShoulder;
  if (!p.ok[MID_HIP_POINT] || !(p.ok[ls] && p.ok[rs])) return null;
  const cx = p.x[MID_HIP_POINT]!;
  const cy = p.y[MID_HIP_POINT]!;
  const dx = (p.x[ls]! + p.x[rs]!) / 2 - cx;
  const dy = (p.y[ls]! + p.y[rs]!) / 2 - cy;
  const scale = Math.sqrt(dx * dx + dy * dy);
  if (scale < 1e-6) return null;
  const x = p.x.map((v) => (v - cx) / scale);
  const y = p.y.map((v) => (v - cy) / scale);
  return { x, y, ok: p.ok, scale };
}

/** §4.1 + §4.3: the 9 limb unit vectors of a dequantized person (floats in [0, 1]). */
export function limbVectors(k: readonly number[], w: number, h: number): LimbVectors {
  if (k.length !== KEYPOINT_LEN) throw new Error(`a person has ${KEYPOINT_LEN} values`);
  const p = points(k, w / h);
  const dx = new Array<number>(LIMB_COUNT).fill(0);
  const dy = new Array<number>(LIMB_COUNT).fill(0);
  const ok = new Array<boolean>(LIMB_COUNT).fill(false);
  let weight = 0;
  for (let l = 0; l < LIMB_COUNT; l++) {
    const limb = LIMBS[l]!;
    if (!p.ok[limb.from] || !p.ok[limb.to]) continue;
    const vx = p.x[limb.to]! - p.x[limb.from]!;
    const vy = p.y[limb.to]! - p.y[limb.from]!;
    const len = Math.sqrt(vx * vx + vy * vy);
    if (len < 1e-6) continue;
    dx[l] = vx / len;
    dy[l] = vy / len;
    ok[l] = true;
    weight += LIMB_WEIGHTS[l]!;
  }
  return { dx, dy, ok, weight };
}

/** §4.2 `mirror`: x flipped and L/R swapped (limb l takes limb LIMB_SWAP[l] with dx negated). */
export function mirrorLimbs(v: LimbVectors): LimbVectors {
  const dx = new Array<number>(LIMB_COUNT).fill(0);
  const dy = new Array<number>(LIMB_COUNT).fill(0);
  const ok = new Array<boolean>(LIMB_COUNT).fill(false);
  for (let l = 0; l < LIMB_COUNT; l++) {
    const s = LIMB_SWAP[l]!;
    dx[l] = v.ok[s] ? -v.dx[s]! : 0;
    dy[l] = v.dy[s]!;
    ok[l] = v.ok[s]!;
  }
  return { dx, dy, ok, weight: v.weight };
}

/** A pose with enough limbs to score (§4.3 MIN_LIMB_WEIGHT_FRAC). */
export const isScorablePose = (v: LimbVectors): boolean =>
  v.weight >= S.MIN_LIMB_WEIGHT_FRAC * TOTAL_WEIGHT;

// ---- §4.3 limb similarity -----------------------------------------------------------------

/**
 * Weighted mean per-limb score over the limbs present in both poses, or null ("no pose") when
 * that weight is below MIN_LIMB_WEIGHT_FRAC. `out`, if given, gets each limb's score (−1 absent).
 */
export function limbSimilarity(p: LimbVectors, r: LimbVectors, out?: number[]): number | null {
  let wsum = 0;
  let ssum = 0;
  for (let l = 0; l < LIMB_COUNT; l++) {
    if (!p.ok[l] || !r.ok[l]) {
      if (out) out[l] = -1;
      continue;
    }
    const cos = p.dx[l]! * r.dx[l]! + p.dy[l]! * r.dy[l]!;
    let s = (cos - S.COS_FLOOR) / (1 - S.COS_FLOOR);
    if (s < 0) s = 0;
    else if (s > 1) s = 1;
    const w = LIMB_WEIGHTS[l]!;
    wsum += w;
    ssum += w * s;
    if (out) out[l] = s;
  }
  if (wsum < S.MIN_LIMB_WEIGHT_FRAC * TOTAL_WEIGHT) return null;
  return ssum / wsum;
}

/** §4.4 lag penalty factor (1 inside the grace, falling linearly beyond it, ≥ 0). */
export function lagFactor(lagMs: number): number {
  const over = Math.abs(lagMs) - S.LAG_GRACE_MS;
  if (over <= 0) return 1;
  const f = 1 - (S.LAG_PENALTY * over) / S.LAG_SCALE_MS;
  return f > 0 ? f : 0;
}

/** Chord between two unit vectors minus the jitter dead zone, scaled to SPEED_DT_MS. */
function speed(a: LimbVectors, b: LimbVectors, l: number, dtMs: number): number {
  const ex = a.dx[l]! - b.dx[l]!;
  const ey = a.dy[l]! - b.dy[l]!;
  const chord = Math.sqrt(ex * ex + ey * ey) - S.SPEED_DEADZONE;
  return chord > 0 ? (chord * S.SPEED_DT_MS) / dtMs : 0;
}

/** Index of the latest entry with t ≤ target − SPEED_DT_MS, within SPEED_TOL_MS; else −1. */
function baselineIndex(times: readonly number[], end: number, t: number): number {
  const target = t - S.SPEED_DT_MS;
  for (let j = end - 1; j >= 0; j--) {
    const tj = times[j]!;
    if (tj <= target) return target - tj <= S.SPEED_TOL_MS ? j : -1;
  }
  return -1;
}

// ---- the reference model (cached per routine object) ------------------------------------

export interface RoutineModel {
  routine: RoutineData;
  t: number[];
  limbs: LimbVectors[];
  /** Per frame, per limb: angular speed, or −1 where undefined. */
  vel: number[][];
  keys: { id: string; name: string; t: number; ref: number }[];
}

const MODELS = new WeakMap<RoutineData, RoutineModel>();

/** First index with t ≥ target (t sorted ascending). */
function lowerBound(t: readonly number[], target: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The nearest reference frame to time t (ties: the earlier one). */
function nearestRef(t: readonly number[], target: number): number {
  const i = lowerBound(t, target);
  if (i <= 0) return 0;
  if (i >= t.length) return t.length - 1;
  return target - t[i - 1]! <= t[i]! - target ? i - 1 : i;
}

export function routineModel(routine: RoutineData): RoutineModel {
  const cached = MODELS.get(routine);
  if (cached) return cached;
  const t = routine.frames.map((f) => f.t);
  const limbs = routine.frames.map((f) => limbVectors(dequantizePerson(f.k), routine.w, routine.h));
  const vel: number[][] = [];
  for (let i = 0; i < limbs.length; i++) {
    const v = new Array<number>(LIMB_COUNT).fill(-1);
    const j = baselineIndex(t, i, t[i]!);
    if (j >= 0) {
      const dt = t[i]! - t[j]!;
      for (let l = 0; l < LIMB_COUNT; l++)
        if (limbs[i]!.ok[l] && limbs[j]!.ok[l]) v[l] = speed(limbs[i]!, limbs[j]!, l, dt);
    }
    vel.push(v);
  }
  const keys = routine.key_moves.map((m) => ({
    id: m.id,
    name: m.name,
    t: m.t,
    ref: nearestRef(t, m.t),
  }));
  const model: RoutineModel = { routine, t, limbs, vel, keys };
  MODELS.set(routine, model);
  return model;
}

// ---- per-player track (shared by scoreRound and the live scorer) ------------------------

/** One scored player frame under one convention. */
export interface TrackFrame {
  /** Effective time: frame t − sync_offset_ms. */
  te: number;
  lv: LimbVectors;
  /** Best-lag match (−1: no reference frame matched). */
  ref: number;
  /** Lag-penalized similarity of that match (0 when none). */
  sim: number;
  lagMs: number;
  /** Per-limb score of that match (−1 absent). */
  limbs: number[];
  /** Per-limb angular speed (−1 undefined). */
  vel: number[];
  /** This frame's Σmin / Σmax contributions to the movement overlap. */
  movMin: number;
  movMax: number;
}

export interface PlayerTrack {
  frames: TrackFrame[];
  times: number[];
  simSum: number;
  matched: number;
  lagSum: number;
  limbSum: number[];
  limbN: number[];
  movMin: number;
  movMax: number;
}

export const newTrack = (): PlayerTrack => ({
  frames: [],
  times: [],
  simSum: 0,
  matched: 0,
  lagSum: 0,
  limbSum: new Array<number>(LIMB_COUNT).fill(0),
  limbN: new Array<number>(LIMB_COUNT).fill(0),
  movMin: 0,
  movMax: 0,
});

/** §4.4: the best lag-penalized match for a pose at effective time te. */
export function bestLagMatch(
  model: RoutineModel,
  lv: LimbVectors,
  te: number,
): { ref: number; sim: number; lagMs: number } | null {
  let best = -1;
  let bestSim = -1;
  let bestLag = 0;
  const hi = te + S.LAG_AHEAD_MS;
  for (let r = lowerBound(model.t, te - S.LAG_BEHIND_MS); r < model.t.length; r++) {
    const tr = model.t[r]!;
    if (tr > hi) break;
    const s = limbSimilarity(lv, model.limbs[r]!);
    if (s === null) continue;
    const lag = te - tr;
    const v = s * lagFactor(lag);
    // Ties (a held pose repeats exactly) go to the smallest |lag|.
    if (v > bestSim || (v === bestSim && Math.abs(lag) < Math.abs(bestLag))) {
      bestSim = v;
      best = r;
      bestLag = lag;
    }
  }
  return best < 0 ? null : { ref: best, sim: bestSim, lagMs: bestLag };
}

/** Adds one present (scorable) pose to a track. Frames must come in te order. */
export function trackAdd(
  model: RoutineModel,
  track: PlayerTrack,
  te: number,
  lv: LimbVectors,
): TrackFrame {
  const limbs = new Array<number>(LIMB_COUNT).fill(-1);
  const vel = new Array<number>(LIMB_COUNT).fill(-1);
  const m = bestLagMatch(model, lv, te);
  const f: TrackFrame = {
    te,
    lv,
    ref: m ? m.ref : -1,
    sim: m ? m.sim : 0,
    lagMs: m ? m.lagMs : 0,
    limbs,
    vel,
    movMin: 0,
    movMax: 0,
  };
  const j = baselineIndex(track.times, track.times.length, te);
  if (j >= 0) {
    const prev = track.frames[j]!;
    const dt = te - prev.te;
    for (let l = 0; l < LIMB_COUNT; l++)
      if (lv.ok[l] && prev.lv.ok[l]) vel[l] = speed(lv, prev.lv, l, dt);
  }
  if (m) {
    limbSimilarity(lv, model.limbs[m.ref]!, limbs);
    track.simSum += m.sim;
    track.matched += 1;
    track.lagSum += m.lagMs;
    for (let l = 0; l < LIMB_COUNT; l++)
      if (limbs[l]! >= 0) {
        track.limbSum[l] = track.limbSum[l]! + limbs[l]!;
        track.limbN[l] = track.limbN[l]! + 1;
      }
    const rv = model.vel[m.ref]!;
    for (let l = 0; l < LIMB_COUNT; l++) {
      const vp = vel[l]!;
      const vr = rv[l]!;
      if (vp < 0 || vr < 0) continue;
      f.movMin += vp < vr ? vp : vr;
      f.movMax += vp > vr ? vp : vr;
    }
    track.movMin += f.movMin;
    track.movMax += f.movMax;
  }
  track.frames.push(f);
  track.times.push(te);
  return f;
}

/** Mean defined speed over entries with t in [from, to]. null when none is defined. */
function meanSpeed(
  times: readonly number[],
  vel: (i: number) => readonly number[],
  from: number,
  to: number,
): number | null {
  let sum = 0;
  let n = 0;
  for (let i = lowerBound(times, from); i < times.length && times[i]! <= to; i++) {
    const v = vel(i);
    for (let l = 0; l < LIMB_COUNT; l++)
      if (v[l]! >= 0) {
        sum += v[l]!;
        n += 1;
      }
  }
  return n === 0 ? null : sum / n;
}

export interface KeyMoveResult {
  id: string;
  name: string;
  t: number;
  grade: KeyMoveGrade;
  /** Best similarity in the window (0 when no frame). */
  sim: number;
  /** te of that frame minus t (null when no frame). */
  lag_ms: number | null;
  /** The §4.5 motion gate. */
  moved: boolean;
}

/** §4.6: one key move's grade from a track (needs the frames up to t + KEY_WINDOW_AFTER_MS). */
export function gradeKeyMove(model: RoutineModel, track: PlayerTrack, k: number): KeyMoveResult {
  const key = model.keys[k]!;
  const ref = model.limbs[key.ref]!;
  let best = 0;
  let bi = -1;
  const to = key.t + S.KEY_WINDOW_AFTER_MS;
  for (
    let i = lowerBound(track.times, key.t - S.KEY_WINDOW_BEFORE_MS);
    i < track.times.length && track.times[i]! <= to;
    i++
  ) {
    const s = limbSimilarity(track.frames[i]!.lv, ref);
    if (s !== null && s > best) {
      best = s;
      bi = i;
    }
  }
  let moved = false;
  if (bi >= 0) {
    const tb = track.times[bi]!;
    const mine = meanSpeed(
      track.times,
      (i) => track.frames[i]!.vel,
      tb - S.KEY_MOTION_WINDOW_MS,
      tb,
    );
    const theirs = meanSpeed(model.t, (i) => model.vel[i]!, key.t - S.KEY_MOTION_WINDOW_MS, key.t);
    moved =
      theirs === null || theirs <= EPS || (mine !== null && mine >= S.KEY_MOTION_MIN * theirs);
  }
  let grade: KeyMoveGrade = 'MISS';
  if (moved && bi >= 0)
    grade = best >= S.PERFECT_AT ? 'PERFECT' : best >= S.GOOD_AT ? 'GOOD' : 'MISS';
  return {
    id: key.id,
    name: key.name,
    t: key.t,
    grade,
    sim: best,
    lag_ms: bi >= 0 ? track.times[bi]! - key.t : null,
    moved,
  };
}

export const keyMovePoints = (g: KeyMoveGrade): number =>
  g === 'PERFECT' ? S.PERFECT_POINTS : g === 'GOOD' ? S.GOOD_POINTS : 0;

/** §4.7: raw score → display tenths 0..1000. */
export function displayX10(raw: number): number {
  let x = (raw - S.RAW_FLOOR) / (S.RAW_CEIL - S.RAW_FLOOR);
  if (!(x > 0)) x = 0;
  else if (x > 1) x = 1;
  return Math.round(1000 * Math.pow(x, S.CURVE_GAMMA)) + 0;
}

// ---- §4.8 results -------------------------------------------------------------------------

export interface DancePlayerScore {
  /** Display score in tenths, 0..1000 (what DanceEvidence carries). */
  score_x10: number;
  raw: number;
  key_moves: KeyMoveResult[];
  /** Mean key-move points / 100, 0..1. */
  key: number;
  /** meanSim × movement × coverage factor, 0..1. */
  continuous: number;
  /** Mean lag-penalized best-lag similarity over matched frames, 0..1. */
  mean_sim: number;
  /** §4.5 overlap Σmin / Σmax, 0..1. */
  movement: number;
  convention: DanceConvention;
  /** 0..100 (int). */
  coverage_pct: number;
  /** Mean best-match lag, ms (int; positive = late). */
  mean_lag_ms: number;
  /** Per-limb mean score at the best matches. */
  limbs: Record<LimbId, number>;
  frames_scored: number;
}

export interface DanceRoundResult {
  scorer_version: typeof DANCE_SCORER_VERSION;
  a: DancePlayerScore;
  b: DancePlayerScore;
  winner: Party | null;
  /** |a − b| < TIE_MARGIN_X10. */
  too_close: boolean;
  failed: DanceFailure | null;
}

/** Finishes one convention's track into a player score. `coverage` is 0..1. */
export function finishPlayer(
  model: RoutineModel,
  track: PlayerTrack,
  convention: DanceConvention,
  coverage: number,
): DancePlayerScore {
  const meanSim = track.matched > 0 ? track.simSum / track.matched : 0;
  const movement = track.movMax > EPS ? track.movMin / track.movMax : 0;
  let covFactor = coverage / S.FULL_COVERAGE;
  if (covFactor > 1) covFactor = 1;
  const continuous = meanSim * movement * covFactor;
  const key_moves: KeyMoveResult[] = [];
  let pts = 0;
  for (let k = 0; k < model.keys.length; k++) {
    const r = gradeKeyMove(model, track, k);
    key_moves.push(r);
    pts += keyMovePoints(r.grade);
  }
  const key = model.keys.length > 0 ? pts / (S.PERFECT_POINTS * model.keys.length) : 0;
  const raw = S.KEY_WEIGHT * key + S.CONT_WEIGHT * continuous;
  const limbs = {} as Record<LimbId, number>;
  for (let l = 0; l < LIMB_COUNT; l++)
    limbs[LIMB_IDS[l]!] = track.limbN[l]! > 0 ? track.limbSum[l]! / track.limbN[l]! : 0;
  return {
    score_x10: displayX10(raw),
    raw,
    key_moves,
    key,
    continuous,
    mean_sim: meanSim,
    movement,
    convention,
    coverage_pct: Math.round(coverage * 100) + 0,
    mean_lag_ms: track.matched > 0 ? Math.round(track.lagSum / track.matched) + 0 : 0,
    limbs,
    frames_scored: track.frames.length,
  };
}

const COVERAGE_BINS = Math.ceil(15_000 / S.COVERAGE_BIN_MS);

/** Coverage bins for a routine's duration. */
const binCount = (durationMs: number): number =>
  Math.max(1, Math.ceil(durationMs / S.COVERAGE_BIN_MS));
const binOf = (te: number, bins: number): number => {
  const b = Math.floor(te / S.COVERAGE_BIN_MS);
  return b < 0 ? 0 : b >= bins ? bins - 1 : b;
};

/** In the round window [0, duration_ms] (effective time). */
const inWindow = (te: number, durationMs: number): boolean => te >= 0 && te <= durationMs;

/** The scorable limb vectors of one side of a frame, or null. */
function sideLimbs(q: readonly number[] | null, w: number, h: number): LimbVectors | null {
  if (q === null) return null;
  const lv = limbVectors(dequantizePerson(q), w, h);
  return isScorablePose(lv) ? lv : null;
}

/** §4.2: the better of the two conventions (identity on a tie). */
const better = (i: DancePlayerScore, m: DancePlayerScore): DancePlayerScore =>
  m.raw > i.raw ? m : i;

function scoreSide(model: RoutineModel, series: PoseSeries, side: 'a' | 'b'): DancePlayerScore {
  const dur = model.routine.duration_ms;
  const bins = binCount(dur);
  const seen = new Array<boolean>(bins).fill(false);
  const id = newTrack();
  const mi = newTrack();
  for (const f of series.frames) {
    const te = f.t - series.sync_offset_ms;
    if (!inWindow(te, dur)) continue;
    const lv = sideLimbs(f[side], series.w, series.h);
    if (!lv) continue;
    seen[binOf(te, bins)] = true;
    trackAdd(model, id, te, lv);
    trackAdd(model, mi, te, mirrorLimbs(lv));
  }
  let covered = 0;
  for (const s of seen) if (s) covered += 1;
  const coverage = covered / bins;
  return better(
    finishPlayer(model, id, 'identity', coverage),
    finishPlayer(model, mi, 'mirror', coverage),
  );
}

/** §4.8 decision from two scores (and a failure). */
export function decideRound(
  a: number,
  b: number,
  failed: DanceFailure | null,
): { winner: Party | null; too_close: boolean } {
  const too_close = Math.abs(a - b) < S.TIE_MARGIN_X10;
  return { winner: failed !== null || too_close ? null : a > b ? 'A' : 'B', too_close };
}

/**
 * §4.8: score a whole round. Deterministic: the server's recomputation from the uploaded series
 * equals the phone's. `failed` = 'no_frames' (fewer than MIN_FRAMES in the routine window),
 * else 'coverage_a' / 'coverage_b' (coverage below MIN_COVERAGE); any failure has no winner.
 */
export function scoreRound(routine: RoutineData, series: PoseSeries): DanceRoundResult {
  const model = routineModel(routine);
  let inWin = 0;
  for (const f of series.frames)
    if (inWindow(f.t - series.sync_offset_ms, routine.duration_ms)) inWin += 1;
  const a = scoreSide(model, series, 'a');
  const b = scoreSide(model, series, 'b');
  let failed: DanceFailure | null = null;
  if (inWin < S.MIN_FRAMES) failed = 'no_frames';
  else if (a.coverage_pct < S.MIN_COVERAGE * 100) failed = 'coverage_a';
  else if (b.coverage_pct < S.MIN_COVERAGE * 100) failed = 'coverage_b';
  const decision = decideRound(a.score_x10, b.score_x10, failed);
  return { scorer_version: DANCE_SCORER_VERSION, a, b, ...decision, failed };
}

/** Per key move, both players' grades, in routine order (DanceEvidence.key_moves). */
export const keyMoveBreakdown = (
  r: DanceRoundResult,
): { id: string; a: KeyMoveGrade; b: KeyMoveGrade }[] =>
  r.a.key_moves.map((m, i) => ({ id: m.id, a: m.grade, b: r.b.key_moves[i]?.grade ?? 'MISS' }));

// ---- §4.6 the live scorer (phone) ---------------------------------------------------------

/** One onPoses frame, already assigned to A / B by the tracker (raw floats in [0, 1]). */
export interface LiveFrameInput {
  /** ms since round t0. */
  t: number;
  /** People seen. */
  n: number;
  a: readonly number[] | null;
  b: readonly number[] | null;
  /** Image size; the first frame that carries it sets the series' w / h. */
  w?: number;
  h?: number;
}

export interface LivePlayerState {
  /** EMA of sim × short-window movement overlap, 0..100 (display only). */
  meter: number;
  /** This frame's best-lag similarity (0..1), null when the player is not seen. */
  sim: number | null;
  lagMs: number | null;
  /** This frame's per-limb scores, LIMB_IDS order (null = absent). */
  limbs: (number | null)[];
  convention: DanceConvention;
}

export interface LiveKeyEvent {
  key_move_id: string;
  name: string;
  t: number;
  player: Party;
  grade: KeyMoveGrade;
}

export interface LiveUpdate {
  a: LivePlayerState;
  b: LivePlayerState;
  /** Key moves whose window closed with this frame (each once per player). */
  events: LiveKeyEvent[];
}

export interface LiveScorerOptions {
  /** −500..500, the calibrated A/V offset (stored in the series, subtracted from every t). */
  syncOffsetMs?: number;
  w?: number;
  h?: number;
  /** ≤ 30. */
  fpsCap?: number;
}

export interface LiveScorer {
  push(frame: LiveFrameInput): LiveUpdate;
  /** The quantized series so far (what gets hashed and uploaded). */
  series(): PoseSeries;
  /** scoreRound over series(): exactly what the server will recompute. */
  final(): { series: PoseSeries; result: DanceRoundResult };
}

interface LiveSide {
  tracks: [PlayerTrack, PlayerTrack];
  ema: [number, number];
  total: [number, number];
  last: [TrackFrame | null, TrackFrame | null];
}

const newSide = (): LiveSide => ({
  tracks: [newTrack(), newTrack()],
  ema: [0, 0],
  total: [0, 0],
  last: [null, null],
});

/** Σmin / Σmax over a track's frames in the last LIVE_MOVE_WINDOW_MS (1 when nothing moved). */
function windowOverlap(track: PlayerTrack, te: number): number {
  let mn = 0;
  let mx = 0;
  for (let i = track.frames.length - 1; i >= 0; i--) {
    const f = track.frames[i]!;
    if (f.te < te - S.LIVE_MOVE_WINDOW_MS) break;
    mn += f.movMin;
    mx += f.movMax;
  }
  return mx > EPS ? mn / mx : 1;
}

/**
 * The phone's incremental scorer: push every tracked frame as it arrives (in t order), read the
 * meters, pop the key-move events, then final() at round end. Same functions as scoreRound.
 */
export function createLiveScorer(routine: RoutineData, opts: LiveScorerOptions = {}): LiveScorer {
  const model = routineModel(routine);
  const syncOffset = Math.max(
    -SYNC_OFFSET_MAX_MS,
    Math.min(SYNC_OFFSET_MAX_MS, Math.round(opts.syncOffsetMs ?? 0) + 0),
  );
  let w = opts.w ?? 0;
  let h = opts.h ?? 0;
  const fpsCap = Math.max(1, Math.min(POSE_MAX_FPS, Math.round(opts.fpsCap ?? POSE_MAX_FPS)));
  const frames: PoseFrame[] = [];
  const sides: Record<Party, LiveSide> = { A: newSide(), B: newSide() };
  let nextKey = 0;
  let lastT = Number.NEGATIVE_INFINITY;

  const lead = (s: LiveSide): 0 | 1 => (s.total[1] > s.total[0] ? 1 : 0);
  const state = (s: LiveSide): LivePlayerState => {
    const c = lead(s);
    const f = s.last[c];
    return {
      meter: 100 * s.ema[c],
      sim: f ? f.sim : null,
      lagMs: f && f.ref >= 0 ? f.lagMs : null,
      limbs: f ? f.limbs.map((v) => (v >= 0 ? v : null)) : new Array<null>(LIMB_COUNT).fill(null),
      convention: c === 1 ? 'mirror' : 'identity',
    };
  };

  const feed = (s: LiveSide, te: number, q: number[] | null, scoring: boolean) => {
    const lv = q && w > 0 && h > 0 ? limbVectors(dequantizePerson(q), w, h) : null;
    const present = lv !== null && isScorablePose(lv);
    for (const c of [0, 1] as const) {
      let value = 0;
      if (lv !== null && present && scoring) {
        const f = trackAdd(model, s.tracks[c], te, c === 1 ? mirrorLimbs(lv) : lv);
        s.last[c] = f;
        value = f.sim * windowOverlap(s.tracks[c], te);
      } else s.last[c] = null;
      if (scoring) {
        s.ema[c] = s.ema[c] + S.LIVE_EMA_ALPHA * (value - s.ema[c]);
        s.total[c] = s.total[c] + value;
      }
    }
  };

  const series = (): PoseSeries => ({
    schema_version: POSE_SCHEMA_VERSION,
    w: w > 0 ? w : 1,
    h: h > 0 ? h : 1,
    fps_cap: fpsCap,
    sync_offset_ms: syncOffset,
    frames: frames.slice(),
  });

  return {
    push(input) {
      if (w <= 0 && input.w !== undefined && input.h !== undefined && input.w > 0 && input.h > 0) {
        w = Math.round(input.w);
        h = Math.round(input.h);
      }
      const t = Math.round(input.t) + 0;
      const events: LiveKeyEvent[] = [];
      const accept =
        t >= POSE_T_MIN_MS && t <= POSE_T_MAX_MS && t >= lastT && frames.length < POSE_MAX_FRAMES;
      if (accept) {
        lastT = t;
        const qa = input.a ? quantizePerson(input.a) : null;
        const qb = input.b ? quantizePerson(input.b) : null;
        frames.push({ t, n: Math.max(0, Math.min(32, Math.round(input.n))), a: qa, b: qb });
        const te = t - syncOffset;
        const scoring = inWindow(te, routine.duration_ms);
        feed(sides.A, te, qa, scoring);
        feed(sides.B, te, qb, scoring);
        while (nextKey < model.keys.length && te > model.keys[nextKey]!.t + S.KEY_WINDOW_AFTER_MS) {
          const key = model.keys[nextKey]!;
          for (const p of ['A', 'B'] as const) {
            const s = sides[p];
            const g = gradeKeyMove(model, s.tracks[lead(s)], nextKey);
            events.push({
              key_move_id: key.id,
              name: key.name,
              t: key.t,
              player: p,
              grade: g.grade,
            });
          }
          nextKey += 1;
        }
      }
      return { a: state(sides.A), b: state(sides.B), events };
    },
    series,
    final() {
      const s = series();
      return { series: s, result: scoreRound(routine, s) };
    },
  };
}

/** Bins used for coverage over the standard 15 s routine (exported for the debug readout). */
export const DANCE_COVERAGE_BINS = COVERAGE_BINS;
