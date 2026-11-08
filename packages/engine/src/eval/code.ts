/**
 * Expression / condition code readers for the evaluator (§5.1), plus the cost
 * function (§3.13) and operand helpers.
 *
 * The evaluator only runs on binaries that passed the decoders, so these
 * readers are defensive (they throw on malformed input) but do not repeat the
 * decoders' validation of operand kinds, limits and ranges.
 */
import type { DecodedCond, DecodedExpr, DecodedProgram, DecodedRef, LeafCode, SubRegionCode } from '../types.js';
import {
  COST_COMBINATOR,
  COST_DISAPPEARS_INTO,
  COST_EVENT_LEAF,
  COST_POLY_EVENT_LEAF,
  COST_POLY_STATE_LEAF,
  COST_STATE_LEAF,
  EVAL_COST_SETUP_FRAMES,
  LEAF_CODE,
} from '../constants.js';
import { EvalInvariantError } from './math.js';

export type LeafNode = Extract<DecodedExpr, { a: DecodedRef }>;

const LEAF_CODES: ReadonlySet<number> = new Set<number>(Object.values(LEAF_CODE));

/** Leaf codes whose `b` byte is a Ref (relational leaves). */
const REF_B_CODES: ReadonlySet<number> = new Set<number>([
  LEAF_CODE.overlaps,
  LEAF_CODE.inside,
  LEAF_CODE.above,
  LEAF_CODE.below,
  LEAF_CODE.near,
  LEAF_CODE.behind,
  LEAF_CODE.beyond,
  LEAF_CODE.enters,
  LEAF_CODE.leaves,
  LEAF_CODE.disappears_into,
  LEAF_CODE.touches,
  LEAF_CODE.crosses,
  LEAF_CODE.released_by,
]);

export function isLeafCode(code: number): code is LeafCode {
  return LEAF_CODES.has(code);
}

/** True iff the leaf's `b` byte is a Ref. */
export function leafHasRefB(code: number): boolean {
  return REF_B_CODES.has(code);
}

/** Event leaves (pulse signals, §3.5): codes 0x30–0x35. */
export function isEventLeaf(code: number): boolean {
  return code >= 0x30 && code <= 0x35;
}

export function decodeRefByte(b: number): DecodedRef {
  return { entity: b & 0x0f, sub: ((b >> 4) & 0x03) as SubRegionCode };
}

export function isLeaf(node: DecodedExpr): node is LeafNode {
  return isLeafCode(node.code);
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.buf.length) throw new EvalInvariantError('expression code truncated');
    return this.buf[this.pos++]!;
  }
  u16(): number {
    const lo = this.u8();
    const hi = this.u8();
    return lo | (hi << 8);
  }
  u32(): number {
    const b0 = this.u8();
    const b1 = this.u8();
    const b2 = this.u8();
    const b3 = this.u8();
    return (b0 | (b1 << 8) | (b2 << 16)) + b3 * 0x1000000;
  }
  i32(): number {
    const b0 = this.u8();
    const b1 = this.u8();
    const b2 = this.u8();
    const b3 = this.u8();
    return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  }
}

function readExpr(r: Reader, depth: number): DecodedExpr {
  if (depth > 64) throw new EvalInvariantError('expression too deep');
  const code = r.u8();
  switch (code) {
    case 0x01:
    case 0x02: {
      const left = readExpr(r, depth + 1);
      const right = readExpr(r, depth + 1);
      return { code, left, right };
    }
    case 0x03:
      return { code, arg: readExpr(r, depth + 1) };
    case 0x04: {
      const frames = r.u16();
      const first = readExpr(r, depth + 1);
      const then = readExpr(r, depth + 1);
      return { code, frames, first, then };
    }
    case 0x05: {
      const frames = r.u16();
      return { code, frames, arg: readExpr(r, depth + 1) };
    }
    case 0x06: {
      const frames = r.u32();
      return { code, frames, arg: readExpr(r, depth + 1) };
    }
    default: {
      if (!isLeafCode(code)) throw new EvalInvariantError(`unknown expression op 0x${code.toString(16)}`);
      const a = decodeRefByte(r.u8());
      const b = r.u8();
      const p = r.i32();
      return { code, a, b, p };
    }
  }
}

