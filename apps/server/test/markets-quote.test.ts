// markets/quote.ts pure parts: the real_world gate, FairRefusal -> the judge's DraftIssue, and the
// proposal a stale market quote is re-quoted from. No DB, no network.
import { describe, expect, it } from 'vitest';
import { marketClaim } from '@youre-on/shared/judge/market-terms';
import { Terms } from '@youre-on/shared/terms';
import { createGeminiClient } from '../src/markets/gemini';
import {
  isTemplateClaim,
  maxStakeOf,
  realWorldEnabled,
  refusalIssue,
  requoteProposal,
} from '../src/markets/quote';
import { MarketService } from '../src/markets/service';
import { silentLogger } from '../src/log';
import { testEnv } from './helpers';

const relay = new MarketService({
  client: createGeminiClient({ fetch: (async () => new Response('{}')) as typeof fetch }),
  now: () => 0,
  log: silentLogger,
});

const terms = (side: 'YES' | 'NO', claim?: string) =>
  Terms.parse({
    schema_version: 1,
    bet_id: '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73',
    escrow: {
      cluster: 'devnet',
      program_id: 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    },
    party_a: { pubkey: 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4', display_name: 'Logan' },
    party_b: { pubkey: 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr', display_name: 'Jake' },
    type: 'real_world',
    claim: claim ?? marketClaim('2026-11-18T02:40:00.000Z'),
    performer: null,
    yes_party: side === 'YES' ? 'A' : 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: ['Gemini settles this contract YES.'],
    failure_criteria: ['Gemini settles this contract NO.'],
    edge_cases: [],
    evidence_source: 'gemini',
    market: {
      venue: 'gemini',
      eventTicker: 'BTC05M2611180240',
      instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
      side,
      priceAtLock: '0.61',
      priceSource: 'mid',
      quotedAt: '2026-11-18T02:37:10.000Z',
      strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' },
      expiry: '2026-11-18T02:40:00.000Z',
    },
    stakes:
      side === 'YES'
        ? { a: '6100000', b: '3900000', currency: 'USDC' }
        : { a: '3900000', b: '6100000', currency: 'USDC' },
    deadline: '2026-11-18T02:50:00.000Z',
    created_at: '2026-11-18T02:37:10.000Z',
  });

describe('markets/quote.ts', () => {
  it('real_world needs the relay and ALLOW_P2P_REAL_WORLD (unset: DEMO_MODE)', () => {
    expect(realWorldEnabled({ env: testEnv({ DEMO_MODE: 'true' }), markets: relay })).toBe(true);
    expect(realWorldEnabled({ env: testEnv({ DEMO_MODE: 'true' }) })).toBe(false);
    expect(realWorldEnabled({ env: testEnv({}), markets: relay })).toBe(false);
    expect(
      realWorldEnabled({
        env: testEnv({ DEMO_MODE: 'true', ALLOW_P2P_REAL_WORLD: 'false' }),
        markets: relay,
      }),
    ).toBe(false);
    expect(
      realWorldEnabled({ env: testEnv({ ALLOW_P2P_REAL_WORLD: 'true' }), markets: relay }),
    ).toBe(true);
    expect(maxStakeOf({ env: testEnv({ MAX_STAKE_MICRO: '5000000' }) })).toBe(5_000_000n);
    expect(maxStakeOf({ env: testEnv({}) })).toBe(20_000_000n);
  });

  it('a FairRefusal becomes the judge draft issue it reads out', () => {
    expect(refusalIssue('STAKE_ABOVE_MAX').code).toBe('STAKE_ABOVE_MAX');
    expect(refusalIssue('STAKE_BELOW_MIN').code).toBe('STAKE_BELOW_MIN');
    expect(refusalIssue('SPREAD_TOO_WIDE').code).toBe('MARKET_UNFAIR');
    expect(refusalIssue('PRICE_OUT_OF_RANGE').code).toBe('MARKET_UNFAIR');
    for (const r of [
      'MARKET_NOT_OPEN',
      'QUOTE_STALE',
      'TOO_CLOSE_TO_EXPIRY',
      'STRIKE_PENDING',
      'NO_TWO_SIDED_QUOTE',
    ] as const)
      expect(refusalIssue(r)).toEqual({ code: 'NO_MARKET', message: `gemini: ${r}` });
  });

  it('a re-quote keeps the side and the even-money amount (pot / 2); the template claim follows', () => {
    const up = terms('YES');
    expect(requoteProposal(up)).toMatchObject({
      type: 'real_world',
      yes_party: 'A',
      amount: '5000000',
      market_query: { asset: 'BTC', horizon: '5m', a_side: 'YES' },
      deadline_minutes: null,
    });
    expect(requoteProposal(terms('NO')).market_query?.a_side).toBe('NO');
    expect(isTemplateClaim(up)).toBe(true);
    expect(isTemplateClaim(terms('YES', "Bitcoin's up by the end of this pitch."))).toBe(false);
  });
});
