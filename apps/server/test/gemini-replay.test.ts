// The REPLAY feed (markets/replay.ts): one recorded real Gemini round replayed onto the current
// window, labelled REPLAY on every surface, and the routed client the relay uses. No network, no DB.
import { describe, expect, it } from 'vitest';
import { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { classifyContract, settlementRecord, settlementRuling } from '@youre-on/shared/settlement';
import { marketClaim } from '@youre-on/shared/judge/market-terms';
import { RawEvent, type GeminiClient } from '../src/markets/gemini';
import {
  createReplayClient,
  createRoutedClient,
  isReplayTicker,
  replayBtcUsd,
  replayEventBody,
  replayExpiry,
  REPLAY_SETTLES_AFTER_MS,
  replaySymbol,
  replayTicker,
} from '../src/markets/replay';
import { REPLAY_RECORDING } from '../src/markets/replay-data';
import { MarketService } from '../src/markets/service';
import { GEMINI_FIXTURE as F } from './gemini-fake';
import { silentLogger } from '../src/log';

const at = (iso: string) => Date.parse(iso);
// A Thursday-evening window: 00:40-00:45 UTC on Nov 19.
const START = at('2026-11-19T00:40:00.000Z');
const EXPIRY = at('2026-11-19T00:45:00.000Z');
const TICKER = 'REPLAY-BTC05M2611190045';

describe('the recording', () => {
  it('is one settled real round: listed, next, active, settled, strike, BTC/USD', () => {
    const R = REPLAY_RECORDING;
    const ticker = R.ticker as string;
    expect(R.listed.ticker).toBe(ticker);
    expect(R.active.ticker).toBe(ticker);
    expect(R.settled.ticker).toBe(ticker);
    expect(RawEvent.parse(R.active).contracts[0]!.expiryDate).toBe(R.expiry);
    expect(Date.parse(RawEvent.parse(R.next_listed).contracts[0]!.effectiveDate)).toBe(
      Date.parse(R.expiry),
    );
    const settled = RawEvent.parse(R.settled).contracts[0]!;
    expect(classifyContract(settled).kind).toBe('settled');
    expect(Date.parse(R.expiry) - Date.parse(R.window_start)).toBe(300_000);
  });

  it('the shipped round is the recorded test fixture, byte for byte', () => {
    if (REPLAY_RECORDING.ticker !== 'BTC05M2611180240') return; // re-recorded since
    const listed = (t: string) => F.events_0237.data.find((e) => e.ticker === t);
    expect(REPLAY_RECORDING.active).toEqual(F.event_0240_active);
    expect(REPLAY_RECORDING.settled).toEqual(F.event_0240_settled);
    expect(REPLAY_RECORDING.strike).toEqual(F.strike_0240_known);
    expect(REPLAY_RECORDING.btcusd).toEqual(F.btcusd);
    expect(REPLAY_RECORDING.listed).toEqual(listed('BTC05M2611180240'));
    expect(REPLAY_RECORDING.next_listed).toEqual(listed('BTC05M2611180245'));
  });
});

describe('replay tickers', () => {
  it('name the window by its expiry, Gemini-style, and are always prefixed REPLAY-', () => {
    expect(replayTicker(EXPIRY)).toBe(TICKER);
    expect(replaySymbol(EXPIRY)).toBe('REPLAY-GEMI-BTC05M2611190045-UP');
    expect(replayExpiry(TICKER)).toBe(EXPIRY);
    expect(replayExpiry('BTC05M2611190045')).toBeNull();
    expect(isReplayTicker(TICKER)).toBe(true);
    expect(isReplayTicker('BTC05M2611190045')).toBe(false);
    expect(marketClaim('2026-11-19T00:45:00.000Z', TICKER)).toBe(
      'REPLAY: a recorded Gemini BTC 5-minute round, ending 00:45 UTC, resolves UP.',
    );
  });
});

describe('the replayed round', () => {
  it('discovery: the recorded round moved onto the current window, plus the next one', async () => {
    const t = { now: at('2026-11-19T00:42:10.000Z') };
    const c = createReplayClient({ now: () => t.now });
    const list = await c.listActiveCrypto();
    expect(list.map((e) => e.ticker)).toEqual([TICKER, 'REPLAY-BTC05M2611190050']);
    const [cur] = list;
    expect(cur).toMatchObject({ series: 'BTC05M', status: 'active' });
    expect(cur!.title).toMatch(/^REPLAY of a recorded Gemini round/);
    expect(cur!.contracts[0]).toMatchObject({
      instrumentSymbol: 'REPLAY-GEMI-BTC05M2611190045-UP',
      label: 'Up',
      effectiveDate: '2026-11-19T00:40:00.000Z',
      expiryDate: '2026-11-19T00:45:00.000Z',
      strike: { type: 'reference', value: '64389.6', availableAt: '2026-11-19T00:40:00.000Z' },
      prices: { bestBid: '0.54', bestAsk: '0.67' },
    });
  });

  it('the event: active until expiry, closed without a side, then settled "no" as recorded', async () => {
    const t = { now: at('2026-11-19T00:43:00.000Z') };
    const c = createReplayClient({ now: () => t.now });
    const active = await c.getEvent(TICKER);
    expect(active.contracts[0]).toMatchObject({ status: 'active', prices: { bestBid: '0.56' } });
    expect(classifyContract(active.contracts[0]!).kind).toBe('pending');

    t.now = EXPIRY + 2_000;
    const closed = await c.getEventRaw(TICKER);
    expect(closed.event.contracts[0]).toMatchObject({ status: 'closed' });
    expect(closed.event.contracts[0]!.resolutionSide).toBeUndefined();
    expect(classifyContract(closed.event.contracts[0]!).kind).toBe('pending');

    t.now = EXPIRY + REPLAY_SETTLES_AFTER_MS;
    const settled = await c.getEventRaw(TICKER);
    expect(settled.url).toBe(`replay://gemini/v1/prediction-markets/events/${TICKER}`);
    expect(JSON.parse(new TextDecoder().decode(settled.bytes))).toEqual(
      replayEventBody(EXPIRY, t.now),
    );
    const k = settled.event.contracts[0]!;
    expect(k).toMatchObject({
      status: 'settled',
      resolutionSide: 'no',
      settlementValue: '64367.38366666667',
      resolvedAt: '2026-11-19T00:45:05.521Z',
      instrumentSymbol: 'REPLAY-GEMI-BTC05M2611190045-UP',
    });
    expect(classifyContract(k)).toEqual({ kind: 'settled', side: 'no' });
    expect(RawEvent.parse(settled.event)).toBeTruthy();
    await expect(c.getEvent('BTC05M2611190045')).rejects.toThrow(/replay: no such event/);
    expect(await c.getStrike(TICKER)).toEqual({
      type: 'reference',
      value: '64389.6',
      availableAt: '2026-11-19T00:40:00.000Z',
    });
  });

  it('BTC/USD walks from above the line to where Gemini settled', () => {
    expect(Number(replayBtcUsd(START))).toBeGreaterThan(64_389.6);
    expect(Number(replayBtcUsd(EXPIRY - 1))).toBeCloseTo(64_367.38, 0);
    expect(replayBtcUsd(START + 90_000)).toMatch(/^\d+\.\d{2}$/);
  });

  it('a settlement ruling over a replayed body says it is a replay', () => {
    const k = RawEvent.parse(replayEventBody(EXPIRY, EXPIRY + 6_000)).contracts[0]!;
    const BET = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
    const record = settlementRecord({
      bet_id: BET,
      terms_hash: 'ab'.repeat(32),
      eventTicker: TICKER,
      instrumentSymbol: k.instrumentSymbol,
      state: { kind: 'settled', side: 'no' },
      settlementValue: String(k.settlementValue),
      strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-19T00:40:00.000Z' },
      resolvedAt: '2026-11-19T00:45:05.521Z',
      source_url: `replay://gemini/v1/prediction-markets/events/${TICKER}`,
      response_sha256: 'cd'.repeat(32),
      fetched_at: '2026-11-19T00:45:06.000Z',
    });
    const r = settlementRuling({
      ruling_id: '9b1d2c3e-4f50-4a61-8b72-c3d4e5f60718',
      created_at: '2026-11-19T00:45:06.000Z',
      terms: {
        bet_id: BET,
        yes_party: 'B',
        market: {
          venue: 'gemini',
          eventTicker: TICKER,
          instrumentSymbol: k.instrumentSymbol,
          side: 'NO',
          priceAtLock: '0.61',
          priceSource: 'mid',
          quotedAt: '2026-11-19T00:42:10.000Z',
          strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-19T00:40:00.000Z' },
          expiry: '2026-11-19T00:45:00.000Z',
        },
      },
      terms_hash: 'ab'.repeat(32),
      record,
    });
    expect(r.outcome).toBe('A_WINS');
    expect(r.reason).toBe(
      'Replay of a recorded round. Gemini settled DOWN: Bitcoin finished at $64,367.38, below the $64,389.60 line.',
    );
  });

  it('the relay over the replay: a lockable REPLAY contract priced at the recorded odds', async () => {
    const t = { now: at('2026-11-19T00:41:00.000Z') };
    const svc = new MarketService({
      client: createReplayClient({ now: () => t.now }),
      now: () => t.now,
      log: silentLogger,
    });
    const s = await svc.refresh();
    expect(GeminiMarketSnapshot.parse(s)).toMatchObject({
      eventTicker: TICKER,
      instrumentSymbol: 'REPLAY-GEMI-BTC05M2611190045-UP',
      strike: { value: '64389.6' },
      expiry: '2026-11-19T00:45:00.000Z',
    });
    expect(svc.current()).toMatchObject({ lockable: true, refusal: null });
    const q = await svc.quote('5000000', 'YES');
    expect(q.result).toMatchObject({ ok: true, priceAtLock: '0.61' });
  });
});

describe('the routed client', () => {
  const tagged = (name: string, log: string[]): GeminiClient => ({
    listActiveCrypto: async () => (log.push(`${name}.list`), []),
    getEvent: async (t) => (
      log.push(`${name}.event:${t}`),
      RawEvent.parse({ ticker: t, title: '', status: 'active' })
    ),
    getEventRaw: async (t) => {
      log.push(`${name}.raw:${t}`);
      return {
        event: RawEvent.parse({ ticker: t, title: '', status: 'active' }),
        url: name,
        bytes: new Uint8Array(),
      };
    },
    getStrike: async (t) => (log.push(`${name}.strike:${t}`), { type: 'reference' }),
    getBtcUsd: async () => (log.push(`${name}.btc`), '1'),
  });

  it('ticker-scoped calls follow the ticker, discovery and BTC follow the mode', async () => {
    const log: string[] = [];
    const c = createRoutedClient({ live: tagged('live', log), replay: tagged('replay', log) });
    expect(c.mode).toBe('live');
    await c.listActiveCrypto();
    await c.getBtcUsd();
    await c.getEventRaw('BTC05M2611190045');
    await c.getEventRaw(TICKER);
    c.setMode('replay');
    await c.listActiveCrypto();
    await c.getEvent('BTC05M2611190045'); // a live bet still settles from Gemini
    await c.getStrike(TICKER);
    expect(log).toEqual([
      'live.list',
      'live.btc',
      'live.raw:BTC05M2611190045',
      `replay.raw:${TICKER}`,
      'replay.list',
      'live.event:BTC05M2611190045',
      `replay.strike:${TICKER}`,
    ]);
  });

  it('MarketService.setFeed switches and forgets the old contract; a plain client cannot', async () => {
    const t = { now: at('2026-11-19T00:41:00.000Z') };
    const log: string[] = [];
    const routed = createRoutedClient({
      live: tagged('live', log),
      replay: createReplayClient({ now: () => t.now }),
    });
    const svc = new MarketService({ client: routed, now: () => t.now, log: silentLogger });
    expect(svc.feed).toBe('live');
    expect(await svc.refresh()).toBeNull(); // the live stub lists nothing
    expect(svc.setFeed('replay')).toBe(true);
    expect(svc.feed).toBe('replay');
    expect((await svc.refresh())?.eventTicker).toBe(TICKER);
    expect(svc.setFeed('live')).toBe(true);
    expect(svc.snapshot).toBeNull();
    const plain = new MarketService({
      client: tagged('x', []),
      now: () => t.now,
      log: silentLogger,
    });
    expect(plain.feed).toBeNull();
    expect(plain.setFeed('replay')).toBe(false);
  });

  it('setFeed mid-poll: the old feed’s poll is disowned, the backoff resets, refresh() polls the new feed', async () => {
    const t = { now: at('2026-11-19T00:41:00.000Z') };
    // live Gemini is down: every discovery fails, and the one in flight hangs until released
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    let calls = 0;
    const down: GeminiClient = {
      ...tagged('live', []),
      listActiveCrypto: async () => {
        calls++;
        if (calls > 2) await hung;
        throw new Error('gemini /v1/prediction-markets/events: HTTP 500');
      },
    };
    const routed = createRoutedClient({
      live: down,
      replay: createReplayClient({ now: () => t.now }),
    });
    const svc = new MarketService({ client: routed, now: () => t.now, log: silentLogger });
    await svc.refresh();
    await svc.refresh();
    expect(svc.failures).toBe(2);
    expect(svc.nextPollMs()).toBe(8_000); // backed off
    const inflight = svc.refresh(); // the 3rd live poll, hanging

    expect(svc.setFeed('replay')).toBe(true);
    expect(svc.failures).toBe(0);
    expect(svc.lastError).toBeNull();
    expect(svc.nextPollMs()).toBe(svc.pollMs);
    // what POST /v1/demo/gemini does next: it gets the REPLAY contract, not the live poll's null
    const switched = svc.refresh();
    release();
    expect((await switched)?.eventTicker).toBe(TICKER);
    await inflight;
    // the live poll failed after the switch: not counted, and it wrote nothing
    expect(svc.failures).toBe(0);
    expect(svc.lastError).toBeNull();
    expect(svc.current()).toMatchObject({ lockable: true, market: { eventTicker: TICKER } });
  });

  it('a live poll that lands after the switch writes nothing (no old-feed contract for a cycle)', async () => {
    const t = { now: at('2026-11-19T00:41:00.000Z') };
    const liveEvent = RawEvent.parse(F.event_0240_active);
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const live: GeminiClient = {
      ...tagged('live', []),
      listActiveCrypto: async () => {
        await slow;
        return [liveEvent];
      },
    };
    const svc = new MarketService({
      client: createRoutedClient({ live, replay: createReplayClient({ now: () => t.now }) }),
      now: () => t.now,
      log: silentLogger,
    });
    const old = svc.refresh();
    svc.setFeed('replay');
    const fresh = svc.refresh();
    release();
    await old;
    expect((await fresh)?.eventTicker).toBe(TICKER);
    expect(svc.snapshot?.eventTicker).toBe(TICKER);
    expect(svc.contractOf('BTC05M2611180240')).toBeNull();
  });
});
