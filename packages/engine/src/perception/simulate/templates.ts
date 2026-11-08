/**
 * Recognize the three worked-example shapes (§15.1–§15.3) structurally, so
 * that compiler variants (other names, attempt counts, rep targets, limits)
 * still get a faithful scene.
 */
import type { Expr, Leg, Program } from '../../types.js';
import { walkExpr } from '../program-info.js';

export interface ThrowTemplate {
  kind: 'throw';
  leg: Leg;
  ball: string;
  actor: string;
  container: string;
  line: string | null;
  attempts: number;
  /** successes needed (k') */
  need: number;
}

export interface HoldsTemplate {
  kind: 'holds';
  leg: Leg;
  object: string;
  frames: number;
}

export interface RepsTemplate {
  kind: 'reps';
  leg: Leg;
  person: string;
  /** reps needed for success to become true */
  target: number;
  /** `before(D)` bound, or null for `exists` */
  deadline: number | null;
}

export type SceneTemplate = ThrowTemplate | HoldsTemplate | RepsTemplate;

function find(e: Expr | undefined, pred: (n: Expr) => boolean): Expr | null {
  let hit: Expr | null = null;
  walkExpr(e, (n) => {
    if (!hit && pred(n)) hit = n;
  });
  return hit;
}

export function recognize(p: Program): SceneTemplate | null {
  if (p.kind !== 'rules' || p.legs.length !== 1) return null;
  const leg = p.legs[0]!;
  const rule = leg.rule;
  if (!rule || !leg.success) return null;
  const kindOf = (name: string) => p.entities.find((x) => x.name === name)?.kind;

  if (rule.kind === 'count' && rule.attempts > 0 && leg.valid_attempt && (rule.cmp === '>=' || rule.cmp === '>')) {
    const rel = find(leg.valid_attempt, (n) => n.op === 'released_by');
    const dis = find(leg.success, (n) => n.op === 'disappears_into' && n.b.sub === 'opening');
    if (rel && dis && 'b' in rel && 'b' in dis && rel.a.e === dis.a.e && kindOf(rel.a.e) === 'object') {
      const beh = find(leg.valid_attempt, (n) => n.op === 'behind' && n.a.e === rel.b.e);
      return {
        kind: 'throw',
        leg,
        ball: rel.a.e,
        actor: rel.b.e,
        container: dis.b.e,
        line: beh && 'b' in beh ? beh.b.e : null,
        attempts: rule.attempts,
        need: rule.cmp === '>' ? rule.k + 1 : rule.k,
      };
    }
  }
  if (rule.kind === 'holds' && leg.success.op === 'intact' && !leg.valid_attempt) {
    return { kind: 'holds', leg, object: leg.success.a.e, frames: rule.frames };
  }
  const s = leg.success;
  if (
    s.op === 'rep_count' &&
    (s.cmp === '>=' || s.cmp === '>') &&
    !leg.valid_attempt &&
    (rule.kind === 'before' || rule.kind === 'exists')
  ) {
    return {
      kind: 'reps',
      leg,
      person: s.a.e,
      target: Math.max(1, s.cmp === '>' ? s.value + 1 : s.value),
      deadline: rule.kind === 'before' ? rule.frames : null,
    };
  }
  return null;
}
