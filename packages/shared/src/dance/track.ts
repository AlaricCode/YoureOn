// DANCE-OFF §3: framing check + identity tracking. A and B are assigned at round start by the
// left / right rule (A = left in the image), or, when the recording phone identified both players
// by face, from where each of them stood (`TrackerStart`: A may stand on the right). Side swaps
// are counted relative to the sides the players started on. Inputs are raw people
// (`k: number[57]`, floats in [0, 1], upright unmirrored image) as the native module reports
// them; seriesChecks() recomputes the server-side checks from a PoseSeries.
import { JOINT, JOINT_COUNT } from './joints';
import { dequantizePerson, type PoseSeries } from './pose';

export const DANCE_TRACKING = {
  /** Joints the framing check needs must be at least this confident. */
  FRAMING_CONF: 0.3,
  /** Hip centres must be on opposite sides of the image centre (normalized x). */
  FRAMING_CENTER: 0.5,
  /** Horizontal gap between the two people's joint extents (normalized x). */
  FRAMING_GAP: 0.02,
  /** Joints used for a hip centre / extents. */
  TRACK_CONF: 0.3,
  /** Max hip-centre jump from the predicted spot, aspect-correct units (x·w/h, y)… */
  TRACK_MAX_JUMP: 0.2,
  /** …growing by this much per second a player is unseen. */
  TRACK_JUMP_PER_S: 0.6,
  /** Constant-velocity prediction: EMA weight of the newest velocity, and the longest horizon. */
  TRACK_VEL_ALPHA: 0.5,
  TRACK_PREDICT_MAX_MS: 300,
  /** A and B on the other's starting side for at least this long counts one side swap. */
  SWAP_MIN_MS: 1_000,
} as const;
const T = DANCE_TRACKING;

export type FramingReason =
  'ok' | 'need_two' | 'too_many' | 'feet' | 'head' | 'same_side' | 'too_close';

export interface FramingResult {
  ok: boolean;
  reason: FramingReason;
  /** Index into `people` of A (left) and B (right), when two full bodies were found. */
  a?: number;
  b?: number;
}

const conf = (k: readonly number[], j: number): number => k[j * 3 + 2] ?? 0;
const jx = (k: readonly number[], j: number): number => k[j * 3] ?? 0;
const jy = (k: readonly number[], j: number): number => k[j * 3 + 1] ?? 0;

/** Hip centre (mid hips, else root, else one hip) in normalized image coords, or null. */
export function hipCenter(
  k: readonly number[],
  minConf: number = T.TRACK_CONF,
): [number, number] | null {
  const lh = JOINT.leftHip;
  const rh = JOINT.rightHip;
  const okL = conf(k, lh) >= minConf;
  const okR = conf(k, rh) >= minConf;
  if (okL && okR) return [(jx(k, lh) + jx(k, rh)) / 2, (jy(k, lh) + jy(k, rh)) / 2];
  if (conf(k, JOINT.root) >= minConf) return [jx(k, JOINT.root), jy(k, JOINT.root)];
  if (okL) return [jx(k, lh), jy(k, lh)];
  if (okR) return [jx(k, rh), jy(k, rh)];
  return null;
}

