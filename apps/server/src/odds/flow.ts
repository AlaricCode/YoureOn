// The odds route bodies (API-CONTRACT §2.19): offer / accept / withdraw, each one transaction under
// the bet row lock (rules R1–R8 in ./service.ts). Kept apart from ./service.ts, which
// lock/terms.ts imports, because accepting can recompose the card through lock/terms.ts.
import { formatUsd, parseUsd } from '@youre-on/shared/money';
import {
  oddsReducer,
  type OddsOffer,
  type OddsOfferRequest,
  type OddsOfferResponse,
} from '@youre-on/shared/odds';
import { checkOddsStakes, stakesFor } from '@youre-on/shared/odds-math';
import type { Party } from '@youre-on/shared/primitives';
import type { TermsProposal } from '@youre-on/shared/negotiation';
import type { AppDeps } from '../context';
import { asciiFold, judgeCue } from '../bets/cues';
import type { BetRow } from '../bets/snapshot';
import { HttpError } from '../errors';
import { lockBet, type Tx } from '../lock/common';
import { loadEnvelope, persistInTx, proposalOf } from '../lock/terms';
import { spendableMicro } from '../me/balance';
import { maxStakeOf } from '../markets/quote';
import { scheduleCompileCurrent } from '../judge/camera-checks';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import {
  assertOddsState,
  displayNames,
  foldFromLog,
  judgeAwaitsOdds,
  newOffer,
  offerCue,
  publish,
  sameStakes,
  stakeWords,
} from './service';

const issueError = (issue: { code: string; message: string }) =>
  new HttpError('VALIDATION_FAILED', issueMessage(issue.code), { issue });

function issueMessage(code: string): string {
  switch (code) {
    case 'ODDS_TOO_LONG':
      return 'Ten to one, tops.';
    case 'STAKE_ABOVE_MAX':
      return 'That stake is over the max.';
    case 'STAKE_BELOW_MIN':
      return 'That stake is under the minimum.';
    default:
      return 'Use dollars and cents, like 7.50.';
  }
}

