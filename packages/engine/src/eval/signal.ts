/**
 * Recursive expression evaluation: every node → boolean signal over F (§3.2).
 */
import type { DecodedExpr } from '../types.js';
import { LEAF_CODE } from '../constants.js';
import type { EvalCtx } from './frames.js';
import { decodeRefByte, type LeafNode } from './code.js';
import { beforeSig, forDuration, sigAnd, sigNot, sigOr, thenWithin } from './combinators.js';
import {
  type Signal,
  sigAboveBelow,
  sigAtRest,
  sigBehindBeyond,
  sigDirection,
  sigInside,
  sigIntact,
  sigMoving,
  sigNear,
  sigOverlaps,
  sigPresent,
  sigRepCount,
  sigSpeed,
  sigStanding,
} from './state.js';
import { sigCrosses, sigDisappearsInto, sigEnters, sigLeaves, sigReleasedBy, sigTouches } from './events.js';
import { EvalInvariantError } from './math.js';

/** Evaluate one leaf node over F. */
export function evalLeaf(ctx: EvalCtx, n: LeafNode): Signal {
  const a = n.a;
  const b = decodeRefByte(n.b);
  switch (n.code) {
    case LEAF_CODE.overlaps:
      return sigOverlaps(ctx, a, b);
    case LEAF_CODE.inside:
      return sigInside(ctx, a, b);
    case LEAF_CODE.above:
      return sigAboveBelow(ctx, a, b, true);
    case LEAF_CODE.below:
      return sigAboveBelow(ctx, a, b, false);
    case LEAF_CODE.near:
      return sigNear(ctx, a, b, n.p);
    case LEAF_CODE.behind:
      return sigBehindBeyond(ctx, a, b, false);
    case LEAF_CODE.beyond:
      return sigBehindBeyond(ctx, a, b, true);
    case LEAF_CODE.moving:
      return sigMoving(ctx, a);
    case LEAF_CODE.at_rest:
      return sigAtRest(ctx, a, n.p);
    case LEAF_CODE.speed:
      return sigSpeed(ctx, a, n.b, n.p);
    case LEAF_CODE.direction:
      return sigDirection(ctx, a, n.b);
    case LEAF_CODE.present:
      return sigPresent(ctx, a);
    case LEAF_CODE.intact:
      return sigIntact(ctx, a);
    case LEAF_CODE.enters:
      return sigEnters(ctx, a, b);
    case LEAF_CODE.leaves:
      return sigLeaves(ctx, a, b);
    case LEAF_CODE.disappears_into:
      return sigDisappearsInto(ctx, a, b);
    case LEAF_CODE.touches:
      return sigTouches(ctx, a, b);
    case LEAF_CODE.crosses:
      return sigCrosses(ctx, a, b);
    case LEAF_CODE.released_by:
      return sigReleasedBy(ctx, a, b);
    case LEAF_CODE.standing:
      return sigStanding(ctx, a);
    case LEAF_CODE.rep_count:
      return sigRepCount(ctx, a, n.b, n.p);
    default:
      throw new EvalInvariantError(`unknown leaf code 0x${(n.code as number).toString(16)}`);
  }
}

/** Evaluate an expression tree over F. */
export function evalExpr(ctx: EvalCtx, e: DecodedExpr): Signal {
  switch (e.code) {
    case 0x01:
      return sigAnd(evalExpr(ctx, e.left), evalExpr(ctx, e.right));
    case 0x02:
      return sigOr(evalExpr(ctx, e.left), evalExpr(ctx, e.right));
    case 0x03:
      return sigNot(evalExpr(ctx, e.arg));
    case 0x04:
      return thenWithin(ctx.fs, e.frames, evalExpr(ctx, e.first), evalExpr(ctx, e.then));
    case 0x05:
      return forDuration(ctx.fs, e.frames, evalExpr(ctx, e.arg));
    case 0x06:
      return beforeSig(ctx.fs, e.frames, evalExpr(ctx, e.arg));
    default:
      return evalLeaf(ctx, e);
  }
}
