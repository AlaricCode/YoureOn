// Gemini BTC 5-min relay (API-CONTRACT §2.13, §7.3) against a fake fetch that answers with real
// recorded Gemini responses (fixtures/gemini-btc5m.json), including a real contract rollover.
// No network, no DB.
import { describe, expect, it } from 'vitest';
import { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import {
  cleanDecimal,
  createGeminiClient,
  GeminiError,
  nextWindowStart,
  pickCurrent,
  RawEvent,
  toSnapshot,
} from '../src/markets/gemini';
import { MarketService } from '../src/markets/service';
import { silentLogger } from '../src/log';
import {
  clone,
  EVENTS_PATH,
  eventPath,
  fakeGemini,
  GEMINI_FIXTURE as F,
  strikePath,
  T0237,
  T0241,
  TICKER_PATH,
} from './gemini-fake';

const events = (list: { data: unknown[] }) => list.data.map((e) => RawEvent.parse(e));
const at = (iso: string) => Date.parse(iso);

function harness(routes: Record<string, unknown>, start: number) {
  const g = fakeGemini(routes);
  const clock = { t: start };
  const svc = new MarketService({
    client: createGeminiClient({ fetch: g.fetch }),
    now: () => clock.t,
    log: silentLogger,
  });
  const seen: GeminiMarketSnapshot[] = [];
  svc.onSnapshot((s) => seen.push(s));
  return { g, clock, svc, seen };
}

describe('gemini parsing (recorded responses)', () => {
  it('pickCurrent: effectiveDate <= now < expiryDate, series BTC05M only', () => {
    const list = events(F.events_0237);
    expect(list.some((e) => e.series !== 'BTC05M')).toBe(true);
    expect(pickCurrent(list, T0237)?.event.ticker).toBe('BTC05M2611180240');
    // the boundary belongs to the next window
    expect(pickCurrent(list, at('2026-11-18T02:40:00.000Z'))?.event.ticker).toBe(
      'BTC05M2611180245',
    );
    expect(pickCurrent(list, at('2026-11-18T03:30:00.000Z'))).toBeNull();
    expect(nextWindowStart(list, at('2026-11-18T02:40:00.000Z'))).toBe('2026-11-18T02:40:00.000Z');
  });

  it('toSnapshot gives a valid shared GeminiMarketSnapshot; a missing strike value is null', () => {
    const list = events(F.events_0237);
    const live = pickCurrent(list, T0237)!;
    const s = toSnapshot(live.event, live.contract, {
      observedAtMs: T0237,
      latchedStrike: null,
      indexPrice: '64379.76',
    });
    expect(GeminiMarketSnapshot.parse(s)).toEqual(s);
    expect(s).toMatchObject({
      eventTicker: 'BTC05M2611180240',
      instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
      contractLabel: 'Up',
      status: 'active',
      marketState: 'open',
      strike: { type: 'reference', value: '64389.6', availableAt: '2026-11-18T02:35:00.000Z' },
      expiry: '2026-11-18T02:40:00.000Z',
      bestBid: '0.54',
      bestAsk: '0.67',
      lastTradePrice: null,
      source: 'rest_event',
    });
    const next = pickCurrent(list, at('2026-11-18T02:40:01.000Z'))!;
    const pending = toSnapshot(next.event, next.contract, {
      observedAtMs: T0237,
      latchedStrike: null,
      indexPrice: null,
    });
    expect(pending.strike.value).toBeNull(); // the key is absent in Gemini's body
    const latched = toSnapshot(next.event, next.contract, {
      observedAtMs: T0237,
      latchedStrike: '64367.38',
      indexPrice: null,
    });
    expect(latched.strike.value).toBe('64367.38');
  });

  it('a settled event (no bestBid/bestAsk) still parses', () => {
    const e = RawEvent.parse(F.event_0240_settled);
    const s = toSnapshot(e, e.contracts[0]!, {
      observedAtMs: T0241,
      latchedStrike: null,
      indexPrice: null,
    });
    expect(s).toMatchObject({ status: 'settled', marketState: 'closed', bestBid: null });
    expect(GeminiMarketSnapshot.safeParse(s).success).toBe(true);
  });

  it('cleanDecimal trims trailing zeros and rejects junk', () => {
    expect(cleanDecimal('64378.84000')).toBe('64378.84');
    expect(cleanDecimal('0.50')).toBe('0.5');
    expect(cleanDecimal('10')).toBe('10');
    expect(cleanDecimal(97250.5)).toBe('97250.5');
    expect(cleanDecimal('-1')).toBeNull();
    expect(cleanDecimal('1e5')).toBeNull();
    expect(cleanDecimal(undefined)).toBeNull();
  });

  it('client: 2 s deadline -> GeminiError timeout; HTTP error -> http', async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
      })) as unknown as typeof fetch;
    const c = createGeminiClient({ fetch: hang, timeoutMs: 30 });
    await expect(c.getBtcUsd()).rejects.toMatchObject({ kind: 'timeout' });
    const g = fakeGemini({ [TICKER_PATH]: 503 });
    await expect(createGeminiClient({ fetch: g.fetch }).getBtcUsd()).rejects.toBeInstanceOf(
      GeminiError,
    );
  });
});

