// Where the focused bet is in the demo's arc, for the phase rail across the top of the stage and
// for which "moment" the big panel shows: Challenge -> Terms -> Lock -> Attempt (or Market) ->
// Ruling -> Paid. Derived from both the server state and the events folded so far, taking the
// furthest of the two, so a lagging bet.state or a cold-start snapshot never moves it backwards.
import type { BetView } from './ticker';

export const PHASES = ['challenge', 'terms', 'lock', 'play', 'ruling', 'paid'] as const;
export type PhaseKey = (typeof PHASES)[number];

const STATE_PHASE: Record<string, PhaseKey> = {
  DRAFTING: 'challenge',
  TERMS_PROPOSED: 'terms',
  AWAITING_AUTHORIZATIONS: 'lock',
  AWAITING_LOCK: 'lock',
  LOCKED: 'play',
  ATTEMPT: 'play',
  JUDGING: 'play',
  AWAITING_MARKET: 'play',
  HEARING: 'ruling',
  RULED: 'ruling',
  CONCEDED: 'ruling',
  FINALIZED: 'ruling',
  APPEALED: 'ruling',
  APPEAL_RESOLVED: 'ruling',
  PAID: 'paid',
  VOIDED: 'paid',
};

const idx = (p: PhaseKey) => PHASES.indexOf(p);

export const isMarketBet = (b: BetView): boolean => !!b.envelope?.terms.market;
export const isDecisiveOrVoid = (o: string | undefined): boolean =>
  o === 'A_WINS' || o === 'B_WINS' || o === 'VOID';

/** The bet ended without (or before) a payout: CANCELLED / EXPIRED. */
export function endedEarly(b: BetView): 'cancelled' | 'expired' | null {
  if (b.payout) return null;
  if (b.state === 'CANCELLED') return 'cancelled';
  if (b.state === 'EXPIRED') return 'expired';
  return null;
}

function fieldPhase(b: BetView): PhaseKey {
  if (b.payout) return 'paid';
  if (isDecisiveOrVoid(b.ruling?.outcome) || b.appealed || b.hearing) return 'ruling';
  if (b.lock && (b.lock.status === 'confirmed' || b.lock.onchain)) return 'play';
  if (b.lock || b.auth_count > 0 || b.auth.A || b.auth.B || b.declined) return 'lock';
  if (b.envelope) return 'terms';
  // the voice judge is talking (DRAFTING): the challenge was accepted, terms are being set
  if (b.invite === 'accepted' || b.last_judge_line) return 'terms';
  return 'challenge';
}

export function phaseOf(b: BetView): PhaseKey {
  const fromState = b.state ? STATE_PHASE[b.state] : undefined;
  const fromFields = fieldPhase(b);
  return fromState && idx(fromState) > idx(fromFields) ? fromState : fromFields;
}

export interface PhaseStep {
  key: PhaseKey;
  label: string;
  status: 'done' | 'current' | 'todo' | 'failed';
}

export function phaseSteps(b: BetView | null): PhaseStep[] {
  const market = b ? isMarketBet(b) : false;
  const refund =
    b?.ruling?.outcome === 'VOID' ||
    b?.state === 'VOIDED' ||
    b?.payout?.event === 'BetRefunded' ||
    b?.payout?.event === 'BetCancelled';
  const label: Record<PhaseKey, string> = {
    challenge: 'Challenge',
    terms: 'Terms',
    lock: 'Lock',
    play: market ? 'Market' : 'Attempt',
    ruling: 'Ruling',
    paid: refund ? 'Refund' : 'Paid',
  };
  if (!b) return PHASES.map((key) => ({ key, label: label[key], status: 'todo' }));
  const at = idx(phaseOf(b));
  const ended = endedEarly(b);
  return PHASES.map((key, i) => ({
    key,
    label: ended && i === at ? (ended === 'cancelled' ? 'Cancelled' : 'Expired') : label[key],
    status:
      i < at || (i === at && key === 'paid')
        ? 'done'
        : i === at
          ? ended
            ? 'failed'
            : 'current'
          : 'todo',
  }));
}
