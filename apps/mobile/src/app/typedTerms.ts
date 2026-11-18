// "Type it instead": Beat 2 without the voice judge, on A's phone (the automatic path when
// EXPO_PUBLIC_VOICE=off or the voice session fails). A pure reducer for the form plus the two
// calls over injected deps, tested in node:
//   submit   claim + stake -> POST /v1/bets/:id/terms/typed (the server runs the propose_terms
//            path: guardrail, stake cap); the terms card then arrives by the normal
//            terms.proposed push, exactly as after the judge's read-back.
//   confirm  "Lock it in" -> POST /v1/bets/:id/terms/confirm {terms_hash of the card shown}
//            (freeze -> both phones get the lock card; LOCK_SIGNER=server locks by itself).
//
//   voice ──open──▶ editing ──submit──▶ sending ──proposed──▶ sent ──confirm──▶ confirming ──▶ confirmed
//                    ▲  ▲                  │ draft / refused / error          │ failed
//                    │  └──── note ────────┘                                  ▼
//                    └──────────── claim / stake edit ◀──────────────────── sent (note)
import {
  bottleFlipClaim,
  TYPED_STAKES_USD,
  typedTermsRequest,
  type TypedStakeUsd,
} from '@youre-on/shared/judge/typed-terms';

import type { YoApi } from '../net/api';
import { ApiClientError } from '../net/signedFetch';
import { COPY, t } from '../screens/copy';
import { isCopyOk } from '../ui/copyRule';

export { TYPED_STAKES_USD, type TypedStakeUsd };

/** $1 each: the Beat 2 bet, small enough for the demo accounts. */
export const DEFAULT_STAKE_USD: TypedStakeUsd = 1;
const MAX_CLAIM = 200;

export type TypedPhase = 'editing' | 'sending' | 'sent' | 'confirming' | 'confirmed';

export interface TypedState {
  bet_id: string | null;
  mode: 'voice' | 'typed';
  claim: string;
  stakeUsd: TypedStakeUsd;
  phase: TypedPhase;
  /** The server's answer to show under the form (a judge line or a short error), or null. */
  note: string | null;
  /** terms_hash of the last proposal this form sent. */
  proposedHash: string | null;
}

export type SubmitOutcome =
  | { kind: 'proposed'; terms_hash: string; code: string }
  | { kind: 'draft' | 'refused' | 'error'; note: string };

export type TypedEvent =
  /** A new bet on screen: reset (typed = start in the form: voice off, or already failed). */
  | { type: 'init'; bet_id: string; bName: string; typed: boolean }
  /** "Type it instead", or the voice session failed. */
  | { type: 'open' }
  /** Back to the judge (only offered while voice is available). */
  | { type: 'voice' }
  | { type: 'claim'; text: string }
  | { type: 'stake'; usd: TypedStakeUsd }
  | { type: 'submit' }
  | { type: 'submitted'; outcome: SubmitOutcome }
  | { type: 'confirm' }
  | { type: 'confirmed' }
  | { type: 'confirm_failed'; note: string };

export const initialTyped: TypedState = {
  bet_id: null,
  mode: 'voice',
  claim: '',
  stakeUsd: DEFAULT_STAKE_USD,
  phase: 'editing',
  note: null,
  proposedHash: null,
};

const busy = (s: TypedState) => s.phase === 'sending' || s.phase === 'confirming';

export function typedReducer(s: TypedState, e: TypedEvent): TypedState {
  switch (e.type) {
    case 'init':
      if (s.bet_id === e.bet_id) return e.typed && s.mode === 'voice' ? { ...s, mode: 'typed' } : s;
      return {
        ...initialTyped,
        bet_id: e.bet_id,
        mode: e.typed ? 'typed' : 'voice',
        claim: bottleFlipClaim(e.bName),
      };
    case 'open':
      return s.mode === 'typed' ? s : { ...s, mode: 'typed' };
    case 'voice':
      return busy(s) || s.mode === 'voice' ? s : { ...s, mode: 'voice', note: null };
    case 'claim':
      if (busy(s) || s.phase === 'confirmed') return s;
      return { ...s, claim: e.text.slice(0, MAX_CLAIM), phase: 'editing', note: null };
    case 'stake':
      if (busy(s) || s.phase === 'confirmed' || s.stakeUsd === e.usd) return s;
      return { ...s, stakeUsd: e.usd, phase: 'editing', note: null };
    case 'submit':
      return canSubmit(s) ? { ...s, phase: 'sending', note: null } : s;
    case 'submitted':
      if (s.phase !== 'sending') return s;
      return e.outcome.kind === 'proposed'
        ? { ...s, phase: 'sent', note: null, proposedHash: e.outcome.terms_hash }
        : { ...s, phase: 'editing', note: e.outcome.note };
    case 'confirm':
      return s.mode === 'typed' && s.phase === 'sent'
        ? { ...s, phase: 'confirming', note: null }
        : s;
    case 'confirmed':
      return s.phase === 'confirming' ? { ...s, phase: 'confirmed' } : s;
    case 'confirm_failed':
      return s.phase === 'confirming' ? { ...s, phase: 'sent', note: e.note } : s;
  }
}

export const canSubmit = (s: TypedState): boolean =>
  s.mode === 'typed' && s.phase === 'editing' && s.bet_id !== null && s.claim.trim().length > 0;

/**
 * "Lock it in" shows once the card this form sent is on screen (the terms.proposed push), and
 * only for that card: a newer proposal (the judge, a second phone) needs a fresh look.
 */
export const canConfirm = (s: TypedState, shownHash: string | null): boolean =>
  s.mode === 'typed' &&
  (s.phase === 'sent' || s.phase === 'confirming') &&
  shownHash !== null &&
  shownHash === s.proposedHash;

/** Server text on a party screen passes the copy rule, or a short fallback shows instead. */
const noteOf = (say: string | null | undefined): string =>
  say && isCopyOk(say, 'body') ? say : t(COPY.app.failed);

export async function submitTypedTerms(
  d: { api: Pick<YoApi, 'proposeTypedTerms'> },
  i: { betId: string; claim: string; stakeUsd: number; bName: string },
): Promise<SubmitOutcome> {
  try {
    const r = await d.api.proposeTypedTerms(
      i.betId,
      typedTermsRequest({ claim: i.claim, stakeUsd: i.stakeUsd, bName: i.bName }),
    );
    if (r.kind === 'proposed') return { kind: 'proposed', terms_hash: r.terms_hash, code: r.code };
    return { kind: r.kind, note: noteOf(r.say) };
  } catch (e) {
    return { kind: 'error', note: errorNote(e) };
  }
}

export async function confirmTypedTerms(
  d: { api: Pick<YoApi, 'confirmTerms'> },
  i: { betId: string; termsHash: string; idempotencyKey: string },
): Promise<{ ok: true } | { ok: false; note: string }> {
  try {
    await d.api.confirmTerms(i.betId, i.termsHash, i.idempotencyKey);
    return { ok: true };
  } catch (e) {
    return { ok: false, note: errorNote(e) };
  }
}

function errorNote(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'TERMS_HASH_MISMATCH') return 'Terms changed, review again';
    if (e.code === 'VALIDATION_FAILED') return noteOf('That bet needs fixing. Try it shorter.');
  }
  return t(COPY.app.failed);
}
