// One bet as this phone knows it, folded from a REST BetSnapshot (cold start / resync) and the
// realtime events after it (API-CONTRACT §3.4). Pure reducer, tested in node; the screens read
// it through ../bets/view (betView) and ../bets/lock (lockReducer, fed by lockSignals below).
//
// Trust rule: every TermsEnvelope here came through TermsEnvelope.parse (RealtimeEvent /
// BetSnapshot / AuthorizeRequest all embed it), which recomputes hashJcs(terms) and fails on a
// mismatch, so a forged hash never reaches the store. On top of that the lock request's
// envelope must carry the same terms_hash as the last terms.proposed this phone saw; otherwise
// `termsMismatch` is set and the card refuses to sign.
import type { BetSnapshot, SignRequest } from '@youre-on/shared/api';
import type { AppealResult, AppealVote } from '@youre-on/shared/appeal';
import type { AuthorizeRequest } from '@youre-on/shared/authorization';
import type { BetState, ChainAck, OnchainStatus, PendingTx } from '@youre-on/shared/bet-state';
import type { CallOffPayload } from '@youre-on/shared/call-off';
import type { GeminiSettlementRecord } from '@youre-on/shared/evidence';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import type { HearingRuling } from '@youre-on/shared/hearing';
import type { MicroUsdc } from '@youre-on/shared/money';
import type { Party, UserRef } from '@youre-on/shared/primitives';
import type { DanceScoredPayload, RealtimeEvent } from '@youre-on/shared/realtime';
import type { Ruling } from '@youre-on/shared/ruling';
import type { TermsEnvelope } from '@youre-on/shared/terms';

import { foldGg, type GgFields } from '../gg/model';
import { emptyOdds, oddsReducer, type OddsState } from '../app/odds';
import type { EndReason, LockEvent } from './lock';

export interface AttemptInfo {
  attempt_no: number;
  performer: Party;
  max_ms: number;
  recorder_device_id: string;
  go_at: string;
}

export interface BetModel {
  bet_id: string;
  lastSeq: number;
  state: BetState | null;
  onchain_status: OnchainStatus | null;
  chain_ack: ChainAck;
  pending_tx: PendingTx | null;
  my_party: Party | null;
  party_a: UserRef | null;
  party_b: UserRef | null;
  room_id: string | null;
  /** B's invite (bet.invited), and B's answer once given. */
  challenger: UserRef | null;
  inviteAnswer: 'accepted' | 'declined' | null;
  envelope: TermsEnvelope | null;
  authorizeRequest: AuthorizeRequest | null;
  /** The lock request's terms differ from the last proposed terms: refuse to sign. */
  termsMismatch: boolean;
  authorized: { A: boolean; B: boolean };
  attempt: AttemptInfo | null;
  /** The latest attempt number (snapshot attempt_no or attempt.started). */
  lastAttemptNo: number | null;
  redo_count: number;
  ruling: { ruling: Ruling | HearingRuling; ruling_hash: string } | null;
  signRequests: { concede: SignRequest | null; appeal: SignRequest | null };
  appeal_deadline: number | null;
  payout: { to_a: MicroUsdc; to_b: MicroUsdc } | null;
  end_reason: string | null;
  lockFailed: boolean;
  /** Caption lines from judge.line / party.line (final ones replace partials by utterance). */
  lines: readonly { id: string; who: 'judge' | 'a' | 'b'; text: string }[];
  lastCue: { cue: string; text: string; speak: boolean } | null;
  /** Gemini bets: the latest market.tick of the bet's contract (the live price). */
  market: GeminiMarketSnapshot | null;
  /** Gemini bets: Gemini's settled result (market.settled), the ruling's evidence. */
  settlement: GeminiSettlementRecord | null;
  /** Beat 5: the panel's votes as they stream in (appeal.vote), by seat. */
  appealVotes: readonly AppealVote[];
  /** Beat 5: the panel's decision (appeal.result, or BetSnapshot.appeal on a resync). */
  appealResult: AppealResult | null;
  /** The GG moment (bet.gg) and the spoken review request (review.*): ../gg/model. */
  gg: GgFields['gg'];
  review: GgFields['review'];
  /** Odds offers and agreement (odds.* events, app/odds). */
  odds: OddsState;
  /** Dance Off: the server's re-scored round and Claude's check (dance.scored), with the ruling. */
  danceScored: DanceScoredPayload | null;
  /** Double or nothing (bet.invited rematch_of, or this phone's rematch): the bet it follows. */
  rematchOf: string | null;
  /** Double or nothing: the stake (dollars per side) the pickers default to. */
  suggestedStakeUsd: number | null;
  /** "Call it off" (bet.call_off): the latest request step, ../app/callOff reads it. */
  callOff: CallOffPayload | null;
}

