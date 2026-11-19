// Odds on this phone: unequal stakes the two parties agree on (offer → counter → accept), and the
// judge's suggestion grounded in the performer's record. Pure TS, tested in node.
//
//   state    the bet's odds.* events folded by the shared foldOdds (the server's confirm gate and
//            the stage run the same fold), kept on BetModel.odds by bets/store applyBetEvent.
//   gates    canAccept / canCounter / canWithdraw for this phone's party; oddsSettled() is the
//            extra condition on "Lock it in" (the server answers 409 odds_pending otherwise).
//   control  the odds picker next to the stake chips: Even / 2:1 / 3:1 / 5:1, "I give" / "I get",
//            and the base (the underdog's stake), turned into stakes by the shared stakesFor.
//   calls    offer / accept / withdraw / suggest over injected api deps, answering a short note.
//
// "I give 3 to 1" = I put in three for every one you put in (I'm the favourite, I stake more).
import { MAX_STAKE, MICRO_PER_USD } from '@youre-on/shared/constants';
import { formatUsd, type MicroUsdc } from '@youre-on/shared/money';
import {
  agreedFor,
  emptyOdds as emptyFold,
  oddsReducer as foldOne,
  type OddsOffer,
  type OddsState as OddsFold,
  type OddsSuggestRequest,
  type OddsSuggestion,
} from '@youre-on/shared/odds';
import {
  offerLine,
  ratioLabel,
  statLine,
  stakesFor,
  toWinLine,
  type OddsRatio,
} from '@youre-on/shared/odds-math';
import { otherParty, type Party } from '@youre-on/shared/primitives';
import type { RealtimeEvent } from '@youre-on/shared/realtime';
import type { BetState } from '@youre-on/shared/bet-state';
import type { Terms } from '@youre-on/shared/terms';

import type { YoApi } from '../net/api';
import { ApiClientError } from '../net/signedFetch';
import { COPY, fill, t } from '../screens/copy';
import { isCopyOk } from '../ui/copyRule';

// ---------------------------------------------------------------------------------------
// State (BetModel.odds)
// ---------------------------------------------------------------------------------------

export type OddsEvent = Extract<
  RealtimeEvent,
  { type: 'odds.offered' | 'odds.answered' | 'odds.agreed' }
>;
export type { OddsFold };

/** BetModel.odds: the shared fold, so a replayed event (same offer_id / answer) is a no-op. */
export type OddsState = OddsFold;
export const emptyOdds: OddsState = emptyFold();
export const oddsReducer = (s: OddsState, e: OddsEvent): OddsState => foldOne(s, e);

// ---------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------

/** Odds offers are answered only while the card is on the table (R2/R8). */
const onTable = (state: BetState | null) => state === 'TERMS_PROPOSED';

/** The open offer is someone else's (or the judge's) and I have not accepted it yet. */
export function canAccept(f: OddsFold, me: Party | null, state: BetState | null): boolean {
  const o = f.open;
  return !!o && !!me && onTable(state) && o.from !== me && !f.accepted_by.includes(me);
}

/** Counter = a new offer against the open one (not my own: I withdraw or re-offer instead). */
export function canCounter(f: OddsFold, me: Party | null, state: BetState | null): boolean {
  const o = f.open;
  return !!o && !!me && onTable(state) && o.from !== me;
}

export const canWithdraw = (f: OddsFold, me: Party | null, state: BetState | null): boolean =>
  !!me && onTable(state) && f.open?.from === me;

/** Skill terms only: market (Gemini) stakes are set by the market and never need an odds offer. */
/**
 * Where "Suggest odds" lives on A's typed form: under the picker only while nothing is proposed
 * (the judge's numbers fill the picker). Once the card is on the table the offer card's own row
 * has "Suggest odds | Offer odds" for both phones, so the form's button goes (it showed twice).
 */
export const typedSuggestShown = (b: { state: BetState | null; envelope: unknown }): boolean =>
  b.state === 'DRAFTING' || b.state === null || b.envelope === null;

export const oddsApply = (terms: Pick<Terms, 'type' | 'market'>): boolean =>
  terms.type === 'skill' && terms.market === null;

/**
 * The card's stakes need no more consent: nothing open, and either even stakes or a pair both
 * accepted. The server's confirm gate (R7) is the same rule; this only keeps "Lock it in" from
 * spending a request on a 409.
 */
export function oddsSettled(
  f: OddsFold,
  terms: Pick<Terms, 'type' | 'market' | 'stakes'>,
): boolean {
  if (!oddsApply(terms)) return true;
  if (f.open) return false;
  const { a, b } = terms.stakes;
  return a === b || agreedFor(f, { a, b });
}

