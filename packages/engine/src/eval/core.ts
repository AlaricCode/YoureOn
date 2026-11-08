/**
 * Evaluation core over decoded inputs (§3.1 check order steps 2–5, §3.7–§3.12).
 *
 * `evaluate` (binaries) and `evaluateSession` both end here; this function
 * never sees undecoded bytes.
 */
import type {
  Checkpoint,
  DecodedCalibration,
  DecodedExpr,
  DecodedProgram,
  EvalAttempt,
  EvalOptions,
  EvalReason,
  EvalResult,
  LegCause,
  LegValue,
  MarketBinEntry,
  TrackBufferData,
} from '../types.js';
import {
  MAX_EVAL_COST,
  REASON_AI_JUDGED,
  REASON_CROSS_CHECK_FAILED,
  REASON_LOW_CONFIDENCE,
  REASON_WINDOW_UNAVAILABLE,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
} from '../constants.js';
import { evalCost, parseCondCode, parseExprCode } from './code.js';
import { buildCtx, type EvalCtx } from './frames.js';
import { evalLegRaw, type RawLegResult } from './legs.js';
import { preIdentityCause } from './causes.js';
import {
  checkpointPasses,
  exceedsCheckpointLimit,
  legCheckpoints,
  mergeCheckpoints,
  personsOfLeg,
  verifiedSet,
} from './identity.js';
import { evalCond, legValueLookup, winnerMask } from './outcome.js';
import { EvalInvariantError } from './math.js';

const KIND_RULES = 0;
const KIND_AI_JUDGED = 1;
const KIND_MARKET = 2;

function totalFrames(t: TrackBufferData): number {
  let n = 0;
  for (const s of t.segments) n += s.frames.length;
  return n;
}

/** Result for §3.1 steps 2–4: every leg Unknown with no causes, no checkpoints. */
function earlyPanel(p: DecodedProgram, reason: EvalReason, cost: number): EvalResult {
  return {
    status: 'needs_panel',
    reason,
    preruling: 3,
    winner_mask: 0,
    leg_results: p.legs.map(() => 2 as const),
    leg_causes: p.legs.map(() => []),
    decisive_frames: p.legs.map(() => []),
    attempts: [],
    checkpoints: [],
    n_checkpoints: 0,
    cost,
  };
}

/** Apply §3.10 to final leg values. */
function finish(
  p: DecodedProgram,
  legResults: LegValue[],
  legCauses: LegCause[][],
  decisive: number[][],
  attempts: EvalAttempt[],
  checkpoints: Checkpoint[],
  cost: number,
): EvalResult {
  const cond = evalCond(parseCondCode(p.cond), legValueLookup(p, legResults));
  const base = {
    leg_results: legResults,
    leg_causes: legCauses,
    decisive_frames: decisive,
    attempts,
    checkpoints,
    n_checkpoints: checkpoints.length,
    cost,
  };
  if (cond === 2) {
    return { status: 'needs_panel', reason: REASON_LOW_CONFIDENCE, preruling: 3, winner_mask: 0, ...base };
  }
  const side = cond === 1 ? p.if_true : p.else_side;
  return { status: 'ok', reason: 0, preruling: 1, winner_mask: winnerMask(p, side), ...base };
}

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** §3.11 market programs. */
export function evaluateMarket(p: DecodedProgram, entries: readonly MarketBinEntry[]): EvalResult {
  const byHash = new Map<string, number>();
  for (const e of entries) byHash.set(e.market_hash.toLowerCase(), e.result);
  const values: LegValue[] = [];
  const causes: LegCause[][] = [];
  for (const leg of p.legs) {
    const r = byHash.get(hex(leg.succ));
    if (r === undefined || r === 2) {
      values.push(2);
      causes.push(['VOID']);
    } else {
      values.push(r === leg.rule_k ? 1 : 0);
      causes.push([]);
    }
  }
  return finish(p, values, causes, p.legs.map(() => []), [], [], 0);
}

interface LegWork {
  va: DecodedExpr | null;
  succ: DecodedExpr;
  raw: RawLegResult;
  cause: LegCause | null;
  actorBound: boolean;
  persons: number[];
  checkpoints: Checkpoint[];
}