export const emptyBet = (bet_id: string, my_party: Party | null = null): BetModel => ({
  bet_id,
  lastSeq: 0,
  state: null,
  onchain_status: null,
  chain_ack: 'none',
  pending_tx: null,
  my_party,
  party_a: null,
  party_b: null,
  room_id: null,
  challenger: null,
  inviteAnswer: null,
  envelope: null,
  authorizeRequest: null,
  termsMismatch: false,
  authorized: { A: false, B: false },
  attempt: null,
  lastAttemptNo: null,
  redo_count: 0,
  ruling: null,
  signRequests: { concede: null, appeal: null },
  appeal_deadline: null,
  payout: null,
  end_reason: null,
  lockFailed: false,
  lines: [],
  lastCue: null,
  market: null,
  settlement: null,
  appealVotes: [],
  appealResult: null,
  gg: null,
  review: null,
  odds: emptyOdds,
  danceScored: null,
  rematchOf: null,
  suggestedStakeUsd: null,
  callOff: null,
});

export function fromSnapshot(s: BetSnapshot, prev?: BetModel): BetModel {
  const base = prev ?? emptyBet(s.bet_id, s.my_party);
  return {
    ...base,
    lastSeq: Math.max(base.lastSeq, s.last_seq),
    state: s.state,
    onchain_status: s.onchain_status,
    chain_ack: s.chain_ack,
    pending_tx: s.pending_tx,
    my_party: s.my_party ?? base.my_party,
    party_a: s.party_a,
    party_b: s.party_b,
    room_id: s.room_id,
    envelope: s.envelope ?? base.envelope,
    authorized: { A: s.authorizations.A !== null, B: s.authorizations.B !== null },
    attempt: base.attempt,
    lastAttemptNo: s.attempt_no ?? base.lastAttemptNo,
    redo_count: s.redo_count,
    ruling: s.latest_ruling ?? base.ruling,
    appeal_deadline: s.deadlines.appeal_deadline,
    payout: s.payout,
    end_reason: s.end_reason,
    appealResult: s.appeal ?? base.appealResult,
    appealVotes: s.appeal ? s.appeal.votes : base.appealVotes,
  };
}

const who = (p: Party): 'a' | 'b' => (p === 'A' ? 'a' : 'b');

export function upsertLine(
  lines: BetModel['lines'],
  id: string,
  w: 'judge' | 'a' | 'b',
  text: string,
) {
  const i = lines.findIndex((l) => l.id === id);
  if (i < 0) return [...lines, { id, who: w, text }].slice(-40);
  const next = lines.slice();
  next[i] = { id, who: w, text };
  return next;
}

