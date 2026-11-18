// "Bet on Bitcoin" (Beat 6) on A's phone: the panel reducer, the three calls over a fake api, the
// store folding market.tick / market.settled, and the route of a locked Gemini bet.
import { MarketTermsRequest } from '@youre-on/shared/judge/market-terms';
import { describe, expect, it } from 'vitest';

import { applyBetEvent, emptyBet } from '../../bets/store';
import { ApiClientError } from '../../net/signedFetch';
import { COPY, t } from '../../screens/copy';
import { checkCopy } from '../../ui/copyRule';
import { appReducer, initialApp, routeForBet } from '../machine';
import {
  canConfirmMarket,
  canSubmitMarket,
  confirmMarketTerms,
  DEFAULT_MARKET_STAKE_USD,
  fetchMarketQuote,
  initialMarket,
  MARKET_STAKES_USD,
  marketReducer,
  REFUSAL_LABEL,
  shouldPoll,
  splitLabel,
  submitMarketTerms,
  waitingForAcceptMarket,
  type MarketEvent,
  type MarketQuoteView,
  type MarketState,
} from '../marketTerms';
import { BET, DEVICE_A, ev, ME_A, stateEv } from './fixtures';

const HASH = 'ab'.repeat(32);
const HASH2 = 'cd'.repeat(32);
const run = (s: MarketState, ...events: MarketEvent[]) => events.reduce(marketReducer, s);
const opened = () => run(initialMarket, { type: 'init', bet_id: BET }, { type: 'open' });

/** A recorded Gemini snapshot (BTC05M2611180240 at 02:37:10, bid .54 / ask .67). */
const snapshot = {
  eventTicker: 'BTC05M2611180240',
  eventTitle: 'BTC price today at 9:40pm EST',
  instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
  contractLabel: 'Up',
  status: 'active' as const,
  marketState: 'open' as const,
  strike: { value: '64389.6', type: 'reference' as const, availableAt: '2026-11-18T02:35:00.000Z' },
  expiry: '2026-11-18T02:40:00.000Z',
  bestBid: '0.54',
  bestAsk: '0.67',
  lastTradePrice: null,
  indexPrice: '64379.76',
  source: 'rest_event' as const,
  exchangeTs: null,
  observedAt: '2026-11-18T02:37:10.000Z',
};
const quoteOk = (a = '1220000', b = '780000') => ({
  result: {
    ok: true as const,
    priceAtLock: '0.61',
    priceSource: 'mid' as const,
    quotedAt: '2026-11-18T02:37:10.000Z',
    stakes: { a, b, currency: 'USDC' as const },
  },
  snapshot,
});
const goodQuote: MarketQuoteView = {
  ok: true,
  refusal: null,
  eventTicker: 'BTC05M2611180240',
  upPct: 61,
  myStake: '2440000',
  theirStake: '1560000',
  strikeUsd: '$64,389.60',
  priceUsd: '$64,379.76',
  expiryMs: Date.parse('2026-11-18T02:40:00.000Z'),
  lockableUntilMs: Date.parse('2026-11-18T02:38:00.000Z'),
  nextWindowMs: null,
};

