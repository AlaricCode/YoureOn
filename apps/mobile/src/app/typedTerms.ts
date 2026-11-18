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

import type { TermsEnvelope } from '@youre-on/shared/terms';

import type { YoApi } from '../net/api';
import {
  controlOf,
  controlStakes,
  evenControl,
  usdString,
  type OddsControl,
  type StakePair,
} from './odds';
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
  /** The odds picker (app/odds): Even by default; `stakeUsd` is its base, the smaller stake. */
  odds: OddsControl;
}

/**
 * The card already on screen when the form opens on a bet: after a restart mid-bet (the bet came
 * back from its event log, but this form's state did not), so "Lock it in" can confirm it.
 */
export interface ShownTypedCard {
  terms_hash: string;
  claim: string;
  stakeUsd: TypedStakeUsd;
  /** The card's odds as the picker shows them (Even for equal stakes). */
  odds: OddsControl;
}

export type SubmitOutcome =
  | { kind: 'proposed'; terms_hash: string; code: string }
  | { kind: 'draft' | 'refused' | 'error'; note: string };

export type TypedEvent =
  /**
   * A new bet on screen: reset (typed = start in the form: voice off, or already failed). With a
   * card already shown (a restart), the form starts on it: sent, ready to confirm.
   */
  | {
      type: 'init';
      bet_id: string;
      bName: string;
      typed: boolean;
      shown?: ShownTypedCard | null;
    }
  /** "Type it instead", or the voice session failed. */
  | { type: 'open' }
  /** Back to the judge (only offered while voice is available). */
  | { type: 'voice' }
  | { type: 'claim'; text: string }
  | { type: 'stake'; usd: TypedStakeUsd }
  /** The odds picker changed (a preset, the direction, or the judge's suggestion). */
  | { type: 'odds'; control: OddsControl }
  /**
   * Both phones accepted odds that differ from the card this form sent, so the server recomposed
   * the card (a new terms_hash, same claim). The form adopts it: "Lock it in" binds the new card.
   */
  | { type: 'odds_agreed'; shown: ShownTypedCard }
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
  odds: evenControl(DEFAULT_STAKE_USD),
};

const busy = (s: TypedState) => s.phase === 'sending' || s.phase === 'confirming';

