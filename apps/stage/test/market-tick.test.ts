// market.tick (API-CONTRACT §3.4: 1 Hz per Gemini bet, persisted) is chatter: ~200 s of it must
// not evict the chain / tx rows from the ticker (MAX_EVENTS), and a bet first seen through a tick
// (the stage reloaded while the bet is AWAITING_MARKET) must still get subscribed and fetched.
import { describe, expect, it } from 'vitest';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { previewAt } from '../src/preview';
import {
  applyFrame,
  initialTicker,
  MAX_EVENTS,
  unseededBets,
  type TickerState,
} from '../src/ticker';
import { tickerRows } from '../src/view';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const BTC = 'c41e8f20-3d5b-4a7c-9e1f-2a3b4c5d6e7f'; // the preview's Gemini bet
const OTHER = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
const snapshot: GeminiMarketSnapshot = {
  eventTicker: 'BTC05M2611201505',
  eventTitle: 'BTC 5-minute',
  instrumentSymbol: 'GEMI-BTC05M2611201505-UP',
  contractLabel: 'Up',
  status: 'active',
  marketState: 'open',
  strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-20T15:00:00.000Z' },
  expiry: '2026-11-20T15:05:00.000Z',
  bestBid: '0.56',
  bestAsk: '0.66',
  lastTradePrice: null,
  indexPrice: '64404.00',
  source: 'rest_event',
  exchangeTs: null,
  observedAt: '2026-11-20T15:01:00.000Z',
};
const tick = (betId: string, seq: number, at: number) => ({
  v: 1,
  type: 'market.tick',
  bet_id: betId,
  seq,
  ts: new Date(at).toISOString(),
  source: 'server',
  payload: { snapshot },
});
const apply = (s: TickerState, raw: unknown, at: number) =>
  applyFrame(s, { kind: 'frame', raw, receivedAt: at });

describe('market.tick', () => {
  it('210 ticks (Beat 6) keep every chain / tx row in the ticker', () => {
    const f = previewAt(START, START, 'market');
    let s = f.state;
    const rows = tickerRows(s).length;
    expect(rows).toBeGreaterThan(5);
    const from = s.lastSeq[BTC]!;
    for (let i = 1; i <= 210; i++)
      s = apply(s, tick(BTC, from + i, f.now + i * 1000), f.now + i * 1000);
    expect(210).toBeGreaterThan(MAX_EVENTS);
    expect(tickerRows(s)).toHaveLength(rows);
    expect(s.events.some((e) => e.type === 'market.tick')).toBe(false);
    expect(s.lastSeq[BTC]).toBe(from + 210);
    expect(s.focusBetId).toBe(f.state.focusBetId);
    expect(s.bets[BTC]).toBe(f.state.bets[BTC]); // the card is untouched
  });

  it('duplicates and replayed ticks are dropped by lastSeq', () => {
    let s = apply(initialTicker, tick(BTC, 5, START), START);
    const once = s;
    s = apply(s, tick(BTC, 5, START), START + 1);
    expect(s).toBe(once);
    s = apply(s, tick(BTC, 3, START), START + 2); // a seq-0 replay's old tick
    expect(s).toBe(once);
    s = apply(s, tick(BTC, 6, START), START + 3);
    expect(s.lastSeq[BTC]).toBe(6);
  });

  it('a bet first seen through a tick is known, so the App subscribes and fetches it', () => {
    const s = apply(initialTicker, tick(BTC, 40, START), START);
    expect(s.focusBetId).toBe(BTC);
    expect(s.bets[BTC]?.bet_id).toBe(BTC);
    expect(unseededBets(s, new Set())).toEqual([BTC]);
    // a tick of another bet never moves the focus
    const t = apply(s, tick(OTHER, 2, START + 1000), START + 1000);
    expect(t.focusBetId).toBe(BTC);
    expect(unseededBets(t, new Set([BTC]))).toEqual([OTHER]);
  });
});
