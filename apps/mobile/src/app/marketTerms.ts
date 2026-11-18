// "Bet on Bitcoin": Beat 6 on A's phone, the live closer. A picks Up or Down on Gemini's current
// Bitcoin 5-minute contract and an even-money stake; Gemini's live odds split the pot. A pure
// reducer for the panel plus the three calls over injected deps, tested in node:
//   quote    GET /v1/markets/btc5m/quote (every QUOTE_POLL_MS while the panel is open): the live
//            odds, the fair split, the line and the time left. A preview only.
//   submit   POST /v1/bets/:id/terms/market {side, amount_usd}: the server takes the BINDING quote
//            and proposes; the terms card arrives by the normal terms.proposed push.
//   confirm  "Lock it in" -> POST /v1/bets/:id/terms/confirm {terms_hash of the card shown}. A
//            quote older than 30 s is re-quoted by the server (409 TERMS_HASH_MISMATCH
//            {reason: 'requoted', terms_hash}): the new card arrives by push and is the one to
//            confirm next (the lock carries accept_deadline = quotedAt + 60 s).
//
//   closed ──open──▶ browsing ──submit──▶ sending ──proposed──▶ sent ──confirm──▶ confirming ──▶ confirmed
//            ▲          ▲  ▲                  │ refused / error          │ requoted ─▶ sent (new hash)
//            └─close────┘  └──── side / stake / note ◀──────────────────┘ failed ──▶ sent (note)
import type { FairRefusal } from '@youre-on/shared/gemini';
import {
  MARKET_STAKES_USD,
  marketSideOf,
  type MarketCall,
  type MarketStakeUsd,
} from '@youre-on/shared/judge/market-terms';
import { formatUsd, parseUsd } from '@youre-on/shared/money';
import { formatPrice } from '@youre-on/shared/settlement';

import type { YoApi } from '../net/api';
import { ApiClientError } from '../net/signedFetch';
import { COPY, t } from '../screens/copy';

export { MARKET_STAKES_USD, type MarketCall, type MarketStakeUsd };

/** The relay polls Gemini every 2 s; the panel asks as often. */
export const QUOTE_POLL_MS = 2_000;
/** $2 a side ($4 pot): small enough for the demo wallets, big enough to show the split. */
export const DEFAULT_MARKET_STAKE_USD: MarketStakeUsd = 2;
/** fairStakes refuses within 120 s of expiry (makers pull their quotes). */
const MIN_TTE_MS = 120_000;

export type MarketPhase = 'closed' | 'browsing' | 'sending' | 'sent' | 'confirming' | 'confirmed';

/** What the panel shows for the current side and stake. */
export interface MarketQuoteView {
  ok: boolean;
  /** The 1-3 word reason when Gemini can't price it ("Next round soon"). */
  refusal: string | null;
  eventTicker: string | null;
  /** P(Up) in percent, e.g. 61. */
  upPct: number | null;
  /** This phone (A) and the other side, micro-USDC. */
  myStake: string | null;
  theirStake: string | null;
  /** "$64,389.60" */
  strikeUsd: string | null;
  priceUsd: string | null;
  expiryMs: number | null;
  /** The last moment Gemini prices this contract (expiry − 120 s). */
  lockableUntilMs: number | null;
  /** When Gemini can't price it: the next 5-minute round's start, if known (server clock). */
  nextWindowMs: number | null;
}

export interface MarketState {
  bet_id: string | null;
  phase: MarketPhase;
  side: MarketCall;
  stakeUsd: MarketStakeUsd;
  quote: MarketQuoteView | null;
  /** terms_hash of the card this panel proposed (or the server re-quoted). */
  proposedHash: string | null;
  note: string | null;
}

export const initialMarket: MarketState = {
  bet_id: null,
  phase: 'closed',
  side: 'UP',
  stakeUsd: DEFAULT_MARKET_STAKE_USD,
  quote: null,
  proposedHash: null,
  note: null,
};

export type SubmitMarketOutcome =
  { kind: 'proposed'; terms_hash: string } | { kind: 'error'; note: string };

export type MarketEvent =
  | { type: 'init'; bet_id: string }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'side'; side: MarketCall }
  | { type: 'stake'; usd: MarketStakeUsd }
  /** A quote for `side` / `stakeUsd` arrived (stale answers for another pick are dropped). */
  | { type: 'quoted'; side: MarketCall; stakeUsd: MarketStakeUsd; quote: MarketQuoteView }
  | { type: 'submit' }
  | { type: 'submitted'; outcome: SubmitMarketOutcome }
  | { type: 'confirm' }
  | { type: 'confirmed' }
  /** The server re-quoted the bet: the new card (by push) is the one to lock. */
  | { type: 'requoted'; terms_hash: string; note: string }
  | { type: 'confirm_failed'; note: string };

