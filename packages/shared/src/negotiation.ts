// SCHEMAS §3 — judge-owned proposal fields, drafts, clarifications (Speech Engine fallback only), refusals.
import { z } from 'zod/v4';
import { MAX_CLARIFICATIONS } from './constants';
import { MicroUsdc } from './money';
import { BetId, IsoUtc, NText, Party, Uuid } from './primitives';
import { Attempts, EdgeCase, TermsV1 } from './terms';

/** Judge-owned fields. propose_terms wire params (API-CONTRACT §4.3) map into it server-side. */
export const TermsProposal = z.strictObject({
  type: TermsV1.shape.type,
  claim: NText(200),
  performer: Party.nullable(),
  yes_party: Party,
  attempts: Attempts,
  success_criteria: z.array(NText(160)).min(1).max(5),
  failure_criteria: z.array(NText(160)).max(5),
  edge_cases: z.array(EdgeCase).max(4),
  evidence_source: TermsV1.shape.evidence_source,
  /** Spoken stake per side (parseUsd); real_world: pot = 2 × amount. */
  amount: MicroUsdc,
  /** real_world only; the server resolves it to a concrete contract. */
  market_query: z
    .strictObject({
      asset: z.enum(['BTC']),
      horizon: z.literal('5m'),
      a_side: z.enum(['YES', 'NO']),
    })
    .nullable(),
  /** null → 10; ≤ 45 keeps RESOLVE_GRACE inside resolve_deadline (§9.3). */
  deadline_minutes: z.number().int().min(1).max(45).nullable(),
});
export type TermsProposal = z.infer<typeof TermsProposal>;

/** Tolerant variant for agent tool calls: strips stray keys (run normTextDeep first), then compose + strict Terms. */
export const TermsProposalLoose = z.object(TermsProposal.shape);

export const ClarificationField = z.enum([
  'claim',
  'attempts',
  'success_criteria',
  'failure_criteria',
  'edge_cases',
  'amount',
  'deadline',
]);
export const ClarificationQuestion = z.strictObject({
  question_id: Uuid,
  /** 1st or 2nd question; there is no 3rd. */
  index: z.number().int().min(1).max(MAX_CLARIFICATIONS),
  field: ClarificationField,
  question: NText(140),
  /** Suggested answers for chips + STT biasing. */
  options: z.array(NText(40)).max(4),
  addressed_to: z.enum(['A', 'B', 'both']),
  asked_at: IsoUtc,
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestion>;
/** LLM-facing. */
export const ClarificationAsk = ClarificationQuestion.pick({
  field: true,
  question: true,
  options: true,
  addressed_to: true,
});
export const ClarificationAnswer = z.strictObject({
  question_id: Uuid,
  answer: NText(160),
  answered_by: Party,
  answered_at: IsoUtc,
});

export const RefusalCategory = z.enum([
  'dangerous',
  'alcohol_drugs',
  'self_harm',
  'minors',
  'illegal',
  'other',
]);
export type RefusalCategory = z.infer<typeof RefusalCategory>;
export const GuardrailRefusal = z.strictObject({
  refused: z.literal(true),
  category: RefusalCategory,
  /** Spoken by the judge, PG-13, one line, never preachy. */
  quip: NText(140),
});
export type GuardrailRefusal = z.infer<typeof GuardrailRefusal>;

export const DraftIssueCode = z.enum([
  'STAKE_ABOVE_MAX',
  'STAKE_BELOW_MIN',
  'NO_MARKET',
  'MARKET_UNFAIR',
  'DEADLINE_TOO_FAR',
  'AMBIGUOUS',
]);
export const DraftIssue = z.strictObject({
  code: DraftIssueCode,
  message: z.string().max(160),
});
export const TermsDraft = z.strictObject({
  bet_id: BetId,
  /** +1 per judge turn that changes the draft. */
  revision: z.number().int().nonnegative(),
  proposal: TermsProposal.partial(),
  missing: z.array(TermsProposal.keyof()),
  clarifications: z
    .array(
      z.strictObject({ question: ClarificationQuestion, answer: ClarificationAnswer.nullable() }),
    )
    .max(MAX_CLARIFICATIONS),
  issues: z.array(DraftIssue),
  updated_at: IsoUtc,
});
export type TermsDraft = z.infer<typeof TermsDraft>;

/** Structured output of one judge step in the terms phase (Speech Engine fallback). */
export const TermsStepOutput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), ask: ClarificationAsk }),
  z.object({ kind: z.literal('propose'), proposal: TermsProposal, readback: NText(400) }),
  z.object({ kind: z.literal('refuse'), refusal: GuardrailRefusal }),
]);
export type TermsStepOutput = z.infer<typeof TermsStepOutput>;
