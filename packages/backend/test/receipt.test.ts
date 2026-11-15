import { afterEach, describe, expect, it } from 'vitest';
import { BET_STATE, ZERO_HASH_HEX, type BetAccount } from '@verdict/engine';
import { chunkGaps, buildReceipt, type ReceiptInput } from '../src/receipt/rows.js';
import { boothService } from '../src/routes/replayBooth.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { auth, login, makeApp, type TestApp } from './appHelpers.js';
import { disputedAiJudgedBet, flush } from './bweHelpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

describe('GET /bets/:id/receipt (§12.11)', () => {
  it('returns the six rows for a panel-settled AI-judged bet', async () => {
    t = await makeApp();
    const a = await login(t.app, 'alex@example.com');
    const b = await login(t.app, 'maya@example.com');
    const { bet, witnessKeys } = await disputedAiJudgedBet(t.ctx, a.wallet, b.wallet, [
      { kind: 0, label: 'cam1', format: 'mjpeg', chunks: 2, user_id: a.user.id },
      { kind: 1, label: 'mic1', format: 'wav', chunks: 3, user_id: b.user.id },
    ]);
    expect(t.ctx.blobs.getChunk(bet, witnessKeys[0]!.publicKey, 0)).not.toBeNull();
    // Before the panel: settlement pending.
    let rows = (await t.app.inject({ method: 'GET', url: `/v1/bets/${bet}/receipt`, headers: auth(a) })).json().rows;
    expect(rows.map((r: { label: string }) => r.label)).toEqual(['Verified', 'Terms', 'Evidence', 'Compute', 'Proof', 'Settlement']);
    expect(rows[5]).toMatchObject({ key: 'settlement', status: 'pending', url: null });

    await boothService(t.ctx).ensure(bet);
    await flush(t.ctx);
    rows = (await t.app.inject({ method: 'GET', url: `/v1/bets/${bet}/receipt`, headers: auth(b) })).json().rows;
    const byKey = Object.fromEntries(rows.map((r: { key: string }) => [r.key, r]));
    expect(byKey.verified).toMatchObject({
      status: 'ok',
      url: null,
      detail: { key: 'verified', participants: [{ name: a.user.display_name, accepted: true }, { name: b.user.display_name, accepted: true }], bio_checks: [] },
    });
    expect(byKey.terms.detail.program_hash).toHaveLength(64);
    expect(byKey.terms.detail.readback[0]).toMatch(/^Question:/);
    expect(byKey.terms.detail.yaml_url).toBe(`${t.ctx.config.publicUrl}/v1/bets/${bet}/terms.yaml`);
    expect(byKey.evidence).toMatchObject({
      status: 'ok',
      detail: {
        gap_mask: 0,
        witnesses: [
          { label: 'cam1', chunks: 2, synced: true, gap: false, late_chunks: 0, gaps_ms: [] },
          { label: 'mic1', chunks: 3, synced: true, gap: false, late_chunks: 0, gaps_ms: [] },
        ],
      },
    });
    expect(byKey.evidence.detail.evidence_root).not.toBe(ZERO_HASH_HEX);
    expect(byKey.proof).toMatchObject({ status: 'none', detail: { binding: 'trusted', biometric: [], sp1: null } });
    expect(byKey.settlement).toMatchObject({
      status: 'ok',
      url: null, // mock mode
      detail: {
        path: 'panel',
        tx_url: null,
        payouts: [
          { name: a.user.display_name, amount_units: 0 },
          { name: b.user.display_name, amount_units: 6_000_000 },
        ],
      },
    });

    // §12.5 close-out: raw chunk bodies are deleted once Settled (exhibits stay).
    expect(t.ctx.blobs.getChunk(bet, witnessKeys[0]!.publicKey, 0)).toBeNull();
    expect(t.ctx.blobs.getChunk(bet, witnessKeys[1]!.publicKey, 0)).toBeNull();

    const yaml = await t.app.inject({ method: 'GET', url: `/v1/bets/${bet}/terms.yaml`, headers: auth(a) });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toMatch(/text\/yaml/);
    expect(yaml.body).toContain('kind: ai_judged');
    expect((await t.app.inject({ method: 'GET', url: `/v1/bets/${generateKeypair().publicKey}/receipt`, headers: auth(a) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/v1/bets/nope/receipt`, headers: auth(a) })).statusCode).toBe(404);
  });
});

describe('receipt rows (unit)', () => {
  const P = [generateKeypair().publicKey, generateKeypair().publicKey];
  const bet = (over: Partial<BetAccount>): BetAccount =>
    ({
      state: BET_STATE.PreRuled,
      flags: 1,
      n_participants: 2,
      participants: [...P, ...Array(6).fill('11111111111111111111111111111111')],
      stakes: [1_000_000n, 1_000_000n, 0n, 0n, 0n, 0n, 0n, 0n],
      funded_mask: 3,
      side_b_mask: 2,
      n_witnesses: 1,
      witnesses: [P[0], ...Array(7).fill('11111111111111111111111111111111')],
      witness_kinds: [0, 255, 255, 255, 255, 255, 255, 255],
      witness_heads: [3, ...Array(7).fill(0xffffffff)],
      witness_head_hashes: Array(8).fill(ZERO_HASH_HEX),
      gap_mask: 1,
      evidence_root: 'ab'.repeat(32),
      program_hash: 'cd'.repeat(32),
      started_at: 100n,
      n_bio: 1,
      bio: [{ participant: 1, modality: 1, frame: 42 }, ...Array(7).fill({ participant: 0, modality: 0, frame: 0 })],
      settle_path: 0,
      tracks_finalized: 1,
      dispute_bond: 0n,
      disputer: '11111111111111111111111111111111',
      ...over,
    }) as unknown as BetAccount;
  const input = (b: BetAccount, over: Partial<ReceiptInput> = {}): ReceiptInput => ({
    betId: 'B',
    bet: b,
    trackFlags: 0b00110,
    artifacts: null,
    witnesses: [],
    chunks: () => [],
    perception: {
      hosts: [{ provider: 'io.net', job_id: 'j1', url: 'https://x/j1', network: 'mainnet', model_hash: 'ef'.repeat(32) }],
      agreed: true,
      entity_agreement_bps: { ball: 9500 },
      audio_disagree: null,
      phone_disagree: null,
    },
    acceptances: [{ user_id: 'u1', accepted: true, voice_cos_bps: 8800 }],
    events: [{ name: 'BiometricVerified', signature: 'SIG1', slot: 1, index: 0, data: { bet: 'B', participant_idx: 1, modality: 1, frame: 42 } }],
    nameOf: (w) => (w === P[0] ? 'Alex' : 'Maya'),
    userIdOf: (w) => (w === P[1] ? 'u1' : null),
    txUrl: (s) => (s ? `https://explorer/tx/${s}` : null),
    accountUrl: (x) => `https://explorer/address/${x}`,
    yamlUrl: 'y',
    ...over,
  });

  it('maps flags, perception, biometric events and witness gaps', () => {
    const rows = buildReceipt(input(bet({})));
    const [verified, terms, evidence, compute, proof, settlement] = rows;
    expect(verified).toMatchObject({
      status: 'ok',
      detail: {
        participants: [{ name: 'Alex', accepted: true, voice_cos_bps: null }, { name: 'Maya', accepted: true, voice_cos_bps: 8800 }],
        bio_checks: [{ participant_name: 'Maya', frame: 42, modality: 'voice' }],
        cross_check_ok: true,
        audio_disagree: true,
        phone_disagree: false,
      },
    });
    expect(terms).toMatchObject({ status: 'pending', url: 'https://explorer/address/B' });
    expect(evidence).toMatchObject({ status: 'ok', detail: { witnesses: [{ label: 'cam1', chunks: 4, gap: true }] } });
    expect(compute).toMatchObject({ status: 'ok', url: 'https://x/j1', detail: { agreed: true, entity_agreement_bps: { ball: 9500 } } });
    expect(proof).toMatchObject({
      status: 'ok',
      url: 'https://explorer/tx/SIG1',
      detail: { biometric: [{ participant_name: 'Maya', modality: 'voice', frame: 42, tx_url: 'https://explorer/tx/SIG1' }] },
    });
    expect(settlement).toMatchObject({ status: 'pending', detail: { payouts: [] } });
  });

  it('cross-check failure and refunds', () => {
    expect(buildReceipt(input(bet({}), { trackFlags: 0, perception: null }))[0]!.status).toBe('failed');
    const refunded = buildReceipt(input(bet({ state: BET_STATE.Refunded, settle_path: 4, started_at: 0n, refund_reason: 1 } as Partial<BetAccount>), { events: [] }));
    expect(refunded[0]!.status).toBe('none');
    expect(refunded[5]).toMatchObject({ status: 'ok', detail: { path: 'refund', payouts: [{ name: 'Alex', amount_units: 1_000_000 }, { name: 'Maya', amount_units: 1_000_000 }] } });
    expect(chunkGaps([
      { index: 1, start_ms: 5200, duration_ms: 5000 },
      { index: 0, start_ms: 0, duration_ms: 5000 },
      { index: 2, start_ms: 10200, duration_ms: 5000 },
    ] as never)).toEqual([200]);
  });
});
