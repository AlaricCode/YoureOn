// Odds between the two parties (packages/shared/src/odds.ts).
//
// The terms card stays the only binding record; its stakes.a / stakes.b are the odds. An odds
// offer is a consent object in the bet's event log (odds.offered / odds.answered / odds.agreed),
// folded by the shared foldOdds() here, on the phones and on the stage. Rules:
//   R1 autoOffer()   a composed skill card with unequal stakes that are not yet agreed opens an
//                    offer (from A for typed terms, from the judge for voice/demo terms), unless
//                    the open offer already has those stakes; a differing open offer is closed
//                    as R3 says. Equal-stake cards open nothing; market (Gemini) cards are exempt.
//   R2               offers only in TERMS_PROPOSED, except the judge's suggestion in DRAFTING
//                    (voice suggest_odds or A's Suggest button): terms_hash null, and accepting
//                    it needs TERMS_PROPOSED.
//   R3 newOffer()    one open offer: your own open offer is superseded (parent kept), anyone
//                    else's is countered (parent = it).
//   R4 accept        (acceptOdds, ./flow.ts) an A/B offer: the other party; a judge offer: both,
//                    one tap each.
//   R5 agree         both accepted: if the card's stakes differ, recompose the card with them (a
//                    new version and hash, in the same transaction), then odds.agreed + a cue.
//   R6 withdraw      (withdrawOdds, ./flow.ts) the author withdraws an open offer (either party
//                    may dismiss the judge's).
//   R7 oddsGate()    confirm is refused (ODDS_PENDING) while unequal skill stakes are not agreed
//                    or any offer is open.
//   R8               after the freeze the phone routes answer 409 "Terms are locked in." and the
//                    suggest_odds webhook answers 200 {ok: false, fix: 'NOT_DRAFTING'}.
// Every transaction locks the bet row (lockBet), so concurrent offers / accepts serialize.
// Spec: docs/planning/API-CONTRACT.md §2.19.
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, like, sql } from 'drizzle-orm';
import { auditLog, betEvents, users } from '@youre-on/db';
import type { BetState } from '@youre-on/shared/bet-state';
import type { JudgeCueName } from '@youre-on/shared/api';
import { formatUsd } from '@youre-on/shared/money';
import {
  agreedFor,
  foldOdds,
  type OddsFrom,
  type OddsOffer,
  type OddsState,
  type OddsSuggestion,
} from '@youre-on/shared/odds';
import { favoredParty, ratioLabel } from '@youre-on/shared/odds-math';
import { numberWords } from '@youre-on/shared/judge/reply';
import type { Party } from '@youre-on/shared/primitives';
import type { Terms, TermsEnvelope } from '@youre-on/shared/terms';
import { asciiFold, judgeCue } from '../bets/cues';
import { CONFIRM_REFUSED_ACTION } from '../bets/invite';
import type { BetRow } from '../bets/snapshot';
import { HttpError } from '../errors';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { fanout, iso, type Tx } from '../lock/common';
import type { TermsDeps } from '../lock/terms';

/** The states in which the terms are still open; in any other, assertOddsState throws 409 (R8). */
const OPEN_STATES: readonly BetState[] = ['DRAFTING', 'TERMS_PROPOSED'];

export const isOddsTerms = (t: Terms): boolean => t.type === 'skill' && t.market === null;

/** The bet's odds.* events, folded. */
export async function foldFromLog(db: Pick<Tx, 'select'>, betId: string): Promise<OddsState> {
  const rows = await db
    .select({ type: betEvents.type, envelope: betEvents.envelope })
    .from(betEvents)
    .where(and(eq(betEvents.bet_id, betId), like(betEvents.type, 'odds.%')))
    .orderBy(asc(betEvents.seq));
  return foldOdds(
    rows.map((r) => ({ type: r.type, payload: (r.envelope as { payload?: unknown }).payload })),
  );
}

/** Display names by user id (no wallet needed, unlike loadUserRefs). */
export async function displayNames(
  db: Pick<Tx, 'select'>,
  bet: Pick<BetRow, 'party_a_id' | 'party_b_id'>,
): Promise<{ A: string; B: string }> {
  const rows = await db
    .select({ id: users.id, name: users.display_name })
    .from(users)
    .where(sql`${users.id} IN (${bet.party_a_id}, ${bet.party_b_id})`);
  const by = new Map(rows.map((r) => [r.id, r.name]));
  return { A: by.get(bet.party_a_id) ?? 'Player A', B: by.get(bet.party_b_id) ?? 'Player B' };
}

