// VisionVerdict -> Ruling (SCHEMAS §5.1, §5.2), as pure functions, plus the one vision call.
//
// Rules, in order:
//   1. confidence rounded to 2 dp; outcome = toOutcome(verdict, yes_party) (REDO_BELOW = 0.8)
//   2. a decisive verdict whose deterministic checks disagree -> REDO 'unclear' (checks.ts)
//   3. redo_reason: 'contested' if contested, else 'unclear' if UNCLEAR, else 'low_confidence'
//   4. a model failure (timeout, error, refusal, bad JSON) -> REDO 'unclear' (API-CONTRACT §7.1);
//      it counts toward MAX_REDOS
//   5. a REDO on attempt_no > MAX_REDOS -> VOID 'max_redos' (hearings are cut, D-C), i.e. Refund
//   6. reason normText'd and cut to 280; cited_frames deduped, in range, at most 8
// ruling_hash = hashJcs(ruling) and commits to frame_hashes (SCHEMAS O3, D7).
import { MAX_REDOS } from '@youre-on/shared/constants';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import { normText, type Party } from '@youre-on/shared/primitives';
import {
  CACHED_RULING_MODEL,
  Ruling,
  toOutcome,
  type ClaimResult,
  type RedoReason,
  type VisionVerdict,
} from '@youre-on/shared/ruling';
import type { Terms } from '@youre-on/shared/terms';
import type { AppDeps } from '../context';
import { compareChecks, isBottleFlip, type JudgeVerdict } from './checks';
import {
  buildJudgeParts,
  JUDGE_MAX_OUTPUT_TOKENS,
  JUDGE_OUTPUT,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_TIMEOUT_MS,
  type PromptFrame,
} from './prompt';

/**
 * `Ruling.model` of a CACHED_RULING ruling (packages/shared ruling.ts, so the stage labels it
 * "replay ruling": isCachedRulingModel).
 */
export { CACHED_RULING_MODEL };

/** What the vision step produced for one attempt. */
export type Judged =
  | { kind: 'verdict'; model: string; verdict: VisionVerdict; disagreement: string | null }
  | { kind: 'failure'; model: string; status: string; message: string };

export interface RulingContext {
  ruling_id: string;
  bet_id: string;
  attempt_no: number;
  yes_party: Party;
  terms_hash: string;
  /** = CameraEvidence.clip_sha256 (what `resolve` commits). */
  evidence_hash: string;
  frame_hashes: string[];
  created_at: string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function cleanReason(s: string, fallback: string): string {
  const r = normText(s).slice(0, 280).trim();
  return r.length > 0 ? r : fallback;
}

function cleanCited(cited: number[], n: number): number[] {
  const out: number[] = [];
  for (const i of cited) {
    if (Number.isInteger(i) && i >= 0 && i < n && !out.includes(i)) out.push(i);
    if (out.length === 8) break;
  }
  return out;
}

/** Builds and validates the SCHEMAS Ruling (throws only on a bug: the record must parse). */
export function buildRuling(ctx: RulingContext, judged: Judged): Ruling {
  let claim: ClaimResult;
  let confidence: number;
  let reason: string;
  let cited: number[];
  let outcome: Ruling['outcome'];
  let redo: RedoReason | null = null;

  if (judged.kind === 'failure') {
    claim = 'UNCLEAR';
    confidence = 0;
    reason = "The clerk couldn't make out that attempt. Run it back.";
    cited = [];
    outcome = 'REDO';
    redo = 'unclear';
  } else {
    const v = judged.verdict;
    claim = v.claim_result;
    confidence = round2(v.confidence);
    reason = cleanReason(v.reason, 'No clear call from the frames.');
    cited = cleanCited(v.cited_frames, ctx.frame_hashes.length);
    outcome = toOutcome({ claim_result: claim, confidence }, ctx.yes_party);
    if (outcome === 'REDO') {
      redo = v.contested ? 'contested' : claim === 'UNCLEAR' ? 'unclear' : 'low_confidence';
    } else if (judged.disagreement) {
      outcome = 'REDO';
      redo = 'unclear';
      reason = cleanReason(`Checks disagree: ${judged.disagreement}. Run it back.`, reason);
    }
  }

  let voidReason: Ruling['void_reason'] = null;
  if (outcome === 'REDO' && ctx.attempt_no > MAX_REDOS) {
    outcome = 'VOID';
    redo = null;
    voidReason = 'max_redos';
  }

  return Ruling.parse({
    schema_version: 1,
    ruling_id: ctx.ruling_id,
    bet_id: ctx.bet_id,
    stage: 'attempt',
    attempt_no: ctx.attempt_no,
    outcome,
    claim_result: claim,
    redo_reason: redo,
    void_reason: voidReason,
    confidence,
    reason,
    cited_frames: cited,
    frame_hashes: ctx.frame_hashes,
    model: judged.model.slice(0, 80),
    evidence_hash: ctx.evidence_hash,
    terms_hash: ctx.terms_hash,
    created_at: ctx.created_at,
  });
}

export const rulingCanonical = (r: Ruling): { canonical: string; hash: string } => ({
  canonical: jcs(r),
  hash: hashJcs(r),
});

/**
 * The stored demo verdict (CACHED_RULING): a clean landing, citing the last three frames. The
 * ruling still commits to the frames actually uploaded, so its hash is real; only the model's
 * judgement is replayed.
 */
export function cachedVerdict(frameCount: number): JudgeVerdict {
  const last = Math.max(0, frameCount - 1);
  const cited = [last - 2, last - 1, last].filter((i) => i >= 0);
  return {
    claim_result: 'MET',
    confidence: 0.93,
    reason: `Full rotation, lands upright on its base in frame ${last} and stays put. Clean.`,
    cited_frames: cited,
    contested: false,
    checks: { cap_tape_visible: true, bottle_upright_at_rest: true },
  };
}

export interface JudgeInput {
  terms: Terms;
  performer_name: string;
  frames: PromptFrame[];
}

/** One structured vision call through deps.providers.llm (or the cached verdict). Never throws. */
export async function judgeFrames(
  deps: Pick<AppDeps, 'env' | 'providers' | 'log'>,
  input: JudgeInput,
): Promise<Judged> {
  const applies = isBottleFlip(input.terms);
  const withChecks = (model: string, v: JudgeVerdict): Judged => {
    const c = compareChecks(v.claim_result, v.checks, applies);
    const { checks: _checks, ...verdict } = v;
    return { kind: 'verdict', model, verdict, disagreement: c.agree ? null : c.why };
  };

  if (deps.env.CACHED_RULING)
    return withChecks(CACHED_RULING_MODEL, cachedVerdict(input.frames.length));

  const model = deps.env.JUDGE_MODEL;
  try {
    const res = await deps.providers.llm.chat({
      vendor: 'anthropic',
      model,
      system: JUDGE_SYSTEM_PROMPT,
      parts: buildJudgeParts(input.terms, input.performer_name, input.frames),
      output: JUDGE_OUTPUT,
      effort: 'low',
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
    const served = `anthropic/${res.model}`;
    if (!res.ok) {
      deps.log.warn('judge.llm_failed', {
        status: res.status,
        message: res.message,
        model: served,
      });
      return { kind: 'failure', model: served, status: res.status, message: res.message };
    }
    return withChecks(served, res.value);
  } catch (e) {
    deps.log.error('judge.llm_threw', { err: String(e) });
    return { kind: 'failure', model: `anthropic/${model}`, status: 'error', message: String(e) };
  }
}