const busy = (s: MarketState) => s.phase === 'sending' || s.phase === 'confirming';
const locked = (s: MarketState) => s.phase === 'confirmed';

export function marketReducer(s: MarketState, e: MarketEvent): MarketState {
  switch (e.type) {
    case 'init':
      return s.bet_id === e.bet_id ? s : { ...initialMarket, bet_id: e.bet_id };
    case 'open':
      return s.bet_id === null || s.phase !== 'closed' ? s : { ...s, phase: 'browsing' };
    case 'close':
      return busy(s) || locked(s) ? s : { ...s, phase: 'closed', note: null };
    case 'side':
      if (busy(s) || locked(s) || s.side === e.side) return s;
      return { ...s, side: e.side, quote: null, phase: 'browsing', note: null };
    case 'stake':
      if (busy(s) || locked(s) || s.stakeUsd === e.usd) return s;
      return { ...s, stakeUsd: e.usd, quote: null, phase: 'browsing', note: null };
    case 'quoted':
      if (s.phase === 'closed' || e.side !== s.side || e.stakeUsd !== s.stakeUsd) return s;
      return { ...s, quote: e.quote };
    case 'submit':
      return canSubmitMarket(s) ? { ...s, phase: 'sending', note: null } : s;
    case 'submitted':
      if (s.phase !== 'sending') return s;
      return e.outcome.kind === 'proposed'
        ? { ...s, phase: 'sent', proposedHash: e.outcome.terms_hash, note: null }
        : { ...s, phase: 'browsing', note: e.outcome.note };
    case 'confirm':
      return s.phase === 'sent' ? { ...s, phase: 'confirming', note: null } : s;
    case 'confirmed':
      return s.phase === 'confirming' ? { ...s, phase: 'confirmed' } : s;
    case 'requoted':
      return s.phase === 'confirming'
        ? { ...s, phase: 'sent', proposedHash: e.terms_hash, note: e.note }
        : s;
    case 'confirm_failed':
      return s.phase === 'confirming' ? { ...s, phase: 'sent', note: e.note } : s;
  }
}

/** Propose only what Gemini is pricing right now. */
export const canSubmitMarket = (s: MarketState): boolean =>
  s.bet_id !== null && s.phase === 'browsing' && s.quote?.ok === true;

/** The panel polls while it is open and not yet locked. */
export const shouldPoll = (s: MarketState): boolean =>
  s.phase === 'browsing' || s.phase === 'sending' || s.phase === 'sent';

/**
 * "Lock it in" shows for the card this panel proposed (or the server's re-quote of it), once B
 * accepted the challenge (the server answers 409 invite_pending before that).
 */
export const canConfirmMarket = (
  s: MarketState,
  shownHash: string | null,
  inviteAnswer: 'accepted' | 'declined' | null,
): boolean =>
  (s.phase === 'sent' || s.phase === 'confirming') &&
  shownHash !== null &&
  shownHash === s.proposedHash &&
  inviteAnswer === 'accepted';

export const waitingForAcceptMarket = (
  s: MarketState,
  shownHash: string | null,
  inviteAnswer: 'accepted' | 'declined' | null,
): boolean =>
  (s.phase === 'sent' || s.phase === 'confirming') &&
  shownHash !== null &&
  shownHash === s.proposedHash &&
  inviteAnswer !== 'accepted';

/** FairRefusal -> a 1-3 word label (ui/copyRule). */
export const REFUSAL_LABEL: Readonly<Record<FairRefusal, string>> = {
  MARKET_NOT_OPEN: 'Market closed',
  QUOTE_STALE: 'Odds updating',
  TOO_CLOSE_TO_EXPIRY: 'Next round soon',
  STRIKE_PENDING: 'Line not set',
  NO_TWO_SIDED_QUOTE: 'No odds yet',
  SPREAD_TOO_WIDE: 'Odds too wide',
  PRICE_OUT_OF_RANGE: 'Too lopsided',
  STAKE_ABOVE_MAX: 'Stake too high',
  STAKE_BELOW_MIN: 'Stake too low',
};

const refusalOf = (e: unknown): string => {
  if (e instanceof ApiClientError) {
    const r = e.details?.reason;
    if (typeof r === 'string' && r in REFUSAL_LABEL) return REFUSAL_LABEL[r as FairRefusal];
    if (e.code === 'MARKET_UNAVAILABLE') return REFUSAL_LABEL.MARKET_NOT_OPEN;
  }
  return t(COPY.app.failed);
};

