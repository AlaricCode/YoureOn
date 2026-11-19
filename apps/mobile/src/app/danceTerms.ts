// "Dance off" (docs/planning/DANCE-OFF.md §1, §6.2) on A's negotiate screen: one of the bundled
// routines and an even stake. A pure reducer for the panel plus the call over injected deps,
// tested in node (the market panel's shape, app/marketTerms, without the quote polling):
//   submit   POST /v1/bets/:id/terms/dance {routine_id, amount_usd}: the server builds the
//            projection (danceTermsArgs) and proposes; the card arrives by the terms.proposed push.
//   confirm  "Lock it in" -> the same POST /v1/bets/:id/terms/confirm as the typed form
//            (app/typedTerms confirmTypedTerms).
//
//   closed ──open──▶ browsing ──submit──▶ sending ──proposed──▶ sent ──confirm──▶ confirming ──▶ confirmed
//            ▲          ▲  ▲                  │ refused / error          │ failed
//            └─close────┘  └── routine / stake / note ◀────────────────────┘
import { danceClaim, isDanceOff, parseDanceTermsRoutine } from '@youre-on/shared/dance/terms';
import { ROUTINES, getRoutine } from '@youre-on/shared/dance/routine';
import { DANCE_STAKES_USD } from '@youre-on/shared/judge/dance-terms';
import { parseUsd } from '@youre-on/shared/money';
import type { TermsEnvelope } from '@youre-on/shared/terms';

import type { YoApi } from '../net/api';
import { ApiClientError } from '../net/signedFetch';
import { COPY, t } from '../screens/copy';
import { isCopyOk } from '../ui/copyRule';

export { DANCE_STAKES_USD };

/** $5 each: enough to care, small enough for the demo accounts. */
export const DEFAULT_DANCE_STAKE_USD = 5;

/** One routine card on the panel (the bundled registry, shared dance/routine). */
export interface DanceRoutineChoice {
  id: string;
  title: string;
  song: string;
  bpm: number;
}

/**
 * The routine cards, straight from the bundled registry, so the panel offers exactly the
 * routines the server (and the scorer) can bind into Terms. Pure: no native code.
 */
export const DANCE_ROUTINE_CHOICES: readonly DanceRoutineChoice[] = ROUTINES.map((r) => ({
  id: r.id,
  title: r.title,
  song: r.song,
  bpm: r.bpm,
}));

const FIRST_ROUTINE = DANCE_ROUTINE_CHOICES[0]?.id ?? '';

export type DancePhase = 'closed' | 'browsing' | 'sending' | 'sent' | 'confirming' | 'confirmed';

export interface DanceState {
  bet_id: string | null;
  phase: DancePhase;
  routineId: string;
  /** Dollars per person (even money). */
  stakeUsd: number;
  /** terms_hash of the card this panel proposed. */
  proposedHash: string | null;
  note: string | null;
}

export const initialDance: DanceState = {
  bet_id: null,
  phase: 'closed',
  routineId: FIRST_ROUTINE,
  stakeUsd: DEFAULT_DANCE_STAKE_USD,
  proposedHash: null,
  note: null,
};

/** The dance card already on screen when the panel opens on a bet (a restart mid-bet). */
export interface ShownDanceCard {
  terms_hash: string;
  routineId: string;
  stakeUsd: number;
}

export type SubmitDanceOutcome =
  { kind: 'proposed'; terms_hash: string } | { kind: 'error'; note: string };

export type DanceEvent =
  /**
   * A new bet: reset. With a dance card already shown (a restart) the panel reopens on it, ready
   * to lock; `stakeUsd` (a double or nothing's suggestion) is the stake chip's default.
   */
  | { type: 'init'; bet_id: string; shown?: ShownDanceCard | null; stakeUsd?: number | null }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'routine'; id: string }
  | { type: 'stake'; usd: number }
  | { type: 'submit' }
  | { type: 'submitted'; outcome: SubmitDanceOutcome }
  | { type: 'confirm' }
  | { type: 'confirmed' }
  | { type: 'confirm_failed'; note: string };

const busy = (s: DanceState) => s.phase === 'sending' || s.phase === 'confirming';
const locked = (s: DanceState) => s.phase === 'confirmed';

/** A usable stake: a positive dollar amount in whole cents. */
const validStake = (usd: number | null | undefined): usd is number =>
  typeof usd === 'number' &&
  Number.isFinite(usd) &&
  usd > 0 &&
  Math.abs(Math.round(usd * 100) - usd * 100) < 1e-6;

