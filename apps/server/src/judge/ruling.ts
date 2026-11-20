// VisionVerdict -> Ruling (SCHEMAS §5.1, §5.2), as pure functions, plus the one vision call.
//
// Rules, in order:
//   1. confidence rounded to 2 dp; outcome = toOutcome(verdict, yes_party) (REDO_BELOW = 0.8)
//   2. a decisive verdict whose deterministic checks disagree -> REDO 'unclear' (checks.ts; for a
//      bet with camera checks, camera-checks.ts: the veto's own template reason is the reason)
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
import type { VetoKind } from '@youre-on/shared/checks/report';
import type { AppDeps } from '../context';
import { cachedRulingOn } from '../demo/toggles';
import { compareChecks, isBottleFlip, type JudgeVerdict } from './checks';
import {
  buildJudgeParts,
  JUDGE_MAX_OUTPUT_TOKENS,
  JUDGE_OUTPUT,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_TIMEOUT_MS,
  type JudgeTerms,
  type PromptFrame,
} from './prompt';
import { judgeStatsOf, type JudgeCallSource } from './stats';

/**
 * `Ruling.model` of a cached ruling (env CACHED_RULING or the runtime toggle POST
 * /v1/demo/toggles, demo/toggles.ts): the marker the stage labels "replay ruling" (shared
 * isCachedRuling / isCachedRulingModel).
 */
export { CACHED_RULING_MODEL };

/** What the vision step produced for one attempt. */
export type Judged =
  | {
      kind: 'verdict';
      model: string;
      verdict: VisionVerdict;
      disagreement: string | null;
      /**
       * Set by the camera checks (camera-checks.ts applyCameraVeto): `disagreement` then is
       * `veto.why`, a full sentence the players read as the ruling's reason.
       */
      veto?: { kind: VetoKind; why: string } | null;
      /** The vision judge's rule finding (JudgeVerdict.rule_broken / rule_note), when it gave one. */
      rule?: { broken: boolean; note: string } | null;
      /** The object tracker decided the result (applyThrowOutcome): how, for the audit. */
      thrown?: { call: 'in' | 'out'; why: string } | null;
    }
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
      reason = cleanReason(
        judged.veto ? judged.veto.why : `Checks disagree: ${judged.disagreement}. Run it back.`,
        reason,
      );
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
  terms: JudgeTerms;
  performer_name: string;
  /** In send order; the landing crop (if any) last (planning D10). */
  frames: PromptFrame[];
  /** CameraEvidence.duration_ms: where the landing window sits (the prompt's LANDING labels). */
  duration_ms?: number | undefined;
}

type JudgeDeps = Pick<AppDeps, 'env' | 'providers' | 'log'>;

function withChecks(terms: JudgeTerms, model: string, v: JudgeVerdict): Judged {
  const c = compareChecks(v.claim_result, v.checks, isBottleFlip(terms));
  const { checks: _checks, rule_broken, rule_note, ...verdict } = v;
  return {
    kind: 'verdict',
    model,
    verdict,
    disagreement: c.agree ? null : c.why,
    rule:
      rule_broken === undefined ? null : { broken: rule_broken, note: (rule_note ?? '').trim() },
  };
}

/** The tracker's own model id, when it rules a throw without a usable vision verdict. */
export const THROW_MODEL = 'sam3.1/throw-track@1';

/**
 * A throw at a target, decided by the object tracker (SAM 3.1 followed the object: shared
 * checks/throw). The tracker says whether it went in; the vision judge is the cheat detector.
 *
 *   in  + no rule broken -> MET        "It went in."
 *   in  + a rule broken  -> NOT_MET    "It went in, but <the rule>, so it does not count."
 *   out                  -> NOT_MET    "It missed." (and the rule too, when one was broken)
 *
 * `unknown` never comes here: the vision judge's own verdict stands then. A vision call that
 * failed has no rule finding, so the track alone decides (nothing was seen broken).
 */
