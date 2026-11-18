// The p1 evaluator (design final.md §2-§7): a CheckSpec plus the raw SAM /segment reply over the
// regular judge frames -> a CheckReport. Pure and deterministic, so the server, judge-eval and the
// GPU-free fixtures all compute the same report from the same stored reply. Every threshold is
// here, pinned by PREDICATE_SET 'p1'; any change ships as 'p2' and this code stays for p1 bets.
//
// A 2D silhouette can show that something is NOT the case, never that it is (§0.2): every
// predicate's false side is the trustworthy one, and unknown never helps a MET through.
import { hashJcs } from '../jcs';
import { isLandingFrame, lastSampleMs, MAX_JUDGE_FRAMES, MIN_JUDGE_FRAMES } from '../judge/frames';
import {
  aspect,
  barea,
  bcx,
  bcy,
  bdiag,
  bh,
  boxGap,
  bw,
  iou,
  overlap1d,
  permutations,
  ratio,
  shiftBox,
  unionBox,
} from './geometry';
import {
  type CheckReport,
  type CheckRow,
  type CheckValue,
  type CheckWhy,
  kleeneAnd,
  kleeneOr,
  type Measure,
  type Tri,
} from './report';
import { type Box, decodeRle, mainBlob } from './rle';
import { SamSegmentReply } from './sam-reply';
import { type CheckSpec, type Entity, type Predicate, roles, subjectKeys } from './spec';

export { checksVeto, CheckReport, kleeneAnd, type Veto } from './report';

/** §3 defaults, predicate set p1. Relative only: no pixel values. */
export const P1 = {
  S_FLOOR: 0.5,
  S_SEEN: 0.8,
  MARGIN: 0.15,
  DEDUPE_IOU: 0.5,
  MIN_AREA_FRAC: 0.0003,
  EDGE_FRAC: 0.01,
  MIN_FRAMES: MIN_JUDGE_FRAMES,
  MIN_LANDING_FRAMES: 4,
  END_FRAMES: 3,
  REST_TRUE_SHIFT: 0.1,
  REST_FALSE_SHIFT: 0.35,
  REST_TRUE_SIZE: 0.15,
  REST_FALSE_SIZE: 0.4,
  REST_SHAKE: 0.015,
  UPRIGHT_TRUE_DEG: 15,
  UPRIGHT_FALSE_DEG: 55,
  UPRIGHT_ELONG: 1.6,
  UPRIGHT_MAIN_FRAC: 0.7,
  GAP_TOUCH: 0.015,
  GAP_APART: 0.05,
  GAP_APART_DIAG: 0.5,
  START_STABLE_IOU: 0.8,
  STAYED_IOU: 0.6,
  STAYED_RATIO: 1.25,
  MOVED_IOU: 0.3,
  MOVED_NEAR_DIAG: 0.5,
  MOVED_ASPECT: 1.3,
  MATCH_DIAG: 0.5,
  MATCH_SECOND: 0.5,
  HOLD_MIN_FRAMES: 3,
  HOLD_SLACK_MS: 100,
} as const;

/** One detection after §2 measurement. */
export interface Det {
  id: number;
  score: number;
  /** box_xyxy: the main blob. */
  box: Box;
  mainArea: number;
  maskArea: number;
  tiltDeg: number;
  elong: number;
  clip: { l: boolean; r: boolean; t: boolean; b: boolean };
  clipped: boolean;
}

/** §5 per-frame resolution of one entity. */
export type ResState = 'seen' | 'ambiguous' | 'weak' | 'absent' | 'partial';
export interface Resolved {
  state: ResState;
  /** seen: the `count` strong instances. Otherwise []. */
  inst: Det[];
  /** Deduped candidates (score >= S_FLOOR, main_area >= MIN_AREA), best first. */
  cands: Det[];
}