/** OddsOfferRequest -> concrete stakes (micro strings), validated (422 on a bad pair). */
export function resolveOfferStakes(
  body: OddsOfferRequest,
  maxStake: bigint,
): { a: string; b: string } {
  let a: bigint;
  let b: bigint;
  try {
    if ('stakes_usd' in body) {
      a = BigInt(parseUsd(body.stakes_usd.a));
      b = BigInt(parseUsd(body.stakes_usd.b));
    } else {
      const s = stakesFor({
        ratio: body.ratio,
        favored: body.favored,
        baseMicro: BigInt(parseUsd(body.base_usd)),
        maxStake,
      });
      if ('issue' in s) throw issueError(s.issue);
      a = s.a;
      b = s.b;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw issueError({ code: 'AMBIGUOUS', message: 'not a dollar amount' });
  }
  const issue = checkOddsStakes(a, b, maxStake);
  if (issue) throw issueError(issue);
  return { a: a.toString(), b: b.toString() };
}

/**
 * Soft check (the lock preflight is the hard one): each side can cover its stake. Skipped when a
 * balance is unknown (no chain runtime, RPC down, no wallet).
 */
export async function softBalanceCheck(
  deps: AppDeps,
  bet: Pick<BetRow, 'party_a_id' | 'party_b_id'>,
  stakes: { a: string; b: string },
): Promise<void> {
  const names = await displayNames(deps.db, bet);
  for (const [party, userId, stake] of [
    ['A', bet.party_a_id, stakes.a],
    ['B', bet.party_b_id, stakes.b],
  ] as const) {
    let have: bigint | null;
    try {
      have = await spendableMicro(deps, userId);
    } catch (err) {
      deps.log.warn('odds.balance_check_failed', { err });
      have = null;
    }
    if (have !== null && have < BigInt(stake))
      throw new HttpError(
        'INSUFFICIENT_FUNDS',
        `${names[party]} can't cover ${formatUsd(stake)}.`,
        { party },
      );
  }
}

/** The card must be the bet's current terms (TERMS_PROPOSED). */
async function currentCard(tx: Tx, bet: BetRow) {
  const latest = await loadEnvelope(tx, bet.id);
  if (!latest || !bet.terms_hash || latest.envelope.terms_hash !== bet.terms_hash)
    throw new HttpError('INVALID_STATE', 'No terms on the card yet.', { reason: 'no_terms' });
  return latest;
}

/** POST /v1/bets/:bet_id/odds/offer */
export async function offerOdds(
  deps: AppDeps,
  bet0: BetRow,
  me: Party,
  body: OddsOfferRequest,
): Promise<OddsOfferResponse> {
  assertOddsState(bet0);
  const stakes = resolveOfferStakes(body, maxStakeOf(deps));
  await softBalanceCheck(deps, bet0, stakes);
  const now = deps.now();
  const out = await deps.db.transaction(async (tx) => {
    const bet = (await lockBet(tx, bet0.id))!;
    assertOddsState(bet);
    await currentCard(tx, bet);
    const fold = await foldFromLog(tx, bet.id);
    const { offer, envs, countered } = await newOffer(tx, bet.id, fold, {
      from: me,
      stakes,
      termsHash: bet.terms_hash,
      now,
    });
    const names = await displayNames(tx, bet);
    envs.push(
      await appendBetEvent(tx, {
        bet_id: bet.id,
        type: 'judge.cue',
        payload: offerCue(countered ? 'ODDS_COUNTERED' : 'ODDS_OFFERED', offer, names, true),
        now,
      }),
    );
    return { bet, offer, envs, termsHash: bet.terms_hash };
  });
  publish(deps, out.bet, out.envs);
  deps.log.info('odds.offer', { bet_id: bet0.id, n: out.offer.n, from: me });
  return { offer: out.offer, agreed: false, terms_hash: out.termsHash };
}

type AcceptRefusal = 'not_open' | 'own_offer' | 'stale' | 'already_accepted' | 'no_terms';
const refuse = (reason: AcceptRefusal, message: string) =>
  new HttpError('INVALID_STATE', message, { reason });

function checkAccept(
  fold: Awaited<ReturnType<typeof foldFromLog>>,
  offerId: string,
  n: number,
  me: Party,
): OddsOffer {
  const open = fold.open;
  if (!open || open.offer_id !== offerId) throw refuse('not_open', 'That offer is closed.');
  if (open.n !== n) throw refuse('stale', 'The odds changed. Look again.');
  if (open.from === me) throw refuse('own_offer', "That's your own offer.");
  if (fold.accepted_by.includes(me)) throw refuse('already_accepted', 'You already accepted.');
  return open;
}

/** POST /v1/bets/:bet_id/odds/:offer_id/accept {n} */
export async function acceptOdds(
  deps: AppDeps,
  bet0: BetRow,
  me: Party,
  offerId: string,
  n: number,
  o: { requestId?: string } = {},
): Promise<OddsOfferResponse> {
  assertOddsState(bet0, { allowDrafting: true });
  // Pre-read for the balance soft check (RPC off the row lock); re-checked under it.
  const pre = checkAccept(await foldFromLog(deps.db, bet0.id), offerId, n, me);
  if (bet0.state === 'DRAFTING') throw refuse('no_terms', 'No terms on the card yet.');
  await softBalanceCheck(deps, bet0, pre.stakes);
  const now = deps.now();
  const out = await deps.db.transaction(async (tx) => {
    const bet = (await lockBet(tx, bet0.id))!;
    assertOddsState(bet, { allowDrafting: true });
    if (bet.state === 'DRAFTING') throw refuse('no_terms', 'No terms on the card yet.');
    const fold = await foldFromLog(tx, bet.id);
    const offer = checkAccept(fold, offerId, n, me);
    const latest = await currentCard(tx, bet);
    const envs: BetEventEnvelope[] = [];
    const answered = {
      offer_id: offer.offer_id,
      party: me,
      answer: 'accepted' as const,
      by_offer_id: null,
    };
    envs.push(
      await appendBetEvent(tx, { bet_id: bet.id, type: 'odds.answered', payload: answered, now }),
    );
    const after = oddsReducer(fold, { type: 'odds.answered', payload: answered });
    if (!after.agreed.some((x) => x.offer_id === offer.offer_id))
      return { bet, offer, envs, agreed: false, termsHash: bet.terms_hash };

    // R5: both accepted. Recompose the card when its stakes differ, in this transaction.
    let termsHash = latest.envelope.terms_hash;
    const t = latest.envelope.terms;
    if (!sameStakes({ a: t.stakes.a, b: t.stakes.b }, offer.stakes)) {
      const minutes = Math.round((Date.parse(t.deadline) - Date.parse(t.created_at)) / 60_000);
      const proposal: TermsProposal = {
        ...proposalOf(t),
        amount: offer.stakes.a,
        amount_b: offer.stakes.a === offer.stakes.b ? null : offer.stakes.b,
        deadline_minutes: Math.min(45, Math.max(1, minutes)),
      };
      const r = await persistInTx(
        deps,
        tx,
        bet.id,
        { kind: 'proposal', proposal, missing: [] },
        {
          source: 'odds',
          draftedBy: offer.from === 'judge' ? 'judge' : me === 'A' ? 'party_a' : 'party_b',
          ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
        },
      );
      if (r.res.kind !== 'proposed')
        throw new HttpError('INVALID_STATE', "Those odds don't fit the card.", {
          reason: 'recompose_failed',
        });
      termsHash = r.res.envelope.terms_hash;
      envs.push(...r.envs);
    }
    envs.push(
      await appendBetEvent(tx, {
        bet_id: bet.id,
        type: 'odds.agreed',
        payload: {
          offer_id: offer.offer_id,
          stakes: offer.stakes,
          ratio_label: offer.ratio_label,
          terms_hash: termsHash,
        },
        now,
      }),
    );
    const names = await displayNames(tx, bet);
    const line = `${asciiFold(names.A)} ${stakeWords(offer.stakes.a)}, ${asciiFold(names.B)} ${stakeWords(offer.stakes.b)}`;
    const speak = await judgeAwaitsOdds(tx, bet.id, offer.created_at);
    envs.push(
      await appendBetEvent(tx, {
        bet_id: bet.id,
        type: 'judge.cue',
        payload: judgeCue(
          'ODDS_AGREED',
          { a: stakeWords(offer.stakes.a), b: stakeWords(offer.stakes.b) },
          speak
            ? `Say the odds are agreed: ${line}. Then call confirm_terms again.`
            : `Odds agreed: ${line}. Keep these stakes in every propose_terms call.`,
          speak,
        ),
        now,
      }),
    );
    return { bet, offer, envs, agreed: true, termsHash };
  });
  publish(deps, out.bet, out.envs);
  // A recomposed card is a new terms_hash: compile its camera checks in the background.
  if (out.agreed && out.termsHash !== bet0.terms_hash) void scheduleCompileCurrent(deps, bet0.id);
  deps.log.info('odds.accept', { bet_id: bet0.id, n, party: me, agreed: out.agreed });
  return { offer: out.offer, agreed: out.agreed, terms_hash: out.termsHash };
}

/** POST /v1/bets/:bet_id/odds/:offer_id/withdraw — the author's own offer (either party may dismiss the judge's). */
export async function withdrawOdds(
  deps: AppDeps,
  bet0: BetRow,
  me: Party,
  offerId: string,
): Promise<{ offer: OddsOffer }> {
  assertOddsState(bet0, { allowDrafting: true });
  const now = deps.now();
  const out = await deps.db.transaction(async (tx) => {
    const bet = (await lockBet(tx, bet0.id))!;
    assertOddsState(bet, { allowDrafting: true });
    const fold = await foldFromLog(tx, bet.id);
    const open = fold.open;
    if (!open || open.offer_id !== offerId) throw refuse('not_open', 'That offer is closed.');
    if (open.from !== 'judge' && open.from !== me)
      throw new HttpError('NOT_A_PARTY', 'Only who made the offer can withdraw it.', {
        reason: 'not_author',
      });
    const envs = [
      await appendBetEvent(tx, {
        bet_id: bet.id,
        type: 'odds.answered',
        payload: { offer_id: open.offer_id, party: me, answer: 'withdrawn', by_offer_id: null },
        now,
      }),
    ];
    return { bet, offer: open, envs };
  });
  publish(deps, out.bet, out.envs);
  return { offer: out.offer };
}