function xExtent(k: readonly number[]): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < JOINT_COUNT; j++) {
    if (conf(k, j) < T.TRACK_CONF) continue;
    const x = jx(k, j);
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * §3: passes only with exactly 2 people, each a full body (nose or neck, both hips, both ankles at
 * FRAMING_CONF), one hip centre left of the image centre and the other right of it, with a gap
 * between their joint extents. `w` / `h` are accepted for symmetry with the tracker (the check
 * itself is in normalized x).
 */
export function framingCheck(
  people: readonly (readonly number[])[],
  _w: number,
  _h: number,
): FramingResult {
  if (people.length < 2) return { ok: false, reason: 'need_two' };
  if (people.length > 2) return { ok: false, reason: 'too_many' };
  const c = T.FRAMING_CONF;
  for (const k of people) {
    if (conf(k, JOINT.nose) < c && conf(k, JOINT.neck) < c) return { ok: false, reason: 'head' };
  }
  for (const k of people) {
    const legs =
      conf(k, JOINT.leftAnkle) >= c &&
      conf(k, JOINT.rightAnkle) >= c &&
      conf(k, JOINT.leftHip) >= c &&
      conf(k, JOINT.rightHip) >= c;
    if (!legs) return { ok: false, reason: 'feet' };
  }
  const h0 = hipCenter(people[0]!, c)!;
  const h1 = hipCenter(people[1]!, c)!;
  const a = h0[0] <= h1[0] ? 0 : 1;
  const b = 1 - a;
  const ha = a === 0 ? h0 : h1;
  const hb = a === 0 ? h1 : h0;
  if (!(ha[0] < T.FRAMING_CENTER && hb[0] > T.FRAMING_CENTER))
    return { ok: false, reason: 'same_side', a, b };
  const ea = xExtent(people[a]!);
  const eb = xExtent(people[b]!);
  if (!ea || !eb || eb[0] - ea[1] < T.FRAMING_GAP) return { ok: false, reason: 'too_close', a, b };
  return { ok: true, reason: 'ok', a, b };
}

export interface TrackerStats {
  frames: number;
  /** Most people seen in one frame. */
  max_people: number;
  /** Frames with more than 2 people. */
  frames_over_two: number;
  side_swaps: number;
}

export interface TrackedFrame<P> {
  t: number;
  n: number;
  a: P | null;
  b: P | null;
}

export interface Tracker {
  /**
   * Assigns A / B on the first frame with ≥ 2 hip centres (A = left, or the people nearest the
   * `start` spots), then follows them.
   */
  push<P extends readonly number[]>(t: number, people: readonly P[]): TrackedFrame<P>;
  stats(): TrackerStats;
  /** Whether A and B have been assigned. */
  started(): boolean;
  /** Whether A started on the right of B (null before the assignment). */
  aStartedRight(): boolean | null;
  /** A's and B's last seen hip centres (normalized image coords), null before they are seen. */
  last(): { a: [number, number] | null; b: [number, number] | null };
}

/**
 * An explicit initial assignment: where A and B stood (hip centres, normalized image coords) when
 * the phone identified them, e.g. by face. The first frame with ≥ 2 hip centres gives A and B the
 * two people nearest these spots (least total distance), whichever side each is on.
 */
export interface TrackerStart {
  a: readonly [number, number];
  b: readonly [number, number];
}

/** A on the other's starting side: A right of B when A started left, A left of B when right. */
const isSwapped = (ca: readonly number[], cb: readonly number[], aRight: boolean): boolean =>
  aRight ? ca[0]! < cb[0]! : ca[0]! > cb[0]!;

interface Slot {
  x: number;
  y: number;
  t: number;
  /** Velocity, normalized units per ms. */
  vx: number;
  vy: number;
}

/**
 * §3 identity tracker. Each frame, every person's hip centre is matched to A's and B's previous
 * one, choosing the assignment with the least total distance within the allowed jump (which grows
 * while a player is unseen); extra people are counted (n) and never become A or B. Without
 * `start` the round-start assignment is the left / right rule (A = left), exactly as before.
 */
export function createTracker(opts: {
  w: number;
  h: number;
  start?: TrackerStart | null | undefined;
}): Tracker {
  const aspect = opts.w / opts.h;
  const start = opts.start ?? null;
  let A: Slot | null = null;
  let B: Slot | null = null;
  const st: TrackerStats = { frames: 0, max_people: 0, frames_over_two: 0, side_swaps: 0 };
  let swapSince: number | null = null;
  let swapCounted = false;
  /** Whether A started on the right of B (fixed by the round-start assignment). */
  let aRight: boolean | null = null;
  /** Aspect-correct distance between two hip centres. */
  const gap = (p: readonly [number, number], c: readonly [number, number]) => {
    const dx = (p[0] - c[0]) * aspect;
    const dy = p[1] - c[1];
    return Math.sqrt(dx * dx + dy * dy);
  };

  /** Distance from the slot's predicted spot at time t (aspect-correct). */
  const dist = (s: Slot, c: [number, number], t: number) => {
    const dt = Math.min(T.TRACK_PREDICT_MAX_MS, Math.max(0, t - s.t));
    const dx = (s.x + s.vx * dt - c[0]) * aspect;
    const dy = s.y + s.vy * dt - c[1];
    return Math.sqrt(dx * dx + dy * dy);
  };
  const moveTo = (s: Slot | null, c: [number, number], t: number): Slot => {
    if (!s || t <= s.t) return { x: c[0], y: c[1], t, vx: s?.vx ?? 0, vy: s?.vy ?? 0 };
    const dt = t - s.t;
    const a = T.TRACK_VEL_ALPHA;
    return {
      x: c[0],
      y: c[1],
      t,
      vx: s.vx + a * ((c[0] - s.x) / dt - s.vx),
      vy: s.vy + a * ((c[1] - s.y) / dt - s.vy),
    };
  };
  const allowed = (s: Slot, t: number) =>
    T.TRACK_MAX_JUMP + (T.TRACK_JUMP_PER_S * Math.max(0, t - s.t)) / 1000;

  return {
    started: () => A !== null && B !== null,
    stats: () => ({ ...st }),
    aStartedRight: () => aRight,
    last: () => ({ a: A ? [A.x, A.y] : null, b: B ? [B.x, B.y] : null }),
    push<P extends readonly number[]>(t: number, people: readonly P[]): TrackedFrame<P> {
      st.frames += 1;
      if (people.length > st.max_people) st.max_people = people.length;
      if (people.length > 2) st.frames_over_two += 1;
      const centers = people.map((k) => hipCenter(k));
      let ia = -1;
      let ib = -1;
      if (A === null || B === null) {
        const idx = centers
          .map((c, i) => (c ? i : -1))
          .filter((i) => i >= 0)
          .sort((i, j) => centers[i]![0] - centers[j]![0] || i - j);
        if (idx.length >= 2 && start) {
          // Identified players: the pair nearest where A and B stood (A may be on the right).
          let best = Number.POSITIVE_INFINITY;
          for (const i of idx) {
            for (const j of idx) {
              if (i === j) continue;
              const cost = gap(start.a, centers[i]!) + gap(start.b, centers[j]!);
              if (cost < best) {
                best = cost;
                ia = i;
                ib = j;
              }
            }
          }
        } else if (idx.length >= 2) {
          // Round start: the two most central people would be a guess; take the leftmost and the
          // rightmost (the framing check has already required exactly two).
          ia = idx[0]!;
          ib = idx[idx.length - 1]!;
        }
        if (ia >= 0 && ib >= 0) aRight = centers[ia]![0] > centers[ib]![0];
      } else {
        const sa = A;
        const sb = B;
        let best = Number.POSITIVE_INFINITY;
        const n = centers.length;
        for (let i = -1; i < n; i++) {
          const ca = i >= 0 ? centers[i] : null;
          if (i >= 0 && (!ca || dist(sa, ca, t) > allowed(sa, t))) continue;
          for (let j = -1; j < n; j++) {
            if (j >= 0 && j === i) continue;
            const cb = j >= 0 ? centers[j] : null;
            if (j >= 0 && (!cb || dist(sb, cb, t) > allowed(sb, t))) continue;
            // Prefer matching more players, then the least total distance.
            const matched = (i >= 0 ? 1 : 0) + (j >= 0 ? 1 : 0);
            const cost =
              (2 - matched) * 1_000 + (ca ? dist(sa, ca, t) : 0) + (cb ? dist(sb, cb, t) : 0);
            if (cost < best) {
              best = cost;
              ia = i;
              ib = j;
            }
          }
        }
      }
      const ca = ia >= 0 ? centers[ia]! : null;
      const cb = ib >= 0 ? centers[ib]! : null;
      if (ca) A = moveTo(A, ca, t);
      if (cb) B = moveTo(B, cb, t);
      if (ca && cb) {
        if (isSwapped(ca, cb, aRight === true)) {
          if (swapSince === null) {
            swapSince = t;
            swapCounted = false;
          }
          if (!swapCounted && t - swapSince >= T.SWAP_MIN_MS) {
            st.side_swaps += 1;
            swapCounted = true;
          }
        } else swapSince = null;
      }
      return {
        t,
        n: people.length,
        a: ia >= 0 ? people[ia]! : null,
        b: ib >= 0 ? people[ib]! : null,
      };
    },
  };
}

/**
 * The deterministic checks DanceEvidence carries, recomputed from a series (server side). A side
 * swap is A and B each on the other's starting side for SWAP_MIN_MS. The starting sides:
 *   - by default (the left / right rule), A starts on the LEFT: any sustained A-right-of-B is a
 *     swap, exactly as before the face assignment existed;
 *   - `byFace` (the server holds this bet's face identification of both players, judge/
 *     dance-faces), the series' first frame where both players' hip centres are seen (A right of
 *     B there: A started on the right).
 * `a_start` is where A is on that first frame either way (null when never seen with B).
 */
export function seriesChecks(
  series: PoseSeries,
  opts: { byFace?: boolean } = {},
): {
  max_people: number;
  frames_over_two: number;
  side_swaps: number;
  /** Where A started, null when the two were never seen together. */
  a_start: 'left' | 'right' | null;
} {
  let max_people = 0;
  let frames_over_two = 0;
  let side_swaps = 0;
  let since: number | null = null;
  let counted = false;
  /** Where A is on the first frame with both. */
  let aRight: boolean | null = null;
  for (const f of series.frames) {
    if (f.n > max_people) max_people = f.n;
    if (f.n > 2) frames_over_two += 1;
    const ca = f.a ? hipCenter(dequantizePerson(f.a)) : null;
    const cb = f.b ? hipCenter(dequantizePerson(f.b)) : null;
    if (!ca || !cb) continue;
    aRight ??= ca[0] > cb[0];
    if (isSwapped(ca, cb, opts.byFace === true ? aRight : false)) {
      if (since === null) {
        since = f.t;
        counted = false;
      }
      if (!counted && f.t - since >= T.SWAP_MIN_MS) {
        side_swaps += 1;
        counted = true;
      }
    } else since = null;
  }
  return {
    max_people,
    frames_over_two,
    side_swaps,
    a_start: aRight === null ? null : aRight ? 'right' : 'left',
  };
}
