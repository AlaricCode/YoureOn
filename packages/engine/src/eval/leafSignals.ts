/**
 * `leafSignals(p, c, session)` (§14, §12.10): one row per distinct leaf atom
 * per leg/field, with the leaf's boolean signal over the session (one full
 * segment starting at frame 0). Non-consensus (scene check, practice, live
 * overlay), but it uses the same leaf evaluators as `evaluate`.
 *
 * - `leg` is the leg **id** (1..8).
 * - `path` is the child indices from the root joined with "." ("" for a root
 *   leaf). Child order: and/or args 0,1; not/for_duration/before arg 0;
 *   then_within first 0, then 1.
 * - Structurally equal atoms in the same leg/field share a row (first path wins).
 * - Regions not yet placed in `c` (or `c === null`) make every leaf that uses
 *   them false.
 */
import type {
  Calibration,
  DecodedExpr,
  DecodedRegion,
  Entity,
  Expr,
  LeafSignalRow,
  Program,
  QFrame,
  SessionTracks,
} from '../types.js';
import { entityIndexMap, entityKindCode, exprFromAst } from './ast.js';
import { buildCtx } from './frames.js';
import { evalLeaf } from './signal.js';
import type { LeafNode } from './code.js';

interface LeafAt {
  path: string;
  expr: Expr;
}

function collectLeaves(e: Expr, path: string, out: LeafAt[]): void {
  const child = (i: number): string => (path === '' ? String(i) : `${path}.${i}`);
  switch (e.op) {
    case 'and':
    case 'or':
      collectLeaves(e.args[0], child(0), out);
      collectLeaves(e.args[1], child(1), out);
      return;
    case 'not':
    case 'for_duration':
    case 'before':
      collectLeaves(e.arg, child(0), out);
      return;
    case 'then_within':
      collectLeaves(e.first, child(0), out);
      collectLeaves(e.then, child(1), out);
      return;
    default:
      out.push({ path, expr: e });
  }
}

function leafKey(n: DecodedExpr): string {
  const l = n as LeafNode;
  return `${l.code}:${l.a.entity}:${l.a.sub}:${l.b}:${l.p}`;
}

/** Entity label: calibration label, else object phrase, else "line"/"zone", else the entity name. */
function entityLabel(e: Entity, c: Calibration | null): string {
  const ref = c?.scene.entity_refs.find((r) => r.entity === e.name);
  if (ref !== undefined && ref.label.trim() !== '') return ref.label.trim();
  if (e.kind === 'object') return e.phrase;
  if (e.kind === 'region') return e.shape;
  return e.name;
}

function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => w !== '');
}

/** Apply a short-label template; if over 3 words, use the label's last word. */
function fill(template: string, label: string): string {
  const full = template.replace('{x}', label);
  if (words(full).length <= 3) return full;
  const w = words(label);
  return template.replace('{x}', w[w.length - 1] ?? label);
}

/** Short label (§12.10), at most 3 words. */
export function leafLabel(e: Expr, entities: readonly Entity[], c: Calibration | null): string {
  const lab = (name: string): string => {
    const ent = entities.find((x) => x.name === name);
    return ent === undefined ? name : entityLabel(ent, c);
  };
  switch (e.op) {
    case 'overlaps':
      return fill('On {x}', lab(e.b.e));
    case 'inside':
      return fill('In {x}', lab(e.b.e));
    case 'above':
      return fill('Above {x}', lab(e.b.e));
    case 'below':
      return fill('Below {x}', lab(e.b.e));
    case 'near':
      return fill('Near {x}', lab(e.b.e));
    case 'behind':
      return 'Behind line';
    case 'beyond':
      return 'Past line';
    case 'moving':
      return fill('{x} moving', lab(e.a.e));
    case 'present':
      return fill('{x} visible', lab(e.a.e));
    case 'intact':
      return fill('{x} standing', lab(e.a.e));
    case 'standing':
      return fill('{x} upright', lab(e.a.e));
    case 'at_rest':
      return fill('{x} still', lab(e.a.e));
    case 'speed':
      return fill('{x} speed', lab(e.a.e));
    case 'direction':
      return fill(`{x} ${e.dir}`, lab(e.a.e));
    case 'rep_count':
      return 'Reps';
    case 'enters':
    case 'disappears_into':
      return fill('Into {x}', lab(e.b.e));
    case 'leaves':
      return fill('Out of {x}', lab(e.b.e));
    case 'touches':
      return fill('Touches {x}', lab(e.b.e));
    case 'crosses':
      return 'Crosses line';
    case 'released_by':
      return fill('{x} released', lab(e.a.e));
    default:
      return e.op;
  }
}

/** Calibration regions (by name) → decoded regions; unplaced or mismatched shapes are skipped. */
function regionsFor(p: Program, c: Calibration | null): DecodedRegion[] {
  if (c === null) return [];
  const out: DecodedRegion[] = [];
  p.entities.forEach((e, i) => {
    if (e.kind !== 'region') return;
    const r = c.regions.find((x) => x.entity === e.name);
    if (r === undefined || r.shape !== e.shape) return;
    if (r.shape === 'line') {
      out.push({ entity_idx: i, shape: 0, points: r.points.map(([x, y]) => [x, y]), behind_sign: r.behind_sign });
    } else if (r.points.length >= 3) {
      out.push({ entity_idx: i, shape: 1, points: r.points.map(([x, y]) => [x, y]), behind_sign: 0 });
    }
  });
  return out;
}

export function leafSignals(p: Program, c: Calibration | null, session: SessionTracks): LeafSignalRow[] {
  const idx = entityIndexMap(p.entities);
  const tracks = session.tracks.filter((t) => p.entities[t.entity_idx] !== undefined && p.entities[t.entity_idx]!.kind !== 'region');
  const n = session.n_frames;
  const frames: (QFrame | null)[][] = [];
  for (let f = 0; f < n; f++) frames.push(tracks.map((t) => t.frames[f] ?? null));
  const ctx = buildCtx(
    p.entities.map((e) => ({ kind: entityKindCode(e), param: e.kind === 'person' ? e.participant : 0 })),
    regionsFor(p, c),
    tracks.map((t) => ({ entity_idx: t.entity_idx, ref_h: t.ref_h })),
    n > 0 ? [{ frame_start: 0, frames }] : [],
    p.time_limit_s,
  );

  const rows: LeafSignalRow[] = [];
  for (const leg of p.legs) {
    const fields: ['valid_attempt' | 'success', Expr | undefined][] = [
      ['valid_attempt', leg.valid_attempt],
      ['success', leg.success],
    ];
    for (const [field, expr] of fields) {
      if (expr === undefined) continue;
      const leaves: LeafAt[] = [];
      collectLeaves(expr, '', leaves);
      const seen = new Set<string>();
      for (const l of leaves) {
        const node = exprFromAst(l.expr, idx);
        const key = leafKey(node);
        if (seen.has(key)) continue;
        seen.add(key);
        const sig = evalLeaf(ctx, node as LeafNode);
        rows.push({
          leg: leg.id,
          field,
          path: l.path,
          label: leafLabel(l.expr, p.entities, c),
          signal: Array.from(sig, (v) => v === 1),
        });
      }
    }
  }
  return rows;
}
