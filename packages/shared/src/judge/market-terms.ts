// Market terms: Beat 6 (the live closer) as a typed proposal. A bets UP or DOWN on Gemini's
// current Bitcoin 5-minute contract; Gemini's odds set the split of the pot and Gemini's settled
// result decides it (SCHEMAS §2.6, §8; API-CONTRACT §2.13).
//
//   POST /v1/bets/:bet_id/terms/market   (S, party A; DRAFTING | TERMS_PROPOSED)
//     body MarketTermsRequest {side, amount_usd}: A's side and the even-money stake per side
//     (pot = 2 x amount). The server takes the BINDING quote from its Gemini relay
//     (fairStakes over the latest snapshot, capped by max_stake), copies the contract into
//     Terms.market (eventTicker, instrumentSymbol, side, priceAtLock, priceSource, quotedAt,
//     strike latched at the window start, expiry), stores the snapshot it priced from
//     (market_snapshots, with its sha256), and then runs the SAME evaluateProposeTerms +
//     persistEvaluation as /terms/typed and the voice judge: terms.proposed fans out as usual.
//     -> 200 MarketTermsResponse; 409 MARKET_UNAVAILABLE {reason: FairRefusal} when Gemini
//        can't price it (no open contract, strike pending, < 120 s to expiry, lopsided, ...).
//   then POST /v1/bets/:bet_id/terms/confirm as for any bet. A quote older than
//     MARKET_CONFIRM_MAX_AGE_MS at confirm is re-quoted (a new terms version) and answered
//     409 TERMS_HASH_MISMATCH {reason: 'requoted'}: the lock must land by quotedAt + 55 s.
//
// Pure (no I/O): the phone builds its request and renders the read-back with these.
import { z } from 'zod/v4';
import { BetState } from '../bet-state';
import { formatUsd } from '../money';
import { Hex32 } from '../primitives';
import { MarketRef, Stakes, type Terms } from '../terms';
import type { ProposeTermsProjection } from './propose-terms';

/**
 * Tickers of the server's REPLAY feed (a recorded real Gemini round replayed onto the current
 * window when Gemini's API is down): every surface says so.
 */
export const REPLAY_TICKER_PREFIX = 'REPLAY-';
export const isReplayTicker = (eventTicker: string): boolean =>
  eventTicker.startsWith(REPLAY_TICKER_PREFIX);

export const marketTermsPath = (betId: string) =>
  `/v1/bets/${encodeURIComponent(betId)}/terms/market`;

/** A's call: UP = Bitcoin finishes at or above the line (Gemini YES). */
export const MarketCall = z.enum(['UP', 'DOWN']);
export type MarketCall = z.infer<typeof MarketCall>;

/** Even-money stakes per side the phone offers (pot = 2 x amount; Gemini's odds split it). */
export const MARKET_STAKES_USD = [1, 2, 5, 10] as const;
export type MarketStakeUsd = (typeof MARKET_STAKES_USD)[number];

/**
 * Confirm must come within this of quotedAt. The lock carries accept_deadline = quotedAt + 60 s
 * and is never submitted within 5 s of it, so this leaves ~25 s to build, sign and land it.
 */
export const MARKET_CONFIRM_MAX_AGE_MS = 30_000;

export const MarketTermsRequest = z.object({
  side: MarketCall,
  /** Dollars per side, e.g. "5" (whole cents). */
  amount_usd: z.string().min(1).max(16),
});
export type MarketTermsRequest = z.infer<typeof MarketTermsRequest>;

export const MarketQuoteRef = z.object({
  /** market_snapshots.id of the snapshot the binding quote was priced from. */
  snapshot_id: z.string(),
  /** sha256(JCS(GeminiMarketSnapshot)) of that snapshot. */
  snapshot_sha256: Hex32,
  market: MarketRef,
  stakes: Stakes,
});
export type MarketQuoteRef = z.infer<typeof MarketQuoteRef>;

