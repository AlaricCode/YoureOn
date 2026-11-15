import { afterEach, describe, expect, it, vi } from 'vitest';
import { BET_STATE, calibrationHash, ZERO_HASH_HEX } from '@verdict/engine';
import { lifecycleService } from '../../src/lifecycle/service.js';
import { exprAt } from '../../src/lifecycle/scene.js';
import { toBase64 } from '../../src/util/bytes.js';
import { api, calibrateAndFund, createBet, makeWorld, settle, signAndSubmit, type World } from './fixtures.js';

let w: World | null = null;
afterEach(async () => {
  await w?.app.close();
  w = null;
});

const JPEG = toBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]));

describe('scene check (§5.2, §12.3, §12.10)', () => {
  it('detects entities and reports condition rows; unplaced regions are grey', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex1_paper_ball_pass');
    const r = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/scene/detect`, { frame_b64: JPEG });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { entities: { entity: string; conf: number; bbox: number[] }[]; conditions: { leg: number; field: string; path: string; label: string; state: boolean; placed: boolean }[] };
    expect(j.entities.map((e) => e.entity).sort()).toEqual(['ball', 'can', 'shooter']);
    expect(j.entities.every((e) => e.conf === 90 && e.bbox.length === 4)).toBe(true);
    // valid_attempt: released_by (0), behind line (1); success: disappears_into (0.0), inside (0.1.0), at_rest (0.1.1)
    expect(j.conditions.map((c) => `${c.field}:${c.path}`)).toEqual([
      'valid_attempt:0',
      'valid_attempt:1',
      'success:0',
      'success:1.0',
      'success:1.1',
    ]);
    const behind = j.conditions.find((c) => c.path === '1' && c.field === 'valid_attempt')!;
    expect(behind.placed).toBe(false);
    expect(behind.label).toBe('Behind line');
    expect(j.conditions.filter((c) => c.placed).length).toBe(4);
    // A stranger cannot use the scene check.
    const s = await api(w, w.carol, 'POST', `/v1/bets/${bet.id}/scene/detect`, { frame_b64: JPEG });
    expect(s.statusCode).toBe(404);
  });

  it('validates calibration, returns the engine calibration_hash, locks after funding', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex1_paper_ball_pass');
    const url = `/v1/bets/${bet.id}/calibration`;
    // Only the creator calibrates.
    expect((await api(w, w.bob, 'PUT', url, bet.calibration)).json().error.code).toBe('WRONG_STATE');
    // Missing the line region → CALIBRATION_INCOMPLETE.
    const incomplete = await api(w, w.alice, 'PUT', url, { ...bet.calibration!, regions: [] });
    expect(incomplete.json().error.code).toBe('CALIBRATION_INCOMPLETE');
    // Degenerate line → 400.
    const bad = await api(w, w.alice, 'PUT', url, {
      ...bet.calibration!,
      regions: [{ entity: 'line', shape: 'line', points: [[10, 10], [10, 10]], behind_sign: 1 }],
    });
    expect(bad.statusCode).toBe(400);
    // Unknown entity in entity_refs → 400.
    const unk = await api(w, w.alice, 'PUT', url, {
      ...bet.calibration!,
      scene: { ...bet.calibration!.scene, entity_refs: [{ entity: 'nope', label: 'Nope', bbox: [0, 0, 1, 1] }] },
    });
    expect(unk.statusCode).toBe(400);

    const ok = await api(w, w.alice, 'PUT', url, bet.calibration);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().calibration_hash).toBe(calibrationHash(bet.calibration!, bet.program));
    // The bets mirror carries it for BetView.
    expect((w.ctx.store.collection('bets').get(bet.id) as Record<string, unknown>)['calibration_hash']).toBe(ok.json().calibration_hash);

    // Placed region → its condition row is placed now.
    const det = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/scene/detect`, { frame_b64: JPEG });
    expect(det.json().conditions.every((c: { placed: boolean }) => c.placed)).toBe(true);

    // Fund (the second tap) commits the calibration onchain.
    const f = await api(w, w.bob, 'POST', `/v1/bets/${bet.id}/fund`);
    expect(f.statusCode).toBe(200);
    expect(f.json().sign.summary).toBe('Stake $5.00');
    expect((await signAndSubmit(w, w.bob, f.json().sign)).status).toBe('confirmed');
    const acct = (await w.ctx.chain.getBet(bet.id))!;
    expect(acct.calibration_hash).toBe(ok.json().calibration_hash);
    expect(acct.funded_mask).toBe(0b10);
    // Locked once anyone funded.
    expect((await api(w, w.alice, 'PUT', url, bet.calibration)).json().error.code).toBe('CALIBRATION_LOCKED');
  });

  it('stores label-correction crops (creator only)', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex1_paper_ball_pass');
    const put = (u = w!.alice, entity = 'ball') =>
      w!.app.inject({
        method: 'PUT',
        url: `/v1/bets/${bet.id}/scene/crops/${entity}`,
        headers: { authorization: `Bearer ${u.token}`, 'content-type': 'image/jpeg' },
        payload: Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]),
      });
    const ok = await put();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().crop_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await put(w.bob)).statusCode).toBe(409);
    expect((await put(w.alice, 'line')).statusCode).toBe(404);
  });

  it('streams WS scene frames into a rolling buffer and publishes scene rows', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    const svc = lifecycleService(w.ctx);
    const pub = vi.spyOn(w.ctx.hub, 'publish');
    const info = (await import('../../src/lifecycle/betInfo.js')).loadBetInfo(w.ctx, bet.id);
    for (let i = 0; i < 60; i++) {
      svc.scene.push(info, JPEG);
      await svc.scene.drain(bet.id);
    }
    expect(svc.scene.bufferLength(bet.id)).toBe(50);
    const scene = pub.mock.calls.map((c) => c[1]).filter((m) => m.type === 'scene');
    expect(scene.length).toBe(60);
    const last = scene[scene.length - 1] as { conditions: { label: string; state: boolean }[] };
    // tower present every frame → "intact" holds (no ref_h shortfall).
    expect(last.conditions).toEqual([{ leg: 1, field: 'success', path: '', label: 'cup tower standing', state: true, placed: true }]);
  });
});