/** Folds one event (already in seq order) into the model. */
export function applyBetEvent(m: BetModel, e: RealtimeEvent): BetModel {
  const base = { ...m, lastSeq: Math.max(m.lastSeq, e.seq) };
  switch (e.type) {
    case 'bet.invited':
      return {
        ...base,
        challenger: e.payload.challenger,
        room_id: e.payload.room_id,
        my_party: m.my_party ?? 'B',
        rematchOf: e.payload.rematch_of ?? m.rematchOf,
        suggestedStakeUsd: e.payload.suggested_stake_usd ?? m.suggestedStakeUsd,
      };
    case 'bet.invite_answered':
      return { ...base, inviteAnswer: e.payload.answer };
    case 'bet.state': {
      const p = e.payload;
      const next: BetModel = {
        ...base,
        state: p.state,
        onchain_status: p.onchain_status,
        chain_ack: p.chain_ack,
        pending_tx: p.pending_tx,
        end_reason: p.reason ?? base.end_reason,
      };
      // A new attempt after REDO clears the last ruling's screen (and a dance round's score).
      if (p.state === 'ATTEMPT' && m.state !== 'ATTEMPT') {
        next.ruling = null;
        next.danceScored = null;
      }
      return { ...next, ...foldGg(m, e) };
    }
    case 'terms.proposed': {
      const changed =
        m.envelope !== null && m.envelope.terms_hash !== e.payload.envelope.terms_hash;
      return {
        ...base,
        envelope: e.payload.envelope,
        termsMismatch:
          m.authorizeRequest !== null &&
          m.authorizeRequest.envelope.terms_hash !== e.payload.envelope.terms_hash,
        // A revision after a lock request was built voids that request (SCHEMAS §9.2).
        authorizeRequest: changed ? null : m.authorizeRequest,
      };
    }
    case 'terms.authorize_request':
      return {
        ...base,
        authorizeRequest: e.payload,
        termsMismatch:
          m.envelope !== null && m.envelope.terms_hash !== e.payload.envelope.terms_hash,
        envelope: m.envelope ?? e.payload.envelope,
        authorized: { A: false, B: false },
        lockFailed: false,
      };
    case 'terms.authorized':
      return { ...base, authorized: { ...m.authorized, [e.payload.party]: true } };
    case 'terms.declined':
      return { ...base, end_reason: 'declined' };
    case 'tx.sign_request': {
      const r = e.payload.request;
      return { ...base, signRequests: { ...m.signRequests, [r.kind]: r } };
    }
    case 'tx.failed':
      return e.payload.kind === 'atomic_lock' ? { ...base, lockFailed: true } : base;
    case 'judge.line':
      return {
        ...base,
        lines: upsertLine(m.lines, e.payload.utterance_id, 'judge', e.payload.text),
      };
    case 'party.line':
      return {
        ...base,
        lines: upsertLine(m.lines, e.payload.utterance_id, who(e.payload.party), e.payload.text),
      };
    case 'judge.cue':
      return { ...base, lastCue: e.payload };
    case 'attempt.started': {
      const p = e.payload;
      return {
        ...base,
        attempt: {
          attempt_no: p.attempt_no,
          performer: p.performer,
          max_ms: p.max_ms,
          recorder_device_id: p.recorder_device_id,
          go_at: p.go_at,
        },
        lastAttemptNo: p.attempt_no,
        ruling: null,
      };
    }
    case 'ruling.issued':
      return {
        ...base,
        ruling: e.payload,
        redo_count: e.payload.ruling.outcome === 'REDO' ? m.redo_count + 1 : m.redo_count,
      };
    case 'chain.BetResolved':
      return { ...base, appeal_deadline: Number(e.payload.appeal_deadline) || m.appeal_deadline };
    case 'market.tick':
      return { ...base, market: e.payload.snapshot };
    case 'market.settled':
      return { ...base, settlement: e.payload.record };
    case 'dance.scored':
      return { ...base, danceScored: e.payload };
    case 'bet.call_off':
      return { ...base, callOff: e.payload };
    case 'appeal.vote': {
      const v = e.payload.vote;
      const votes = [...m.appealVotes.filter((x) => x.seat !== v.seat), v];
      return { ...base, appealVotes: votes.sort((a, b) => a.seat - b.seat) };
    }
    case 'appeal.result':
      return { ...base, appealResult: e.payload.result, appealVotes: e.payload.result.votes };
    // ../gg/model: bet.gg, the review request and its close, an appeal confirming the review.
    case 'bet.gg':
    case 'review.requested':
    case 'review.closed':
    case 'tx.submitted':
      return { ...base, ...foldGg(m, e) };
    case 'odds.offered':
    case 'odds.answered':
    case 'odds.agreed':
      return { ...base, odds: oddsReducer(m.odds, e) };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------------------
// Lock card signals (feeds ./lock lockReducer)
// ---------------------------------------------------------------------------------------

export function endReasonOf(m: Pick<BetModel, 'state' | 'end_reason' | 'lockFailed'>): EndReason {
  if (m.lockFailed) return 'lock_failed';
  if (m.state === 'EXPIRED') return 'expired';
  const r = m.end_reason ?? '';
  if (r === 'declined') return 'declined';
  if (r.includes('timeout') || r.includes('expired')) return 'expired';
  if (r.includes('terms') || r.includes('supersed')) return 'terms_changed';
  if (r.includes('lock') || r.includes('fund') || r.includes('preflight')) return 'lock_failed';
  return 'declined';
}

/** The lock-card events one realtime event implies for this phone. */
export function lockSignals(
  before: BetModel,
  after: BetModel,
  e: RealtimeEvent,
  me: Party,
): LockEvent[] {
  switch (e.type) {
    case 'terms.authorize_request':
      return [{ type: 'reset' }];
    case 'terms.authorized':
      return e.payload.party === me ? [] : [{ type: 'their_signature' }];
    case 'terms.declined':
      return [{ type: 'end', reason: 'declined' }];
    case 'terms.proposed':
      return before.authorizeRequest !== null && after.authorizeRequest === null
        ? [{ type: 'end', reason: 'terms_changed' }]
        : [];
    case 'tx.failed':
      return e.payload.kind === 'atomic_lock' ? [{ type: 'end', reason: 'lock_failed' }] : [];
    case 'bet.state': {
      const s = e.payload.state;
      if (s === 'AWAITING_LOCK') return [{ type: 'submitted' }];
      // The custodial path: the server signed for both and just pushes LOCKED.
      if (s === 'LOCKED' && before.state !== 'LOCKED')
        return [{ type: 'submitted' }, { type: 'confirmed' }];
      if (s === 'CANCELLED' || s === 'EXPIRED')
        return [{ type: 'end', reason: endReasonOf(after) }];
      return [];
    }
    default:
      return [];
  }
}

/** The bet was appealed (votes or a result on this phone): the appeal screen has something to show. */
export const isAppealed = (m: Pick<BetModel, 'appealVotes' | 'appealResult'>): boolean =>
  m.appealResult !== null || m.appealVotes.length > 0;

/** The outcome that pays: the panel's when there was one, else the ruling's (null before). */
export function finalOutcome(m: Pick<BetModel, 'appealResult' | 'ruling'>) {
  return m.appealResult?.final_outcome ?? m.ruling?.ruling.outcome ?? null;
}

/** Payout amount for this phone (micro-USDC), from the snapshot's payout or the Terms pot. */
export function myPayout(m: BetModel): bigint | null {
  if (!m.payout || !m.my_party) return null;
  return BigInt(m.my_party === 'A' ? m.payout.to_a : m.payout.to_b);
}
