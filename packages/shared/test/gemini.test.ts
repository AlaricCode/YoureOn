import { describe, expect, it } from 'vitest';
import {
  decimalToPpm,
  divRoundHalfUp,
  fairStakes,
  GeminiMarketSnapshot,
  GeminiSettlementRecord,
  parseUsd,
  pctFromPrice,
  splitPot,
} from '../src';
import { marketSnapshot } from './fixtures';

const NOW = Date.parse('2026-11-21T18:06:30.000Z');

describe('fair stakes math (§8.2)', () => {
  it('decimalToPpm / divRoundHalfUp / pctFromPrice', () => {
    expect(decimalToPpm('0.5800')).toBe(580_000n);
    expect(decimalToPpm('1')).toBe(1_000_000n);
    expect(() => decimalToPpm('0.1234567')).toThrow();
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 2n)).toBe(2n);
    expect(pctFromPrice('0.62')).toBe(62n);
    expect(pctFromPrice('0.615')).toBe(62n);
  });
  it('worked examples: $10 pot at 0.62; $3.33 at 0.615 → $4.13 / $2.53', () => {
    expect(splitPot(10_000_000n, 'YES', 62n)).toEqual({ a: 6_200_000n, b: 3_800_000n });
    expect(splitPot(10_000_000n, 'NO', 62n)).toEqual({ a: 3_800_000n, b: 6_200_000n });
    expect(splitPot(2n * BigInt(parseUsd('3.33')), 'YES', pctFromPrice('0.615'))).toEqual({
      a: 4_130_000n,
      b: 2_530_000n,
    });
  });
});

describe('fairStakes guards (§8.2)', () => {
  const snap = (over: Partial<ReturnType<typeof marketSnapshot>> = {}) =>
    GeminiMarketSnapshot.parse({ ...marketSnapshot(), ...over });

  it('§8.1 snapshot parses; bid 0.58 / ask 0.66 → mid 0.62 → A YES $6.20, B $3.80', () => {
    const r = fairStakes(snap(), parseUsd('$5'), 'YES', NOW);
    expect(r).toEqual({
      ok: true,
      priceAtLock: '0.62',
      priceSource: 'mid',
      quotedAt: '2026-11-21T18:06:30.000Z',
      stakes: { a: '6200000', b: '3800000', currency: 'USDC' },
    });
    const no = fairStakes(snap(), parseUsd('$5'), 'NO', NOW);
    expect(no.ok && no.stakes).toEqual({ a: '3800000', b: '6200000', currency: 'USDC' });
  });
  it('cap guard: $20 at 62/38 refuses, $16 fits ($19.84 / $12.16)', () => {
    expect(fairStakes(snap(), parseUsd('20'), 'YES', NOW)).toEqual({
      ok: false,
      reason: 'STAKE_ABOVE_MAX',
    });
    const r = fairStakes(snap(), parseUsd('16'), 'YES', NOW);
    expect(r.ok && r.stakes).toEqual({ a: '19840000', b: '12160000', currency: 'USDC' });
  });
  it('refusals', () => {
    const amt = parseUsd('5');
    expect(fairStakes(snap({ status: 'closed' as never }), amt, 'YES', NOW)).toMatchObject({
      reason: 'MARKET_NOT_OPEN',
    });
    expect(fairStakes(snap(), amt, 'YES', NOW + 6_000)).toMatchObject({ reason: 'QUOTE_STALE' });
    expect(
      fairStakes(
        snap({ observedAt: '2026-11-21T18:08:30.000Z' }),
        amt,
        'YES',
        Date.parse('2026-11-21T18:08:01.000Z'),
      ),
    ).toMatchObject({
      reason: 'TOO_CLOSE_TO_EXPIRY',
    });
    expect(
      fairStakes(
        snap({
          strike: { value: null, type: 'reference', availableAt: '2026-11-21T18:05:00.000Z' },
        }),
        amt,
        'YES',
        NOW,
      ),
    ).toMatchObject({ reason: 'STRIKE_PENDING' });
    expect(
      fairStakes(snap({ bestBid: '0.0100', bestAsk: '0.9900' }), amt, 'YES', NOW),
    ).toMatchObject({ reason: 'NO_TWO_SIDED_QUOTE' });
    expect(fairStakes(snap({ bestBid: null }), amt, 'YES', NOW)).toMatchObject({
      reason: 'NO_TWO_SIDED_QUOTE',
    });
    expect(
      fairStakes(
        snap({ bestBid: '0.2000', bestAsk: '0.6000', lastTradePrice: '0.7000' }),
        amt,
        'YES',
        NOW,
      ),
    ).toMatchObject({
      reason: 'SPREAD_TOO_WIDE',
    });
    const last = fairStakes(
      snap({ bestBid: '0.2000', bestAsk: '0.6000', lastTradePrice: '0.4500' }),
      amt,
      'YES',
      NOW,
    );
    expect(last).toMatchObject({ ok: true, priceAtLock: '0.45', priceSource: 'last_in_spread' });
    expect(
      fairStakes(snap({ bestBid: '0.9500', bestAsk: '0.9700' }), amt, 'YES', NOW),
    ).toMatchObject({ reason: 'PRICE_OUT_OF_RANGE' });
    expect(
      fairStakes(snap({ bestBid: '0.0400', bestAsk: '0.0600' }), parseUsd('0.10'), 'YES', NOW),
    ).toMatchObject({
      reason: 'STAKE_BELOW_MIN',
    });
  });
});

describe('GeminiSettlementRecord (§4)', () => {
  it('parses a settled record', () => {
    const r = GeminiSettlementRecord.parse({
      schema_version: 1,
      kind: 'gemini_settlement',
      bet_id: '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73',
      terms_hash: 'ab'.repeat(32),
      contract: {
        eventTicker: 'BTC05M2611211810',
        instrumentSymbol: 'GEMI-BTC05M2611211810-UP',
        status: 'settled',
        resolutionSide: 'yes',
        settlementValue: '75550.7195',
        strike: { value: '97250.03', type: 'reference', availableAt: '2026-11-21T18:05:00.000Z' },
        resolvedAt: '2026-11-21T18:10:07.512Z',
      },
      source_url: 'https://api.gemini.com/v1/prediction-markets/events/BTC05M2611211810',
      response_sha256: 'cd'.repeat(32),
      fetched_at: '2026-11-21T18:10:08.000Z',
    });
    expect(r.contract.resolutionSide).toBe('yes');
  });
});
