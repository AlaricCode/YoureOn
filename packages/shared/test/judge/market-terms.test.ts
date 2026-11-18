// Beat 6 market terms: the projection goes through the same evaluateProposeTerms as voice/typed.
import { describe, expect, it } from 'vitest';
import { evaluateProposeTerms } from '../../src/judge/reply';
import {
  callOf,
  expiryLabel,
  isReplayTicker,
  marketClaim,
  marketReadback,
  marketSideOf,
  marketTermsArgs,
  MarketTermsRequest,
  marketTermsPath,
  MARKET_VOID_EDGE,
  newRoundLine,
  oddsDisplay,
} from '../../src/judge/market-terms';
import { Terms } from '../../src/terms';
import { realWorldTerms } from '../fixtures';

const EXPIRY = '2026-11-18T02:40:00.000Z';

describe('market terms (Beat 6)', () => {
  it('path, sides, labels', () => {
    expect(marketTermsPath('b/1')).toBe('/v1/bets/b%2F1/terms/market');
    expect(marketSideOf('UP')).toBe('YES');
    expect(marketSideOf('DOWN')).toBe('NO');
    expect(callOf('YES')).toBe('UP');
    expect(callOf('NO')).toBe('DOWN');
    expect(expiryLabel(EXPIRY)).toBe('02:40 UTC');
    expect(marketClaim(EXPIRY)).toBe(
      "Gemini's BTC 5-minute contract expiring 02:40 UTC resolves UP.",
    );
  });

  it('a re-quote onto the next round names its line and end', () => {
    const strike = { value: '64367.38', type: 'reference' as const, availableAt: null };
    expect(newRoundLine({ strike, expiry: '2026-11-18T02:45:00.000Z' })).toBe(
      'New round: line $64,367.38, ends 02:45 UTC.',
    );
    expect(newRoundLine({ strike: { ...strike, value: null }, expiry: EXPIRY })).toBe(
      'New round: line not set, ends 02:40 UTC.',
    );
  });

  it('a REPLAY-feed contract gets a REPLAY claim', () => {
    expect(isReplayTicker('REPLAY-BTC05M2611190045')).toBe(true);
    expect(isReplayTicker('BTC05M2611190045')).toBe(false);
    expect(marketClaim(EXPIRY, 'REPLAY-BTC05M2611180240')).toBe(
      'REPLAY: a recorded Gemini BTC 5-minute round, ending 02:40 UTC, resolves UP.',
    );
    expect(
      marketTermsArgs({
        side: 'UP',
        amount_usd: '5',
        expiry: EXPIRY,
        eventTicker: 'REPLAY-BTC05M2611180240',
      }).claim,
    ).toMatch(/^REPLAY: /);
  });

  it('the request is lenient on extra keys but needs a side and an amount', () => {
    expect(MarketTermsRequest.parse({ side: 'UP', amount_usd: '5', x: 1 })).toEqual({
      side: 'UP',
      amount_usd: '5',
    });
    expect(MarketTermsRequest.safeParse({ side: 'SIDEWAYS', amount_usd: '5' }).success).toBe(false);
    expect(MarketTermsRequest.safeParse({ side: 'UP' }).success).toBe(false);
  });

  it('UP: A is the yes party; the proposal is a real_world gemini bet with the void rule', () => {
    const ev = evaluateProposeTerms(
      marketTermsArgs({ side: 'UP', amount_usd: '$5', expiry: EXPIRY }),
      { realWorldEnabled: true },
    );
    expect(ev.kind).toBe('proposal');
    if (ev.kind !== 'proposal') return;
    expect(ev.missing).toEqual([]);
    expect(ev.proposal).toMatchObject({
      type: 'real_world',
      performer: null,
      yes_party: 'A',
      attempts: { count: 1, rule: 'single' },
      evidence_source: 'gemini',
      amount: '5000000',
      market_query: { asset: 'BTC', horizon: '5m', a_side: 'YES' },
      deadline_minutes: null,
      edge_cases: [{ ...MARKET_VOID_EDGE, asked_by: 'judge' }],
    });
  });

  it('DOWN: B holds YES', () => {
    const ev = evaluateProposeTerms(
      marketTermsArgs({ side: 'DOWN', amount_usd: '2', expiry: EXPIRY }),
      { realWorldEnabled: true },
    );
    expect(ev.kind === 'proposal' && ev.proposal).toMatchObject({
      yes_party: 'B',
      market_query: { a_side: 'NO' },
    });
  });

  it('gated like any real_world proposal, and the stake cap still applies', () => {
    const args = marketTermsArgs({ side: 'UP', amount_usd: '5', expiry: EXPIRY });
    expect(evaluateProposeTerms(args, {})).toMatchObject({
      kind: 'issue',
      issue: { code: 'NO_MARKET' },
    });
    expect(
      evaluateProposeTerms({ ...args, amount_usd: '50' }, { realWorldEnabled: true }),
    ).toMatchObject({ kind: 'issue', issue: { code: 'STAKE_ABOVE_MAX' } });
  });

  it('odds and the read-back', () => {
    expect(oddsDisplay('6200000', '3800000')).toBe('62/38');
    expect(oddsDisplay('3800000', '6200000')).toBe('38/62');
    const t = Terms.parse(realWorldTerms());
    expect(marketReadback(t)).toBe(
      "Gemini's BTC 5-minute contract expiring 18:10 UTC resolves UP. Logan has Up, Jake has Down. Gemini's odds: $6.20 against $3.80.",
    );
    const down = { ...t, market: { ...t.market!, side: 'NO' as const } };
    expect(marketReadback(down)).toContain('Jake has Up, Logan has Down.');
    expect(marketReadback(t, 80).length).toBeLessThanOrEqual(80);
  });
});