export const MarketTermsResponse = z.object({
  ok: z.literal(true),
  kind: z.literal('proposed'),
  state: BetState,
  terms_hash: Hex32,
  /** "0586·0f0a" */
  code: z.string(),
  say: z.string(),
  quote: MarketQuoteRef,
});
export type MarketTermsResponse = z.infer<typeof MarketTermsResponse>;

export const marketSideOf = (c: MarketCall): 'YES' | 'NO' => (c === 'UP' ? 'YES' : 'NO');
export const callOf = (side: 'YES' | 'NO'): MarketCall => (side === 'YES' ? 'UP' : 'DOWN');

/** "2026-11-18T02:40:00.000Z" -> "02:40 UTC". */
export function expiryLabel(expiryIso: string): string {
  const d = new Date(expiryIso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/** SCHEMAS §2.6 claim: always about UP (YES); `yes_party` says who holds it. */
export const marketClaim = (expiryIso: string, eventTicker = ''): string =>
  isReplayTicker(eventTicker)
    ? `REPLAY: a recorded Gemini BTC 5-minute round, ending ${expiryLabel(expiryIso)}, resolves UP.`
    : `Gemini's BTC 5-minute contract expiring ${expiryLabel(expiryIso)} resolves UP.`;

export const MARKET_SUCCESS = 'Gemini settles this contract YES.';
export const MARKET_FAILURE = 'Gemini settles this contract NO.';
/** Bound into the terms so the refund rule is part of what both sides lock. */
export const MARKET_VOID_EDGE = {
  question: 'What if Gemini voids the contract?',
  answer: 'Then nobody wins and both stakes go back.',
} as const;

/** The propose_terms projection for a market call (run through evaluateProposeTerms). */
export function marketTermsArgs(i: {
  side: MarketCall;
  amount_usd: string;
  expiry: string;
  /** The contract's eventTicker (a REPLAY- ticker makes a REPLAY claim). */
  eventTicker?: string;
}): ProposeTermsProjection {
  return {
    type: 'real_world',
    claim: marketClaim(i.expiry, i.eventTicker),
    performer: 'none',
    yes_party: i.side === 'UP' ? 'A' : 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: [MARKET_SUCCESS],
    failure_criteria: [MARKET_FAILURE],
    edge_cases: [{ ...MARKET_VOID_EDGE }],
    amount_usd: i.amount_usd.trim().replace(/^\$/, ''),
    market_side: marketSideOf(i.side),
    deadline_minutes: 0,
  };
}

/** "62/38": A's share of the pot first, rounded half-up (sign-card.ts uses the same rule). */
export function oddsDisplay(stakeA: string, stakeB: string): string {
  const a = BigInt(stakeA);
  const pot = a + BigInt(stakeB);
  const pct = pot === 0n ? 50 : Number((a * 100n + pot / 2n) / pot);
  return `${pct}/${100 - pct}`;
}

/**
 * The read-back of a market bet (TermsPresentation.readback and the spoken `say`):
 * "<claim> Logan has Up, Jake has Down. Gemini's odds: $6.20 against $3.80."
 */
export function marketReadback(
  t: Pick<Terms, 'claim' | 'market' | 'stakes' | 'party_a' | 'party_b'>,
  max = 200,
): string {
  const aUp = t.market?.side !== 'NO';
  const up = aUp ? t.party_a.display_name : t.party_b.display_name;
  const down = aUp ? t.party_b.display_name : t.party_a.display_name;
  const money = `Gemini's odds: ${formatUsd(t.stakes.a)} against ${formatUsd(t.stakes.b)}.`;
  const full = `${t.claim} ${up} has Up, ${down} has Down. ${money}`;
  if (full.length <= max) return full;
  const short = `${t.claim} ${money}`;
  return short.length <= max ? short : `${short.slice(0, max - 1)}…`;
}
