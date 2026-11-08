/**
 * Frame space and evaluation context (§3.2).
 *
 * Signals are indexed by position in F (`pos`), never by absolute frame.
 * Look-backs and look-aheads never leave the segment of the frame.
 */
import type { DecodedRef, DecodedRegion, EntityKindCode, QFrame, TrackSegment } from '../types.js';
import { FPS, PRESENCE_MIN, RELEASE_GAP, STALE_REGION_FRAMES } from '../constants.js';
import { type Box, type Pt, boxOf, bottomCenter, center, interiorRect, openingRect, polyBBox, toPts } from './geometry.js';
import { EvalInvariantError } from './math.js';

export interface FrameSpace {
  /** |F| */
  n: number;
  /** absolute frame at each position */
  abs: number[];
  /** segment index at each position */
  seg: number[];
  /** position of the first frame of the segment containing pos */
  segStart: number[];
  /** exclusive end position of the segment containing pos */
  segEnd: number[];
  /** LIMIT = time_limit_s · FPS */
  limit: number;
}

export type RegionGeom =
  | { shape: 'line'; a: Pt; b: Pt; behindSign: number }
  | { shape: 'zone'; v: Pt[]; bbox: Box };

export interface EntityCtx {
  kind: EntityKindCode;
  /** participant index for person, else 0 */
  param: number;
  /** track index, or -1 for region / untracked entities */
  track: number;
  /** static geometry for region entities (null if not placed) */
  region: RegionGeom | null;
}

export interface EvalCtx {
  fs: FrameSpace;
  entities: EntityCtx[];
  /** records `[track][pos]` (null ⇔ absent / zero record) */
  recs: (QFrame | null)[][];
  /** ref_h per track */
  refH: number[];
  /** memo for per-entity derived arrays */
  memo: Map<string, unknown>;
}

export interface TrackTableLike {
  entity_idx: number;
  ref_h: number;
}

export function buildFrameSpace(segments: readonly TrackSegment[], timeLimitS: number): FrameSpace {
  const abs: number[] = [];
  const seg: number[] = [];
  const segStart: number[] = [];
  const segEnd: number[] = [];
  segments.forEach((s, si) => {
    const startPos = abs.length;
    const endPos = startPos + s.frames.length;
    for (let i = 0; i < s.frames.length; i++) {
      abs.push(s.frame_start + i);
      seg.push(si);
      segStart.push(startPos);
      segEnd.push(endPos);
    }
  });
  return { n: abs.length, abs, seg, segStart, segEnd, limit: timeLimitS * FPS };
}

export function regionGeom(r: DecodedRegion): RegionGeom {
  const pts = toPts(r.points);
  if (r.shape === 0) {
    if (pts.length !== 2) throw new EvalInvariantError('line region must have 2 points');
    return { shape: 'line', a: pts[0]!, b: pts[1]!, behindSign: r.behind_sign };
  }
  return { shape: 'zone', v: pts, bbox: polyBBox(pts) };
}

/**
 * Build the evaluation context from decoded parts. `entities` carry kind and
 * param; `regions` the decoded calibration regions (possibly partial for
 * scene-check use); `tracks` the track table; `segments` the records.
 */
export function buildCtx(
  entities: readonly { kind: EntityKindCode; param: number }[],
  regions: readonly DecodedRegion[],
  tracks: readonly TrackTableLike[],
  segments: readonly TrackSegment[],
  timeLimitS: number,
): EvalCtx {
  const fs = buildFrameSpace(segments, timeLimitS);
  const ents: EntityCtx[] = entities.map((e) => ({ kind: e.kind, param: e.param, track: -1, region: null }));
  tracks.forEach((t, ti) => {
    const e = ents[t.entity_idx];
    if (e === undefined) throw new EvalInvariantError(`track for unknown entity ${t.entity_idx}`);
    e.track = ti;
  });
  for (const r of regions) {
    const e = ents[r.entity_idx];
    if (e === undefined) throw new EvalInvariantError(`region for unknown entity ${r.entity_idx}`);
    e.region = regionGeom(r);
  }
  const recs: (QFrame | null)[][] = tracks.map(() => []);
  for (const s of segments) {
    for (const frame of s.frames) {
      for (let ti = 0; ti < tracks.length; ti++) {
        const r = frame[ti] ?? null;
        recs[ti]!.push(r !== null && r.conf > 0 ? r : null);
      }
    }
  }
  return { fs, entities: ents, recs, refH: tracks.map((t) => t.ref_h), memo: new Map() };
}

// ---------------------------------------------------------------------------
// Frame-space navigation
// ---------------------------------------------------------------------------

/** `prev(f)` as a position, or -1 when f-1 is not in seg(f). */
export function prevPos(fs: FrameSpace, pos: number): number {
  return pos > fs.segStart[pos]! ? pos - 1 : -1;
}

/** Position of absolute frame `pos_abs - k` if it is in the same segment, else -1. */
export function backPos(fs: FrameSpace, pos: number, k: number): number {
  const q = pos - k;
  return q >= fs.segStart[pos]! ? q : -1;
}

/** Position of absolute frame `abs(pos) + k` if it is in the same segment, else -1. */
export function aheadPos(fs: FrameSpace, pos: number, k: number): number {
  const q = pos + k;
  return q < fs.segEnd[pos]! ? q : -1;
}

