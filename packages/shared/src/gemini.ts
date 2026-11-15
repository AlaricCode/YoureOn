// SCHEMAS §8 — Gemini market snapshot and fair stakes. camelCase objects mirror Gemini's API verbatim.
// GeminiStrike lives here (not in terms.ts) so terms.ts → gemini.ts stays acyclic.
import { z } from 'zod/v4';
import { CENT, MAX_STAKE, MIN_STAKE } from './constants';
import { fromMicro, type MicroUsdc } from './money';
import { DecimalStr, IsoUtc } from './primitives';

/** Gemini's Strike object, verbatim. `value` is null until availableAt for 'reference' strikes. */
export const GeminiStrike = z.strictObject({
  value: DecimalStr.nullable(),
  type: z.enum([
    'reference',
    'above',
    'spread',
    'over',
    'over_or_equal',
    'under',
    'under_or_equal',
  ]),
  availableAt: IsoUtc.nullable(),
});
export type GeminiStrike = z.infer<typeof GeminiStrike>;

export const GeminiMarketStatus = z.enum([
  'approved',
  'active',
  'closed',
  'under_review',
  'settled',
  'invalid',
]);

export const GeminiMarketSnapshot = z.strictObject({
  eventTicker: z.string(),
  eventTitle: z.string(),
  /** REST casing (upper). WS bookTicker `s` arrives lowercase: compare case-insensitively. */
  instrumentSymbol: z.string(),
  contractLabel: z.string(),
  status: GeminiMarketStatus,
  marketState: z.enum(['open', 'closed']).nullable(),
  strike: GeminiStrike,
  expiry: IsoUtc,
  /** YES bid, as sent ("0.5800"). */
  bestBid: DecimalStr.nullable(),
  /** YES ask. */
  bestAsk: DecimalStr.nullable(),
  lastTradePrice: DecimalStr.nullable(),
  indexPrice: DecimalStr.nullable(),
  source: z.enum(['ws_book_ticker', 'rest_event']),
  /** From bookTicker E (nanoseconds, > 2^53: parse as bigint, not number). */
  exchangeTs: IsoUtc.nullable(),
  /** Our receive time; staleness is measured from this. */
  observedAt: IsoUtc,
});
export type GeminiMarketSnapshot = z.infer<typeof GeminiMarketSnapshot>;

/** "0.5800" → 580000n. At most 6 decimals. */
export function decimalToPpm(s: string): bigint {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(s);
  if (!m || m[1] === undefined) throw new Error(`price needs <= 6 decimals: ${s}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** n >= 0, d > 0. */
export const divRoundHalfUp = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);

export const FAIR = {
  /** bid <= 0.01 or ask >= 0.99 → placeholder → no quote. */
  STUB_PPM: 10_000n,
  /** 0.30; wider → last trade if inside the spread, else refuse. */
  MAX_SPREAD_PPM: 300_000n,
  /** p must be in [0.05, 0.95] after rounding. */
  MIN_PCT: 5n,
  MAX_PCT: 95n,
  /** observedAt older than this → refetch REST, else refuse. */
  STALE_MS: 5_000,
  /** Quote >= 120 s before expiry: makers pull quotes at T-120 s. */
  MIN_TTE_MS: 120_000,
  /** Both authorizations within 60 s of quotedAt. */
  QUOTE_TTL_MS: 60_000,
} as const;

/** "0.62" → 62n (percent, half-up to 0.01). */
export const pctFromPrice = (p: string): bigint => divRoundHalfUp(decimalToPpm(p), 10_000n);

/** YES stake rounds half-up to whole cents; NO takes the remainder, so a + b = pot exactly. */
export function splitPot(
  pot: bigint,
  aSide: 'YES' | 'NO',
  pYesPct: bigint,
): { a: bigint; b: bigint } {
  const yes = divRoundHalfUp(pot * pYesPct, 100n * CENT) * CENT;
  const no = pot - yes;
  return aSide === 'YES' ? { a: yes, b: no } : { a: no, b: yes };
}

export type FairRefusal =
  | 'MARKET_NOT_OPEN'
  | 'QUOTE_STALE'
  | 'TOO_CLOSE_TO_EXPIRY'
  | 'STRIKE_PENDING'
  | 'NO_TWO_SIDED_QUOTE'
  | 'SPREAD_TOO_WIDE'
  | 'PRICE_OUT_OF_RANGE'
  | 'STAKE_ABOVE_MAX'
  | 'STAKE_BELOW_MIN';

export type FairStakesResult =
  | {
      ok: true;
      priceAtLock: string;
      priceSource: 'mid' | 'last_in_spread';
      quotedAt: string;
      stakes: { a: MicroUsdc; b: MicroUsdc; currency: 'USDC' };
    }
  | { ok: false; reason: FairRefusal };

/** amount = spoken stake per side; pot = 2 × amount. Integer math only. */
export function fairStakes(
  snap: GeminiMarketSnapshot,
  amount: MicroUsdc,
  aSide: 'YES' | 'NO',
  nowMs: number,
): FairStakesResult {
  const no = (reason: FairRefusal) => ({ ok: false, reason }) as const;
  if (snap.status !== 'active' || snap.marketState !== 'open') return no('MARKET_NOT_OPEN');
  if (nowMs - Date.parse(snap.observedAt) > FAIR.STALE_MS) return no('QUOTE_STALE');
  if (Date.parse(snap.expiry) - nowMs < FAIR.MIN_TTE_MS) return no('TOO_CLOSE_TO_EXPIRY');
  const windowOpen =
    snap.strike.availableAt !== null && Date.parse(snap.strike.availableAt) <= nowMs;
  if (windowOpen && snap.strike.value === null) return no('STRIKE_PENDING');
  let bid = snap.bestBid === null ? null : decimalToPpm(snap.bestBid);
  let ask = snap.bestAsk === null ? null : decimalToPpm(snap.bestAsk);
  if (bid !== null && bid <= FAIR.STUB_PPM) bid = null;
  if (ask !== null && ask >= 1_000_000n - FAIR.STUB_PPM) ask = null;
  if (bid === null || ask === null || ask < bid) return no('NO_TWO_SIDED_QUOTE');
  let pct: bigint;
  let priceSource: 'mid' | 'last_in_spread';
  if (ask - bid <= FAIR.MAX_SPREAD_PPM) {
    pct = divRoundHalfUp(bid + ask, 20_000n); // mid, rounded to 0.01
    priceSource = 'mid';
  } else {
    const last = snap.lastTradePrice === null ? null : decimalToPpm(snap.lastTradePrice);
    if (last === null || last < bid || last > ask) return no('SPREAD_TOO_WIDE');
    pct = divRoundHalfUp(last, 10_000n);
    priceSource = 'last_in_spread';
  }
  if (pct < FAIR.MIN_PCT || pct > FAIR.MAX_PCT) return no('PRICE_OUT_OF_RANGE');
  const { a, b } = splitPot(2n * BigInt(amount), aSide, pct);
  if (a > MAX_STAKE || b > MAX_STAKE) return no('STAKE_ABOVE_MAX');
  if (a < MIN_STAKE || b < MIN_STAKE) return no('STAKE_BELOW_MIN');
  return {
    ok: true,
    priceAtLock: `0.${pct.toString().padStart(2, '0')}`,
    priceSource,
    quotedAt: new Date(nowMs).toISOString(),
    stakes: { a: fromMicro(a), b: fromMicro(b), currency: 'USDC' },
  };
}
