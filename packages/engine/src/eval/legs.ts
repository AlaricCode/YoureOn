/**
 * Leg evaluation for kind `rules` (§3.7): raw value, decisive frames,
 * attempts and identity anchor frames (§3.8).
 */
import type { DecodedExpr, DecodedLeg } from '../types.js';
import type { EvalCtx, FrameSpace } from './frames.js';
import { rising } from './combinators.js';
import { evalExpr } from './signal.js';
import { applyCmp, EvalInvariantError } from './math.js';
import type { Signal } from './state.js';

export const RULE_EXISTS = 0;
export const RULE_COUNT = 1;
export const RULE_HOLDS = 2;
export const RULE_NEVER = 3;
export const RULE_BEFORE = 4;
export const RULE_MARKET = 5;

export interface RawAttempt {
  frame: number;
  success_frame: number | null;
}

export interface RawLegResult {
  /** raw value before §3.9: 0 False, 1 True */
  value: 0 | 1;
  /** holds only: some frame of [0, D) is not in F */
  coverageMissing: boolean;
  /** decisive frames DF, absolute, ascending, distinct */
  decisive: number[];
  /** count with attempts only */
  attempts: RawAttempt[];
  /** identity anchor frames (§3.8), meaningful when value = 1 */
  anchors: number[];
  /** holds only: first failing frame (absolute) or null */
  firstFail: number | null;
}

/** Number of F_R positions (F is ascending, so F_R is a prefix). */
export function frCount(fs: FrameSpace): number {
  let n = 0;
  while (n < fs.n && fs.abs[n]! < fs.limit) n++;
  return n;
}

/** `k' = k` for `>=`, `k+1` for `>`; other comparisons (invalid for actor-bound legs) use k. */
export function kPrime(cmp: number, k: number): number {
  return cmp === 1 ? k + 1 : k;
}

function sortedUnique(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

function firstTrue(sig: Signal, fromPos: number, toPos: number, ok: (pos: number) => boolean = () => true): number {
  for (let pos = fromPos; pos < toPos; pos++) if (sig[pos] && ok(pos)) return pos;
  return -1;
}

/**
 * Evaluate one rules leg. `va`/`succ` are the parsed expressions (succ is
 * required). Signals are computed over all of F; the rule looks only at F_R.
 */
export function evalLegRaw(
  ctx: EvalCtx,
  leg: DecodedLeg,
  va: DecodedExpr | null,
  succ: DecodedExpr,
): RawLegResult {
  const { fs } = ctx;
  const nR = frCount(fs);
  const S = evalExpr(ctx, succ);
  const res: RawLegResult = { value: 0, coverageMissing: false, decisive: [], attempts: [], anchors: [], firstFail: null };
  const abs = (pos: number): number => fs.abs[pos]!;

  switch (leg.rule_kind) {
    case RULE_COUNT: {
      const k = leg.rule_k;
      const kp = kPrime(leg.rule_cmp, k);
      const rS = rising(fs, S);
      if (leg.rule_n > 0) {
        if (va === null) throw new EvalInvariantError('count with attempts requires valid_attempt');
        const rV = rising(fs, evalExpr(ctx, va));
        const R: number[] = [];
        for (let pos = 0; pos < nR; pos++) if (rV[pos]) R.push(pos);
        const m = Math.min(leg.rule_n, R.length);
        const df: number[] = [];
        let c = 0;
        for (let i = 0; i < m; i++) {
          const a = R[i]!;
          let end = abs(a) + leg.attempt_window;
          if (i + 1 < R.length) end = Math.min(end, abs(R[i + 1]!));
          const stop = Math.min(fs.segEnd[a]!, nR);
          let s = -1;
          for (let pos = a; pos < stop && abs(pos) < end; pos++) {
            if (rS[pos]) {
              s = pos;
              break;
            }
          }
          df.push(abs(a));
          if (s >= 0) {
            df.push(abs(s));
            c++;
            if (res.anchors.length < kp) res.anchors.push(abs(a));
          }
          res.attempts.push({ frame: abs(a), success_frame: s >= 0 ? abs(s) : null });
        }
        res.value = applyCmp(leg.rule_cmp, c, k) ? 1 : 0;
        res.decisive = sortedUnique(df);
      } else {
        const frames: number[] = [];
        for (let pos = 0; pos < nR; pos++) if (rS[pos]) frames.push(abs(pos));
        res.value = applyCmp(leg.rule_cmp, frames.length, k) ? 1 : 0;
        res.decisive = frames;
        res.anchors = frames.slice(0, kp);
      }
      return res;
    }
    case RULE_EXISTS:
    case RULE_NEVER: {
      const p = firstTrue(S, 0, nR);
      const exists = p >= 0;
      res.value = (leg.rule_kind === RULE_EXISTS ? exists : !exists) ? 1 : 0;
      if (exists) res.decisive = [abs(p)];
      if (leg.rule_kind === RULE_EXISTS && exists) res.anchors = [abs(p)];
      return res;
    }
    case RULE_BEFORE: {
      const d = leg.rule_n;
      const p = firstTrue(S, 0, nR, (pos) => abs(pos) < d);
      res.value = p >= 0 ? 1 : 0;
      if (p >= 0) {
        res.decisive = [abs(p)];
        res.anchors = [abs(p)];
      }
      return res;
    }
    case RULE_HOLDS: {
      const d = leg.rule_n;
      let covered = 0;
      let fail = -1;
      for (let pos = 0; pos < nR && abs(pos) < d; pos++) {
        covered++;
        if (!S[pos] && fail < 0) fail = pos;
      }
      res.coverageMissing = covered !== d;
      // A frame of [0, D) missing from F counts as "not satisfied": the raw value
      // is False and no checkpoint is produced (matches crates/verdict-rules,
      // CONTRACTS-ERRATA "[verdict-rules] 4"). The cause is COVERAGE (§3.9).
      res.value = fail < 0 && !res.coverageMissing ? 1 : 0;
      if (fail >= 0) {
        res.firstFail = abs(fail);
        res.decisive = [abs(fail)];
      }
      if (res.value === 1) res.anchors = [d - 1];
      return res;
    }
    default:
      throw new EvalInvariantError(`rule kind ${leg.rule_kind} is not a rules-leg rule`);
  }
}