/** Caller-supplied report fields this pure function cannot compute (§8). */
export interface ReportMeta {
  terms_hash: string;
  frame_hashes: string[];
  created_at: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const m = (k: Measure['k'], v: number): Measure => ({
  k,
  v: Number.isFinite(v) ? (k === 'tilt_deg' || k === 'elong' ? r2(v) : r3(v)) : 0,
});
const EPS = 1e-9;

// ---------------- measurement (§2) and identity (§5) ----------------

interface Frames {
  W: number;
  H: number;
  Fmin: number;
  n: number;
  /** res.get(key)[frame] */
  res: Map<string, Resolved[]>;
}

/** The reply parsed but cannot be measured: treated as unavailable (§7). */
class Malformed extends Error {}

function measure(reply: SamSegmentReply, entities: readonly Entity[], n: number): Frames | 'u1' {
  let W = 0;
  let H = 0;
  const raw = new Map<string, Det[][]>();
  let u1 = false;
  for (const e of entities) {
    const r = reply.results.find((x) => x.prompt === e.prompt);
    if (r === undefined) throw new Malformed(`no result for prompt '${e.prompt}'`);
    const per: Det[][] = Array.from({ length: n }, () => []);
    const idx = new Set(r.frames.map((f) => f.index));
    if (r.frames.length !== n || idx.size !== n || [...idx].some((i) => i >= n)) u1 = true;
    for (const f of r.frames) {
      if (f.index >= n) continue;
      for (const o of f.objects) {
        if (o.mask_area === 0 || o.box_xyxy === null) continue;
        if (o.mask_rle === undefined) throw new Malformed('mask_rle missing (send masks: true)');
        const [h, w] = o.mask_rle.size;
        if (W === 0) [W, H] = [w, h];
        else if (w !== W || h !== H) throw new Malformed('frame sizes differ');
        const s = mainBlob(decodeRle(o.mask_rle));
        if (s === null) continue;
        const [x0, y0, x1, y1] = s.box;
        const ex = P1.EDGE_FRAC * W;
        const ey = P1.EDGE_FRAC * H;
        const clip = { l: x0 <= ex, r: x1 >= W - ex, t: y0 <= ey, b: y1 >= H - ey };
        per[f.index]?.push({
          id: o.id,
          score: o.score,
          box: s.box,
          mainArea: s.mainArea,
          maskArea: s.maskArea,
          tiltDeg: s.tiltDeg,
          elong: s.elong,
          clip,
          clipped: clip.l || clip.r || clip.t || clip.b,
        });
      }
    }
    raw.set(e.key, per);
  }
  if (u1) return 'u1';
  const res = new Map<string, Resolved[]>();
  for (const e of entities)
    res.set(
      e.key,
      (raw.get(e.key) ?? []).map((ds) => resolve(ds, e.count, W * H)),
    );
  return { W, H, Fmin: Math.min(W, H), n, res };
}

/** §5 steps 1-3: candidates, dedupe, resolve. */
export function resolve(dets: readonly Det[], count: number, frameArea: number): Resolved {
  const cands: Det[] = [];
  const sorted = dets
    .filter((d) => d.score >= P1.S_FLOOR && d.mainArea >= P1.MIN_AREA_FRAC * frameArea)
    .sort((a, b) => b.score - a.score);
  for (const d of sorted) if (!cands.some((k) => iou(k.box, d.box) >= P1.DEDUPE_IOU)) cands.push(d);
  const strong = cands.filter((d) => d.score >= P1.S_SEEN);
  const none: Det[] = [];
  if (count === 1) {
    if (cands.length === 0) return { state: 'absent', inst: none, cands };
    if (strong.length === 0) return { state: 'weak', inst: none, cands };
    const [best, rival] = cands as [Det, Det | undefined];
    if (strong.length >= 2 || (rival !== undefined && rival.score >= best.score - P1.MARGIN - EPS))
      return { state: 'ambiguous', inst: none, cands };
    return { state: 'seen', inst: [best], cands };
  }
  if (strong.length > count) return { state: 'ambiguous', inst: none, cands };
  if (strong.length < count) return { state: 'partial', inst: none, cands };
  const nth = cands[count - 1] as Det;
  const next = cands[count];
  if (next !== undefined && next.score >= nth.score - P1.MARGIN - EPS)
    return { state: 'ambiguous', inst: none, cands };
  return { state: 'seen', inst: cands.slice(0, count), cands };
}

const stateWhy = (s: ResState): CheckWhy =>
  s === 'absent'
    ? 'absent'
    : s === 'weak'
      ? 'weak'
      : s === 'partial'
        ? 'count_mismatch'
        : 'ambiguous';

type Got<T> = { ok: true; v: T } | { ok: false; why: CheckWhy };

/** One frame's instances of `key`, or why not (U2). A subject must also be unclipped. */
function got(F: Frames, key: string, f: number, subject: boolean): Got<Det[]> {
  const r = F.res.get(key)?.[f];
  if (r === undefined || r.state !== 'seen')
    return { ok: false, why: stateWhy(r?.state ?? 'absent') };
  if (subject && r.inst.some((d) => d.clipped)) return { ok: false, why: 'clipped' };
  return { ok: true, v: r.inst };
}
const got1 = (F: Frames, key: string, f: number, subject: boolean): Got<Det> => {
  const g = got(F, key, f, subject);
  return g.ok ? { ok: true, v: g.v[0] as Det } : g;
};
/** A reference (b / ref): clipping allowed; not seen is ref_missing (U3). */
const gotRef = (F: Frames, key: string, f: number): Got<Det> => {
  const g = got1(F, key, f, false);
  return g.ok ? g : { ok: false, why: 'ref_missing' };
};

// ---------------- windows (§2) ----------------

interface Win {
  n: number;
  times: readonly number[];
  durationMs: number;
}
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const endFrames = (w: Win) => range(Math.max(0, w.n - P1.END_FRAMES), w.n);
const landingFrames = (w: Win) =>
  range(0, w.n).filter((i) => isLandingFrame(w.times[i] as number, w.durationMs));
const leadInFrames = (w: Win) =>
  range(0, w.n).filter((i) => !isLandingFrame(w.times[i] as number, w.durationMs));
const lastNsFrames = (w: Win, s: number) =>
  range(0, w.n).filter((i) => (w.times[i] as number) >= lastSampleMs(w.durationMs) - s * 1000);
const holdSeconds = (window: string) => Number(/^last_(\d)s$/.exec(window)?.[1] ?? NaN);

function windowFrames(w: Win, window: string): number[] {
  if (window === 'start') return [0, 1];
  if (window === 'end') return endFrames(w);
  if (window === 'landing') return landingFrames(w);
  return lastNsFrames(w, holdSeconds(window));
}

// ---------------- aggregation (§4, §7) ----------------

interface FV {
  f: number;
  t: Tri;
  why: CheckWhy;
}
const T = (f: number): FV => ({ f, t: 'true', why: 'ok' });
const F_ = (f: number, why: CheckWhy = 'ok'): FV => ({ f, t: 'false', why });
const U = (f: number, why: CheckWhy): FV => ({ f, t: 'unknown', why });

interface Agg {
  value: Tri;
  why: CheckWhy;
  frames: number[];
}

/**
 * Kleene AND over window frames with the two-frame rule: false needs >= `falseMin` false frames
 * (1 for pairwise predicates, whose rows are pairs). A lone false frame is unknown 'single_frame'.
 */
function windowAnd(rows: readonly FV[], falseMin = 2): Agg {
  const fs = rows.filter((r) => r.t === 'false');
  if (fs.length >= falseMin)
    return { value: 'false', why: fs[0]?.why ?? 'ok', frames: fs.map((r) => r.f) };
  if (rows.length > 0 && rows.every((r) => r.t === 'true'))
    return { value: 'true', why: 'ok', frames: rows.map((r) => r.f) };
  const us = rows.filter((r) => r.t === 'unknown');
  if (us.length > 0)
    return { value: 'unknown', why: us[0]?.why ?? 'ok', frames: us.map((r) => r.f) };
  if (fs.length > 0) return { value: 'unknown', why: 'single_frame', frames: fs.map((r) => r.f) };
  return { value: 'unknown', why: 'too_few_frames', frames: [] };
}

const uniqSorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

/** Combine per-instance results: AND for "all", OR for "any" (§4). */
function combineInstances(xs: readonly Agg[], of: 'all' | 'any'): Agg {
  const value = of === 'all' ? kleeneAnd(xs.map((x) => x.value)) : kleeneOr(xs.map((x) => x.value));
  const deciding = xs.filter((x) => x.value === value);
  const first = deciding[0] ?? xs[0];
  return {
    value,
    why: value === 'true' ? 'ok' : (first?.why ?? 'ok'),
    frames: uniqSorted(deciding.flatMap((x) => x.frames)),
  };
}

// ---------------- cross-frame matching (§5) ----------------

/**
 * Match `other` to `anchor` instances by minimum total centre distance / anchor diag, after
 * shifting the anchor by the ref's centre shift. Accepted only if every pair is under
 * MATCH_DIAG·diag and each anchor's nearest is its match and closer than MATCH_SECOND x the second
 * nearest. Returns other-index per anchor-index, or null (unmatched).
 */
export function matchInstances(
  anchor: readonly Det[],
  other: readonly Det[],
  shift: readonly [number, number] = [0, 0],
): number[] | null {
  if (anchor.length !== other.length) return null;
  if (anchor.length === 1) return [0];
  const d = anchor.map((a) =>
    other.map(
      (o) =>
        Math.hypot(bcx(o.box) - bcx(a.box) - shift[0], bcy(o.box) - bcy(a.box) - shift[1]) /
        Math.max(1, bdiag(a.box)),
    ),
  );
  let best: number[] | null = null;
  let bestCost = Infinity;
  for (const p of permutations(anchor.length)) {
    const c = p.reduce((s, j, i) => s + (d[i]?.[j] ?? Infinity), 0);
    if (c < bestCost) [best, bestCost] = [p, c];
  }
  if (best === null) return null;
  for (let i = 0; i < anchor.length; i++) {
    const row = d[i] as number[];
    const j = best[i] as number;
    const sorted = [...row].sort((x, y) => x - y);
    if ((row[j] as number) >= P1.MATCH_DIAG) return null;
    if ((row[j] as number) !== sorted[0]) return null;
    if ((sorted[0] as number) >= P1.MATCH_SECOND * (sorted[1] as number)) return null;
  }
  return best;
}

const centreShift = (from: Det, to: Det): [number, number] => [
  bcx(to.box) - bcx(from.box),
  bcy(to.box) - bcy(from.box),
];

// ---------------- the 9 predicates (§4) ----------------

interface Ctx {
  F: Frames;
  w: Win;
  spec: CheckSpec;
  subjects: Set<string>;
  count: (key: string) => number;
}
type Eval = Agg & { measures: Measure[] };

function visible(c: Ctx, t: Extract<Predicate, { p: 'visible' }>): Eval {
  const { F } = c;
  const frames = windowFrames(c.w, t.window);
  const subject = c.subjects.has(t.e);
  const n = c.count(t.e);
  // floor(n/4) with n the upload frame count, as everywhere in final.md (3 of 8 at n=12)
  let weakOk = t.window === 'landing' ? Math.floor(c.w.n / 4) : 0;
  let minScore = Infinity;
  let seen = 0;
  const rows = frames.map((f): FV => {
    const r = F.res.get(t.e)?.[f] as Resolved;
    minScore = Math.min(minScore, r.cands[0]?.score ?? 0);
    const g = got(F, t.e, f, subject);
    if (g.ok) {
      seen++;
      return T(f);
    }
    if (r.cands.length < n) return F_(f, r.cands.length === 0 ? 'absent' : 'count_mismatch');
    // landing only: up to floor(n/4) frames may be merely weak (§4 #1)
    const best = r.cands[0] as Det;
    if (r.state === 'weak' && weakOk > 0 && !(subject && best.clipped)) {
      weakOk--;
      return T(f);
    }
    return U(f, g.why);
  });
  const measures = [m('score', minScore), m('frames', seen)];
  // false only when EVERY window frame is clearly empty
  if (rows.length > 0 && rows.every((r) => r.t === 'false'))
    return { value: 'false', why: rows[0]?.why ?? 'absent', frames, measures };
  if (rows.length > 0 && rows.every((r) => r.t === 'true'))
    return { value: 'true', why: 'ok', frames, measures };
  const u = rows.find((r) => r.t === 'unknown') ?? rows.find((r) => r.t === 'false');
  return {
    value: 'unknown',
    why: u?.why ?? 'too_few_frames',
    frames: rows.filter((r) => r.t !== 'true').map((r) => r.f),
    measures,
  };
}

function atRest(c: Ctx, t: Extract<Predicate, { p: 'at_rest' }>): Eval {
  const { F } = c;
  const E = endFrames(c.w);
  const A = t.ref === null ? P1.REST_SHAKE * F.Fmin : 0;
  const inst = E.map((f) => got(F, t.e, f, true));
  const ref = E.map((f) => (t.ref === null ? null : gotRef(F, t.ref, f)));
  // §5: instances anchored at the first end frame; later frames map onto it.
  const a0 = inst[0];
  const maps: (number[] | null)[] = E.map((_, k) => {
    const g = inst[k];
    if (a0 === undefined || !a0.ok || g === undefined || !g.ok) return null;
    const r0 = ref[0];
    const rk = ref[k];
    const sh = r0?.ok && rk?.ok ? centreShift(r0.v, rk.v) : ([0, 0] as const);
    return matchInstances(a0.v, g.v, sh);
  });
  let maxShift = -1;
  let maxSize = -1;
  const rows: FV[] = [];
  for (let k = 0; k + 1 < E.length; k++) {
    const f = E[k] as number;
    const g1 = inst[k] as Got<Det[]>;
    const g2 = inst[k + 1] as Got<Det[]>;
    if (!g1.ok || !g2.ok) {
      rows.push(
        U(g1.ok ? (E[k + 1] as number) : f, g1.ok ? (g2 as { why: CheckWhy }).why : g1.why),
      );
      continue;
    }
    const rr1 = ref[k];
    const rr2 = ref[k + 1];
    if (
      (rr1 !== null && rr1 !== undefined && !rr1.ok) ||
      (rr2 !== null && rr2 !== undefined && !rr2.ok)
    ) {
      rows.push(U(f, 'ref_missing'));
      continue;
    }
    const m1 = maps[k];
    const m2 = maps[k + 1];
    if (m1 === null || m2 === null || m1 === undefined || m2 === undefined) {
      rows.push(U(f, 'unmatched'));
      continue;
    }
    const rs: readonly [number, number] = rr1?.ok && rr2?.ok ? centreShift(rr1.v, rr2.v) : [0, 0];
    const per: Tri[] = m1.map((j1, i) => {
      const d1 = g1.v[j1] as Det;
      const d2 = g2.v[m2[i] as number] as Det;
      const shift = Math.hypot(
        bcx(d2.box) - bcx(d1.box) - rs[0],
        bcy(d2.box) - bcy(d1.box) - rs[1],
      );
      const diag = (bdiag(d1.box) + bdiag(d2.box)) / 2;
      const size = Math.max(
        Math.abs(bw(d2.box) - bw(d1.box)) / ((bw(d1.box) + bw(d2.box)) / 2),
        Math.abs(bh(d2.box) - bh(d1.box)) / ((bh(d1.box) + bh(d2.box)) / 2),
      );
      maxShift = Math.max(maxShift, shift / Math.max(1, diag));
      maxSize = Math.max(maxSize, size);
      if (shift <= P1.REST_TRUE_SHIFT * diag + A && size <= P1.REST_TRUE_SIZE) return 'true';
      if (shift >= P1.REST_FALSE_SHIFT * diag + A || size >= P1.REST_FALSE_SIZE) return 'false';
      return 'unknown';
    });
    const v = kleeneAnd(per);
    rows.push(v === 'true' ? T(f) : v === 'false' ? F_(f) : U(f, 'between_bands'));
  }
  // pairwise: one false pair is enough (the pair already spans two frames)
  const agg = windowAnd(rows, 1);
  const measures = maxShift < 0 ? [] : [m('shift_rel', maxShift), m('size_chg', maxSize)];
  return { ...widenPairs(agg, E), measures };
}

/** Pair rows are keyed by their first frame; report both frames of each deciding pair. */
function widenPairs(a: Agg, E: readonly number[]): Agg {
  if (a.value === 'true') return { ...a, frames: [...E] };
  return {
    ...a,
    frames: uniqSorted(a.frames.flatMap((f) => (E.includes(f + 1) ? [f, f + 1] : [f]))),
  };
}

function upright(c: Ctx, t: Extract<Predicate, { p: 'upright' }>): Eval {
  const E = endFrames(c.w);
  let maxTilt = -1;
  let minElong = Infinity;
  const rows = E.map((f): FV => {
    const g = got1(c.F, t.e, f, true);
    if (!g.ok) return U(f, g.why);
    const d = g.v;
    maxTilt = Math.max(maxTilt, d.tiltDeg);
    minElong = Math.min(minElong, d.elong);
    if (d.mainArea < P1.UPRIGHT_MAIN_FRAC * d.maskArea) return U(f, 'fragmented');
    if (d.elong < P1.UPRIGHT_ELONG) return U(f, 'between_bands');
    if (d.tiltDeg <= P1.UPRIGHT_TRUE_DEG) return T(f);
    if (d.tiltDeg >= P1.UPRIGHT_FALSE_DEG) return F_(f);
    return U(f, 'between_bands');
  });
  const measures = maxTilt < 0 ? [] : [m('tilt_deg', maxTilt), m('elong', minElong)];
  return { ...windowAnd(rows), measures };
}

function movedFromStart(c: Ctx, t: Extract<Predicate, { p: 'moved_from_start' }>): Eval {
  const { F } = c;
  const E = endFrames(c.w);
  const n = c.count(t.e);
  let maxIou = 0;
  const done = (a: Agg): Eval => ({ ...a, measures: [m('iou', maxIou)] });
  const s0 = got(F, t.e, 0, true);
  const s1 = got(F, t.e, 1, true);
  if (!s0.ok || !s1.ok)
    return done({
      value: 'unknown',
      why: s0.ok ? (s1 as { why: CheckWhy }).why : s0.why,
      frames: [0, 1],
    });
  const r0 = t.ref === null ? null : gotRef(F, t.ref, 0);
  const r1 = t.ref === null ? null : gotRef(F, t.ref, 1);
  if ((r0 !== null && !r0.ok) || (r1 !== null && !r1.ok))
    return done({ value: 'unknown', why: 'ref_missing', frames: [0, 1] });
  const sh01: readonly [number, number] = r0?.ok && r1?.ok ? centreShift(r0.v, r1.v) : [0, 0];
  const map01 = matchInstances(s0.v, s1.v, sh01);
  if (map01 === null) return done({ value: 'unknown', why: 'unmatched', frames: [0, 1] });
  // per end frame: the ref's shift since frame 0, and the frame-wide unknowns
  const endCtx = E.map((f) => {
    const rf = t.ref === null ? null : gotRef(F, t.ref, f);
    const r = F.res.get(t.e)?.[f] as Resolved;
    const strong = r.cands.filter((d) => d.score >= P1.S_SEEN).length;
    // U2: an ambiguous end frame (crowded, or a rival within MARGIN) is unknown, never STAYED
    return { f, rf, r, crowded: strong > n || r.state === 'ambiguous' };
  });
  const perInst = s0.v.map((start, i): Agg => {
    const next = s1.v[map01[i] as number] as Det;
    if (iou(shiftBox(start.box, sh01[0], sh01[1]), next.box) < P1.START_STABLE_IOU)
      return { value: 'unknown', why: 'start_unstable', frames: [0, 1] };
    const rows = endCtx.map(({ f, rf, r, crowded }): FV => {
      if (crowded) return U(f, 'ambiguous');
      if (rf !== null && !rf.ok) return U(f, 'ref_missing');
      const sh = rf?.ok && r0?.ok ? centreShift(r0.v, rf.v) : [0, 0];
      const sb = shiftBox(start.box, sh[0] as number, sh[1] as number);
      const dist = (d: Det) => Math.hypot(bcx(d.box) - bcx(sb), bcy(d.box) - bcy(sb));
      const near = [...r.cands].sort((a, b) => dist(a) - dist(b))[0];
      const ious = r.cands.map((d) => iou(sb, d.box));
      if (near !== undefined) maxIou = Math.max(maxIou, iou(sb, near.box));
      // §4: clipping makes a subject's frame unknown (the nearest, or anything still in the spot)
      if (r.cands.some((d, k) => d.clipped && (d === near || (ious[k] as number) >= P1.MOVED_IOU)))
        return U(f, 'clipped');
      // STAYED: the nearest candidate sits in the start spot with the same shape (false side)
      if (
        near !== undefined &&
        near.score >= P1.S_SEEN &&
        iou(sb, near.box) >= P1.STAYED_IOU &&
        ratio(barea(near.box), barea(sb)) <= P1.STAYED_RATIO &&
        ratio(aspect(near.box), aspect(sb)) <= P1.STAYED_RATIO
      )
        return F_(f);
      // MOVED: gone from the start spot, or toppled in place
      if (ious.every((x) => x < P1.MOVED_IOU)) return T(f);
      if (
        near !== undefined &&
        dist(near) <= P1.MOVED_NEAR_DIAG * bdiag(sb) &&
        ratio(aspect(near.box), aspect(sb)) > P1.MOVED_ASPECT
      )
        return T(f);
      return U(f, 'between_bands');
    });
    return windowAnd(rows);
  });
  return done(combineInstances(perInst, t.of));
}

function stacked(c: Ctx, t: Extract<Predicate, { p: 'stacked' }>): Eval {
  const E = endFrames(c.w);
  const rows = E.map((f): FV => {
    const g = got(c.F, t.e, f, true);
    if (!g.ok) return U(f, g.why);
    const ds = [...g.v].sort((a, b) => bcy(a.box) - bcy(b.box));
    const top = ds[0] as Det;
    const u = unionBox(ds.slice(1).map((d) => d.box));
    const px = bcx(top.box);
    const th = bh(top.box);
    if (
      px >= u[0] - 0.05 * bw(u) &&
      px <= u[2] + 0.05 * bw(u) &&
      top.box[3] >= u[1] - 0.15 * th &&
      top.box[3] <= u[1] + 0.5 * th
    )
      return T(f);
    const beside = px < u[0] - 0.5 * bw(u) || px > u[2] + 0.5 * bw(u);
    let sideBySide = true;
    for (let i = 0; i < ds.length; i++)
      for (let j = i + 1; j < ds.length; j++) {
        const a = (ds[i] as Det).box;
        const b = (ds[j] as Det).box;
        const yo = overlap1d(a[1], a[3], b[1], b[3]) > 0.5 * Math.min(bh(a), bh(b));
        const xo = overlap1d(a[0], a[2], b[0], b[2]) < 0.1 * Math.min(bw(a), bw(b));
        if (!(yo && xo)) sideBySide = false;
      }
    return beside || sideBySide ? F_(f) : U(f, 'between_bands');
  });
  return { ...windowAnd(rows), measures: [] };
}

function touching(c: Ctx, t: Extract<Predicate, { p: 'touching' }>): Eval {
  const { F } = c;
  const hold = holdSeconds(t.window);
  if (Number.isFinite(hold) && lastSampleMs(c.w.durationMs) < hold * 1000 - P1.HOLD_SLACK_MS)
    return { value: 'false', why: 'clip_too_short', frames: [], measures: [] };
  const frames = windowFrames(c.w, t.window);
  let maxGap = 0;
  const rows = frames.map((f): FV => {
    const a = got1(F, t.a, f, true);
    if (!a.ok) return U(f, a.why);
    const b = gotRef(F, t.b, f);
    if (!b.ok) return U(f, b.why);
    const gap = boxGap(a.v.box, b.v.box);
    maxGap = Math.max(maxGap, gap);
    if (gap <= P1.GAP_TOUCH * F.Fmin) return T(f);
    if (gap >= Math.max(P1.GAP_APART * F.Fmin, P1.GAP_APART_DIAG * bdiag(a.v.box))) return F_(f);
    return U(f, 'between_bands');
  });
  let agg = windowAnd(rows);
  if (Number.isFinite(hold) && agg.value === 'true' && frames.length < P1.HOLD_MIN_FRAMES)
    agg = { value: 'unknown', why: 'too_few_frames', frames };
  return { ...agg, measures: [m('gap_rel', maxGap / F.Fmin), m('frames', frames.length)] };
}

function onTop(c: Ctx, t: Extract<Predicate, { p: 'on_top' }>): Eval {
  const { F } = c;
  const rows = endFrames(c.w).map((f): FV => {
    const ga = got1(F, t.a, f, true);
    if (!ga.ok) return U(f, ga.why);
    const gb = gotRef(F, t.b, f);
    if (!gb.ok) return U(f, gb.why);
    const a = ga.v.box;
    const b = gb.v.box;
    const px = bcx(a);
    if (
      px >= b[0] - 0.05 * bw(b) &&
      px <= b[2] + 0.05 * bw(b) &&
      a[3] >= b[1] - 0.15 * bh(a) &&
      a[3] <= b[3] &&
      bcy(a) < bcy(b) &&
      boxGap(a, b) <= P1.GAP_TOUCH * F.Fmin
    )
      return T(f);
    const below = bcy(a) > b[3] + 0.02 * F.H && !gb.v.clip.b;
    const beside = px < b[0] - 0.5 * bw(b) || px > b[2] + 0.5 * bw(b);
    return below || beside ? F_(f) : U(f, 'between_bands');
  });
  return { ...windowAnd(rows), measures: [] };
}

function endsAt(c: Ctx, t: Extract<Predicate, { p: 'ends_at' }>): Eval {
  const { F } = c;
  const E = endFrames(c.w);
  const last = E[E.length - 1] as number;
  let lastGap = NaN;
  const apart = (f: number): FV => {
    const gb = gotRef(F, t.b, f);
    if (!gb.ok) return U(f, gb.why);
    const ra = F.res.get(t.a)?.[f] as Resolved;
    if (ra.cands.length === 0) return T(f); // absent: inside the target, or gone
    const ga = got1(F, t.a, f, true);
    if (!ga.ok) return U(f, ga.why);
    const gap = boxGap(ga.v.box, gb.v.box);
    if (f === last) lastGap = gap;
    if (gap <= P1.GAP_TOUCH * F.Fmin) return T(f);
    if (gap >= Math.max(P1.GAP_APART * F.Fmin, P1.GAP_APART_DIAG * bdiag(ga.v.box))) return F_(f);
    return U(f, 'between_bands');
  };
  const rows = E.map(apart);
  const lastRow = rows[rows.length - 1] as FV;
  const measures = Number.isNaN(lastGap) ? [] : [m('gap_rel', lastGap / F.Fmin)];
  // TRUE is decided on the last frame alone; FALSE needs >= 2 end frames including the last.
  if (lastRow.t === 'true') return { value: 'true', why: 'ok', frames: [last], measures };
  const fs = rows.filter((r) => r.t === 'false');
  if (lastRow.t === 'false' && fs.length >= 2)
    return { value: 'false', why: 'ok', frames: fs.map((r) => r.f), measures };
  return {
    value: 'unknown',
    why: lastRow.t === 'false' ? 'single_frame' : lastRow.why,
    frames: [last],
    measures,
  };
}

function switchedSides(c: Ctx, t: Extract<Predicate, { p: 'switched_sides' }>): Eval {
  const { F } = c;
  type Side = 'L' | 'R' | null; // null: straddling
  const sideAt = (f: number): Got<Side> => {
    const r = F.res.get(t.a)?.[f] as Resolved;
    if (r.state !== 'seen') return { ok: false, why: stateWhy(r.state) };
    const a = r.inst[0] as Det;
    // only the x-extent matters here: clipping at the left or right makes it unknown
    if (a.clip.l || a.clip.r) return { ok: false, why: 'clipped' };
    const gb = gotRef(F, t.b, f);
    if (!gb.ok) return gb;
    const ax = bcx(a.box);
    return { ok: true, v: ax <= gb.v.box[0] ? 'L' : ax >= gb.v.box[2] ? 'R' : null };
  };
  const all = range(0, c.w.n).map(sideAt);
  // §4 #9: the first lead-in frame where both are seen; a clipped a there is unknown, not skipped
  const together = (f: number) => F.res.get(t.a)?.[f]?.state === 'seen' && gotRef(F, t.b, f).ok;
  const f0 = leadInFrames(c.w).find(together);
  if (f0 === undefined)
    return { value: 'unknown', why: 'not_together', frames: leadInFrames(c.w), measures: [] };
  const g0 = all[f0] as Got<Side>;
  if (!g0.ok) return { value: 'unknown', why: g0.why, frames: [f0], measures: [] };
  const s0 = g0.v;
  if (s0 === null) return { value: 'unknown', why: 'between_bands', frames: [f0], measures: [] };
  const other: Side = s0 === 'L' ? 'R' : 'L';
  const E = endFrames(c.w);
  const rows = E.map((f): FV => {
    const g = all[f] as Got<Side>;
    if (!g.ok) return U(f, g.why);
    return g.v === other ? T(f) : g.v === s0 ? F_(f) : U(f, 'between_bands');
  });
  const measures = [m('frames', rows.filter((r) => r.t === 'true').length)];
  if (rows.every((r) => r.t === 'true'))
    return { value: 'true', why: 'ok', frames: [f0, ...E], measures };
  const fs = rows.filter((r) => r.t === 'false');
  const everOther = all.some((g) => g.ok && g.v === other);
  if (fs.length >= 2 && !everOther)
    return { value: 'false', why: 'ok', frames: [f0, ...fs.map((r) => r.f)], measures };
  const u = rows.find((r) => r.t === 'unknown');
  return {
    value: 'unknown',
    why: u?.why ?? (fs.length < 2 ? 'single_frame' : 'between_bands'),
    frames: [f0, ...rows.filter((r) => r.t !== 'true').map((r) => r.f)],
    measures,
  };
}

function evalPredicate(c: Ctx, t: Predicate): Eval {
  switch (t.p) {
    case 'visible':
      return visible(c, t);
    case 'at_rest':
      return atRest(c, t);
    case 'upright':
      return upright(c, t);
    case 'moved_from_start':
      return movedFromStart(c, t);
    case 'stacked':
      return stacked(c, t);
    case 'touching':
      return touching(c, t);
    case 'on_top':
      return onTop(c, t);
    case 'ends_at':
      return endsAt(c, t);
    case 'switched_sides':
      return switchedSides(c, t);
  }
}

// ---------------- the report (§7-§8) ----------------

function unavailable(rev: string, meta: ReportMeta): CheckReport {
  return {
    schema_version: 1,
    predicates: 'p1',
    status: 'unavailable',
    sam_rev: rev,
    sam_reply_hash: null,
    terms_hash: meta.terms_hash,
    frame_hashes: meta.frame_hashes,
    results: [],
    gate: 'unknown',
    need: 'unknown',
    created_at: meta.created_at,
  };
}

/**
 * §2-§8. `samReply` is the raw /segment JSON (masks: true) over the regular frames at
 * `frameTimesMs`, or null when SAM errored or timed out; a reply that does not parse or decode is
 * treated the same (status 'unavailable': no veto). U1 (fewer than MIN_FRAMES, a frame-count
 * mismatch, fewer than 4 landing frames) makes every row unknown.
 */
export function evaluateChecks(
  spec: CheckSpec,
  samReply: unknown,
  frameTimesMs: readonly number[],
  durationMs: number,
  meta: ReportMeta,
): CheckReport {
  const parsed = SamSegmentReply.safeParse(samReply);
  if (!parsed.success) return unavailable('', meta);
  const reply = parsed.data;
  const n = frameTimesMs.length;
  const w: Win = { n, times: frameTimesMs, durationMs };
  let measured: Frames | 'u1';
  try {
    measured = measure(reply, spec.entities, n);
  } catch {
    return unavailable(reply.rev, meta); // missing prompt, bad RLE, mixed frame sizes
  }
  const F = measured;
  const results: CheckRow[] = [];
  if (
    F === 'u1' ||
    n < P1.MIN_FRAMES ||
    n > MAX_JUDGE_FRAMES ||
    landingFrames(w).length < P1.MIN_LANDING_FRAMES
  ) {
    for (const _ of spec.assertions)
      results.push({ value: 'unknown', why: 'too_few_frames', frames: [], measures: [] });
  } else {
    const frames = F;
    const subjects = subjectKeys(spec);
    const gated = new Set(
      spec.assertions.flatMap((a) =>
        a.role === 'gate' && a.test.p === 'visible' ? [a.test.e] : [],
      ),
    );
    const everDetected = (k: string) => (frames.res.get(k) ?? []).some((r) => r.cands.length > 0);
    const ctx: Ctx = {
      F: frames,
      w,
      spec,
      subjects,
      count: (k) => spec.entities.find((e) => e.key === k)?.count ?? 1,
    };
    for (const a of spec.assertions) {
      // §7.6 never_seen: a need whose subjects are all ungated and never detected abstains.
      const subs = roles(a.test).subjects;
      if (
        a.role === 'need' &&
        subs.length > 0 &&
        subs.every((k) => !gated.has(k) && !everDetected(k))
      ) {
        results.push({ value: 'abstain', why: 'never_seen', frames: [], measures: [] });
        continue;
      }
      const r = evalPredicate(ctx, a.test);
      results.push({
        value: r.value,
        why: r.why,
        frames: uniqSorted(r.frames),
        measures: r.measures.slice(0, 4),
      });
    }
  }
  const of = (role: 'gate' | 'need'): CheckValue[] =>
    spec.assertions.flatMap((a, i) => (a.role === role ? [results[i]?.value ?? 'unknown'] : []));
  return {
    schema_version: 1,
    predicates: 'p1',
    status: 'ok',
    sam_rev: reply.rev,
    sam_reply_hash: hashJcs(samReply),
    terms_hash: meta.terms_hash,
    frame_hashes: meta.frame_hashes,
    results,
    gate: kleeneAnd(of('gate')),
    need: kleeneAnd(of('need')),
    created_at: meta.created_at,
  };
}
