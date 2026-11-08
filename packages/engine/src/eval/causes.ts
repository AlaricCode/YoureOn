/**
 * Unknown causes MOTION, COVERAGE, OCCLUSION and CONF (§3.9 items 1–4).
 * IDENTITY (item 5) is decided with the checkpoints in core.ts.
 */
import type { DecodedExpr, LegCause } from '../types.js';
import { DECISIVE_CONF_MIN, TRACK_FLAG_CAMERA_MOTION } from '../constants.js';
import { type EvalCtx, present, rec } from './frames.js';
import { referencedEntities } from './code.js';
import { RULE_HOLDS, type RawLegResult } from './legs.js';
import { posOfAbs } from './positions.js';

/** Non-region entities referenced by the given expressions (incl. owners of sub-region refs). */
export function nonRegionEntities(ctx: EvalCtx, ...exprs: (DecodedExpr | null)[]): number[] {
  const out = new Set<number>();
  for (const e of exprs) {
    for (const i of referencedEntities(e)) {
      const k = ctx.entities[i]?.kind;
      if (k !== undefined && k !== 3 && k !== 4) out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * First applicable cause among MOTION, COVERAGE, OCCLUSION, CONF, or null.
 */
export function preIdentityCause(
  ctx: EvalCtx,
  flags: number,
  ruleKind: number,
  raw: RawLegResult,
  va: DecodedExpr | null,
  succ: DecodedExpr,
): LegCause | null {
  if ((flags & TRACK_FLAG_CAMERA_MOTION) !== 0) return 'MOTION';
  if (ruleKind === RULE_HOLDS && raw.coverageMissing) return 'COVERAGE';
  if (ruleKind === RULE_HOLDS && raw.value === 0 && raw.firstFail !== null) {
    const pos = posOfAbs(ctx.fs, raw.firstFail);
    if (nonRegionEntities(ctx, succ).some((e) => !present(ctx, e, pos))) return 'OCCLUSION';
  }
  const ents = nonRegionEntities(ctx, va, succ);
  for (const d of raw.decisive) {
    const pos = posOfAbs(ctx.fs, d);
    if (pos < 0) continue;
    for (const e of ents) {
      if (present(ctx, e, pos) && rec(ctx, e, pos)!.conf < DECISIVE_CONF_MIN) return 'CONF';
    }
  }
  return null;
}