describe('calibration vs fund race', () => {
  it('PUT is refused while a fund tx is pending; a late scene change is rolled back to the onchain hash', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex1_paper_ball_pass');
    const url = `/v1/bets/${bet.id}/calibration`;
    const h1 = (await api(w, w.alice, 'PUT', url, bet.calibration)).json().calibration_hash as string;
    const cal2 = { ...bet.calibration!, regions: bet.calibration!.regions.map((r) => ({ ...r, points: r.points.map(([x, y]) => [Math.min(10000, x + 7), y]) })) };
    const fa = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/fund`);
    expect(fa.statusCode).toBe(200);
    // fundSign → PUT a new calibration: locked while A's fund tx can still land.
    expect((await api(w, w.alice, 'PUT', url, cal2)).json().error.code).toBe('CALIBRATION_LOCKED');
    // Crops are locked the same way.
    const crop = await w.app.inject({
      method: 'PUT',
      url: `/v1/bets/${bet.id}/scene/crops/ball`,
      headers: { authorization: `Bearer ${w.alice.token}`, 'content-type': 'image/jpeg' },
      payload: Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]),
    });
    expect(crop.json().error.code).toBe('CALIBRATION_LOCKED');
    expect((await signAndSubmit(w, w.alice, fa.json().sign)).status).toBe('confirmed');
    expect((await w.ctx.chain.getBet(bet.id))!.calibration_hash).toBe(h1);

    // Defence in depth: even if the scene was replaced (H2) after the first fund
    // landed, fundSign and the CAMERA_MISMATCH/perception paths use history[H1].
    const { lifecycleStores } = await import('../../src/lifecycle/stores.js');
    const s = lifecycleStores(w.ctx);
    const h2 = calibrationHash(cal2 as typeof bet.calibration & object, bet.program);
    expect(h2).not.toBe(h1);
    s.scenes.update(bet.id, (r) => ({ ...r, calibration: cal2 as never, calibration_hash: h2, history: { ...r.history, [h2]: cal2 as never } }));
    const fb = await api(w, w.bob, 'POST', `/v1/bets/${bet.id}/fund`);
    expect(fb.statusCode).toBe(200);
    expect((await signAndSubmit(w, w.bob, fb.json().sign)).status).toBe('confirmed');
    expect(s.scenes.get(bet.id)!.calibration_hash).toBe(h1);
    expect((await w.ctx.chain.getBet(bet.id))!.state).toBe(BET_STATE.Funded);
  });
});

describe('fund (§9.4 #3, §12.3)', () => {
  it('refuses before calibration, then funds both with sponsored gas → Funded', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    const early = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/fund`);
    expect(early.json().error.code).toBe('CALIBRATION_INCOMPLETE');
    // Strangers are not participants.
    await api(w, w.alice, 'PUT', `/v1/bets/${bet.id}/calibration`, bet.calibration);
    expect((await api(w, w.carol, 'POST', `/v1/bets/${bet.id}/fund`)).json().error.code).toBe('WRONG_STATE');
    const notify = vi.spyOn(w.ctx.hub, 'notify');
    const before = await w.ctx.chain.getUsdcBalance(w.alice.wallet.publicKey);
    await calibrateAndFund(w, bet);
    await settle(w);
    const acct = (await w.ctx.chain.getBet(bet.id))!;
    expect(acct.state).toBe(BET_STATE.Funded);
    expect(await w.ctx.chain.getUsdcBalance(w.alice.wallet.publicKey)).toBe(before - 2_000_000n);
    expect(notify).toHaveBeenCalledWith(w.alice.user.id, 'Ready', bet.id);
    // Already funded.
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/fund`)).json().error.code).toBe('WRONG_STATE');
  });

  it('INSUFFICIENT_FUNDS when the wallet cannot cover the stake', async () => {
    w = await makeWorld();
    const poor = await (await import('../appHelpers.js')).login(w.app, 'poor@example.com');
    const bet = await createBet(w, 'ex4_ai_judged', { other: poor });
    const r = await api(w, poor, 'POST', `/v1/bets/${bet.id}/fund`);
    expect(r.json().error.code).toBe('INSUFFICIENT_FUNDS');
    // ai_judged funds with a zero calibration hash (no scene).
    const ok = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/fund`);
    expect(ok.statusCode).toBe(200);
    expect((await signAndSubmit(w, w.alice, ok.json().sign)).status).toBe('confirmed');
    expect((await w.ctx.chain.getBet(bet.id))!.calibration_hash).toBe(ZERO_HASH_HEX);
  });
});

describe('exprAt', () => {
  it('walks leafSignals paths', () => {
    const e = { op: 'or', args: [{ op: 'present', a: { e: 'x' } }, { op: 'not', arg: { op: 'moving', a: { e: 'x' } } }] } as never;
    expect(exprAt(e, '')).toBe(e);
    expect((exprAt(e, '1.0') as { op: string }).op).toBe('moving');
    expect(exprAt(e, '2')).toBeNull();
  });
});
