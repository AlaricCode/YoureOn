// Spoken-bet fixtures for the judge (TASKS D0-J3): 12 bets, 8 benign (2 of them need
// clarification) and 4 refusals, one per BRIEF 5c category. Files: ./fixtures/*.json.
//
// Deterministic checks (tested now): every file parses with SpokenBetFixture; `sample_args` (what
// a correct judge sends as its final propose_terms call) maps to `expected_proposal` exactly, and
// gives `ok:true` from the server core for benign fixtures, or the expected RefusalCategory for
// refusal fixtures. The live run (the real LLM on these transcripts) is PENDING-KEY: see
// apps/server/src/judge/fixture-runner.ts, which grades the LLM's own calls against `checks`.
import { z } from 'zod/v4';
import { MAX_CLARIFICATIONS } from '../constants';
import { MicroUsdc } from '../money';
import { Party } from '../primitives';
import { RefusalCategory, TermsProposal } from '../negotiation';
import { ProposeTermsProjection } from './propose-terms';

const Line = z.strictObject({ speaker: Party, text: z.string().min(1).max(300) });

export const FixtureChecks = z.strictObject({
  type: z.enum(['skill', 'real_world']),
  performer: Party.nullable(),
  yes_party: Party,
  amount: MicroUsdc,
  attempts: z.strictObject({ count: z.number().int(), rule: z.string() }).optional(),
  market_side: z.enum(['YES', 'NO']).optional(),
  /** Edge-case keywords at least one agreed edge case must mention (case-insensitive). */
  edge_case_mentions: z.array(z.string()).optional(),
});

export const SpokenBetFixture = z
  .strictObject({
    id: z.string().regex(/^[0-9]{2}-[a-z0-9-]+$/),
    title: z.string().max(60),
    kind: z.enum(['benign', 'clarify', 'refusal']),
    party_a_name: z.string().min(1).max(32),
    party_b_name: z.string().min(1).max(32),
    /** What the parties say before the judge's first move. */
    opening: z.array(Line).min(1).max(4),
    /** Scripted replies, in order, to the judge's clarifying questions (≤ MAX_CLARIFICATIONS). */
    answers: z.array(Line).max(MAX_CLARIFICATIONS),
    min_questions: z.number().int().min(0).max(MAX_CLARIFICATIONS),
    max_questions: z.number().int().min(0).max(MAX_CLARIFICATIONS),
    /** A correct final propose_terms call (the LLM-facing projection, without the ids). */
    sample_args: ProposeTermsProjection,
    expected_proposal: TermsProposal.nullable(),
    refusal_category: RefusalCategory.nullable(),
    checks: FixtureChecks.nullable(),
    note: z.string().max(300).optional(),
  })
  .superRefine((f, ctx) => {
    const bad = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (f.min_questions > f.max_questions) bad('min_questions', '> max_questions');
    if (f.answers.length < f.min_questions)
      bad('answers', 'fewer scripted answers than min_questions');
    if (f.kind === 'refusal') {
      if (f.refusal_category === null) bad('refusal_category', 'required for refusals');
      if (f.expected_proposal !== null && f.checks !== null)
        bad('checks', 'refusals have no checks');
    } else {
      if (f.refusal_category !== null) bad('refusal_category', 'only for refusals');
      if (f.expected_proposal === null) bad('expected_proposal', 'required');
      if (f.checks === null) bad('checks', 'required');
      if (f.kind === 'clarify' && f.min_questions < 1) bad('min_questions', 'clarify needs >= 1');
    }
  });
export type SpokenBetFixture = z.infer<typeof SpokenBetFixture>;

/** 8 benign bets = 6 'benign' + 2 'clarify'; 4 refusals, one per BRIEF 5c category. */
export const FIXTURE_COUNTS = { total: 12, benign: 6, clarify: 2, refusal: 4 } as const;
