// The BINDING quote of a Gemini bet: fairStakes over the relay's snapshot, bound into the terms
// (Terms.market) and stored with the exact snapshot it was priced from. Its `quotedAt` becomes the
// lock's accept_deadline (unix(quotedAt) + 60 s), so it is taken as late as possible: when the
// terms are composed.
// Spec: docs/planning/SCHEMAS.md §8.
import { sql } from 'drizzle-orm';
import { geminiMarkets, marketSnapshots } from '@youre-on/db';
import { MAX_STAKE } from '@youre-on/shared/constants';
import type { FairRefusal, GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { jcs } from '@youre-on/shared/jcs';
import { marketClaim } from '@youre-on/shared/judge/market-terms';
import type { MicroUsdc } from '@youre-on/shared/money';
import type { TermsProposal } from '@youre-on/shared/negotiation';
import type { DraftIssue } from '@youre-on/shared/judge/propose-terms';
import { sha256Hex } from '@youre-on/shared/primitives';
import { MarketRef, type Terms } from '@youre-on/shared/terms';
import type { AppDeps } from '../context';
import type { Tx } from '../lock/common';
import { BTC5M_SERIES } from './gemini';

/** The terms deadline of a market bet = expiry + 10 min (timeout_refund backstop). */
export const MARKET_DEADLINE_AFTER_EXPIRY_MS = 10 * 60_000;

export interface BindingQuote {
  ref: MarketRef;
  stakes: Terms['stakes'];
  snapshot: GeminiMarketSnapshot;
  /** jcs(snapshot) and its sha256: the binding quote's hash. */
  canonical: string;
  sha256: string;
  /** For the gemini_markets row. */
  contract: { contractTicker: string | null; windowStart: string | null };
}

export type QuoteOutcome = { ok: true; quote: BindingQuote } | { ok: false; reason: FairRefusal };

export type QuoteDeps = Pick<AppDeps, 'env'> & Partial<Pick<AppDeps, 'markets'>>;

/**
 * The devnet demo exception: real_world bets need the relay and ALLOW_P2P_REAL_WORLD (unset:
 * follows DEMO_MODE). SOLANA_CLUSTER can only be devnet or localnet (env.ts), so a mainnet escrow
 * never takes one.
 */
export function realWorldEnabled(deps: QuoteDeps): boolean {
  return !!deps.markets && (deps.env.ALLOW_P2P_REAL_WORLD ?? deps.env.DEMO_MODE);
}

export const maxStakeOf = (deps: Pick<AppDeps, 'env'>): bigint =>
  deps.env.MAX_STAKE_MICRO ? BigInt(deps.env.MAX_STAKE_MICRO) : MAX_STAKE;

/**
 * fairStakes over the relay's latest snapshot (MarketService.quote refetches a stale one once),
 * capped by max_stake, copied into a strict Terms.market (MarketRef). Never binds without the
 * strike.
 */
export async function takeBindingQuote(
  deps: QuoteDeps,
  i: { amount: MicroUsdc; side: 'YES' | 'NO' },
): Promise<QuoteOutcome> {
  if (!deps.markets) return { ok: false, reason: 'MARKET_NOT_OPEN' };
  const { result, snapshot } = await deps.markets.quote(i.amount, i.side);
  if (!result.ok) return { ok: false, reason: result.reason };
  if (!snapshot) return { ok: false, reason: 'MARKET_NOT_OPEN' };
  // Never bind an unknown line (fairStakes lets a not-yet-open window through).
  if (snapshot.strike.value === null) return { ok: false, reason: 'STRIKE_PENDING' };
  const max = maxStakeOf(deps);
  if (BigInt(result.stakes.a) > max || BigInt(result.stakes.b) > max)
    return { ok: false, reason: 'STAKE_ABOVE_MAX' };
  const ref = MarketRef.safeParse({
    venue: 'gemini',
    eventTicker: snapshot.eventTicker,
    instrumentSymbol: snapshot.instrumentSymbol,
    side: i.side,
    priceAtLock: result.priceAtLock,
    priceSource: result.priceSource,
    quotedAt: result.quotedAt,
    strike: snapshot.strike,
    expiry: snapshot.expiry,
  });
  // e.g. an expiry off the whole second: Gemini's contract, not ours to round.
  if (!ref.success) return { ok: false, reason: 'MARKET_NOT_OPEN' };
  const canonical = jcs(snapshot);
  const cur = deps.markets.contractOf(snapshot.eventTicker);
  return {
    ok: true,
    quote: {
      ref: ref.data,
      stakes: result.stakes,
      snapshot,
      canonical,
      sha256: sha256Hex(canonical),
      contract: {
        contractTicker: cur?.contract.ticker ?? null,
        windowStart: snapshot.strike.availableAt,
      },
    },
  };
}

/** A FairRefusal as the judge's DraftIssue (spoken via issueSay). */
export function refusalIssue(reason: FairRefusal): DraftIssue {
  const code: DraftIssue['code'] =
    reason === 'STAKE_ABOVE_MAX' || reason === 'STAKE_BELOW_MIN'
      ? reason
      : reason === 'SPREAD_TOO_WIDE' || reason === 'PRICE_OUT_OF_RANGE'
        ? 'MARKET_UNFAIR'
        : 'NO_MARKET';
  return { code, message: `gemini: ${reason}` };
}

/**
 * Inside the terms transaction: upserts the contract (gemini_markets, keyed by instrumentSymbol)
 * and stores the snapshot it was priced from (market_snapshots, with its JCS and sha256). The bet
 * points at both (gemini_market_id, pricing_snapshot_id).
 */
export async function persistQuote(
  tx: Tx,
  q: BindingQuote,
): Promise<{ marketId: string; snapshotId: bigint }> {
  const s = q.snapshot;
  const [m] = await tx
    .insert(geminiMarkets)
    .values({
      event_ticker: s.eventTicker,
      instrument_symbol: s.instrumentSymbol,
      contract_ticker: q.contract.contractTicker,
      series: BTC5M_SERIES,
      title: s.eventTitle,
      strike: s.strike.value,
      window_start: q.contract.windowStart ? new Date(q.contract.windowStart) : null,
      expires_at: new Date(s.expiry),
      status: s.status,
    })
    .onConflictDoUpdate({
      target: geminiMarkets.instrument_symbol,
      set: {
        // the latched line never changes once known; the status follows Gemini
        strike: sql`coalesce(${geminiMarkets.strike}, excluded.strike)`,
        status: sql`CASE WHEN ${geminiMarkets.status} IN ('settled','invalid')
                         THEN ${geminiMarkets.status} ELSE excluded.status END`,
        updated_at: sql`now()`,
      },
    })
    .returning({ id: geminiMarkets.id });
  const [snap] = await tx
    .insert(marketSnapshots)
    .values({
      market_id: m!.id,
      captured_at: new Date(s.observedAt),
      exchange_ts: s.exchangeTs ? new Date(s.exchangeTs) : null,
      source: s.source,
      best_bid: s.bestBid,
      best_ask: s.bestAsk,
      last_price: s.lastTradePrice,
      index_price: s.indexPrice,
      snapshot_canonical: q.canonical,
      snapshot_sha256: q.sha256,
    })
    .returning({ id: marketSnapshots.id });
  return { marketId: m!.id, snapshotId: snap!.id };
}

/**
 * The judge-owned proposal behind a market bet's terms, for the re-quote at confirm once the
 * quote is older than MARKET_CONFIRM_MAX_AGE_MS: the same side and even-money amount (pot / 2).
 * A server-written claim follows the new contract's expiry.
 */
export function requoteProposal(t: Terms): TermsProposal {
  if (!t.market) throw new Error('requoteProposal: not a market bet');
  const pot = BigInt(t.stakes.a) + BigInt(t.stakes.b);
  return {
    type: t.type,
    claim: t.claim,
    performer: t.performer,
    yes_party: t.yes_party,
    attempts: t.attempts,
    success_criteria: t.success_criteria,
    failure_criteria: t.failure_criteria,
    edge_cases: t.edge_cases,
    evidence_source: t.evidence_source,
    amount: (pot / 2n).toString(),
    amount_b: null,
    market_query: { asset: 'BTC', horizon: '5m', a_side: t.market.side },
    deadline_minutes: null,
  };
}

/** True when the claim is the server's template (so a re-quote may rewrite its expiry). */
export const isTemplateClaim = (t: Terms): boolean =>
  t.market !== null && t.claim === marketClaim(t.market.expiry, t.market.eventTicker);