// ---------------------------------------------------------------------------------------
// The odds picker
// ---------------------------------------------------------------------------------------

export const ODDS_PRESETS = ['Even', '2:1', '3:1', '5:1'] as const;
export type OddsPreset = (typeof ODDS_PRESETS)[number];
const PRESET_RATIO: Readonly<Record<OddsPreset, OddsRatio>> = {
  Even: '1:1',
  '2:1': '2:1',
  '3:1': '3:1',
  '5:1': '5:1',
};

export interface OddsControl {
  /** 'custom' = stakes that no preset reproduces (a counter typed elsewhere, the judge's 3:2). */
  preset: OddsPreset | 'custom';
  /** give = I'm the favourite (I put in more); get = they put in more. */
  dir: 'give' | 'get';
  /** The underdog's stake in whole dollars (the stake chip). */
  baseUsd: number;
  /** Exact stakes for 'custom' (mine, theirs), else null. */
  custom: { mine: MicroUsdc; theirs: MicroUsdc } | null;
}

export const evenControl = (baseUsd: number): OddsControl => ({
  preset: 'Even',
  dir: 'give',
  baseUsd,
  custom: null,
});

export type StakePair = { a: MicroUsdc; b: MicroUsdc };
export type ControlStakes = { ok: true; stakes: StakePair } | { ok: false; note: string };

const pair = (me: Party, mine: bigint, theirs: bigint): StakePair =>
  me === 'A'
    ? { a: mine.toString(), b: theirs.toString() }
    : { a: theirs.toString(), b: mine.toString() };

/** The stakes the picker stands for, as party A / B micro-USDC. */
export function controlStakes(
  c: OddsControl,
  me: Party,
  maxStake: bigint = MAX_STAKE,
): ControlStakes {
  if (c.preset === 'custom' && c.custom)
    return { ok: true, stakes: pair(me, BigInt(c.custom.mine), BigInt(c.custom.theirs)) };
  const preset = c.preset === 'custom' ? 'Even' : c.preset;
  const favored = preset === 'Even' ? null : c.dir === 'give' ? me : otherParty(me);
  const r = stakesFor({
    ratio: PRESET_RATIO[preset],
    favored,
    baseMicro: BigInt(c.baseUsd) * MICRO_PER_USD,
    maxStake,
  });
  if ('issue' in r) return { ok: false, note: t(COPY.odds.tooLong) };
  return { ok: true, stakes: { a: BigInt(r.a).toString(), b: BigInt(r.b).toString() } };
}

/** The picker that reproduces `stakes` (a card or an offer), or a 'custom' one. */
export function controlOf(stakes: StakePair, me: Party, maxStake: bigint = MAX_STAKE): OddsControl {
  const mine = BigInt(me === 'A' ? stakes.a : stakes.b);
  const theirs = BigInt(me === 'A' ? stakes.b : stakes.a);
  const lo = mine < theirs ? mine : theirs;
  const dir = mine > theirs ? 'give' : 'get';
  const wholeBase = lo % MICRO_PER_USD === 0n ? Number(lo / MICRO_PER_USD) : null;
  if (wholeBase !== null && wholeBase > 0) {
    for (const preset of ODDS_PRESETS) {
      const c: OddsControl = { preset, dir, baseUsd: wholeBase, custom: null };
      const r = controlStakes(c, me, maxStake);
      if (
        r.ok &&
        BigInt(r.stakes.a) === BigInt(stakes.a) &&
        BigInt(r.stakes.b) === BigInt(stakes.b)
      )
        return preset === 'Even' ? evenControl(wholeBase) : c;
    }
  }
  return {
    preset: 'custom',
    dir,
    baseUsd: wholeBase ?? 1,
    custom: { mine: mine.toString(), theirs: theirs.toString() },
  };
}

/** A preset chip: custom stakes give way to the preset over the same base. */
export const pickPreset = (c: OddsControl, preset: OddsPreset): OddsControl =>
  preset === 'Even' ? evenControl(c.baseUsd) : { ...c, preset, custom: null };

/** "I give" / "I get" (meaningless at Even, so it leaves Even alone). */
export function pickDir(c: OddsControl, dir: OddsControl['dir']): OddsControl {
  if (c.preset === 'Even' || c.dir === dir) return c;
  if (c.preset === 'custom' && c.custom)
    return { ...c, dir, custom: { mine: c.custom.theirs, theirs: c.custom.mine } };
  return { ...c, dir };
}

/** A base chip (the smaller stake): custom stakes start over at Even from it. */
export const pickBase = (c: OddsControl, usd: number): OddsControl =>
  c.preset === 'custom' ? evenControl(usd) : { ...c, baseUsd: usd };

