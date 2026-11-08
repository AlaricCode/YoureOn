/**
 * Identity checkpoints (§3.8, actor-bound legs only).
 */
import type { Checkpoint, DecodedExpr } from '../types.js';
import { ID_CONF_MIN, MAX_CHECKPOINTS } from '../constants.js';
import { type EvalCtx, present, rec } from './frames.js';
import { referencedEntities } from './code.js';
import { posOfAbs } from './positions.js';

/**
 * `persons(leg)`: `kind:"person"` entities referenced in valid_attempt if it
 * references at least one, else those in success. Ascending entity index.
 */
export function personsOfLeg(ctx: EvalCtx, va: DecodedExpr | null, succ: DecodedExpr | null): number[] {
  const persons = (e: DecodedExpr | null): number[] =>
    referencedEntities(e)
      .filter((i) => ctx.entities[i]?.kind === 0)
      .sort((x, y) => x - y);
  const fromVa = persons(va);
  return fromVa.length > 0 ? fromVa : persons(succ);
}

/** Pairs (participant(person), anchor) for one leg. */
export function legCheckpoints(ctx: EvalCtx, persons: readonly number[], anchors: readonly number[]): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const frame of anchors) for (const e of persons) out.push({ participant: ctx.entities[e]!.param, frame });
  return out;
}

function cpKey(c: Checkpoint): string {
  return `${c.participant}:${c.frame}`;
}

/** Union, deduplicated, sorted by (frame, participant). */
export function mergeCheckpoints(lists: readonly (readonly Checkpoint[])[]): Checkpoint[] {
  const seen = new Map<string, Checkpoint>();
  for (const l of lists) for (const c of l) if (!seen.has(cpKey(c))) seen.set(cpKey(c), { participant: c.participant, frame: c.frame });
  return [...seen.values()].sort((a, b) => a.frame - b.frame || a.participant - b.participant);
}

export function exceedsCheckpointLimit(list: readonly Checkpoint[]): boolean {
  return list.length > MAX_CHECKPOINTS;
}

/**
 * A checkpoint passes iff the person entity's record at that frame is present,
 * `id_conf >= ID_CONF_MIN`, and `(participant, frame)` is in `verified`.
 */
export function checkpointPasses(
  ctx: EvalCtx,
  personEntity: number,
  cp: Checkpoint,
  verified: ReadonlySet<string>,
): boolean {
  if (!verified.has(cpKey(cp))) return false;
  const pos = posOfAbs(ctx.fs, cp.frame);
  if (pos < 0 || !present(ctx, personEntity, pos)) return false;
  return rec(ctx, personEntity, pos)!.id_conf >= ID_CONF_MIN;
}

export function verifiedSet(verified: readonly Checkpoint[]): Set<string> {
  return new Set(verified.map(cpKey));
}