export function typedReducer(s: TypedState, e: TypedEvent): TypedState {
  switch (e.type) {
    case 'init':
      if (s.bet_id === e.bet_id) return e.typed && s.mode === 'voice' ? { ...s, mode: 'typed' } : s;
      if (e.typed && e.shown)
        return {
          ...initialTyped,
          bet_id: e.bet_id,
          mode: 'typed',
          claim: e.shown.claim.slice(0, MAX_CLAIM),
          stakeUsd: e.shown.stakeUsd,
          odds: e.shown.odds,
          phase: 'sent',
          proposedHash: e.shown.terms_hash,
        };
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
    case 'stake': {
      if (busy(s) || s.phase === 'confirmed') return s;
      // A chip after custom stakes (the judge's 3:2) starts over at Even from that base.
      const odds: OddsControl =
        s.odds.preset === 'custom' ? evenControl(e.usd) : { ...s.odds, baseUsd: e.usd };
      if (s.stakeUsd === e.usd && odds.preset === s.odds.preset) return s;
      return { ...s, stakeUsd: e.usd, odds, phase: 'editing', note: null };
    }
    case 'odds': {
      if (busy(s) || s.phase === 'confirmed') return s;
      const chip = TYPED_STAKES_USD.find((x) => x === e.control.baseUsd);
      // A preset over a base the chips don't offer is kept as its exact stakes.
      let odds = e.control;
      if (chip === undefined && odds.preset !== 'custom') {
        const r = controlStakes(odds, 'A');
        if (!r.ok) return { ...s, note: r.note };
        odds = { ...odds, preset: 'custom', custom: { mine: r.stakes.a, theirs: r.stakes.b } };
      }
      return { ...s, odds, stakeUsd: chip ?? s.stakeUsd, phase: 'editing', note: null };
    }
    case 'odds_agreed':
      // Only a card this form already sent can be replaced (not a fresh edit, not mid-request).
      if (s.mode !== 'typed' || s.phase !== 'sent' || s.proposedHash === null) return s;
      if (s.proposedHash === e.shown.terms_hash) return s;
      return {
        ...s,
        claim: e.shown.claim.slice(0, MAX_CLAIM),
        stakeUsd: e.shown.stakeUsd,
        odds: e.shown.odds,
        proposedHash: e.shown.terms_hash,
        note: null,
      };
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

/**
 * The card on screen, as the typed form would have sent it: a camera bet with even stakes the
 * form offers, or odds (unequal stakes) the picker can show: a preset over a chip, or custom
 * stakes (the judge's 3:2, a counter). Anything else (a market card, an even stake the chips do
 * not offer) is not adopted: the form starts fresh.
 */
export function typedCardOf(
  env: Pick<TermsEnvelope, 'terms' | 'terms_hash'> | null | undefined,
): ShownTypedCard | null {
  if (!env || env.terms.market !== null || env.terms.type === 'real_world') return null;
  const { a, b } = env.terms.stakes;
  // The form is A's: the picker reads the stakes from A's side.
  const odds = controlOf({ a, b }, 'A');
  const chip = TYPED_STAKES_USD.find((x) => x === odds.baseUsd);
  if (odds.preset !== 'custom' && chip === undefined) return null;
  if (a === b && (odds.preset !== 'Even' || chip === undefined)) return null;
  return {
    terms_hash: env.terms_hash,
    claim: env.terms.claim,
    stakeUsd: chip ?? DEFAULT_STAKE_USD,
    odds: chip === undefined ? odds : { ...odds, baseUsd: chip },
  };
}

/** The stakes the form would send (A, B), or a short note when the picker can't make them. */
export const typedStakes = (s: Pick<TypedState, 'odds' | 'stakeUsd'>) =>
  controlStakes({ ...s.odds, baseUsd: s.stakeUsd }, 'A');

export const canSubmit = (s: TypedState): boolean =>
  s.mode === 'typed' && s.phase === 'editing' && s.bet_id !== null && s.claim.trim().length > 0;

/** The card this form sent is on screen (the terms.proposed push), and only that card. */
const ownCardShown = (s: TypedState, shownHash: string | null): boolean =>
  s.mode === 'typed' &&
  (s.phase === 'sent' || s.phase === 'confirming') &&
  shownHash !== null &&
  shownHash === s.proposedHash;

/**
 * "Lock it in" shows once the card this form sent is on screen, and only for that card: a newer
 * proposal (the judge, a second phone) needs a fresh look. It also waits for B to accept the
 * challenge (bet.invite_answered): the server answers 409 invite_pending before that, and with
 * LOCK_SIGNER=server the accept is B's only consent to the lock.
 */
export const canConfirm = (
  s: TypedState,
  shownHash: string | null,
  inviteAnswer: 'accepted' | 'declined' | null,
  /** app/odds oddsSettled: no open offer, and the card's odds (if any) both accepted. */
  oddsOk = true,
): boolean => ownCardShown(s, shownHash) && inviteAnswer === 'accepted' && oddsOk;

/** The card is ready but B has not said yes yet: show "Waiting for <B>" in place of the button. */
export const waitingForAccept = (
  s: TypedState,
  shownHash: string | null,
  inviteAnswer: 'accepted' | 'declined' | null,
  /** The odds are still out (the other side has not tapped Accept): wait for them too. */
  oddsOk = true,
): boolean => ownCardShown(s, shownHash) && (inviteAnswer !== 'accepted' || !oddsOk);

/** Server text on a party screen passes the copy rule, or a short fallback shows instead. */
const noteOf = (say: string | null | undefined): string =>
  say && isCopyOk(say, 'body') ? say : t(COPY.app.failed);

export async function submitTypedTerms(
  d: { api: Pick<YoApi, 'proposeTypedTerms'> },
  i: {
    betId: string;
    claim: string;
    stakeUsd: number;
    bName: string;
    /** Odds from the picker (typedStakes): A's stake is amount_usd, B's is stake_b_usd. */
    stakes?: StakePair | undefined;
  },
): Promise<SubmitOutcome> {
  try {
    const odds = i.stakes && i.stakes.a !== i.stakes.b ? i.stakes : null;
    const req = typedTermsRequest({ claim: i.claim, stakeUsd: i.stakeUsd, bName: i.bName });
    const r = await d.api.proposeTypedTerms(
      i.betId,
      odds ? { ...req, amount_usd: usdString(odds.a), stake_b_usd: usdString(odds.b) } : req,
    );
    if (r.kind === 'proposed') return { kind: 'proposed', terms_hash: r.terms_hash, code: r.code };
    return { kind: r.kind, note: noteOf(r.say) };
  } catch (e) {
    return { kind: 'error', note: errorNote(e) };
  }
}

/**
 * `freshKey`: the server answered with a 4xx, which it replays for that Idempotency-Key for 24h,
 * so the next tap must mint a new key (a network error or 5xx keeps the key: same write).
 */
export async function confirmTypedTerms(
  d: { api: Pick<YoApi, 'confirmTerms'> },
  i: { betId: string; termsHash: string; idempotencyKey: string },
): Promise<{ ok: true } | { ok: false; note: string; freshKey: boolean }> {
  try {
    await d.api.confirmTerms(i.betId, i.termsHash, i.idempotencyKey);
    return { ok: true };
  } catch (e) {
    const answered = e instanceof ApiClientError && e.status >= 400 && e.status < 500;
    return { ok: false, note: errorNote(e), freshKey: answered };
  }
}

function errorNote(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'TERMS_HASH_MISMATCH') return 'Terms changed, review again';
    if (e.code === 'VALIDATION_FAILED') return noteOf('That bet needs fixing. Try it shorter.');
    if (e.code === 'INVALID_STATE' && e.details?.reason === 'invite_pending')
      return noteOf('They have not accepted yet.');
    if (e.code === 'INVALID_STATE' && e.details?.reason === 'odds_pending')
      return t(COPY.odds.pending);
  }
  return t(COPY.app.failed);
}