/** "You $15 · Jake $5" under the picker. */
export function readout(s: StakePair, me: Party, theirName: string): string {
  const mine = me === 'A' ? s.a : s.b;
  const theirs = me === 'A' ? s.b : s.a;
  return `You ${formatUsd(mine)} · ${firstName(theirName)} ${formatUsd(theirs)}`;
}

/** "Even", "3 to 1": the odds a pair of stakes stands for. */
export const pairLabel = (s: StakePair): string => ratioLabel(BigInt(s.a), BigInt(s.b));

/** "$15 vs $5 · 3 to 1" (mine first), or "$5 vs $5" when even. */
export function stakesLine(myStake: MicroUsdc, theirStake: MicroUsdc): string {
  const base = `${formatUsd(myStake)} vs ${formatUsd(theirStake)}`;
  return myStake === theirStake
    ? base
    : `${base} · ${ratioLabel(BigInt(myStake), BigInt(theirStake))}`;
}

/** A wire dollar string for the odds routes ("15", "7.50"). */
export const usdString = (m: MicroUsdc): string => formatUsd(m).replace(/^\$/, '');

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

// ---------------------------------------------------------------------------------------
// The offer card
// ---------------------------------------------------------------------------------------

export interface OfferCardView {
  offerId: string;
  n: number;
  fromJudge: boolean;
  /** "Jake offers 3 to 1: your $5 to win $20" / "Judge suggests 3 to 1". */
  title: string;
  /** "Judge suggests 3:1" (judge offers only). */
  header: string | null;
  /** "You put in $5 to win $20". */
  toWin: string;
  /** Judge offers: the performer's record, the reason, the chance, the Demo history tag. */
  judge: {
    stats: string;
    reason: string;
    chance: string;
    demo: boolean;
    byDefault: boolean;
  } | null;
  canAccept: boolean;
  canCounter: boolean;
  canWithdraw: boolean;
  /** "Waiting on Jake" when my side is in and theirs is not. */
  waitingOn: string | null;
  /** The picker a counter starts from (the offer's own stakes). */
  counterFrom: OddsControl;
}

export interface OddsCardInput {
  odds: OddsState;
  me: Party | null;
  state: BetState | null;
  /** The card on the table, if any. */
  terms: Pick<Terms, 'type' | 'market' | 'stakes' | 'party_a' | 'party_b' | 'performer'> | null;
}

const nameOf = (terms: Pick<Terms, 'party_a' | 'party_b'> | null, p: Party): string =>
  firstName((p === 'A' ? terms?.party_a : terms?.party_b)?.display_name ?? '') || p;

/** What the offer card shows on this phone, or null when there is no open offer. */
export function offerCardView(i: OddsCardInput): OfferCardView | null {
  const o = i.odds.open;
  if (!o || !i.me) return null;
  const me = i.me;
  const fromJudge = o.from === 'judge';
  const fromName = fromJudge ? t(COPY.ruling.judge) : nameOf(i.terms, o.from as Party);
  const mine = BigInt(me === 'A' ? o.stakes.a : o.stakes.b);
  const pot = BigInt(o.stakes.a) + BigInt(o.stakes.b);
  const accepted = i.odds.accepted_by;
  const iAmIn = o.from === me || accepted.includes(me);
  const them = otherParty(me);
  const theyAreIn = o.from === them || accepted.includes(them);
  const s = o.suggestion;
  return {
    offerId: o.offer_id,
    n: o.n,
    fromJudge,
    title: offerLine(fromName, o, me),
    header: fromJudge ? fill.judgeSuggests(compactRatio(s?.ratio ?? null, o)) : null,
    toWin: toWinLine(mine, pot),
    judge: fromJudge && s ? judgeLines(s, i.terms) : null,
    canAccept: canAccept(i.odds, me, i.state),
    canCounter: canCounter(i.odds, me, i.state),
    canWithdraw: canWithdraw(i.odds, me, i.state),
    waitingOn: iAmIn && !theyAreIn ? nameOf(i.terms, them) : null,
    counterFrom: controlOf(o.stakes, me),
  };
}

/** "3:1" for the header (the ratio the judge picked, else the stakes' own), "even" for 1:1. */
function compactRatio(ratio: OddsRatio | null, o: OddsOffer): string {
  if (ratio) return ratio === '1:1' ? 'even' : ratio;
  const label = ratioLabel(o.stakes.a, o.stakes.b);
  return label === 'Even' ? 'even' : label.replace(' to ', ':');
}

