import { afterEach, describe, expect, it, vi } from 'vitest';
import { BET_STATE, CONSENT_WINDOW_S, FUND_WINDOW_S, marketHash, PERCEPTION_TIMEOUT_S, type Program } from '@verdict/engine';
import { lifecycleService } from '../../src/lifecycle/service.js';
import { lifecycleStores } from '../../src/lifecycle/stores.js';
import { marketEntries } from '../../src/lifecycle/seal.js';
import { lifecycleView } from '../../src/lifecycle/view.js';
import { betSources } from '../../src/integration/sources.js';
import { api, createBet, enrollFace, makeWorld, playBet, settle, signAndSubmit, type World } from './fixtures.js';

let w: World | null = null;
afterEach(async () => {
  await w?.app.close();
  w = null;
});

const state = async (id: string) => (await w!.ctx.chain.getBet(id))!;
/** Went through Disputed (the replay booth may already have ruled on it). */
const DISPUTED_OR_LATER = [BET_STATE.Disputed, BET_STATE.Settled, BET_STATE.Refunded] as number[];

describe('perception → post_tracks → run_rules (§6, §9.4, §12.6 step 4)', () => {
  it('cup tower (not actor-bound): two mock hosts agree, tracks posted in ≤700 B chunks, PreRuled for side 0', async () => {
    w = await makeWorld();
    const notify = vi.spyOn(w.ctx.hub, 'notify');
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await playBet(w, bet);
    const acct = await state(bet.id);
    expect(acct.state).toBe(BET_STATE.PreRuled);
    expect(acct.preruling).toBe(1);
    expect(acct.winner_mask).toBe(1);
    expect(acct.leg_results[0]).toBe(1);
    const rec = lifecycleStores(w.ctx).perception.get(bet.id)!;
    expect(rec.step).toBe('ruled');
    expect(rec.hosts).toHaveLength(2);
    expect(rec.cross?.ok).toBe(true);
    expect(rec.expected).toMatchObject({ preruling: 1, winner_mask: 1 });
    const payloadLen = Buffer.from(rec.payload_b64!, 'base64').length;
    expect(rec.posted_signatures.length).toBe(Math.ceil(payloadLen / 700));
    expect(acct.perception_root).toBe(rec.perception_root);
    expect(notify).toHaveBeenCalledWith(w.bob.user.id, 'Ruled', bet.id);
    // Read seam for booth/receipt.
    expect(betSources(w.ctx).perception(bet.id)).toMatchObject({ agreed: true, hosts: [{ provider: 'mock' }, { provider: 'mock' }] });
    expect(lifecycleView(w.ctx, bet.id).perception?.cross_check_ok).toBe(true);
  });

  it('consent by both participants settles to the winner', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await playBet(w, bet);
    const aliceBefore = await w.ctx.chain.getUsdcBalance(w.alice.wallet.publicKey);
    for (const u of [w.alice, w.bob]) {
      const r = await api(w, u, 'POST', `/v1/bets/${bet.id}/consent`);
      expect(r.statusCode).toBe(200);
      expect(r.json().sign.summary).toBe('Agree');
      expect((await signAndSubmit(w, u, r.json().sign)).status).toBe('confirmed');
    }
    await settle(w);
    const acct = await state(bet.id);
    expect(acct.state).toBe(BET_STATE.Settled);
    expect(acct.settle_path).toBe(1);
    expect(await w.ctx.chain.getUsdcBalance(w.alice.wallet.publicKey)).toBe(aliceBefore + 4_000_000n);
    // Nothing left to respond to.
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/consent`)).json().error.code).toBe('WRONG_STATE');
  });

  it('silence = consent: the keeper consents as the oracle after the deadline + 5 s', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await playBet(w, bet);
    // Alice agrees, Bob stays silent.
    const r = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/consent`);
    await signAndSubmit(w, w.alice, r.json().sign);
    await w.ctx.keeper.tick();
    expect((await state(bet.id)).state).toBe(BET_STATE.PreRuled);
    w.clock.advance((CONSENT_WINDOW_S + 6) * 1000);
    await w.ctx.keeper.tick();
    await settle(w);
    expect((await state(bet.id)).state).toBe(BET_STATE.Settled);
  });

  it('dispute posts the bond and moves to Disputed', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await playBet(w, bet);
    expect((await api(w, w.bob, 'POST', `/v1/bets/${bet.id}/dispute`, { reason: 9 })).statusCode).toBe(400);
    expect((await api(w, w.carol, 'POST', `/v1/bets/${bet.id}/dispute`, { reason: 1 })).json().error.code).toBe('WRONG_STATE');
    const r = await api(w, w.bob, 'POST', `/v1/bets/${bet.id}/dispute`, { reason: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().bond_units).toBe(400_000);
    expect(r.json().sign.summary).toBe('Bond $0.40');
    expect((await signAndSubmit(w, w.bob, r.json().sign)).status).toBe('confirmed');
    await settle(w);
    const acct = await state(bet.id);
    expect(DISPUTED_OR_LATER).toContain(acct.state);
    expect(acct.disputed_at).toBeGreaterThan(0n);
    expect(acct.dispute_reason).toBe(1);
    expect(acct.dispute_bond).toBe(400_000n);
  });

  it('paper ball (actor-bound): proves the shooter checkpoint with the enrolled face, then PreRuled for side 1', async () => {
    w = await makeWorld();
    await enrollFace(w, w.alice);
    await enrollFace(w, w.bob);
    w.clock.advance(1000);
    const bet = await createBet(w, 'ex1_paper_ball_pass');
    await playBet(w, bet);
    const acct = await state(bet.id);
    const rec = lifecycleStores(w.ctx).perception.get(bet.id)!;
    expect(rec.proofs).toHaveLength(1);
    expect(rec.proofs[0]).toMatchObject({ participant: 1, modality: 'face', tau_bps: 5500, status: 'verified' });
    expect(acct.n_bio).toBe(1);
    expect(acct.bio[0]).toMatchObject({ participant: 1, modality: 0, frame: rec.proofs[0]!.frame });
    expect(acct.state).toBe(BET_STATE.PreRuled);
    expect(acct.winner_mask).toBe(2);
  });

  it('paper ball without enrollment: no proof → IDENTITY → replay booth (reason 10)', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex1_paper_ball_pass');
    await playBet(w, bet);
    const acct = await state(bet.id);
    expect(lifecycleStores(w.ctx).perception.get(bet.id)!.proofs).toEqual([]);
    expect(DISPUTED_OR_LATER).toContain(acct.state);
    expect(acct.disputed_at).toBeGreaterThan(0n);
    expect(acct.dispute_reason).toBe(10);
    expect(acct.leg_results[0]).toBe(2);
  });
});

