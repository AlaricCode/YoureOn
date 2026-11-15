import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WorldPrice } from '../src/providers/types.js';
import { normalizeContract, normalizeEvent, probBpsFromPrices } from '../src/providers/real/geminiNormalize.js';
import { GEMINI_EVENTS_PATH, LiveGemini, LiveHedge, TopOfBook, type PriceSocket } from '../src/providers/real/world.js';
import { ManualClock } from '../src/util/clock.js';

/** Captured from the live API (2026-11-08), trimmed. */
const LIVE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gemini-live-events.json', import.meta.url)), 'utf8')) as {
  data: Record<string, unknown>[];
};

describe('Gemini normalization (§11.1)', () => {
  it('maps live API events: ids, prices → prob_bps, status, resolution', () => {
    const now = Date.parse('2026-11-08T06:00:00Z');
    const evs = LIVE.data.map((e) => normalizeEvent(e, now)!);
    const [btc, heisman, settled] = evs;
    expect(btc).toMatchObject({ id: 'BTC2611080700', category: 'Crypto', status: 'open', close_time_ms: Date.parse('2026-11-08T07:00:00.000Z') });
    expect(btc!.contracts[0]!.id).toBe('GEMI-BTC2611080700-HI75600');
    let mids = 0;
    for (const c of [...btc!.contracts, ...heisman!.contracts]) {
      if (c.bid_bps === undefined || c.ask_bps === undefined) continue; // one-sided book: last trade
      expect(c.prob_bps).toBe(Math.floor((c.bid_bps + c.ask_bps) / 2));
      mids++;
    }
    expect(mids).toBeGreaterThan(3);
    expect(settled).toMatchObject({ id: 'BTC2611080200', status: 'resolved' });
    expect(settled!.resolution).toEqual(settled!.contracts.map((c) => ({ contract_id: c.id, result: 'yes' })));
    expect(settled!.contracts.every((c) => c.prob_bps === 10000 && c.bid_bps === undefined)).toBe(true);
    // past expiry ⇒ closed even if the API still says active
    expect(normalizeEvent(LIVE.data[0], Date.parse('2026-11-09T00:00:00Z'))!.status).toBe('closed');
    expect(normalizeEvent({ ...LIVE.data[1], status: 'under_review' }, now)!.status).toBe('closed');
    expect(normalizeEvent({ id: 1 }, now)).toBeNull();
  });

  it('prob_bps: mid of bid/ask, else last trade, else ask; settled sides; void', () => {
    expect(probBpsFromPrices(0.78, 0.79, 0.5)).toBe(7850);
    expect(probBpsFromPrices(null, 0.3, 0.25)).toBe(2500);
    expect(probBpsFromPrices(null, 0.3, null)).toBe(3000);
    expect(probBpsFromPrices(0.3, null, null)).toBeNull();
    expect(normalizeContract({ id: 'x', label: 'X', prices: { bestBid: '0.1', bestAsk: '0.2' } })).toEqual({ id: 'x', label: 'X', prob_bps: 1500, bid_bps: 1000, ask_bps: 2000 });
    expect(normalizeContract({ id: 'x', resolutionSide: 'no' })!.prob_bps).toBe(0);
    const ev = normalizeEvent({ ticker: 'T', title: 't', status: 'settled', expiryDate: '2026-01-01T00:00:00Z', contracts: [{ id: 'c1', instrumentSymbol: 'S1' }] }, 0)!;
    expect(ev.resolution).toEqual([{ contract_id: 'S1', result: 'void' }]);
  });
});