describe('market panel reducer', () => {
  it('opens per bet with $2 Up; side / stake changes drop the old quote', () => {
    const s = opened();
    expect(s).toMatchObject({
      bet_id: BET,
      phase: 'browsing',
      side: 'UP',
      stakeUsd: DEFAULT_MARKET_STAKE_USD,
      quote: null,
    });
    expect(shouldPoll(s)).toBe(true);
    expect(shouldPoll(initialMarket)).toBe(false);
    const q = run(s, { type: 'quoted', side: 'UP', stakeUsd: 2, quote: goodQuote });
    expect(q.quote).toBe(goodQuote);
    expect(run(q, { type: 'side', side: 'DOWN' })).toMatchObject({ side: 'DOWN', quote: null });
    expect(run(q, { type: 'stake', usd: 5 })).toMatchObject({ stakeUsd: 5, quote: null });
    // a late answer for the previous pick is dropped
    const down = run(q, { type: 'side', side: 'DOWN' });
    expect(run(down, { type: 'quoted', side: 'UP', stakeUsd: 2, quote: goodQuote }).quote).toBe(
      null,
    );
    // the same bet keeps its state; another bet resets it
    expect(run(q, { type: 'init', bet_id: BET })).toBe(q);
    expect(run(q, { type: 'init', bet_id: '11111111-1111-4111-8111-111111111111' }).phase).toBe(
      'closed',
    );
  });

  it('submit needs a priceable quote; proposed -> sent; refused -> a note', () => {
    const s = opened();
    expect(canSubmitMarket(s)).toBe(false); // no quote yet
    const bad = run(s, {
      type: 'quoted',
      side: 'UP',
      stakeUsd: 2,
      quote: { ...goodQuote, ok: false, refusal: 'Next round soon' },
    });
    expect(canSubmitMarket(bad)).toBe(false);
    const q = run(s, { type: 'quoted', side: 'UP', stakeUsd: 2, quote: goodQuote });
    expect(canSubmitMarket(q)).toBe(true);
    const sending = run(q, { type: 'submit' });
    expect(sending.phase).toBe('sending');
    // frozen while sending
    expect(run(sending, { type: 'side', side: 'DOWN' })).toBe(sending);
    expect(run(sending, { type: 'close' })).toBe(sending);
    const sent = run(sending, {
      type: 'submitted',
      outcome: { kind: 'proposed', terms_hash: HASH },
    });
    expect(sent).toMatchObject({ phase: 'sent', proposedHash: HASH });
    expect(shouldPoll(sent)).toBe(true); // the odds keep moving until it is locked
    const failed = run(sending, {
      type: 'submitted',
      outcome: { kind: 'error', note: 'Too lopsided' },
    });
    expect(failed).toMatchObject({ phase: 'browsing', note: 'Too lopsided' });
  });

  it('"Lock it in" only for the card it proposed, once B accepted; a re-quote moves the target', () => {
    const sent = run(
      opened(),
      { type: 'quoted', side: 'UP', stakeUsd: 2, quote: goodQuote },
      { type: 'submit' },
      { type: 'submitted', outcome: { kind: 'proposed', terms_hash: HASH } },
    );
    expect(canConfirmMarket(sent, HASH, 'accepted')).toBe(true);
    expect(canConfirmMarket(sent, HASH2, 'accepted')).toBe(false); // another card is up
    expect(canConfirmMarket(sent, HASH, null)).toBe(false);
    expect(waitingForAcceptMarket(sent, HASH, null)).toBe(true);
    const confirming = run(sent, { type: 'confirm' });
    const requoted = run(confirming, { type: 'requoted', terms_hash: HASH2, note: 'Odds moved' });
    expect(requoted).toMatchObject({ phase: 'sent', proposedHash: HASH2, note: 'Odds moved' });
    expect(canConfirmMarket(requoted, HASH2, 'accepted')).toBe(true);
    const done = run(requoted, { type: 'confirm' }, { type: 'confirmed' });
    expect(done.phase).toBe('confirmed');
    expect(shouldPoll(done)).toBe(false);
    expect(run(done, { type: 'stake', usd: 10 })).toBe(done);
    expect(run(confirming, { type: 'confirm_failed', note: 'Try again' })).toMatchObject({
      phase: 'sent',
      note: 'Try again',
    });
  });

  it('close goes back to the judge / form without losing the pick', () => {
    const q = run(opened(), { type: 'stake', usd: 5 }, { type: 'close' });
    expect(q).toMatchObject({ phase: 'closed', stakeUsd: 5 });
    expect(run(q, { type: 'open' }).phase).toBe('browsing');
  });
});