function judgeLines(s: OddsSuggestion, terms: OddsCardInput['terms']) {
  const p = s.stats.performer;
  const performer = p.display_name || nameOf(terms, p.party);
  const opponent = terms ? nameOf(terms, otherParty(p.party)) : undefined;
  return {
    stats: statLine(s.stats, opponent),
    reason: s.reason,
    chance: fill.chanceFor(s.chance_pct, performer),
    demo: s.stats.includes_seed,
    byDefault: s.source === 'default',
  };
}

/** The card's odds are agreed and unequal: "Odds agreed" on both phones. */
export function oddsAgreedShown(i: OddsCardInput): boolean {
  if (!i.terms || !oddsApply(i.terms) || i.odds.open) return false;
  const { a, b } = i.terms.stakes;
  return a !== b && agreedFor(i.odds, { a, b });
}

// ---------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------

type OddsApi = Pick<YoApi, 'offerOdds' | 'acceptOdds' | 'withdrawOdds' | 'suggestOdds'>;
export type OddsCallResult = { ok: true; agreed: boolean } | { ok: false; note: string };

/** A body line the server wrote (copy-checked), or the short fallback. */
const bodyOr = (s: string | null | undefined, fallback: string): string =>
  s && isCopyOk(s, 'body') ? s : fallback;

export function oddsErrorNote(e: unknown): string {
  if (e instanceof ApiClientError) {
    const reason = e.details?.reason;
    const issue = e.details?.issue as { code?: unknown } | undefined;
    if (e.code === 'INSUFFICIENT_FUNDS') return bodyOr(e.message, t(COPY.app.failed));
    if (e.code === 'VALIDATION_FAILED' && issue?.code === 'ODDS_TOO_LONG')
      return t(COPY.odds.tooLong);
    if (e.code === 'RATE_LIMITED') return t(COPY.home.slowDown);
    if (e.code === 'INVALID_STATE') {
      if (reason === 'odds_pending') return t(COPY.odds.pending);
      if (reason === 'stale' || reason === 'not_open') return t(COPY.odds.changed);
      return bodyOr(e.message, t(COPY.app.failed));
    }
    if (e.code === 'VALIDATION_FAILED') return bodyOr(e.message, t(COPY.app.failed));
  }
  return t(COPY.app.failed);
}

export async function offerOdds(
  d: { api: Pick<OddsApi, 'offerOdds'> },
  i: { betId: string; stakes: StakePair },
): Promise<OddsCallResult> {
  try {
    const r = await d.api.offerOdds(i.betId, {
      stakes_usd: { a: usdString(i.stakes.a), b: usdString(i.stakes.b) },
    });
    return { ok: true, agreed: r.agreed };
  } catch (e) {
    return { ok: false, note: oddsErrorNote(e) };
  }
}

export async function acceptOdds(
  d: { api: Pick<OddsApi, 'acceptOdds'> },
  i: { betId: string; offerId: string; n: number },
): Promise<OddsCallResult> {
  try {
    const r = await d.api.acceptOdds(i.betId, i.offerId, i.n);
    return { ok: true, agreed: r.agreed };
  } catch (e) {
    return { ok: false, note: oddsErrorNote(e) };
  }
}

export async function withdrawOdds(
  d: { api: Pick<OddsApi, 'withdrawOdds'> },
  i: { betId: string; offerId: string },
): Promise<OddsCallResult> {
  try {
    await d.api.withdrawOdds(i.betId, i.offerId);
    return { ok: true, agreed: false };
  } catch (e) {
    return { ok: false, note: oddsErrorNote(e) };
  }
}

export type SuggestResult =
  { ok: true; offer: OddsOffer; say: string } | { ok: false; note: string };

/**
 * "Suggest odds": the judge's offer for this bet. On the card it needs no body; in the typed
 * form (DRAFTING, nothing proposed yet) it sends the claim as it stands, and the form takes the
 * suggested stakes into its picker.
 */
export async function suggestOdds(
  d: { api: Pick<OddsApi, 'suggestOdds'> },
  i: { betId: string; body: OddsSuggestRequest },
): Promise<SuggestResult> {
  try {
    const r = await d.api.suggestOdds(i.betId, i.body);
    return { ok: true, offer: r.offer, say: r.say };
  } catch (e) {
    return { ok: false, note: oddsErrorNote(e) };
  }
}

/** The typed form's suggest body (B performs, one try, as typedTermsRequest builds it). */
export const typedSuggestBody = (claim: string, baseUsd: number): OddsSuggestRequest => ({
  base_usd: String(baseUsd),
  claim: claim.replace(/\s+/g, ' ').trim(),
  performer: 'B',
  attempts: { count: 1, rule: 'single' },
});
