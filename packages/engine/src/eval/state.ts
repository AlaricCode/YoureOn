/**
 * State primitives (level signals, §3.4).
 */
import type { DecodedRef } from '../types.js';
import {
  FPS,
  INTACT_PCT,
  MOVE_MIN_UPS,
  STILL_MAX_UPS,
  VEL_K,
} from '../constants.js';
import { type BOperand, type EvalCtx, anchorOf, bOperand, backPos, boxAt, present, rec } from './frames.js';
import { type Box, area, center, inter, ptInPoly, ptInRect, side } from './geometry.js';
import { applyCmp, iabs, idiv, isqrt } from './math.js';
import { forDuration } from './combinators.js';

export type Signal = Uint8Array;

export function newSignal(n: number): Signal {
  return new Uint8Array(n);
}

/** Build a signal from a per-position predicate. */
export function pointwise(ctx: EvalCtx, pred: (pos: number) => boolean): Signal {
  const out = newSignal(ctx.fs.n);
  for (let pos = 0; pos < ctx.fs.n; pos++) if (pred(pos)) out[pos] = 1;
  return out;
}

// ---------------------------------------------------------------------------
// Per-frame predicates (shared with event primitives)
// ---------------------------------------------------------------------------

/** `overlaps(a, b)` at pos for given a box and resolved b operand. */
export function overlapsWith(ctx: EvalCtx, a: number, ab: Box, b: BOperand): boolean {
  switch (b.kind) {
    case 'box':
    case 'rect':
      return inter(ab, b.box) !== null;
    case 'zone':
      return ptInPoly(center(ab), b.v) || ptInPoly(anchorOf(ctx, a, ab), b.v);
    case 'line':
      return false;
  }
}

/** `inside(a, b)` at pos for given a box and resolved b operand. */
export function insideWith(ctx: EvalCtx, a: number, ab: Box, b: BOperand): boolean {
  switch (b.kind) {
    case 'box': {
      if (!ptInRect(center(ab), b.box)) return false;
      const aa = area(ab);
      if (aa === 0) return true;
      const i = inter(ab, b.box);
      const ia = i === null ? 0 : area(i);
      return 2 * ia >= aa;
    }
    case 'rect':
      return ptInRect(center(ab), b.box);
    case 'zone':
      return ptInPoly(anchorOf(ctx, a, ab), b.v);
    case 'line':
      return false;
  }
}

export function overlapsAt(ctx: EvalCtx, a: DecodedRef, bRef: DecodedRef, pos: number): boolean {
  const ab = boxAt(ctx, a.entity, pos);
  if (ab === null) return false;
  const b = bOperand(ctx, bRef, pos);
  return b !== null && overlapsWith(ctx, a.entity, ab, b);
}

export function insideAt(ctx: EvalCtx, a: DecodedRef, bRef: DecodedRef, pos: number): boolean {
  const ab = boxAt(ctx, a.entity, pos);
  if (ab === null) return false;
  const b = bOperand(ctx, bRef, pos);
  return b !== null && insideWith(ctx, a.entity, ab, b);
}

/** `vel(e, f)`: `[dx, dy]` of centers over VEL_K frames, or null if undefined. */
export function velAt(ctx: EvalCtx, entity: number, pos: number): [number, number] | null {
  const b = boxAt(ctx, entity, pos);
  if (b === null) return null;
  const q = backPos(ctx.fs, pos, VEL_K);
  if (q < 0) return null;
  const bq = boxAt(ctx, entity, q);
  if (bq === null) return null;
  const c = center(b);
  const cq = center(bq);
  return [c.x - cq.x, c.y - cq.y];
}

/** `speed = isqrt(dx² + dy²) · FPS / VEL_K` (ups). */
export function speedOf(dx: number, dy: number): number {
  return idiv(isqrt(dx * dx + dy * dy) * FPS, VEL_K);
}

// ---------------------------------------------------------------------------
// Leaf signals
// ---------------------------------------------------------------------------

export function sigPresent(ctx: EvalCtx, a: DecodedRef): Signal {
  return pointwise(ctx, (pos) => present(ctx, a.entity, pos));
}

export function sigOverlaps(ctx: EvalCtx, a: DecodedRef, b: DecodedRef): Signal {
  return pointwise(ctx, (pos) => overlapsAt(ctx, a, b, pos));
}

export function sigInside(ctx: EvalCtx, a: DecodedRef, b: DecodedRef): Signal {
  return pointwise(ctx, (pos) => insideAt(ctx, a, b, pos));
}

function boxLike(b: BOperand | null): Box | null {
  return b === null || b.kind === 'line' ? null : b.box;
}

/** `above(a,b)` (`up = true`) or `below(a,b)` (`up = false`). */
export function sigAboveBelow(ctx: EvalCtx, a: DecodedRef, bRef: DecodedRef, up: boolean): Signal {
  return pointwise(ctx, (pos) => {
    const ab = boxAt(ctx, a.entity, pos);
    if (ab === null) return false;
    const bb = boxLike(bOperand(ctx, bRef, pos));
    if (bb === null) return false;
    const cy = center(ab).y;
    const vert = up ? cy < bb.y0 : cy > bb.y1;
    return vert && ab.x0 < bb.x1 && bb.x0 < ab.x1;
  });
}