const sameStakes = (x: { a: string; b: string }, y: { a: string; b: string }) =>
  x.a === y.a && x.b === y.b;

/** "fifteen" / "$7.50" (cue text). */
const words = (micro: string): string => {
  const n = BigInt(micro);
  return n % 1_000_000n === 0n && n / 1_000_000n <= 99n
    ? numberWords(Number(n / 1_000_000n))
    : formatUsd(micro);
};

// ---- offers ------------------------------------------------------------------------------------

export interface NewOfferInput {
  from: OddsFrom;
  stakes: { a: string; b: string };
  termsHash: string | null;
  suggestion?: OddsSuggestion | null;
  now: number;
  /** Who is counted as answering a closed offer when the new one is the judge's. */
  actor?: Party;
}

/** R3: closes the open offer (superseded / countered) and appends the new one. */
export async function newOffer(
  tx: Tx,
  betId: string,
  fold: OddsState,
  i: NewOfferInput,
): Promise<{ offer: OddsOffer; envs: BetEventEnvelope[]; countered: OddsOffer | null }> {
  const open = fold.open;
  const offerId = randomUUID();
  const envs: BetEventEnvelope[] = [];
  let parent: string | null = null;
  let countered: OddsOffer | null = null;
  if (open) {
    const own = i.from !== 'judge' && open.from === i.from;
    const sameJudge = i.from === 'judge' && open.from === 'judge';
    const answer = own || sameJudge ? 'superseded' : 'countered';
    parent = own ? open.parent_id : sameJudge ? open.parent_id : open.offer_id;
    if (answer === 'countered') countered = open;
    envs.push(
      await appendBetEvent(tx, {
        bet_id: betId,
        type: 'odds.answered',
        payload: {
          offer_id: open.offer_id,
          party: i.from === 'judge' ? (i.actor ?? 'A') : i.from,
          answer,
          by_offer_id: offerId,
        },
        now: i.now,
      }),
    );
  }
  const offer: OddsOffer = {
    offer_id: offerId,
    n: fold.count + 1,
    parent_id: parent,
    from: i.from,
    stakes: { a: i.stakes.a, b: i.stakes.b },
    ratio_label: ratioLabel(i.stakes.a, i.stakes.b).slice(0, 16),
    favored: favoredParty(i.stakes.a, i.stakes.b),
    terms_hash: i.termsHash,
    suggestion: i.suggestion ?? null,
    created_at: iso(i.now),
  };
  envs.push(
    await appendBetEvent(tx, {
      bet_id: betId,
      type: 'odds.offered',
      payload: { offer },
      now: i.now,
    }),
  );
  return { offer, envs, countered };
}

/**
 * ODDS_OFFERED / ODDS_COUNTERED for a new offer: spoken when `speak` (an offer from a phone, which
 * the judge did not say), else only context for a voice judge that already read it back.
 */
export function offerCue(
  name: Extract<JudgeCueName, 'ODDS_OFFERED' | 'ODDS_COUNTERED'>,
  offer: OddsOffer,
  names: { A: string; B: string },
  speak: boolean,
) {
  const by = offer.from === 'judge' ? 'The judge' : names[offer.from];
  const other = offer.from === 'judge' ? 'both' : offer.from === 'A' ? names.B : names.A;
  const ratio = offer.ratio_label === 'Even' ? 'even money' : offer.ratio_label;
  const stakes = `${asciiFold(names.A)} ${words(offer.stakes.a)}, ${asciiFold(names.B)} ${words(offer.stakes.b)}`;
  const verb =
    name === 'ODDS_COUNTERED' ? 'counters at' : offer.from === 'judge' ? 'suggests' : 'offers';
  const instruction = speak
    ? `Say ${asciiFold(by)} ${verb} ${ratio}: ${stakes}. ${other === 'both' ? 'Both tap Accept or Counter on their phones.' : `${asciiFold(other)} taps Accept or Counter.`}`
    : `Odds on the table: ${stakes}. Both must tap Accept on their phones; do not call confirm_terms before [EVENT] ODDS_AGREED.`;
  return judgeCue(name, { name: by, ratio }, instruction, speak);
}

/**
 * R1, called by persistInTx right after a skill card is composed (inside its transaction).
 * Returns the events to fan out.
 */