describe('market panel calls', () => {
  it('quote: the preview in dollars per side, the line and the lock window', async () => {
    const seen: unknown[] = [];
    const v = await fetchMarketQuote(
      {
        api: {
          async marketQuote(amount, side) {
            seen.push([amount, side]);
            return quoteOk();
          },
        },
      },
      { side: 'DOWN', stakeUsd: 1 },
    );
    expect(seen).toEqual([['1000000', 'NO']]);
    expect(v).toEqual({
      ok: true,
      refusal: null,
      eventTicker: 'BTC05M2611180240',
      upPct: 61,
      myStake: '1220000',
      theirStake: '780000',
      strikeUsd: '$64,389.60',
      priceUsd: '$64,379.76',
      expiryMs: Date.parse('2026-11-18T02:40:00.000Z'),
      lockableUntilMs: Date.parse('2026-11-18T02:38:00.000Z'),
      nextWindowMs: null,
    });
    expect(splitLabel(v)).toBe('$1.22 vs $0.78');
  });

  it('quote refusals become 1-3 word labels', async () => {
    const refuse = (reason: string) => ({
      async marketQuote(): Promise<never> {
        throw new ApiClientError('MARKET_UNAVAILABLE', 409, 'x', true, { reason });
      },
    });
    expect(
      (await fetchMarketQuote({ api: refuse('TOO_CLOSE_TO_EXPIRY') }, { side: 'UP', stakeUsd: 2 }))
        .refusal,
    ).toBe('Next round soon');
    expect(
      (await fetchMarketQuote({ api: refuse('WEIRD') }, { side: 'UP', stakeUsd: 2 })).refusal,
    ).toBe('Market closed');
    const offline = {
      async marketQuote(): Promise<never> {
        throw new TypeError('network');
      },
    };
    expect(await fetchMarketQuote({ api: offline }, { side: 'UP', stakeUsd: 2 })).toMatchObject({
      ok: false,
      refusal: t(COPY.app.failed),
    });
    for (const label of Object.values(REFUSAL_LABEL)) expect(checkCopy(label, 'label')).toEqual([]);
  });

  it('too late for this round: the refusal comes with the next round’s start', async () => {
    const api = {
      async marketQuote(): Promise<never> {
        throw new ApiClientError('MARKET_UNAVAILABLE', 409, 'x', true, {
          reason: 'TOO_CLOSE_TO_EXPIRY',
        });
      },
      async marketCurrent() {
        return { lockable: false, next_window_start: '2026-11-18T02:40:00.000Z' };
      },
    };
    expect(await fetchMarketQuote({ api }, { side: 'UP', stakeUsd: 2 })).toMatchObject({
      ok: false,
      refusal: 'Next round soon',
      nextWindowMs: Date.parse('2026-11-18T02:40:00.000Z'),
    });
    // a stake problem is not fixed by waiting: no countdown, and no extra call
    let asked = 0;
    const stake = {
      async marketQuote(): Promise<never> {
        throw new ApiClientError('MARKET_UNAVAILABLE', 409, 'x', true, {
          reason: 'STAKE_ABOVE_MAX',
        });
      },
      async marketCurrent() {
        asked++;
        return { lockable: true, next_window_start: null };
      },
    };
    expect(
      (await fetchMarketQuote({ api: stake }, { side: 'UP', stakeUsd: 10 })).nextWindowMs,
    ).toBeNull();
    expect(asked).toBe(0);
  });

  it('submit sends the side and the dollars; a refusal is a note', async () => {
    let body: unknown = null;
    const r = await submitMarketTerms(
      {
        api: {
          async proposeMarketTerms(_id, b) {
            body = b;
            return { terms_hash: HASH } as never;
          },
        },
      },
      { betId: BET, side: 'UP', stakeUsd: 5 },
    );
    expect(r).toEqual({ kind: 'proposed', terms_hash: HASH });
    expect(MarketTermsRequest.parse(body)).toEqual({ side: 'UP', amount_usd: '5' });
    const refused = await submitMarketTerms(
      {
        api: {
          async proposeMarketTerms(): Promise<never> {
            throw new ApiClientError('MARKET_UNAVAILABLE', 409, 'x', true, {
              reason: 'STRIKE_PENDING',
            });
          },
        },
      },
      { betId: BET, side: 'UP', stakeUsd: 5 },
    );
    expect(refused).toEqual({ kind: 'error', note: 'Line not set' });
  });

  it('confirm: ok, re-quoted (the new hash), invite pending, other failures', async () => {
    const ok = {
      async confirmTerms() {
        return {} as never;
      },
    };
    expect(
      await confirmMarketTerms({ api: ok }, { betId: BET, termsHash: HASH, idempotencyKey: 'k' }),
    ).toEqual({ kind: 'confirmed' });
    const throwing = (e: unknown) => ({
      async confirmTerms(): Promise<never> {
        throw e;
      },
    });
    const i = { betId: BET, termsHash: HASH, idempotencyKey: 'k' };
    expect(
      await confirmMarketTerms(
        {
          api: throwing(
            new ApiClientError('TERMS_HASH_MISMATCH', 409, 'x', false, {
              reason: 'requoted',
              terms_hash: HASH2,
            }),
          ),
        },
        i,
      ),
    ).toEqual({ kind: 'requoted', terms_hash: HASH2, note: 'Odds moved' });
    expect(
      await confirmMarketTerms(
        {
          api: throwing(
            new ApiClientError('INVALID_STATE', 409, 'x', false, { reason: 'invite_pending' }),
          ),
        },
        i,
      ),
    ).toEqual({ kind: 'failed', note: 'Not accepted yet', freshKey: true });
    expect(
      await confirmMarketTerms(
        {
          api: throwing(
            new ApiClientError('MARKET_UNAVAILABLE', 409, 'x', true, { reason: 'QUOTE_STALE' }),
          ),
        },
        i,
      ),
    ).toEqual({ kind: 'failed', note: 'Odds updating', freshKey: true });
    expect(await confirmMarketTerms({ api: throwing(new TypeError('net')) }, i)).toEqual({
      kind: 'failed',
      note: t(COPY.app.failed),
      freshKey: false,
    });
    for (const n of ['Odds moved', 'Not accepted yet']) expect(checkCopy(n, 'label')).toEqual([]);
  });

  it('offers the four even-money stakes', () => {
    expect([...MARKET_STAKES_USD]).toEqual([1, 2, 5, 10]);
  });
});