describe('LiveGemini (fake fetch / sockets, no network)', () => {
  function fakeFetch(calls: string[]) {
    return (async (url: string) => {
      calls.push(url);
      if (url.includes('/events/GONE')) return new Response(JSON.stringify({ error: 'Event not found' }), { status: 404 });
      if (url.includes('/events/BTC2611080700')) return new Response(JSON.stringify(LIVE.data[0]));
      if (url.includes(`${GEMINI_EVENTS_PATH}?`)) return new Response(JSON.stringify({ data: LIVE.data, pagination: {} }));
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
  }

  it('lists (active, search, limit), gets by ticker, 404 ⇒ null, errors throw', async () => {
    const calls: string[] = [];
    const clock = new ManualClock(Date.parse('2026-11-08T06:00:00Z'));
    const g = new LiveGemini('https://api.gemini.com', { fetch: fakeFetch(calls), clock });
    const list = await g.listEvents('bitcoin', 500);
    expect(list.map((e) => e.id)).toEqual(['BTC2611080700', 'CFBHEISMAN2627', 'BTC2611080200']);
    expect(calls[0]).toBe('https://api.gemini.com/v1/prediction-markets/events?limit=100&status=active&search=bitcoin');
    expect((await g.getEvent('BTC2611080700'))!.contracts).toHaveLength(3);
    expect(await g.getEvent('GONE')).toBeNull();
    await expect(g.getEvent('BOOM')).rejects.toThrow(/HTTP 500/);
    expect(g.marketDataUrl('GEMI-X')).toBe('wss://api.gemini.com/v1/marketdata/GEMI-X?top_of_book=true&trades=true');
  });

  it('top of book → prob_bps updates; one socket per contract; unsubscribe closes', async () => {
    const book = new TopOfBook();
    expect(book.apply({ type: 'update', events: [{ type: 'change', side: 'ask', price: '0.79', remaining: '10' }, { type: 'change', side: 'bid', price: '0.78', remaining: '5' }] })).toBe(true);
    expect(book.probBps()).toBe(7850);
    expect(book.apply({ type: 'update', events: [{ type: 'change', side: 'bid', price: '0.78', remaining: '0' }] })).toBe(true);
    expect(book.probBps()).toBe(7900);
    expect(book.apply({ type: 'heartbeat' })).toBe(false);

    const sockets: { url: string; handlers: Record<string, ((x?: unknown) => void)[]>; closed: boolean }[] = [];
    const open = (url: string): PriceSocket => {
      const s = { url, handlers: {} as Record<string, ((x?: unknown) => void)[]>, closed: false };
      sockets.push(s);
      return {
        on: (ev: string, fn: (x?: unknown) => void) => {
          (s.handlers[ev] ??= []).push(fn);
        },
        close: () => {
          s.closed = true;
        },
      } as PriceSocket;
    };
    const clock = new ManualClock(Date.parse('2026-11-08T06:00:00Z'));
    const g = new LiveGemini('https://api.gemini.com', { fetch: fakeFetch([]), openSocket: open, clock });
    const prices: WorldPrice[] = [];
    const unsub = g.subscribePrices('BTC2611080700', (p) => prices.push(p));
    for (let i = 0; i < 20 && sockets.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(sockets.map((s) => s.url.split('/').pop())).toEqual([
      'GEMI-BTC2611080700-HI75600?top_of_book=true&trades=true',
      'GEMI-BTC2611080700-HI75700?top_of_book=true&trades=true',
      'GEMI-BTC2611080700-HI75800?top_of_book=true&trades=true',
    ]);
    sockets[1]!.handlers['message']![0]!(JSON.stringify({ type: 'update', events: [{ type: 'trade', price: '0.66' }] }));
    sockets[1]!.handlers['message']![0]!('not json');
    expect(prices).toEqual([{ event_id: 'BTC2611080700', contract_id: 'GEMI-BTC2611080700-HI75700', prob_bps: 6600, at_ms: clock.nowMs() }]);
    unsub();
    expect(sockets.every((s) => s.closed)).toBe(true);
  });

  it('live hedge needs ALLOW_SPEND and then the demo OAuth config (SPEND_DISABLED)', async () => {
    expect(() => new LiveHedge({ allowSpend: false })).toThrow(/ALLOW_SPEND/);
    await expect(new LiveHedge({ allowSpend: true }).placeOrder()).rejects.toMatchObject({ code: 'SPEND_DISABLED' });
  });
});
