/**
 * Scene-check / practice condition rows (§12.10, §14 `conditionRows`).
 *
 * One row per distinct leaf atom per leg/field, in pre-order; structurally
 * equal atoms within the same leg/field share a row (first path wins).
 */
import type { ConditionField, ConditionRow, Entity, LeafExpr, Program } from '../types.js';
import { cloneLeaf, forEachLeaf } from './walk.js';

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter((w) => w.length > 0);
}

/** Template text with `{a}`/`{b}` placeholders (§12.10). */
function template(l: LeafExpr): string {
  switch (l.op) {
    case 'overlaps':
      return 'On {b}';
    case 'inside':
      return 'In {b}';
    case 'above':
      return 'Above {b}';
    case 'below':
      return 'Below {b}';
    case 'near':
      return 'Near {b}';
    case 'behind':
      return 'Behind line';
    case 'beyond':
      return 'Past line';
    case 'moving':
      return '{a} moving';
    case 'present':
      return '{a} visible';
    case 'intact':
      return '{a} standing';
    case 'standing':
      return '{a} upright';
    case 'at_rest':
      return '{a} still';
    case 'speed':
      return '{a} speed';
    case 'direction':
      return `{a} ${l.dir}`;
    case 'rep_count':
      return 'Reps';
    case 'enters':
      return 'Into {b}';
    case 'leaves':
      return 'Out of {b}';
    case 'disappears_into':
      return 'Into {b}';
    case 'touches':
      return 'Touches {b}';
    case 'crosses':
      return 'Crosses line';
    case 'released_by':
      return '{a} released';
  }
}

function defaultLabel(e: Entity | undefined, name: string): string {
  if (!e) return name;
  switch (e.kind) {
    case 'object':
      return e.phrase;
    case 'region':
      return e.shape;
    default:
      return name;
  }
}

/** Short (≤ 3 words) label of a leaf (§12.10). `labels` maps entity name → label. */
export function leafLabel(l: LeafExpr, p: Program, labels: Record<string, string> = {}): string {
  const byName = new Map(p.entities.map((e) => [e.name, e] as const));
  const label = (name: string): string => labels[name] ?? defaultLabel(byName.get(name), name);
  const t = template(l);
  const fill = (short: boolean): string =>
    t.replace(/\{(a|b)\}/g, (_m, which: string) => {
      const name = which === 'a' ? l.a.e : 'b' in l ? l.b.e : l.a.e;
      const full = label(name);
      if (!short) return full;
      const ws = words(full);
      return ws.length > 0 ? ws[ws.length - 1]! : full;
    });
  const full = fill(false);
  return words(full).length > 3 ? fill(true) : full;
}

export function conditionRows(p: Program, labels: Record<string, string> = {}): ConditionRow[] {
  const rows: ConditionRow[] = [];
  for (const leg of p.legs) {
    for (const field of ['valid_attempt', 'success'] as ConditionField[]) {
      const e = leg[field];
      if (!e) continue;
      const seen = new Set<string>();
      forEachLeaf(e, (l, path) => {
        const key = JSON.stringify(cloneLeaf(l));
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ leg: leg.id, field, path, label: leafLabel(l, p, labels) });
      });
    }
  }
  return rows;
}