export function danceReducer(s: DanceState, e: DanceEvent): DanceState {
  switch (e.type) {
    case 'init':
      if (s.bet_id === e.bet_id) return s;
      if (e.shown)
        return {
          ...initialDance,
          bet_id: e.bet_id,
          phase: 'sent',
          routineId: e.shown.routineId,
          stakeUsd: e.shown.stakeUsd,
          proposedHash: e.shown.terms_hash,
        };
      return {
        ...initialDance,
        bet_id: e.bet_id,
        stakeUsd: validStake(e.stakeUsd) ? e.stakeUsd : DEFAULT_DANCE_STAKE_USD,
      };
    case 'open':
      // Back on the card this panel already sent (closed over it), else a fresh pick.
      if (s.bet_id === null || s.phase !== 'closed') return s;
      return { ...s, phase: s.proposedHash !== null ? 'sent' : 'browsing' };
    case 'close':
      return busy(s) || locked(s) ? s : { ...s, phase: 'closed', note: null };
    case 'routine':
      if (busy(s) || locked(s) || s.routineId === e.id || !getRoutine(e.id)) return s;
      return { ...s, routineId: e.id, phase: 'browsing', proposedHash: null, note: null };
    case 'stake':
      if (busy(s) || locked(s) || s.stakeUsd === e.usd || !validStake(e.usd)) return s;
      return { ...s, stakeUsd: e.usd, phase: 'browsing', proposedHash: null, note: null };
    case 'submit':
      return canSubmitDance(s) ? { ...s, phase: 'sending', note: null } : s;
    case 'submitted':
      if (s.phase !== 'sending') return s;
      return e.outcome.kind === 'proposed'
        ? { ...s, phase: 'sent', proposedHash: e.outcome.terms_hash, note: null }
        : { ...s, phase: 'browsing', note: e.outcome.note };
    case 'confirm':
      return s.phase === 'sent' ? { ...s, phase: 'confirming', note: null } : s;
    case 'confirmed':
      return s.phase === 'confirming' ? { ...s, phase: 'confirmed' } : s;
    case 'confirm_failed':
      return s.phase === 'confirming' ? { ...s, phase: 'sent', note: e.note } : s;
  }
}

/** The panel is the screen: open, or holding the card it sent. */
export const danceOpen = (s: DanceState): boolean => s.phase !== 'closed';

export const canSubmitDance = (s: DanceState): boolean =>
  s.bet_id !== null && s.phase === 'browsing' && getRoutine(s.routineId) !== null;

/** "Lock it in" for the card this panel proposed, once B accepted the challenge. */
export const canConfirmDance = (
  s: DanceState,
  shownHash: string | null,
  inviteAnswer: 'accepted' | 'declined' | null,
): boolean =>
  (s.phase === 'sent' || s.phase === 'confirming') &&
  shownHash !== null &&
  shownHash === s.proposedHash &&
  inviteAnswer === 'accepted';

export const waitingForAcceptDance = (
  s: DanceState,
  shownHash: string | null,
  inviteAnswer: 'accepted' | 'declined' | null,
): boolean =>
  (s.phase === 'sent' || s.phase === 'confirming') &&
  shownHash !== null &&
  shownHash === s.proposedHash &&
  inviteAnswer !== 'accepted';

/** The dance card on screen (a verified, bundled routine and the even stake), else null. */
export function danceCardOf(
  env: Pick<TermsEnvelope, 'terms' | 'terms_hash'> | null | undefined,
): ShownDanceCard | null {
  if (!env || !isDanceOff(env.terms) || env.terms.stakes.a !== env.terms.stakes.b) return null;
  const r = parseDanceTermsRoutine(env.terms);
  if (!r.ok) return null;
  const micro = BigInt(env.terms.stakes.a);
  // Whole cents only (the Stake schema guarantees it); dollars for the chip.
  const usd = Number(micro / 10_000n) / 100;
  return { terms_hash: env.terms_hash, routineId: r.routine_id, stakeUsd: usd };
}

/** "5", "2.50": the request's amount_usd for a dollar figure in whole cents. */
export const amountUsd = (usd: number): string =>
  Number.isInteger(usd) ? String(usd) : usd.toFixed(2);

/**
 * The stake chips: the dance stakes, plus a double or nothing's suggestion when the chips don't
 * already offer it (sorted), so the suggested stake is always one tap.
 */
export function stakeChips(chips: readonly number[], suggested?: number | null): number[] {
  const out = [...chips];
  if (validStake(suggested) && !out.includes(suggested)) out.push(suggested);
  return out.sort((a, b) => a - b);
}

/**
 * The claim the card will read, as the server composes it (shared danceClaim), for the panel's
 * preview: "Dance Off: Wave Pop, 15 seconds, higher match score wins, $5 each". null for a
 * routine that is not bundled or a stake that is not an amount.
 */
export function danceClaimPreview(routineId: string, stakeUsd: number): string | null {
  const r = getRoutine(routineId);
  if (!r) return null;
  try {
    return danceClaim(r, parseUsd(amountUsd(stakeUsd)));
  } catch {
    return null;
  }
}

/** Server text on a party screen passes the copy rule, or a short fallback shows instead. */
const noteOf = (say: string | null | undefined): string =>
  say && isCopyOk(say, 'body') ? say : t(COPY.app.failed);

function errorNote(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'NETWORK') return t(COPY.app.offline);
    if (e.code === 'NOT_FOUND') return t(COPY.dance.unknownRoutine);
    if (e.code === 'INVALID_STATE' && e.details?.reason === 'invite_pending')
      return noteOf('They have not accepted yet.');
  }
  return t(COPY.app.failed);
}

export async function submitDanceTerms(
  d: { api: Pick<YoApi, 'proposeDanceTerms'> },
  i: { betId: string; routineId: string; stakeUsd: number },
): Promise<SubmitDanceOutcome> {
  try {
    const r = await d.api.proposeDanceTerms(i.betId, {
      routine_id: i.routineId,
      amount_usd: amountUsd(i.stakeUsd),
    });
    if (r.kind === 'proposed') return { kind: 'proposed', terms_hash: r.terms_hash };
    // A stake the server would not compose (over the cap), or a refusal: its own words.
    return { kind: 'error', note: noteOf(r.say) };
  } catch (e) {
    return { kind: 'error', note: errorNote(e) };
  }
}