describe('MOCK_SCENARIO paths (§13)', () => {
  const cases: [string, string, number][] = [
    ['no_identity', 'ex1_paper_ball_pass', 10],
    ['cross_fail', 'ex2_cup_tower_pass', 12],
    ['oversize', 'ex2_cup_tower_pass', 13],
    ['motion', 'ex3_push_ups_pass', 10],
  ];
  for (const [scenario, vec, reason] of cases) {
    it(`${scenario} → Disputed reason ${reason}`, async () => {
      w = await makeWorld({ MOCK_SCENARIO: scenario });
      await enrollFace(w, w.alice);
      await enrollFace(w, w.bob);
      w.clock.advance(1000);
      const bet = await createBet(w, vec);
      await playBet(w, bet);
      const acct = await state(bet.id);
      expect(DISPUTED_OR_LATER).toContain(acct.state);
    expect(acct.disputed_at).toBeGreaterThan(0n);
      expect(acct.dispute_reason).toBe(reason);
      const rec = lifecycleStores(w.ctx).perception.get(bet.id)!;
      expect(rec.expected?.reason).toBe(reason);
      if (scenario === 'cross_fail') expect(rec.cross?.ok).toBe(false);
      if (scenario === 'oversize') expect(rec.window_unavailable).toBe(true);
    });
  }

  it('fail → PreRuled for the other side', async () => {
    w = await makeWorld({ MOCK_SCENARIO: 'fail' });
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await playBet(w, bet);
    const acct = await state(bet.id);
    expect(acct.state).toBe(BET_STATE.PreRuled);
    expect(acct.winner_mask).toBe(2);
  });

  it('ai_judged posts the minimal track_bin → Disputed reason 11', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex4_ai_judged');
    await playBet(w, bet);
    const acct = await state(bet.id);
    expect(DISPUTED_OR_LATER).toContain(acct.state);
    expect(acct.disputed_at).toBeGreaterThan(0n);
    expect(acct.dispute_reason).toBe(11);
  });
});

describe('keeper refunds (§9.4 #15, §12.6 step 7)', () => {
  it('refunds a Proposed bet after the fund window', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex4_ai_judged');
    const f = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/fund`);
    await signAndSubmit(w, w.alice, f.json().sign);
    const before = await w.ctx.chain.getUsdcBalance(w.alice.wallet.publicKey);
    w.clock.advance((FUND_WINDOW_S + 1) * 1000);
    await w.ctx.keeper.tick();
    await settle(w);
    const acct = await state(bet.id);
    expect(acct.state).toBe(BET_STATE.Refunded);
    expect(acct.refund_reason).toBe(1);
    expect(await w.ctx.chain.getUsdcBalance(w.alice.wallet.publicKey)).toBe(before + 3_000_000n);
  });

  it('a failing perception provider retries, then the perception timeout refunds', async () => {
    w = await makeWorld();
    const svc = lifecycleService(w.ctx);
    vi.spyOn(w.ctx.providers.perception, 'runPair').mockRejectedValue(new Error('hosts unavailable'));
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await playBet(w, bet);
    expect((await state(bet.id)).state).toBe(BET_STATE.Perceiving);
    const rec = lifecycleStores(w.ctx).perception.get(bet.id)!;
    expect(rec.step).toBe('failed');
    expect(rec.error).toMatch(/hosts unavailable/);
    w.clock.advance((PERCEPTION_TIMEOUT_S + 1) * 1000);
    await w.ctx.keeper.tick();
    await settle(w);
    await svc.perception.idle();
    const acct = await state(bet.id);
    expect(acct.state).toBe(BET_STATE.Refunded);
    expect(acct.refund_reason).toBe(5);
  });
});

describe('market resolutions (§11.4)', () => {
  it('reads Gemini resolutions into market_bin entries', async () => {
    w = await makeWorld();
    const leg = (id: number, event_id: string, contract_id: string) => ({
      id,
      actor_bound: false,
      attempt_window_frames: 0,
      market: { venue: 'gemini' as const, event_id, contract_id, side: 'yes' as const, prob_bps: 5000 },
    });
    const p = { legs: [leg(1, 'GEMI-ETH-ETF-NOV26', 'GEMI-ETH-5K-NOV26-YES')] } as unknown as Program;
    const r = await marketEntries(w.ctx, p);
    expect(r).toEqual({ resolved: true, entries: [{ market_hash: marketHash('GEMI-ETH-ETF-NOV26', 'GEMI-ETH-5K-NOV26-YES'), result: 1 }] });
    const open = await marketEntries(w.ctx, { legs: [leg(1, 'GEMI-FED-DEC26', 'x')] } as unknown as Program);
    expect(open).toEqual({ resolved: false, entries: [] });
  });
});
