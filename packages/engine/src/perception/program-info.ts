/**
 * Static facts about a Program needed by perception (§2.2, §5.4 [D-43], §6.2):
 * which entities are tracked, who the `released_by` actors are, which legs
 * use `rep_count`, etc. Works on the canonical AST.
 */
import { FPS, TAIL_FRAMES } from '../constants.js';
import type { Expr, Leg, Program, Ref } from '../types.js';

/** Visit every node of an expression (pre-order). */
export function walkExpr(e: Expr | undefined, visit: (node: Expr) => void): void {
  if (!e) return;
  visit(e);
  switch (e.op) {
    case 'and':
    case 'or':
      walkExpr(e.args[0], visit);
      walkExpr(e.args[1], visit);
      return;
    case 'not':
    case 'for_duration':
    case 'before':
      walkExpr(e.arg, visit);
      return;
    case 'then_within':
      walkExpr(e.first, visit);
      walkExpr(e.then, visit);
      return;
    default:
      return;
  }
}

/** All refs (`a` and `b` operands) of an expression. */
export function exprRefs(e: Expr | undefined): Ref[] {
  const out: Ref[] = [];
  walkExpr(e, (n) => {
    if ('a' in n) out.push(n.a);
    if ('b' in n) out.push(n.b);
  });
  return out;
}

/** True iff the expression contains a leaf with the given op. */
export function exprHasOp(e: Expr | undefined, op: Expr['op']): boolean {
  let found = false;
  walkExpr(e, (n) => {
    if (n.op === op) found = true;
  });
  return found;
}

export function entityIndex(p: Program, name: string): number {
  return p.entities.findIndex((x) => x.name === name);
}

export function legExprs(leg: Leg): Expr[] {
  const out: Expr[] = [];
  if (leg.valid_attempt) out.push(leg.valid_attempt);
  if (leg.success) out.push(leg.success);
  return out;
}

/**
 * Non-region entities referenced in at least one leg expression (including the
 * owning object of a sub-region ref), ascending entity index (§5.4, [D-43]).
 */
export function trackedEntityIndices(p: Program): number[] {
  const set = new Set<number>();
  for (const leg of p.legs) {
    for (const ex of legExprs(leg)) {
      for (const r of exprRefs(ex)) {
        const i = entityIndex(p, r.e);
        if (i >= 0 && p.entities[i]!.kind !== 'region') set.add(i);
      }
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** True iff the expression references a `kind: "person"` entity (actor-bound test, §2.7). */
export function exprIsActorBound(p: Program, ex: Expr | undefined): boolean {
  return exprRefs(ex).some((r) => p.entities.find((x) => x.name === r.e)?.kind === 'person');
}

/**
 * `released_by` actors for each `a` entity, across all legs: map entity name →
 * set of actor entity names (§6.2 binding steps 3 and 4).
 */
export function releaseActors(p: Program): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  for (const leg of p.legs) {
    for (const ex of legExprs(leg)) {
      walkExpr(ex, (n) => {
        if (n.op === 'released_by') {
          let s = m.get(n.a.e);
          if (!s) m.set(n.a.e, (s = new Set()));
          s.add(n.b.e);
        }
      });
    }
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of m) out.set(k, [...v].sort());
  return out;
}

/** `LIMIT = time_limit_s · FPS` (§3.2). */
export function limitFrames(p: Program): number {
  return p.time_limit_s * FPS;
}

/** Exclusive upper bound of frames a track_bin may carry: `LIMIT + TAIL_FRAMES` ([D-38]). */
export function maxBufferFrame(p: Program): number {
  return limitFrames(p) + TAIL_FRAMES;
}

