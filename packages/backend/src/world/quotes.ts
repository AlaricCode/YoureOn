/**
 * World Mode quotes (§11.2, §11.3, §12.3 POST /world/quote):
 *   {legs: [{event_id, contract_id, side}], total_units}
 *   → {quote_id, p_bps, proposer_units, counterparty_units, legs: [{…, prob_bps}], expires_at_ms}
 * Prices come from the Gemini provider at quote time; the split uses the
 * engine (parlayProb over the proposer-side probabilities, then stakeSplit,
 * which clamps). Quotes live QUOTE_TTL_MS; after that POST /world/bets
 * answers QUOTE_EXPIRED.
 */
import { MAX_PARLAY_LEGS, WorldMathError, clampProb, parlayProb, sideProb, stakeSplit, type MarketPick, type MarketSide } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { COLLECTIONS } from '../persistence/records.js';
import type { WorldEvent } from '../providers/types.js';
import { badRequest } from '../routes/util.js';
import { uuid } from '../util/ids.js';

export const QUOTE_TTL_MS = 30_000;

export interface QuoteLeg {
  event_id: string;
  contract_id: string;
  side: MarketSide;
  /** contract "yes" probability at quote time */
  prob_bps: number;
  event_title: string;
  contract_label: string;
  close_time_ms: number;
}

export interface QuoteRecord {
  quote_id: string;
  user_id: string;
  legs: QuoteLeg[];
  total_units: number;
  /** clamped proposer win probability */
  p_bps: number;
  proposer_units: number;
  counterparty_units: number;
  created_at_ms: number;
  expires_at_ms: number;
  /** set once a bet was created from it (single use) */
  used_by_bet: string | null;
}

export interface QuoteView {
  quote_id: string;
  p_bps: number;
  proposer_units: number;
  counterparty_units: number;
  legs: { event_id: string; contract_id: string; side: MarketSide; prob_bps: number; event_title: string; contract_label: string; close_time_ms: number }[];
  expires_at_ms: number;
}

export function quoteView(q: QuoteRecord): QuoteView {
  return {
    quote_id: q.quote_id,
    p_bps: q.p_bps,
    proposer_units: q.proposer_units,
    counterparty_units: q.counterparty_units,
    legs: q.legs.map((l) => ({ ...l })),
    expires_at_ms: q.expires_at_ms,
  };
}

export function quotePicks(q: QuoteRecord): MarketPick[] {
  return q.legs.map((l) => ({
    event_id: l.event_id,
    contract_id: l.contract_id,
    side: l.side,
    prob_bps: l.prob_bps,
    close_time_ms: l.close_time_ms,
    event_title: l.event_title,
  }));
}

interface LegReq {
  event_id: string;
  contract_id: string;
  side: MarketSide;
}

export function parseQuoteRequest(body: Record<string, unknown>): { legs: LegReq[]; total_units: number } {
  const legs = body['legs'];
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > MAX_PARLAY_LEGS) throw badRequest(`legs must have 1..${MAX_PARLAY_LEGS} entries`);
  const out: LegReq[] = legs.map((l, i) => {
    const x = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    if (typeof x['event_id'] !== 'string' || !x['event_id'] || x['event_id'].length > 128) throw badRequest(`legs[${i}].event_id`);
    if (typeof x['contract_id'] !== 'string' || !x['contract_id'] || x['contract_id'].length > 128) throw badRequest(`legs[${i}].contract_id`);
    if (x['side'] !== 'yes' && x['side'] !== 'no') throw badRequest(`legs[${i}].side must be "yes" or "no"`);
    return { event_id: x['event_id'], contract_id: x['contract_id'], side: x['side'] };
  });
  const keys = new Set(out.map((l) => `${l.event_id}\u0000${l.contract_id}`));
  if (keys.size !== out.length) throw new ApiError('DRAFT_INVALID', 'parlay legs must be distinct contracts');
  const t = body['total_units'];
  if (!Number.isSafeInteger(t) || (t as number) <= 0) throw new ApiError('BAD_STAKE', 'total_units must be a positive integer');
  return { legs: out, total_units: t as number };
}

/** Looks up live prices and splits the pot. */
export async function createQuote(ctx: AppContext, userId: string, body: Record<string, unknown>): Promise<QuoteRecord> {
  const req = parseQuoteRequest(body);
  const events = new Map<string, WorldEvent>();
  const legs: QuoteLeg[] = [];
  for (const l of req.legs) {
    let ev = events.get(l.event_id);
    if (!ev) {
      const got = await ctx.providers.gemini.getEvent(l.event_id);
      if (!got) throw new ApiError('NOT_FOUND', `event ${l.event_id}`);
      ev = got;
      events.set(l.event_id, ev);
    }
    if (ev.status !== 'open' || ev.close_time_ms <= ctx.clock.nowMs()) throw new ApiError('WRONG_STATE', `event ${ev.id} is not open`);
    const c = ev.contracts.find((x) => x.id === l.contract_id);
    if (!c) throw new ApiError('NOT_FOUND', `contract ${l.contract_id}`);
    legs.push({ ...l, prob_bps: c.prob_bps, event_title: ev.title, contract_label: c.label, close_time_ms: ev.close_time_ms });
  }
  let P: number;
  let split;
  try {
    P = clampProb(parlayProb(legs.map((l) => sideProb(l.prob_bps, l.side))));
    split = stakeSplit(req.total_units, P);
  } catch (e) {
    if (e instanceof WorldMathError) throw new ApiError(e.code, e.message);
    throw e;
  }
  const now = ctx.clock.nowMs();
  const rec: QuoteRecord = {
    quote_id: uuid(),
    user_id: userId,
    legs,
    total_units: req.total_units,
    p_bps: P,
    proposer_units: Number(split.proposer_stake),
    counterparty_units: Number(split.counterparty_stake),
    created_at_ms: now,
    expires_at_ms: now + QUOTE_TTL_MS,
    used_by_bet: null,
  };
  ctx.store.collection<QuoteRecord>(COLLECTIONS.quotes).set(rec.quote_id, rec);
  return rec;
}