describe('MarketService relay', () => {
  it('discovers, latches the strike, quotes fair stakes, then follows the 02:40 rollover', async () => {
    const h = harness(
      {
        [EVENTS_PATH]: F.events_0237,
        [eventPath('BTC05M2611180240')]: F.event_0240_active,
        [TICKER_PATH]: F.btcusd,
      },
      T0237,
    );
    const s1 = await h.svc.refresh();
    expect(s1).toMatchObject({
      eventTicker: 'BTC05M2611180240',
      strike: { value: '64389.6' },
      indexPrice: '64379.76',
      observedAt: new Date(T0237).toISOString(),
    });
    expect(h.g.calls).toEqual(expect.arrayContaining([EVENTS_PATH, TICKER_PATH]));

    const cur = h.svc.current();
    expect(cur).toMatchObject({
      window: { start: '2026-11-18T02:35:00.000Z', expiry: '2026-11-18T02:40:00.000Z' },
      strike_known: true,
      lockable: true,
      lockable_until: '2026-11-18T02:38:00.000Z',
      recommended_lock_by: '2026-11-18T02:36:30.000Z',
      refusal: null,
      next_window_start: '2026-11-18T02:40:00.000Z',
    });

    // bid .54 / ask .67 -> mid .605 -> 61 %: YES takes 61 % of the $10 pot
    const q = await h.svc.quote('5000000', 'YES');
    expect(q.result).toEqual({
      ok: true,
      priceAtLock: '0.61',
      priceSource: 'mid',
      quotedAt: new Date(T0237).toISOString(),
      stakes: { a: '6100000', b: '3900000', currency: 'USDC' },
    });
    const qNo = await h.svc.quote('5000000', 'NO');
    expect(qNo.result.ok && qNo.result.stakes).toEqual({
      a: '3900000',
      b: '6100000',
      currency: 'USDC',
    });

    // 2 s later: no re-discovery, just the event refresh (fresher prices from the detail call)
    h.clock.t += 2_000;
    h.g.calls.length = 0;
    const s2 = await h.svc.refresh();
    expect(h.g.calls).toEqual(expect.arrayContaining([eventPath('BTC05M2611180240'), TICKER_PATH]));
    expect(h.g.calls).not.toContain(EVENTS_PATH);
    expect(s2).toMatchObject({ bestBid: '0.56', bestAsk: '0.69' });

    // inside T-120 s: not lockable any more
    h.clock.t = at('2026-11-18T02:38:30.000Z');
    await h.svc.refresh();
    expect(h.svc.current()).toMatchObject({ lockable: false, refusal: 'TOO_CLOSE_TO_EXPIRY' });

    // rollover: the 02:40 contract expired; the next poll re-discovers the 02:45 one
    h.g.routes.set(EVENTS_PATH, F.events_0241);
    h.g.routes.set(eventPath('BTC05M2611180245'), F.event_0245_active);
    h.clock.t = T0241;
    h.g.calls.length = 0;
    const s3 = await h.svc.refresh();
    expect(h.g.calls).toContain(EVENTS_PATH);
    expect(s3).toMatchObject({
      eventTicker: 'BTC05M2611180245',
      instrumentSymbol: 'GEMI-BTC05M2611180245-UP',
      strike: { value: '64367.38' },
      expiry: '2026-11-18T02:45:00.000Z',
    });
    expect(h.svc.rollovers).toBe(1);
    expect(h.seen.map((s) => s.eventTicker)).toEqual([
      'BTC05M2611180240',
      'BTC05M2611180240',
      'BTC05M2611180240',
      'BTC05M2611180245',
    ]);
    // bid .11 / ask .20 at 02:41:57 -> 16 % (in range): lockable until 02:43:00
    expect(h.svc.current()).toMatchObject({ lockable: true, refusal: null });
    expect(h.svc.ring.length).toBe(4);
  });

  it('strike pending: refuses STRIKE_PENDING, latches from /strike, keeps the latch', async () => {
    const t = at('2026-11-18T02:40:01.000Z');
    const noValue = clone(F.event_0245_active) as { contracts: Array<{ strike: object }> };
    noValue.contracts[0]!.strike = { type: 'reference', availableAt: '2026-11-18T02:40:00.000Z' };
    const h = harness(
      {
        [EVENTS_PATH]: F.events_0237, // 02:45 contract listed without a strike value yet
        [eventPath('BTC05M2611180245')]: noValue,
        [strikePath('BTC05M2611180245')]: F.strike_0245_pending,
        [TICKER_PATH]: F.btcusd,
      },
      t,
    );
    const s1 = await h.svc.refresh();
    expect(s1?.eventTicker).toBe('BTC05M2611180245');
    expect(s1?.strike.value).toBeNull();
    expect(h.g.calls).toContain(strikePath('BTC05M2611180245'));
    expect(h.svc.current()).toMatchObject({ strike_known: false, refusal: 'STRIKE_PENDING' });
    const q = await h.svc.quote('5000000', 'YES');
    expect(q.result).toEqual({ ok: false, reason: 'STRIKE_PENDING' });

    h.g.routes.set(strikePath('BTC05M2611180245'), {
      ...F.strike_0245_pending,
      value: '64367.38',
    });
    h.clock.t += 2_000;
    const s2 = await h.svc.refresh();
    expect(s2?.strike.value).toBe('64367.38');

    // the event body still lacks the value: the latch holds and /strike is not asked again
    h.g.calls.length = 0;
    h.clock.t += 2_000;
    const s3 = await h.svc.refresh();
    expect(s3?.strike.value).toBe('64367.38');
    expect(h.g.calls).not.toContain(strikePath('BTC05M2611180245'));
  });

  it('upstream failures: keeps the last snapshot, reports lastError, then refuses QUOTE_STALE', async () => {
    const h = harness(
      {
        [EVENTS_PATH]: F.events_0237,
        [eventPath('BTC05M2611180240')]: 500,
        [TICKER_PATH]: 'throw',
      },
      T0237,
    );
    const s1 = await h.svc.refresh();
    expect(s1?.indexPrice).toBeNull(); // the ticker failing never blocks the market
    h.clock.t += 3_000;
    await expect(h.svc.refresh()).resolves.toEqual(s1);
    expect(h.svc.lastError).toMatch(/HTTP 500/);
    h.clock.t += 3_000; // observedAt is now 6 s old
    const q = await h.svc.quote('5000000', 'YES');
    expect(q.result).toEqual({ ok: false, reason: 'QUOTE_STALE' });
  });

  it('no live contract: MarketCurrent says MARKET_NOT_OPEN; concurrent refreshes share one poll', async () => {
    const h = harness({ [EVENTS_PATH]: { data: [] }, [TICKER_PATH]: F.btcusd }, T0237);
    await Promise.all([h.svc.refresh(), h.svc.refresh(), h.svc.refresh()]);
    expect(h.g.calls.filter((c) => c === EVENTS_PATH)).toHaveLength(1);
    expect(h.svc.current()).toMatchObject({
      market: null,
      window: null,
      lockable: false,
      refusal: 'MARKET_NOT_OPEN',
    });
  });

  it('start() polls on a timer; stop() ends it', async () => {
    const g = fakeGemini({ [EVENTS_PATH]: F.events_0237, [TICKER_PATH]: F.btcusd });
    g.routes.set(eventPath('BTC05M2611180240'), F.event_0240_active);
    const svc = new MarketService({
      client: createGeminiClient({ fetch: g.fetch }),
      now: () => T0237,
      log: silentLogger,
      pollMs: 10,
    });
    svc.start();
    await expect.poll(() => g.calls.length, { timeout: 2000 }).toBeGreaterThan(6);
    await svc.stop();
    const n = g.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(g.calls.length).toBe(n);
    expect(svc.snapshot?.eventTicker).toBe('BTC05M2611180240');
  });
});
