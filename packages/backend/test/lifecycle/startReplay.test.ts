import { afterEach, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../../src/persistence/records.js';
import type { SnapshotProvider } from '../../src/ws/hub.js';
import { addWitness, api, calibrateAndFund, createBet, makeWorld, type World } from './fixtures.js';

let w: World | null = null;
afterEach(async () => {
  await w?.app.close();
  w = null;
});

/** The registered `bet` snapshot provider (what a (re)subscribing socket receives). */
function betSnapshot(world: World): SnapshotProvider {
  const map = (world.ctx.hub as unknown as { snapshots: Map<string, SnapshotProvider> }).snapshots;
  return map.get('bet')!;
}

describe('WS start replay (errata App: late start)', () => {
  it('a bet:<id> snapshot replays `start` while Live, not before', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass', { huddleMembers: [] });
    // The lifecycle fixture writes a minimal mirror; complete it so BetView builds.
    const bets = w.ctx.store.collection<Record<string, unknown>>(COLLECTIONS.bets);
    bets.set(bet.id, {
      ...bets.get(bet.id)!,
      bet: bet.id,
      draft_id: 'd',
      kind: 'rules',
      program_hash: '00'.repeat(32),
      yaml: null,
      readback: [],
      transcript: null,
      nonce: '1',
      acceptance_audio_hash: '00'.repeat(32),
      create_tx_id: 't',
      created: true,
      candidate_user_ids: [],
      acceptances: [],
      created_at_ms: 0,
      updated_at_ms: 0,
    });
    await calibrateAndFund(w, bet);
    await addWitness(w, bet, w.alice, 'camera');
    await addWitness(w, bet, w.bob, 'audio');

    const before = await betSnapshot(w)(bet.id, w.bob.user.id);
    expect(before.map((m) => m.type)).toEqual(['bet']);

    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`)).json()).toEqual({ ok: true });
    const live = await betSnapshot(w)(bet.id, w.bob.user.id);
    expect(live.map((m) => m.type)).toEqual(['bet', 'start']);
    const start = live[1] as { type: 'start'; bet_id: string; play_on_user_id: string; wav_url: string; beacon: { symbols: number[] } };
    expect(start.bet_id).toBe(bet.id);
    expect(start.play_on_user_id).toBe(w.alice.user.id);
    expect(start.wav_url.endsWith(`/v1/bets/${bet.id}/beacon.wav`)).toBe(true);
    expect(start.beacon.symbols.length).toBeGreaterThan(0);
  });
});