export function sigNear(ctx: EvalCtx, a: DecodedRef, bRef: DecodedRef, dist: number): Signal {
  const d2 = dist * dist;
  return pointwise(ctx, (pos) => {
    const ab = boxAt(ctx, a.entity, pos);
    if (ab === null) return false;
    const bb = boxLike(bOperand(ctx, bRef, pos));
    if (bb === null) return false;
    const gx = Math.max(0, bb.x0 - ab.x1, ab.x0 - bb.x1);
    const gy = Math.max(0, bb.y0 - ab.y1, ab.y0 - bb.y1);
    return gx * gx + gy * gy <= d2;
  });
}

/** `behind(a,L)` (`wantSign = +behind_sign`) or `beyond(a,L)` (`-behind_sign`). */
export function sigBehindBeyond(ctx: EvalCtx, a: DecodedRef, bRef: DecodedRef, beyond: boolean): Signal {
  return pointwise(ctx, (pos) => {
    const ab = boxAt(ctx, a.entity, pos);
    if (ab === null) return false;
    const l = bOperand(ctx, bRef, pos);
    if (l === null || l.kind !== 'line') return false;
    const s = side(l.a, l.b, anchorOf(ctx, a.entity, ab));
    const want = beyond ? -l.behindSign : l.behindSign;
    return s !== 0 && s === want;
  });
}

export function sigMoving(ctx: EvalCtx, a: DecodedRef): Signal {
  return pointwise(ctx, (pos) => {
    const v = velAt(ctx, a.entity, pos);
    return v !== null && speedOf(v[0], v[1]) >= MOVE_MIN_UPS;
  });
}

export function sigSpeed(ctx: EvalCtx, a: DecodedRef, cmp: number, value: number): Signal {
  return pointwise(ctx, (pos) => {
    const v = velAt(ctx, a.entity, pos);
    return v !== null && applyCmp(cmp, speedOf(v[0], v[1]), value);
  });
}

export function sigDirection(ctx: EvalCtx, a: DecodedRef, dir: number): Signal {
  return pointwise(ctx, (pos) => {
    const v = velAt(ctx, a.entity, pos);
    if (v === null) return false;
    const [dx, dy] = v;
    if (speedOf(dx, dy) < MOVE_MIN_UPS) return false;
    switch (dir) {
      case 0:
        return dy < 0 && 2 * iabs(dy) >= iabs(dx);
      case 1:
        return dy > 0 && 2 * dy >= iabs(dx);
      case 2:
        return dx < 0 && 2 * iabs(dx) >= iabs(dy);
      case 3:
        return dx > 0 && 2 * dx >= iabs(dy);
      default:
        return false;
    }
  });
}

/** `still(a)[f] = vel defined && speed <= STILL_MAX_UPS`. */
export function sigStill(ctx: EvalCtx, a: DecodedRef): Signal {
  return pointwise(ctx, (pos) => {
    const v = velAt(ctx, a.entity, pos);
    return v !== null && speedOf(v[0], v[1]) <= STILL_MAX_UPS;
  });
}

/** `at_rest(a, D) = for_duration(D, still(a))`. */
export function sigAtRest(ctx: EvalCtx, a: DecodedRef, frames: number): Signal {
  return forDuration(ctx.fs, frames, sigStill(ctx, a));
}

export function sigIntact(ctx: EvalCtx, a: DecodedRef): Signal {
  const e = ctx.entities[a.entity]!;
  const refH = e.track >= 0 ? ctx.refH[e.track]! : 0;
  return pointwise(ctx, (pos) => {
    const b = boxAt(ctx, a.entity, pos);
    if (b === null) return false;
    if (refH === 0) return true;
    return (b.y1 - b.y0) * 100 >= refH * INTACT_PCT;
  });
}

export function sigStanding(ctx: EvalCtx, a: DecodedRef): Signal {
  return pointwise(ctx, (pos) => present(ctx, a.entity, pos) && (rec(ctx, a.entity, pos)!.pose & 0x01) !== 0);
}

/**
 * `reps(a, f)` for every position: one scan over all of F in order, crossing
 * segments (§3.4).
 */
export function repsArr(ctx: EvalCtx, entity: number): Int32Array {
  const out = new Int32Array(ctx.fs.n);
  let low = false;
  let count = 0;
  for (let pos = 0; pos < ctx.fs.n; pos++) {
    if (present(ctx, entity, pos)) {
      const pose = rec(ctx, entity, pos)!.pose;
      if ((pose & 0x02) !== 0) {
        low = true;
      } else if ((pose & 0x04) !== 0) {
        if (low) count += 1;
        low = false;
      }
    }
    out[pos] = count;
  }
  return out;
}

export function sigRepCount(ctx: EvalCtx, a: DecodedRef, cmp: number, value: number): Signal {
  const reps = repsArr(ctx, a.entity);
  return pointwise(ctx, (pos) => present(ctx, a.entity, pos) && applyCmp(cmp, reps[pos]!, value));
}
