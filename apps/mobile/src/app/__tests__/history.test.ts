import { MeBetItem } from '@youre-on/shared/api';
import { describe, expect, it } from 'vitest';

import type { z } from 'zod/v4';

import { createYoApi } from '../../net/api';
import { createClock, type ApiClient } from '../../net/signedFetch';
import { HISTORY_LIMIT, historyFrom, historyItemOf } from '../history';
import { ME_B, snapshot } from './fixtures';

/** A GET /v1/me/bets item for party A, parsed like the app does. */
function item(o: Partial<MeBetItem> = {}): MeBetItem {
  return MeBetItem.parse({
    ...snapshot({ state: 'PAID' }),
    title: 'Bottle flip',
    opponent: ME_B,
    my_stake: '5000000',
    my_payout: '10000000',
    outcome: 'PartyA',
    settled_at: '2026-11-18T05:00:00.000Z',
    is_seed: false,
    ...o,
  });
}

describe('historyItemOf', () => {
  it('a win shows the opponent and the net gain', () => {
    expect(historyItemOf(item())).toEqual({
      bet_id: item().bet_id,
      title: 'Bottle flip',
      opponent: 'Jake',
      net: '5000000',
      outcome: 'won',
      settled_at: '2026-11-18T05:00:00.000Z',
    });
  });

  it('a loss is the stake gone (no payout row, or a zero one)', () => {
    expect(historyItemOf(item({ my_payout: '0', outcome: 'PartyB' }))).toMatchObject({
      net: '-5000000',
      outcome: 'lost',
    });
    expect(historyItemOf(item({ my_payout: null, outcome: 'PartyB' }))).toMatchObject({
      net: '-5000000',
      outcome: 'lost',
    });
  });

  it('falls back to the snapshot payout split when the list field is missing', () => {
    expect(
      historyItemOf(item({ my_payout: null, payout: { to_a: '10000000', to_b: '0' } })),
    ).toMatchObject({ net: '5000000', outcome: 'won' });
    // As party B of the same bet.
    expect(
      historyItemOf(
        item({ my_party: 'B', my_payout: null, payout: { to_a: '10000000', to_b: '0' } }),
      ),
    ).toMatchObject({ net: '-5000000', outcome: 'lost' });
  });

  it('a voided bet is refunded: net 0 even before the payout row is written', () => {
    const v = { state: 'VOIDED' as const, outcome: 'Refund' as const };
    expect(historyItemOf(item({ ...v, my_payout: '5000000' }))).toMatchObject({
      net: '0',
      outcome: 'void',
    });
    expect(historyItemOf(item({ ...v, my_payout: null }))).toMatchObject({
      net: '0',
      outcome: 'void',
    });
  });

  it('a paid bet that netted zero (a split back to stakes) reads as refunded', () => {
    expect(historyItemOf(item({ my_payout: '5000000', outcome: 'Split' }))).toMatchObject({
      net: '0',
      outcome: 'void',
    });
  });

  it('leaves out bets that are not settled', () => {
    for (const state of ['DRAFTING', 'LOCKED', 'RULED', 'CANCELLED', 'EXPIRED'] as const)
      expect(historyItemOf(item({ state }))).toBeNull();
  });

  it('a missing settled_at becomes an empty string (the screen does not show it)', () => {
    expect(historyItemOf(item({ settled_at: null }))?.settled_at).toBe('');
  });

  it('seed rows (is_seed, POST /v1/demo/seed-h2h) read as demo history, never as "Challenge"', () => {
    // today's server titles a seed row from its (absent) terms: the generic "Challenge"
    expect(historyItemOf(item({ is_seed: true, title: 'Challenge' }))?.title).toBe('Demo history');
    // a server that sends the row's own title ("Demo history: …") keeps it as is
    expect(historyItemOf(item({ is_seed: true, title: 'Demo history: Free throw' }))?.title).toBe(
      'Demo history: Free throw',
    );
    // any other title of a seed row is marked
    expect(historyItemOf(item({ is_seed: true, title: 'Bottle flip' }))?.title).toBe(
      'Demo history: Bottle flip',
    );
    expect(historyItemOf(item({ is_seed: true, title: '' }))?.title).toBe('Demo history');
    // a real bet is left alone, even one titled "Challenge"
    expect(historyItemOf(item({ is_seed: false, title: 'Challenge' }))?.title).toBe('Challenge');
    // the rest of the row is unchanged
    expect(historyItemOf(item({ is_seed: true, title: 'Challenge' }))).toMatchObject({
      opponent: 'Jake',
      net: '5000000',
      outcome: 'won',
    });
  });
});

describe('api.myBets', () => {
  it('GETs one page of settled bets (bearer only) and leaves the items for historyFrom', async () => {
    const calls: { method: string; path: string; auth: unknown }[] = [];
    const client = {
      clock: createClock(),
      async request(method: string, path: string, opts: { auth?: unknown; schema?: z.ZodType }) {
        calls.push({ method, path, auth: opts.auth });
        return opts.schema!.parse({ items: [item(), { odd: 1 }], next_cursor: null });
      },
    } as unknown as ApiClient;
    const r = await createYoApi(client).myBets('settled', HISTORY_LIMIT);
    expect(calls).toEqual([
      { method: 'GET', path: `/v1/me/bets?status=settled&limit=${HISTORY_LIMIT}`, auth: undefined },
    ]);
    expect(r.items).toHaveLength(2);
    expect(historyFrom(r.items)).toHaveLength(1);
  });
});

describe('historyFrom', () => {
  it('keeps the server order and skips items that do not parse or are not settled', () => {
    const paid = item();
    const voided = item({
      bet_id: '11111111-1111-4111-8111-111111111111',
      state: 'VOIDED',
      outcome: 'Refund',
    });
    const rows = historyFrom([
      paid,
      { nonsense: true },
      item({ bet_id: '22222222-2222-4222-8222-222222222222', state: 'LOCKED' }),
      voided,
    ]);
    expect(rows.map((r) => [r.bet_id, r.outcome])).toEqual([
      [paid.bet_id, 'won'],
      [voided.bet_id, 'void'],
    ]);
  });

  it('is empty for no bets', () => {
    expect(historyFrom([])).toEqual([]);
  });
});