export async function autoOffer(
  deps: Pick<TermsDeps, 'log'>,
  tx: Tx,
  bet: Pick<BetRow, 'id' | 'party_a_id' | 'party_b_id'>,
  envelope: TermsEnvelope,
  o: { from: OddsFrom; now: number; source: string },
): Promise<BetEventEnvelope[]> {
  const t = envelope.terms;
  if (!isOddsTerms(t)) return [];
  const stakes = { a: t.stakes.a, b: t.stakes.b };
  if (stakes.a === stakes.b) return [];
  const fold = await foldFromLog(tx, bet.id);
  if (fold.open && sameStakes(fold.open.stakes, stakes)) return [];
  if (agreedFor(fold, stakes)) return [];
  const { offer, envs } = await newOffer(tx, bet.id, fold, {
    from: o.from,
    stakes,
    termsHash: envelope.terms_hash,
    now: o.now,
  });
  // Typed terms come from A's phone: the host judge (if any) announces them. The voice judge
  // already read the stakes back (its propose_terms reply says to tap Accept): only inform it.
  const names = { A: t.party_a.display_name, B: t.party_b.display_name };
  const speak = o.from !== 'judge';
  envs.push(
    await appendBetEvent(tx, {
      bet_id: bet.id,
      type: 'judge.cue',
      payload: offerCue('ODDS_OFFERED', offer, names, speak),
      now: o.now,
    }),
  );
  deps.log.info('odds.auto_offer', { bet_id: bet.id, n: offer.n, from: o.from, source: o.source });
  return envs;
}

/** R7: the confirm gate, under the row lock. true = refuse (ODDS_PENDING). */
export async function oddsGate(tx: Tx, betId: string, t: Terms): Promise<boolean> {
  if (!isOddsTerms(t)) return false;
  const fold = await foldFromLog(tx, betId);
  if (fold.open) return true;
  return t.stakes.a !== t.stakes.b && !agreedFor(fold, { a: t.stakes.a, b: t.stakes.b });
}

/**
 * The audit row for a confirm refused ODDS_PENDING (mirrors bets/invite.ts recordInvitePending).
 */
export async function recordOddsPending(
  tx: Tx,
  o: {
    betId: string;
    termsHash: string | null;
    actor: 'judge' | 'system' | 'user';
    actorUserId?: string | undefined;
    requestId?: string | undefined;
    heard?: string | undefined;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actor_kind: o.actor,
    actor_user_id: o.actorUserId ?? null,
    action: CONFIRM_REFUSED_ACTION,
    bet_id: o.betId,
    request_id: o.requestId ?? null,
    details: { reason: 'odds_pending', terms_hash: o.termsHash, heard: o.heard ?? null },
  });
}

/** Did the voice judge's confirm_terms get refused ODDS_PENDING since `sinceIso`? */
export async function judgeAwaitsOdds(tx: Tx, betId: string, sinceIso: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.bet_id, betId),
        eq(auditLog.action, CONFIRM_REFUSED_ACTION),
        eq(auditLog.actor_kind, 'judge'),
        sql`${auditLog.details}->>'reason' = 'odds_pending'`,
        gte(auditLog.at, new Date(Date.parse(sinceIso) - 60_000)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ---- shared by the route bodies (./flow.ts, ./suggest.ts) ---------------------------------------

export const LOCKED_IN = 'Terms are locked in.';

/** 409s shared by the routes. */
export function assertOddsState(bet: BetRow, o: { allowDrafting?: boolean } = {}): void {
  if (!OPEN_STATES.includes(bet.state))
    throw new HttpError('INVALID_STATE', LOCKED_IN, { state: bet.state, reason: 'locked' });
  if (bet.state === 'DRAFTING' && !o.allowDrafting)
    throw new HttpError('INVALID_STATE', 'No terms on the card yet.', {
      state: bet.state,
      reason: 'no_terms',
    });
  if (bet.evidence_source === 'gemini' || bet.gemini_market_id !== null)
    throw new HttpError('INVALID_STATE', 'Gemini sets the odds on this one.', {
      reason: 'market_bet',
    });
}

export function publish(deps: Pick<TermsDeps, 'hub'>, bet: BetRow, envs: BetEventEnvelope[]) {
  if (envs.length) fanout(deps, bet, envs);
}

export { sameStakes, words as stakeWords };