/** True iff pos is in F_R (absolute frame < LIMIT). */
export function inFR(fs: FrameSpace, pos: number): boolean {
  return fs.abs[pos]! < fs.limit;
}

// ---------------------------------------------------------------------------
// Records and presence
// ---------------------------------------------------------------------------

/** The raw record (conf may be below PRESENCE_MIN), or null. */
export function rec(ctx: EvalCtx, entity: number, pos: number): QFrame | null {
  const e = ctx.entities[entity];
  if (e === undefined || e.track < 0) return null;
  return ctx.recs[e.track]![pos] ?? null;
}

/** `present(e, f) ⇔ rec.conf ≥ PRESENCE_MIN`. */
export function present(ctx: EvalCtx, entity: number, pos: number): boolean {
  const r = rec(ctx, entity, pos);
  return r !== null && r.conf >= PRESENCE_MIN;
}

/** `box(e, f)` if present, else null. */
export function boxAt(ctx: EvalCtx, entity: number, pos: number): Box | null {
  const r = rec(ctx, entity, pos);
  return r !== null && r.conf >= PRESENCE_MIN ? boxOf(r) : null;
}

/** Anchor point (§2.2): persons → bottom-center (feet); objects → center. */
export function anchorOf(ctx: EvalCtx, entity: number, b: Box): Pt {
  const k = ctx.entities[entity]!.kind;
  return k === 0 || k === 1 ? bottomCenter(b) : center(b);
}

function memo<T>(ctx: EvalCtx, key: string, build: () => T): T {
  const hit = ctx.memo.get(key);
  if (hit !== undefined) return hit as T;
  const v = build();
  ctx.memo.set(key, v);
  return v;
}

/**
 * `lastSeen(a, f)` for every position: the latest `p < f` in seg(f) with
 * `present(a, p)` and `f - p ≤ RELEASE_GAP`, as a position, or -1. O(|F|).
 */
export function lastSeenArr(ctx: EvalCtx, entity: number): Int32Array {
  return memo(ctx, `ls:${entity}`, () => {
    const { fs } = ctx;
    const out = new Int32Array(fs.n).fill(-1);
    let last = -1;
    for (let pos = 0; pos < fs.n; pos++) {
      if (pos === fs.segStart[pos]) last = -1;
      if (last >= 0 && fs.abs[pos]! - fs.abs[last]! <= RELEASE_GAP) out[pos] = last;
      if (present(ctx, entity, pos)) last = pos;
    }
    return out;
  });
}

/**
 * Container box of an object for sub-region refs (§2.3): its box if present,
 * else the box at the most recent present frame p in the same segment with
 * `f - p ≤ STALE_REGION_FRAMES`, else null (undefined). O(|F|).
 */
export function containerArr(ctx: EvalCtx, entity: number): (Box | null)[] {
  return memo(ctx, `ct:${entity}`, () => {
    const { fs } = ctx;
    const out: (Box | null)[] = new Array<Box | null>(fs.n).fill(null);
    let last = -1;
    let lastBox: Box | null = null;
    for (let pos = 0; pos < fs.n; pos++) {
      if (pos === fs.segStart[pos]) {
        last = -1;
        lastBox = null;
      }
      const b = boxAt(ctx, entity, pos);
      if (b !== null) {
        last = pos;
        lastBox = b;
        out[pos] = b;
      } else if (last >= 0 && fs.abs[pos]! - fs.abs[last]! <= STALE_REGION_FRAMES) {
        out[pos] = lastBox;
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// `b` operands
// ---------------------------------------------------------------------------

export type BOperand =
  | { kind: 'box'; box: Box; tracked: true }
  | { kind: 'rect'; box: Box; container: Box; tracked: false }
  | { kind: 'zone'; v: Pt[]; box: Box; tracked: false }
  | { kind: 'line'; a: Pt; b: Pt; behindSign: number; tracked: false };

/**
 * Resolve a `b` operand at pos, or null when it is undefined there
 * ("b defined at f", §3.2). `box` is `bbox_b` (§3.3) for box/rect/zone.
 */
export function bOperand(ctx: EvalCtx, ref: DecodedRef, pos: number): BOperand | null {
  const e = ctx.entities[ref.entity];
  if (e === undefined) return null;
  if (e.kind === 3 || e.kind === 4) {
    const g = e.region;
    if (g === null) return null;
    if (g.shape === 'line') return { kind: 'line', a: g.a, b: g.b, behindSign: g.behindSign, tracked: false };
    return { kind: 'zone', v: g.v, box: g.bbox, tracked: false };
  }
  if (ref.sub === 0) {
    const b = boxAt(ctx, ref.entity, pos);
    return b === null ? null : { kind: 'box', box: b, tracked: true };
  }
  const c = containerArr(ctx, ref.entity)[pos] ?? null;
  if (c === null) return null;
  return { kind: 'rect', box: ref.sub === 1 ? openingRect(c) : interiorRect(c), container: c, tracked: false };
}

/** "b defined at f" (§3.2). */
export function bDefined(ctx: EvalCtx, ref: DecodedRef, pos: number): boolean {
  return bOperand(ctx, ref, pos) !== null;
}
