// Dance Off terms (DANCE-OFF §1): A picks one of the bundled routines and an even stake.
//
//   POST /v1/bets/:bet_id/terms/dance   (S, party A; DRAFTING | TERMS_PROPOSED)
//     body DanceTermsRequest {routine_id, amount_usd}. The server builds the projection with
//     danceTermsArgs() and runs the SAME evaluateProposeTerms + persistEvaluation as /terms/typed
//     and /terms/market: terms.proposed fans out as usual.
//     -> 200 DanceTermsResponse (= TypedTermsResponse); 404 NOT_FOUND for an unknown routine.
//   then POST /v1/bets/:bet_id/terms/confirm as for any bet.
//
// The voice agent does NOT propose dance offs in v1 (PROPOSE_TERMS_BODY_SCHEMA does not list
// 'dance_off'; that would need an ElevenLabs agent re-sync). Pure (no I/O).
import { z } from 'zod/v4';
import { parseUsd } from '../money';
import { getRoutine } from '../dance/routine';
import { danceTermsText } from '../dance/terms';
import type { ProposeTermsProjection } from './propose-terms';
import { TypedTermsResponse } from './typed-terms';

export const danceTermsPath = (betId: string) =>
  `/v1/bets/${encodeURIComponent(betId)}/terms/dance`;

/** The stake chips the phone offers, dollars per person (even money). */
export const DANCE_STAKES_USD = [1, 5, 10, 20] as const;
export type DanceStakeUsd = (typeof DANCE_STAKES_USD)[number];

export const DanceTermsRequest = z.object({
  routine_id: z.string().min(1).max(32),
  /** Dollars per person, e.g. "5" (whole cents). */
  amount_usd: z.string().min(1).max(16),
});
export type DanceTermsRequest = z.infer<typeof DanceTermsRequest>;

export const DanceTermsResponse = TypedTermsResponse;
export type DanceTermsResponse = z.infer<typeof DanceTermsResponse>;

/**
 * The propose_terms projection of a dance off: camera evidence, nobody singled out as performer,
 * A is the yes party ("A out-dances B"), one round, even stakes, no edge cases. null for a routine
 * that is not bundled. An unparseable amount is passed through as typed (the claim then says $0);
 * evaluateProposeTerms answers AMBIGUOUS, as for any bad amount, so it never reaches Terms.
 */
export function danceTermsArgs(i: DanceTermsRequest): ProposeTermsProjection | null {
  const routine = getRoutine(i.routine_id.trim());
  if (!routine) return null;
  const amount_usd = i.amount_usd.trim().replace(/^\$/, '');
  let micro: string;
  try {
    micro = parseUsd(amount_usd);
  } catch {
    micro = '0';
  }
  const text = danceTermsText(routine, micro);
  return {
    type: 'dance_off',
    claim: text.claim,
    performer: 'none',
    yes_party: 'A',
    attempts: { count: 1, rule: 'single' },
    success_criteria: [...text.success_criteria],
    failure_criteria: [...text.failure_criteria],
    edge_cases: [],
    amount_usd,
    market_side: 'none',
    deadline_minutes: 0,
  };
}