const pctOf = (price: string) => Math.round(Number(price) * 100);

/** Refusals that the next round fixes: the panel counts down to it. */
const WAIT_FOR_NEXT: ReadonlySet<string> = new Set([
  'MARKET_NOT_OPEN',
  'TOO_CLOSE_TO_EXPIRY',
  'STRIKE_PENDING',
  'NO_TWO_SIDED_QUOTE',
  'PRICE_OUT_OF_RANGE',
  'SPREAD_TOO_WIDE',
]);

/** One preview for `side` / `stakeUsd`. Never throws (a refusal is a view with ok: false). */
export async function fetchMarketQuote(
  d: { api: Pick<YoApi, 'marketQuote'> & Partial<Pick<YoApi, 'marketCurrent'>> },
  i: { side: MarketCall; stakeUsd: number },
): Promise<MarketQuoteView> {
  try {
    const r = await d.api.marketQuote(parseUsd(String(i.stakeUsd)), marketSideOf(i.side));
    const s = r.snapshot;
    const pYes = pctOf(r.result.priceAtLock);
    const expiryMs = Date.parse(s.expiry);
    return {
      ok: true,
      refusal: null,
      eventTicker: s.eventTicker,
      upPct: pYes,
      myStake: r.result.stakes.a,
      theirStake: r.result.stakes.b,
      strikeUsd: s.strike.value === null ? null : formatPrice(s.strike.value),
      priceUsd: s.indexPrice === null ? null : formatPrice(s.indexPrice),
      expiryMs,
      lockableUntilMs: expiryMs - MIN_TTE_MS,
      nextWindowMs: null,
    };
  } catch (e) {
    const reason = e instanceof ApiClientError ? e.details?.reason : undefined;
    let nextWindowMs: number | null = null;
    if (typeof reason === 'string' && WAIT_FOR_NEXT.has(reason) && d.api.marketCurrent) {
      const cur = await d.api.marketCurrent().catch(() => null);
      nextWindowMs = cur?.next_window_start ? Date.parse(cur.next_window_start) : null;
    }
    return {
      ok: false,
      refusal: refusalOf(e),
      eventTicker: null,
      upPct: null,
      myStake: null,
      theirStake: null,
      strikeUsd: null,
      priceUsd: null,
      expiryMs: null,
      lockableUntilMs: null,
      nextWindowMs,
    };
  }
}

export async function submitMarketTerms(
  d: { api: Pick<YoApi, 'proposeMarketTerms'> },
  i: { betId: string; side: MarketCall; stakeUsd: number },
): Promise<SubmitMarketOutcome> {
  try {
    const r = await d.api.proposeMarketTerms(i.betId, {
      side: i.side,
      amount_usd: String(i.stakeUsd),
    });
    return { kind: 'proposed', terms_hash: r.terms_hash };
  } catch (e) {
    return { kind: 'error', note: refusalOf(e) };
  }
}

export type ConfirmMarketOutcome =
  | { kind: 'confirmed' }
  | { kind: 'requoted'; terms_hash: string; note: string }
  | { kind: 'failed'; note: string; freshKey: boolean };

/**
 * `freshKey`: a 4xx is replayed for that Idempotency-Key, so the next tap needs a new key (a
 * re-quote always does: it confirms a different card).
 */
export async function confirmMarketTerms(
  d: { api: Pick<YoApi, 'confirmTerms'> },
  i: { betId: string; termsHash: string; idempotencyKey: string },
): Promise<ConfirmMarketOutcome> {
  try {
    await d.api.confirmTerms(i.betId, i.termsHash, i.idempotencyKey);
    return { kind: 'confirmed' };
  } catch (e) {
    if (
      e instanceof ApiClientError &&
      e.code === 'TERMS_HASH_MISMATCH' &&
      e.details?.reason === 'requoted' &&
      typeof e.details.terms_hash === 'string'
    )
      return { kind: 'requoted', terms_hash: e.details.terms_hash, note: 'Odds moved' };
    const answered = e instanceof ApiClientError && e.status >= 400 && e.status < 500;
    let note = refusalOf(e);
    if (e instanceof ApiClientError && e.code === 'INVALID_STATE')
      note = e.details?.reason === 'invite_pending' ? 'Not accepted yet' : t(COPY.app.failed);
    return { kind: 'failed', note, freshKey: answered };
  }
}

/** "$6.10 vs $3.90" from a quote view (A's side first), or null. */
export const splitLabel = (q: MarketQuoteView | null): string | null =>
  q?.ok && q.myStake && q.theirStake
    ? `${formatUsd(q.myStake)} vs ${formatUsd(q.theirStake)}`
    : null;