export function applyThrowOutcome(
  judged: Judged,
  t: { call: 'in' | 'out'; why: string; frames: number[]; last_seen: number | null },
  labels: { object: string; target: string },
): Judged {
  const rule = judged.kind === 'verdict' ? (judged.rule ?? null) : null;
  const broken = rule?.broken === true;
  const note = (rule?.note || 'a rule of the bet was broken').replace(/[.!\s]+$/, '');
  const at = t.last_seen === null ? '' : ` in frame ${t.last_seen}`;
  const obj = labels.object;
  const tgt = labels.target;
  let reason: string;
  let claim: 'MET' | 'NOT_MET';
  if (t.call === 'in') {
    claim = broken ? 'NOT_MET' : 'MET';
    reason = broken
      ? `The ${obj} went in, tracked to the ${tgt}'s rim${at}. But ${lowerFirst(note)}, so it does not count.`
      : `The ${obj} went in: tracked from the throw to the ${tgt}'s rim${at}, and it is in no frame after.`;
  } else {
    claim = 'NOT_MET';
    reason = broken
      ? `The ${obj} missed: tracked to the floor outside the ${tgt}${at}. Also, ${lowerFirst(note)}.`
      : `The ${obj} missed: tracked to the floor outside the ${tgt}, still there${at}.`;
  }
  return {
    kind: 'verdict',
    model: judged.kind === 'verdict' ? judged.model : THROW_MODEL,
    verdict: {
      claim_result: claim,
      confidence: 0.92,
      reason: reason.slice(0, 280),
      cited_frames: t.frames.slice(-4),
      contested: false,
    },
    disagreement: null,
    veto: null,
    rule,
    thrown: { call: t.call, why: t.why },
  };
}

/** "Logan stepped…" stays (a name); "He stepped…" becomes "he stepped…" after "But". */
function lowerFirst(s: string): string {
  return /^(He|She|They|The|A|An|His|Her|Their)\b/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * The attempt ruling's vision step: the stored verdict while cached_ruling is on (the runtime
 * toggle POST /v1/demo/toggles, else env CACHED_RULING; read at call time, so no restart), else
 * one structured vision call through deps.providers.llm. Never throws.
 */
export async function judgeFrames(deps: JudgeDeps, input: JudgeInput): Promise<Judged> {
  if (cachedRulingOn(deps))
    return withChecks(input.terms, CACHED_RULING_MODEL, cachedVerdict(input.frames.length));
  return callJudge(deps, input, 'ruling');
}

/**
 * One live vision call (the real provider, prompt and output schema; never the cached verdict),
 * recorded in the judge stats (judge/stats.ts) as `source`. POST /v1/demo/warmup calls it
 * directly. Never throws.
 */
export async function callJudge(
  deps: JudgeDeps,
  input: JudgeInput,
  source: JudgeCallSource,
): Promise<Judged> {
  const model = deps.env.JUDGE_MODEL;
  const t0 = performance.now();
  const record = (ok: boolean, served: string, fail?: { status: string; message: string }) =>
    judgeStatsOf(deps).record({
      at: Date.now(),
      ms: Math.round(performance.now() - t0),
      ok,
      model: served,
      source,
      ...(fail ? { status: fail.status, error: fail.message } : {}),
    });
  try {
    const res = await deps.providers.llm.chat({
      vendor: 'anthropic',
      model,
      system: JUDGE_SYSTEM_PROMPT,
      parts: buildJudgeParts(input.terms, input.performer_name, input.frames, input.duration_ms),
      output: JUDGE_OUTPUT,
      effort: 'low',
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
    const served = `anthropic/${res.model}`;
    if (!res.ok) {
      record(false, served, res);
      deps.log.warn('judge.llm_failed', {
        status: res.status,
        message: res.message,
        model: served,
        source,
      });
      return { kind: 'failure', model: served, status: res.status, message: res.message };
    }
    record(true, served);
    return withChecks(input.terms, served, res.value);
  } catch (e) {
    record(false, `anthropic/${model}`, { status: 'error', message: String(e) });
    deps.log.error('judge.llm_threw', { err: String(e), source });
    return { kind: 'failure', model: `anthropic/${model}`, status: 'error', message: String(e) };
  }
}