describe('a locked Gemini bet on the phone', () => {
  const record = {
    schema_version: 1,
    kind: 'gemini_settlement',
    bet_id: BET,
    terms_hash: HASH,
    contract: {
      eventTicker: 'BTC05M2611180240',
      instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
      status: 'settled',
      resolutionSide: 'no',
      settlementValue: '64367.38366666667',
      strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' },
      resolvedAt: '2026-11-18T02:40:05.521Z',
    },
    source_url: 'https://api.gemini.com/v1/prediction-markets/events/BTC05M2611180240',
    response_sha256: HASH2,
    fetched_at: '2026-11-18T02:40:08.000Z',
  };

  it('the store keeps the live tick and Gemini’s settled record', () => {
    let m = emptyBet(BET, 'A');
    m = applyBetEvent(m, ev('market.tick', { snapshot }, 20));
    expect(m.market).toEqual(snapshot);
    m = applyBetEvent(m, ev('market.settled', { record, evidence_hash: HASH }, 21));
    expect(m.settlement?.contract.resolutionSide).toBe('no');
    expect(m.lastSeq).toBe(21);
  });

  it('AWAITING_MARKET shows the Locked card first, then the market clock', () => {
    const app = appReducer(
      { ...initialApp, auth: 'signedIn', me: ME_A, deviceId: DEVICE_A },
      { type: 'bet_opened', bet_id: BET },
    );
    const m = applyBetEvent(
      { ...emptyBet(BET, 'A'), state: 'LOCKED' },
      stateEv('AWAITING_MARKET', 30),
    );
    expect(routeForBet(app, m)).toBe('terms');
    const acked = appReducer(app, { type: 'lock_ack', bet_id: BET });
    expect(routeForBet(acked, m)).toBe('market');
    // a judge-cam device never shows it
    expect(routeForBet({ ...acked, judgeCam: true }, m)).toBe('judgeCam');
  });

  it('the panel copy follows the copy rule', () => {
    for (const k of Object.keys(COPY.market) as (keyof typeof COPY.market)[])
      expect(checkCopy(t(COPY.market[k]), 'label')).toEqual([]);
  });
});
