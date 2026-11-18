// Typed terms: the non-voice way for party A to set the terms (Beat 2 without ElevenLabs).
//
//   POST /v1/bets/:bet_id/terms/typed    (S, party A, DRAFTING | TERMS_PROPOSED)
//     body TypedTermsRequest: the propose_terms LLM projection (API-CONTRACT §4.3) with the
//     structural fields optional; typedTermsArgs() fills them (skill, B performs, B is the yes
//     party, one try). The server then runs the SAME evaluateProposeTerms (guardrail prefilter,
//     stake cap) and lock/terms.ts persistEvaluation as /el/tools/propose_terms, so
//     terms.proposed / terms.draft / terms.refused fan out exactly as for a spoken bet.
//     -> 200 TypedTermsResponse (a refusal or an unfinished draft is a business answer, not an
//        HTTP error; a refusal has already cancelled the bet).
//   POST /v1/bets/:bet_id/terms/confirm  (S, party A, TERMS_PROPOSED)
//     body TermsConfirmRequest {terms_hash}: the terms the phone showed. The confirm_terms step:
//     freeze -> AWAITING_AUTHORIZATIONS -> LockService.start (LOCK_SIGNER=server locks by itself).
//     -> 200 TermsConfirmResponse
//
// Pure (no I/O) so the phone builds the request with the same defaults the server applies.
import { z } from 'zod/v4';
import { BetState } from '../bet-state';
import { Hex32 } from '../primitives';
import { ProposeTermsProjection, type ProposeTermsProjection as Projection } from './propose-terms';

export const typedTermsPath = (betId: string) =>
  `/v1/bets/${encodeURIComponent(betId)}/terms/typed`;
export const termsConfirmPath = (betId: string) =>
  `/v1/bets/${encodeURIComponent(betId)}/terms/confirm`;

/** The stakes the phone offers (dollars per person). */
export const TYPED_STAKES_USD = [1, 5, 10, 20] as const;
export type TypedStakeUsd = (typeof TYPED_STAKES_USD)[number];

/** The projection with only `claim` and `amount_usd` required (lenient on unknown keys). */
export const TypedTermsRequest = ProposeTermsProjection.partial().extend({
  claim: z.string().min(1).max(400),
  amount_usd: z.string().min(1).max(16),
});
export type TypedTermsRequest = z.infer<typeof TypedTermsRequest>;

/** Server defaults for the fields a typed request may leave out. */
export function typedTermsArgs(r: TypedTermsRequest): Projection {
  const type = r.type ?? 'skill';
  return {
    type,
    claim: r.claim,
    performer: r.performer ?? (type === 'real_world' ? 'none' : 'B'),
    yes_party: r.yes_party ?? 'B',
    attempts: r.attempts ?? { count: 1, rule: 'single' },
    success_criteria: r.success_criteria ?? [r.claim],
    failure_criteria: r.failure_criteria ?? [],
    edge_cases: r.edge_cases ?? [],
    amount_usd: r.amount_usd,
    market_side: r.market_side ?? 'none',
    deadline_minutes: r.deadline_minutes ?? 0,
  };
}

/** The Beat 2 bet, prefilled on A's phone: "<B> lands a water bottle flip upright on the table. One try." */
export const bottleFlipClaim = (bName: string) =>
  `${bName.trim() || 'They'} lands a water bottle flip upright on the table. One try.`;

const BOTTLE_FLIP = {
  success_criteria: [
    'The bottle rotates at least once in the air.',
    'The bottle comes to rest standing upright on its base on the table.',
  ],
  failure_criteria: ['The bottle ends on its side, upside down, or off the table.'],
  edge_cases: [
    { question: 'Does landing on the cap count?', answer: 'No. Only upright on its base counts.' },
  ],
} as const;

const GENERIC = {
  edge_cases: [
    {
      question: 'Does anything off camera count?',
      answer: 'No. Only what the camera records counts.',
    },
  ],
} as const;

/**
 * The phone's request: the bottle-flip criteria when the claim is still the template, otherwise
 * the claim itself as the one success condition plus a generic camera ruling (v1 asks for at
 * least one edge case on a skill bet, propose-terms missingFields).
 */
export function typedTermsRequest(i: {
  claim: string;
  stakeUsd: number;
  bName: string;
}): TypedTermsRequest {
  const claim = i.claim.replace(/\s+/g, ' ').trim();
  const template = claim === bottleFlipClaim(i.bName);
  return {
    claim,
    amount_usd: String(i.stakeUsd),
    type: 'skill',
    performer: 'B',
    yes_party: 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: template ? [...BOTTLE_FLIP.success_criteria] : [claim],
    failure_criteria: template ? [...BOTTLE_FLIP.failure_criteria] : [],
    edge_cases: (template ? BOTTLE_FLIP.edge_cases : GENERIC.edge_cases).map((e) => ({ ...e })),
    deadline_minutes: 0,
  };
}

export const TypedTermsResponse = z.discriminatedUnion('kind', [
  z.object({
    ok: z.literal(true),
    kind: z.literal('proposed'),
    state: BetState,
    terms_hash: Hex32,
    /** "0586·0f0a" */
    code: z.string(),
    say: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    /** Not composed yet: a stake / deadline / market issue, or fields still to agree. */
    kind: z.literal('draft'),
    fix: z.string().nullable(),
    missing: z.array(z.string()),
    say: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    /** The guardrail refused the bet; it is CANCELLED (terms.refused already pushed). */
    kind: z.literal('refused'),
    category: z.string(),
    say: z.string(),
  }),
]);
export type TypedTermsResponse = z.infer<typeof TypedTermsResponse>;

export const TermsConfirmRequest = z.object({ terms_hash: Hex32 });
export type TermsConfirmRequest = z.infer<typeof TermsConfirmRequest>;

export const TermsConfirmResponse = z.object({
  ok: z.literal(true),
  code: z.string(),
  state: BetState,
  say: z.string(),
});
export type TermsConfirmResponse = z.infer<typeof TermsConfirmResponse>;
