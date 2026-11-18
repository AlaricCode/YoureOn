import { describe, expect, it } from 'vitest';

import { MARKET_STAKES_USD } from '@youre-on/shared/judge/market-terms';

import { emptyBet } from '../../bets/store';
import { ApiClientError } from '../../net/signedFetch';
import { canRematch, chipAtMost, rematchStakeUsd, startRematch, withRematch } from '../rematch';
import { dance, envelope, snapshot } from './fixtures';

const NEW_BET = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';

describe('double or nothing', () => {
  it('only once the bet is over', () => {
    for (const s of ['PAID', 'VOIDED', 'FINALIZED', 'EXPIRED'] as const)
      expect(canRematch(s)).toBe(true);
    for (const s of ['RULED', 'CONCEDED', 'JUDGING', 'CANCELLED'] as const)
      expect(canRematch(s)).toBe(false);
    expect(canRematch(null)).toBe(false);
  });

  it('suggests twice the old stake (the server wins), capped at $20 a side', () => {
    const fromTerms = { ...emptyBet('x'), envelope: envelope() }; // $5 each
    expect(rematchStakeUsd(fromTerms)).toBe(10);
    expect(rematchStakeUsd({ ...fromTerms, suggestedStakeUsd: 8 })).toBe(8);
    expect(rematchStakeUsd({ suggestedStakeUsd: null, envelope: null })).toBeNull();
    const big = {
      suggestedStakeUsd: null,
      envelope: { terms: { stakes: { a: '15000000', b: '15000000', currency: 'USDC' as const } } },
    };
    expect(rematchStakeUsd(big)).toBe(20);
    expect(dance.terms.stakes.a).toBe('5000000');
  });

  it('a fixed picker starts on the largest chip at or below the suggestion', () => {
    expect(chipAtMost(MARKET_STAKES_USD, 10)).toBe(10);
    expect(chipAtMost(MARKET_STAKES_USD, 20)).toBe(10);
    expect(chipAtMost(MARKET_STAKES_USD, 4)).toBe(2);
    expect(chipAtMost(MARKET_STAKES_USD, 0.5)).toBe(1);
    expect(chipAtMost(MARKET_STAKES_USD, null)).toBeNull();
  });

  it('the new bet is this phone as A, following the old one', () => {
    const m = withRematch(emptyBet(NEW_BET), 'old', 10);
    expect(m).toMatchObject({ my_party: 'A', rematchOf: 'old', suggestedStakeUsd: 10 });
    // What the server already said wins.
    const known = { ...emptyBet(NEW_BET, 'A'), rematchOf: 'older', suggestedStakeUsd: 4 };
    expect(withRematch(known, 'old', 10)).toMatchObject({
      rematchOf: 'older',
      suggestedStakeUsd: 4,
    });
  });

  it('POSTs under the pinned key, then reads the new bet', async () => {
    const calls: unknown[] = [];
    const out = await startRematch(
      {
        api: {
          rematch: async (betId, key) => {
            calls.push(['rematch', betId, key]);
            return { bet_id: NEW_BET, suggested_stake_usd: 10 };
          },
          getBet: async (betId) => {
            calls.push(['getBet', betId]);
            return snapshot({ bet_id: NEW_BET });
          },
        },
      },
      'old',
      'k1',
    );
    expect(calls).toEqual([
      ['rematch', 'old', 'k1'],
      ['getBet', NEW_BET],
    ]);
    expect(out).toMatchObject({ ok: true, betId: NEW_BET, suggestedStakeUsd: 10 });
    expect(out.ok && out.snapshot?.bet_id).toBe(NEW_BET);
  });

  it('a failed read still opens the new bet; a refusal says why (a fresh key on 4xx)', async () => {
    const opened = await startRematch(
      {
        api: {
          rematch: async () => ({ bet_id: NEW_BET, suggested_stake_usd: 2 }),
          getBet: async () => {
            throw new Error('offline');
          },
        },
      },
      'old',
      'k1',
    );
    expect(opened).toMatchObject({ ok: true, snapshot: null });
    const busy = await startRematch(
      {
        api: {
          rematch: async () => {
            throw new ApiClientError('INVALID_STATE', 409, 'busy', false, { reason: 'pair_busy' });
          },
          getBet: async () => snapshot(),
        },
      },
      'old',
      'k2',
    );
    expect(busy).toEqual({ ok: false, note: 'Bet already open', freshKey: true });
    const offline = await startRematch(
      {
        api: {
          rematch: async () => {
            throw new ApiClientError('NETWORK', 0, 'offline', true);
          },
          getBet: async () => snapshot(),
        },
      },
      'old',
      'k3',
    );
    expect(offline).toMatchObject({ ok: false, freshKey: false });
  });
});