/** Parse a leg expression code (prefix order, §5.1). Empty input → null. */
export function parseExprCode(code: Uint8Array): DecodedExpr | null {
  if (code.length === 0) return null;
  const r = new Reader(code);
  const e = readExpr(r, 0);
  if (r.pos !== code.length) throw new EvalInvariantError('trailing bytes in expression code');
  return e;
}

function readCond(r: Reader, depth: number): DecodedCond {
  if (depth > 64) throw new EvalInvariantError('condition too deep');
  const code = r.u8();
  switch (code) {
    case 0x01:
    case 0x02: {
      const left = readCond(r, depth + 1);
      const right = readCond(r, depth + 1);
      return { code, left, right };
    }
    case 0x03:
      return { code, arg: readCond(r, depth + 1) };
    case 0x50:
      return { code, leg_id: r.u8() };
    case 0x51:
      return { code };
    default:
      throw new EvalInvariantError(`unknown condition op 0x${code.toString(16)}`);
  }
}

/** Parse an outcome condition code (§5.1). */
export function parseCondCode(code: Uint8Array): DecodedCond {
  const r = new Reader(code);
  const c = readCond(r, 0);
  if (r.pos !== code.length) throw new EvalInvariantError('trailing bytes in condition code');
  return c;
}

/** Visit every node of an expression tree in prefix order. */
export function walkExpr(e: DecodedExpr, visit: (n: DecodedExpr) => void): void {
  visit(e);
  switch (e.code) {
    case 0x01:
    case 0x02:
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      return;
    case 0x03:
    case 0x05:
    case 0x06:
      walkExpr(e.arg, visit);
      return;
    case 0x04:
      walkExpr(e.first, visit);
      walkExpr(e.then, visit);
      return;
    default:
      return;
  }
}

/** Cost weight of one node (§3.13). */
export function nodeWeight(n: DecodedExpr): number {
  if (!isLeaf(n)) return COST_COMBINATOR;
  switch (n.code) {
    case LEAF_CODE.disappears_into:
      return COST_DISAPPEARS_INTO;
    case LEAF_CODE.enters:
    case LEAF_CODE.leaves:
    case LEAF_CODE.touches:
      return COST_POLY_EVENT_LEAF;
    case LEAF_CODE.overlaps:
    case LEAF_CODE.inside:
      return COST_POLY_STATE_LEAF;
    default:
      return isEventLeaf(n.code) ? COST_EVENT_LEAF : COST_STATE_LEAF;
  }
}

/** Σ node weights of one expression. */
export function exprWeight(e: DecodedExpr | null): number {
  if (e === null) return 0;
  let w = 0;
  walkExpr(e, (n) => {
    w += nodeWeight(n);
  });
  return w;
}

/** Per-frame cost weight of a decoded program: Σ legs Σ nodes w(node). */
export function programWeight(p: DecodedProgram): number {
  if (p.kind !== 0) return 0;
  let w = 0;
  for (const leg of p.legs) {
    w += exprWeight(parseExprCode(leg.va));
    w += exprWeight(parseExprCode(leg.succ));
  }
  return w;
}

/**
 * `evalCost(decodedProgram, nFrames)` (§3.13):
 * `(|F| + EVAL_COST_SETUP_FRAMES) × Σ_legs Σ_nodes w(node)` over `valid_attempt`
 * and `success`. Non-`rules` programs have no expressions and cost 0.
 */
export function evalCost(p: DecodedProgram, nFrames: number): number {
  return (nFrames + EVAL_COST_SETUP_FRAMES) * programWeight(p);
}

/** Entity indices referenced by an expression (`a` refs and Ref-valued `b`s), in first-seen order. */
export function referencedEntities(e: DecodedExpr | null): number[] {
  const out: number[] = [];
  if (e === null) return out;
  const add = (i: number): void => {
    if (!out.includes(i)) out.push(i);
  };
  walkExpr(e, (n) => {
    if (!isLeaf(n)) return;
    add(n.a.entity);
    if (leafHasRefB(n.code)) add(decodeRefByte(n.b).entity);
  });
  return out;
}
