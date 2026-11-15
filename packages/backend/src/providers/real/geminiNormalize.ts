/**
 * Gemini prediction-markets public API → §11.1 WorldEvent (non-consensus
 * adapter math). Verified against the live API on 2026-11-08:
 *   GET /v1/prediction-markets/events?limit=&offset=&status=&search=&category=
 *       → { data: Event[], pagination: { limit, offset, total } }
 *       status ∈ active | approved | under_review | settled
 *   GET /v1/prediction-markets/events/{ticker} → Event (404 {"error":"Event not found"})
 *   Event    { id, ticker, title, category, status, expiryDate (ISO), contracts: Contract[], … }
 *   Contract { id, label, instrumentSymbol, status, marketState ("open"|"closed"),
 *              prices?: { bestBid, bestAsk, lastTradePrice, buy:{yes,no}, sell:{yes,no} } (decimal strings),
 *              expiryDate, resolutionSide?: "yes"|"no", resolvedAt? }
 * Ids: WorldEvent.id = event `ticker` (the only key GET /events/{id} accepts);
 * WorldContract.id = `instrumentSymbol` (also the market-data WS symbol).
 */
import type { WorldContract, WorldEvent } from '../types.js';

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x);

/** Decimal-string or number price in [0,1] → number, else null. */
export function priceOf(x: unknown): number | null {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** p ∈ [0,1] → round(p·10000) (§11.1). */
export const bpsOf = (p: number): number => Math.round(p * 10000);

/** §11.1 prob_bps from Gemini dollar prices: mid of bid/ask, else last trade, else ask. */
export function probBpsFromPrices(bid: number | null, ask: number | null, last: number | null): number | null {
  if (bid !== null && ask !== null) return Math.floor((bpsOf(bid) + bpsOf(ask)) / 2);
  if (last !== null) return bpsOf(last);
  if (ask !== null) return bpsOf(ask);
  return null;
}

function timeOf(x: unknown): number | null {
  if (typeof x !== 'string') return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}

export function normalizeContract(c: Rec): WorldContract | null {
  const id = typeof c['instrumentSymbol'] === 'string' && c['instrumentSymbol'] ? c['instrumentSymbol'] : c['id'] != null ? String(c['id']) : null;
  if (!id) return null;
  const prices = isRec(c['prices']) ? c['prices'] : {};
  const bid = priceOf(prices['bestBid']);
  const ask = priceOf(prices['bestAsk']);
  const last = priceOf(prices['lastTradePrice']);
  let prob = probBpsFromPrices(bid, ask, last);
  if (prob === null) {
    const side = c['resolutionSide'];
    prob = side === 'yes' ? 10000 : side === 'no' ? 0 : (() => {
      const buyYes = isRec(prices['buy']) ? priceOf((prices['buy'] as Rec)['yes']) : null;
      return buyYes === null ? 0 : bpsOf(buyYes);
    })();
  }
  const out: WorldContract = { id, label: typeof c['label'] === 'string' ? c['label'] : id, prob_bps: prob };
  if (bid !== null) out.bid_bps = bpsOf(bid);
  if (ask !== null) out.ask_bps = bpsOf(ask);
  return out;
}

/** Normalizes one API event; null if it lacks an id or contracts. */
export function normalizeEvent(e: unknown, nowMs: number): WorldEvent | null {
  if (!isRec(e)) return null;
  const id = typeof e['ticker'] === 'string' && e['ticker'] ? e['ticker'] : e['id'] != null ? String(e['id']) : null;
  if (!id) return null;
  const pairs = (Array.isArray(e['contracts']) ? e['contracts'].filter(isRec) : [])
    .map((raw) => ({ raw, c: normalizeContract(raw) }))
    .filter((x): x is { raw: Rec; c: WorldContract } => x.c !== null);
  const rawContracts = pairs.map((x) => x.raw);
  const contracts = pairs.map((x) => x.c);
  if (contracts.length === 0) return null;
  const close =
    timeOf(e['expiryDate']) ??
    rawContracts.map((c) => timeOf(c['expiryDate'])).reduce<number | null>((a, b) => (b === null ? a : a === null ? b : Math.max(a, b)), null) ??
    0;
  const apiStatus = typeof e['status'] === 'string' ? e['status'] : 'active';
  const allClosed = rawContracts.length > 0 && rawContracts.every((c) => c['marketState'] === 'closed' || c['status'] === 'settled');
  let status: WorldEvent['status'];
  if (apiStatus === 'settled') status = 'resolved';
  else if (apiStatus === 'under_review' || allClosed || (close > 0 && close <= nowMs)) status = 'closed';
  else status = 'open';
  const ev: WorldEvent = {
    id,
    title: typeof e['title'] === 'string' ? e['title'] : id,
    category: typeof e['category'] === 'string' ? e['category'] : 'Other',
    close_time_ms: close,
    status,
    contracts,
  };
  if (status === 'resolved') {
    ev.resolution = pairs.map(({ raw, c }) => {
      const side = raw['resolutionSide'];
      return { contract_id: c.id, result: side === 'yes' ? 'yes' : side === 'no' ? 'no' : 'void' };
    });
  }
  return ev;
}
