/**
 * Expression utilities: traversal, rebuilding, and encoded-size metrics (§5.1).
 */
import { REL2_OPS, UNARY_OPS, LEAF_NODE_BYTES } from '../constants.js';
import type { Expr, LeafExpr, LegExpr, Ref, YesCondition } from '../types.js';

const REL2_SET: ReadonlySet<string> = new Set<string>(REL2_OPS);
const UNARY_SET: ReadonlySet<string> = new Set<string>(UNARY_OPS);

export const COMBINATOR_OPS: ReadonlySet<string> = new Set(['and', 'or', 'not', 'then_within', 'for_duration', 'before']);

export function isLeaf(e: Expr): e is LeafExpr {
  return !COMBINATOR_OPS.has(e.op);
}

export function isRel2Op(op: string): boolean {
  return REL2_SET.has(op);
}

export function isUnaryOp(op: string): boolean {
  return UNARY_SET.has(op);
}

/** Leaves whose `b` is a Ref. */
export function hasBRef(e: LeafExpr): e is Extract<LeafExpr, { b: Ref }> {
  return e.op === 'near' || REL2_SET.has(e.op);
}

/** Children of a combinator in path order (§12.10: "0.1" = child indices from the root). */
export function children(e: Expr): Expr[] {
  switch (e.op) {
    case 'and':
    case 'or':
      return [e.args[0], e.args[1]];
    case 'not':
    case 'for_duration':
    case 'before':
      return [e.arg];
    case 'then_within':
      return [e.first, e.then];
    default:
      return [];
  }
}

/** Pre-order traversal of leaves with their child-index path ("" for a root leaf). */
export function forEachLeaf(e: Expr, cb: (leaf: LeafExpr, path: string) => void, path = ''): void {
  if (isLeaf(e)) {
    cb(e, path);
    return;
  }
  children(e).forEach((c, i) => forEachLeaf(c, cb, path === '' ? String(i) : `${path}.${i}`));
}

/** Pre-order traversal of all nodes with their parent (null for the root). */
export function forEachNode(e: Expr, cb: (node: Expr, parent: Expr | null) => void, parent: Expr | null = null): void {
  cb(e, parent);
  for (const c of children(e)) forEachNode(c, cb, e);
}

/** All refs of an expression, in pre-order (a before b). */
export function refsOf(e: Expr): Ref[] {
  const out: Ref[] = [];
  forEachLeaf(e, (l) => {
    out.push(l.a);
    if (hasBRef(l)) out.push(l.b);
  });
  return out;
}

/** Rebuild an expression bottom-up; `leaf` maps each leaf. Returns fresh objects. */
export function mapLeaves(e: Expr, leaf: (l: LeafExpr) => Expr): Expr {
  switch (e.op) {
    case 'and':
    case 'or':
      return { op: e.op, args: [mapLeaves(e.args[0], leaf), mapLeaves(e.args[1], leaf)] };
    case 'not':
      return { op: 'not', arg: mapLeaves(e.arg, leaf) };
    case 'for_duration':
    case 'before':
      return { op: e.op, frames: e.frames, arg: mapLeaves(e.arg, leaf) };
    case 'then_within':
      return { op: 'then_within', frames: e.frames, first: mapLeaves(e.first, leaf), then: mapLeaves(e.then, leaf) };
    default:
      return leaf(e);
  }
}

export function cloneRef(r: Ref): Ref {
  const out: Ref = { e: r.e };
  if (r.sub !== undefined) out.sub = r.sub;
  return out;
}

/** Fresh copy of a leaf with exactly its canonical fields. */
export function cloneLeaf(l: LeafExpr): LeafExpr {
  switch (l.op) {
    case 'near':
      return { op: 'near', a: cloneRef(l.a), b: cloneRef(l.b), dist: l.dist };
    case 'moving':
    case 'present':
    case 'intact':
    case 'standing':
      return { op: l.op, a: cloneRef(l.a) };
    case 'at_rest':
      return { op: 'at_rest', a: cloneRef(l.a), frames: l.frames };
    case 'speed':
      return { op: 'speed', a: cloneRef(l.a), cmp: l.cmp, value: l.value };
    case 'direction':
      return { op: 'direction', a: cloneRef(l.a), dir: l.dir };
    case 'rep_count':
      return { op: 'rep_count', a: cloneRef(l.a), cmp: l.cmp, value: l.value };
    default:
      return { op: l.op, a: cloneRef(l.a), b: cloneRef(l.b) };
  }
}

export function cloneExpr(e: Expr): Expr {
  return mapLeaves(e, cloneLeaf);
}

export function cloneLegExpr(c: LegExpr): LegExpr {
  switch (c.op) {
    case 'leg':
      return { op: 'leg', id: c.id };
    case 'not':
      return { op: 'not', arg: cloneLegExpr(c.arg) };
    default:
      return { op: c.op, args: [cloneLegExpr(c.args[0]), cloneLegExpr(c.args[1])] };
  }
}

export interface CodeMetrics {
  bytes: number;
  nodes: number;
  depth: number;
}

/** Encoded size of a leg expression (§5.1): bytes, op-byte count, depth (leaf = 1). */
export function exprMetrics(e: Expr): CodeMetrics {
  switch (e.op) {
    case 'and':
    case 'or': {
      const l = exprMetrics(e.args[0]);
      const r = exprMetrics(e.args[1]);
      return { bytes: 1 + l.bytes + r.bytes, nodes: 1 + l.nodes + r.nodes, depth: 1 + Math.max(l.depth, r.depth) };
    }
    case 'not': {
      const x = exprMetrics(e.arg);
      return { bytes: 1 + x.bytes, nodes: 1 + x.nodes, depth: 1 + x.depth };
    }
    case 'then_within': {
      const l = exprMetrics(e.first);
      const r = exprMetrics(e.then);
      return { bytes: 3 + l.bytes + r.bytes, nodes: 1 + l.nodes + r.nodes, depth: 1 + Math.max(l.depth, r.depth) };
    }
    case 'for_duration': {
      const x = exprMetrics(e.arg);
      return { bytes: 3 + x.bytes, nodes: 1 + x.nodes, depth: 1 + x.depth };
    }
    case 'before': {
      const x = exprMetrics(e.arg);
      return { bytes: 5 + x.bytes, nodes: 1 + x.nodes, depth: 1 + x.depth };
    }
    default:
      return { bytes: LEAF_NODE_BYTES, nodes: 1, depth: 1 };
  }
}

/** Encoded size of an outcome condition (§5.1). */
export function condMetrics(c: LegExpr | YesCondition): CodeMetrics {
  switch (c.op) {
    case 'yes':
      return { bytes: 1, nodes: 1, depth: 1 };
    case 'leg':
      return { bytes: 2, nodes: 1, depth: 1 };
    case 'not': {
      const x = condMetrics(c.arg);
      return { bytes: 1 + x.bytes, nodes: 1 + x.nodes, depth: 1 + x.depth };
    }
    default: {
      const l = condMetrics(c.args[0]);
      const r = condMetrics(c.args[1]);
      return { bytes: 1 + l.bytes + r.bytes, nodes: 1 + l.nodes + r.nodes, depth: 1 + Math.max(l.depth, r.depth) };
    }
  }
}

/** Leg ids referenced by a condition, pre-order. */
export function legIdsOf(c: LegExpr | YesCondition): number[] {
  switch (c.op) {
    case 'yes':
      return [];
    case 'leg':
      return [c.id];
    case 'not':
      return legIdsOf(c.arg);
    default:
      return [...legIdsOf(c.args[0]), ...legIdsOf(c.args[1])];
  }
}
