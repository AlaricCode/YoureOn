/**
 * Booth / exhibits / receipt / terms.yaml are readable by bet viewers only
 * (participants, confirmed huddle members of mirror bets; World bets:
 * participants). Everyone else gets NOT_FOUND, before any booth lookup.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { boothService } from '../src/routes/replayBooth.js';
import { COLLECTIONS } from '../src/persistence/records.js';
import { auth, login, makeApp, type TestApp, type TestUser } from './appHelpers.js';
import { disputedAiJudgedBet, flush } from './bweHelpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

const ROUTES = (bet: string) => [`/v1/bets/${bet}/booth`, `/v1/bets/${bet}/exhibits/E1`, `/v1/bets/${bet}/receipt`, `/v1/bets/${bet}/terms.yaml`];

async function codes(app: TestApp['app'], u: TestUser, bet: string): Promise<number[]> {
  const out: number[] = [];
  for (const url of ROUTES(bet)) {
    const r = await app.inject({ method: 'GET', url, headers: auth(u) });
    out.push(r.statusCode);
    if (r.statusCode === 404) expect(r.json().error.code).toBe('NOT_FOUND');
  }
  return out;
}

describe('bet viewer gate (booth, exhibits, receipt, terms.yaml)', () => {
  it('non-members get NOT_FOUND; participants and confirmed huddle members get 200; World bets are participants-only', async () => {
    t = await makeApp();
    const a = await login(t.app, 'alex@example.com');
    const b = await login(t.app, 'maya@example.com');
    const stranger = await login(t.app, 'stranger@example.com');
    const friend = await login(t.app, 'friend@example.com');
    const pending = await login(t.app, 'pending@example.com');
    const { bet, program } = await disputedAiJudgedBet(t.ctx, a.wallet, b.wallet, [
      { kind: 0, label: 'cam1', format: 'mjpeg', chunks: 2, user_id: a.user.id },
      { kind: 1, label: 'mic1', format: 'wav', chunks: 2, user_id: b.user.id },
    ]);
    await boothService(t.ctx).ensure(bet);
    await flush(t.ctx);

    // Chain-only bet (no backend record): participants only.
    expect(await codes(t.app, a, bet)).toEqual([200, 200, 200, 200]);
    expect(await codes(t.app, stranger, bet)).toEqual([404, 404, 404, 404]);
    expect(await codes(t.app, friend, bet)).toEqual([404, 404, 404, 404]);

    // Huddle (mirror) bet: confirmed huddle members may view; unconfirmed joiners may not.
    t.ctx.store.collection(COLLECTIONS.huddles).set('h1', {
      id: 'h1',
      members: [
        { user_id: a.user.id, confirmed: true },
        { user_id: b.user.id, confirmed: true },
        { user_id: friend.user.id, confirmed: true },
        { user_id: pending.user.id, confirmed: false },
      ],
    });
    t.ctx.store.collection(COLLECTIONS.bets).set(bet, { id: bet, program, huddle_id: 'h1', title: 'Hot sauce wing', creator_user_id: a.user.id });
    expect(await codes(t.app, friend, bet)).toEqual([200, 200, 200, 200]);
    expect(await codes(t.app, b, bet)).toEqual([200, 200, 200, 200]);
    expect(await codes(t.app, stranger, bet)).toEqual([404, 404, 404, 404]);
    expect(await codes(t.app, pending, bet)).toEqual([404, 404, 404, 404]);

    // World bet: participants only (no huddle).
    t.ctx.store.collection(COLLECTIONS.bets).delete(bet);
    t.ctx.store.collection('world_bets').set(bet, { id: bet, program, huddle_id: 'h1', title: 'World' });
    expect(await codes(t.app, a, bet)).toEqual([200, 200, 200, 200]);
    expect(await codes(t.app, friend, bet)).toEqual([404, 404, 404, 404]);
    expect(await codes(t.app, stranger, bet)).toEqual([404, 404, 404, 404]);
  });
});
