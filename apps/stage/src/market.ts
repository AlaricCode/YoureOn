// The odds widget's numbers, derived purely from the latest `stage.market` snapshot
// (API-CONTRACT §3.1) with the shared fairStakes (SCHEMAS §8.2): strike, BTC price and its side
// of the line, time left, the implied Up %, and the fair split of a pot. When the focused bet is
// a real-world bet on this contract, its locked terms stakes are shown instead of a preview.
import { fairStakes, pctFromPrice, type GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import type { MicroUsdc } from '@youre-on/shared/money';
import type { BetView } from './ticker';

/** The preview split: $5 a side ($10 pot), the demo's default stake. */
export const PREVIEW_AMOUNT = '5000000' as MicroUsdc;

export type SplitView =
  | { ok: true; up: string; down: string; pot: string; fromTerms: boolean }
  | { ok: false; reason: string };

export interface MarketView {
  eventTicker: string;
  strike: string | null;
  price: string | null;
  /** BTC vs the line: 'up' at or above (YES wins), 'down' below, 'flat' if unknown. */
  direction: 'up' | 'down' | 'flat';
  msLeft: number;
  upPct: number | null;
  history: number[];
  split: SplitView;
}

function midPct(s: GeminiMarketSnapshot): number | null {
  if (s.bestBid === null || s.bestAsk === null) return null;
  try {
    const pct = Number((pctFromPrice(s.bestBid) + pctFromPrice(s.bestAsk)) / 2n);
    return pct > 0 && pct < 100 ? pct : null;
  } catch {
    return null;
  }
}

export function marketView(
  snap: GeminiMarketSnapshot,
  history: ReadonlyArray<{ price: number }>,
  nowMs: number,
  bet: BetView | null,
): MarketView {
  const strike = snap.strike.value;
  const price = snap.indexPrice;
  const direction =
    strike === null || price === null ? 'flat' : Number(price) >= Number(strike) ? 'up' : 'down';
  let split: SplitView;
  const terms = bet?.envelope?.terms;
  if (terms?.market && terms.market.eventTicker === snap.eventTicker) {
    const aUp = terms.market.side === 'YES';
    const pot = (BigInt(terms.stakes.a) + BigInt(terms.stakes.b)).toString();
    split = {
      ok: true,
      up: aUp ? terms.stakes.a : terms.stakes.b,
      down: aUp ? terms.stakes.b : terms.stakes.a,
      pot,
      fromTerms: true,
    };
  } else {
    let r: ReturnType<typeof fairStakes>;
    try {
      r = fairStakes(snap, PREVIEW_AMOUNT, 'YES', nowMs);
    } catch {
      r = { ok: false, reason: 'NO_TWO_SIDED_QUOTE' };
    }
    split = r.ok
      ? {
          ok: true,
          up: r.stakes.a,
          down: r.stakes.b,
          pot: (2n * BigInt(PREVIEW_AMOUNT)).toString(),
          fromTerms: false,
        }
      : { ok: false, reason: r.reason };
  }
  return {
    eventTicker: snap.eventTicker,
    strike,
    price,
    direction,
    msLeft: Math.max(0, Date.parse(snap.expiry) - nowMs),
    upPct: midPct(snap),
    history: history.map((h) => h.price),
    split,
  };
}