/** §3.7–§3.10 for kind rules, given a built context. */
export function evaluateRulesCtx(
  p: DecodedProgram,
  ctx: EvalCtx,
  flags: number,
  verified: readonly Checkpoint[],
  cost: number,
): EvalResult {
  const work: LegWork[] = p.legs.map((leg) => {
    const va = parseExprCode(leg.va);
    const succ = parseExprCode(leg.succ);
    if (succ === null) throw new EvalInvariantError(`leg ${leg.id} has no success expression`);
    const raw = evalLegRaw(ctx, leg, va, succ);
    const actorBound = (leg.flags & 0x01) !== 0;
    const persons = actorBound ? personsOfLeg(ctx, va, succ) : [];
    const checkpoints = actorBound && raw.value === 1 ? legCheckpoints(ctx, persons, raw.anchors) : [];
    return { va, succ, raw, cause: preIdentityCause(ctx, flags, leg.rule_kind, raw, va, succ), actorBound, persons, checkpoints };
  });

  let checkpoints = mergeCheckpoints(work.map((w) => w.checkpoints));
  const vset = verifiedSet(verified);
  if (exceedsCheckpointLimit(checkpoints)) {
    checkpoints = [];
    for (const w of work) if (w.actorBound && w.cause === null) w.cause = 'IDENTITY';
  } else {
    const entityOf = new Map<number, number>();
    ctx.entities.forEach((e, i) => {
      if (e.kind === 0) entityOf.set(e.param, i);
    });
    for (const w of work) {
      if (w.cause !== null) continue;
      if (w.checkpoints.some((cp) => !checkpointPasses(ctx, entityOf.get(cp.participant)!, cp, vset))) w.cause = 'IDENTITY';
    }
  }

  const legResults: LegValue[] = work.map((w) => (w.cause !== null ? 2 : w.raw.value));
  const legCauses: LegCause[][] = work.map((w) => (w.cause !== null ? [w.cause] : []));
  const attempts: EvalAttempt[] = [];
  work.forEach((w, i) => {
    for (const a of w.raw.attempts) attempts.push({ leg: i, frame: a.frame, success_frame: a.success_frame });
  });
  return finish(p, legResults, legCauses, work.map((w) => w.raw.decisive), attempts, checkpoints, cost);
}

/**
 * Evaluate decoded inputs (§3.1 steps 2–5). `tracks` is the decoded
 * track_bin for rules / ai_judged programs, or the market_bin entries for
 * market programs.
 */
export function evaluateDecoded(
  p: DecodedProgram,
  calibration: DecodedCalibration | null,
  tracks: TrackBufferData | readonly MarketBinEntry[],
  verified: readonly Checkpoint[],
  opts?: EvalOptions,
): EvalResult {
  const maxCost = opts?.maxCost ?? MAX_EVAL_COST;
  if (p.kind === KIND_AI_JUDGED) return earlyPanel(p, REASON_AI_JUDGED, 0);
  if (p.kind === KIND_MARKET) {
    if (!Array.isArray(tracks)) throw new EvalInvariantError('market program requires market_bin entries');
    return evaluateMarket(p, tracks as readonly MarketBinEntry[]);
  }
  if (p.kind !== KIND_RULES) throw new EvalInvariantError(`unknown program kind ${p.kind as number}`);
  if (Array.isArray(tracks)) throw new EvalInvariantError('rules program requires track_bin data');
  const t = tracks as TrackBufferData;
  const cost = evalCost(p, totalFrames(t));
  if ((t.flags & TRACK_FLAG_WINDOW_UNAVAILABLE) !== 0) return earlyPanel(p, REASON_WINDOW_UNAVAILABLE, cost);
  if ((t.flags & TRACK_FLAG_CROSS_CHECK_OK) === 0) return earlyPanel(p, REASON_CROSS_CHECK_FAILED, cost);
  if (cost > maxCost) return earlyPanel(p, REASON_WINDOW_UNAVAILABLE, cost);
  const ctx = buildCtx(p.entities, calibration?.regions ?? [], t.tracks, t.segments, p.time_limit_s);
  return evaluateRulesCtx(p, ctx, t.flags, verified, cost);
}
