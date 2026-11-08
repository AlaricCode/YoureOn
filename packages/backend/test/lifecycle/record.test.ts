import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BEACON_SAMPLE_RATE,
  BET_STATE,
  beaconSymbols,
  decodeBeacon,
  encodeBeaconPayload,
  evidenceRoot,
  HEAD_INDEX_NONE,
  synthBeacon,
} from '@verdict/engine';
import { lifecycleService } from '../../src/lifecycle/service.js';
import { lifecycleStores } from '../../src/lifecycle/stores.js';
import { fromHex } from '../../src/util/bytes.js';
import { decodeWav, encodeWav } from '../../src/util/wav.js';
import { auth, login, type TestUser } from '../appHelpers.js';
import { generateKeypair } from '../../src/crypto/keys.js';
import { primaryCamera } from '../../src/lifecycle/footage.js';
import {
  addWitness,
  api,
  calibrateAndFund,
  chunkRecord,
  createBet,
  makeWorld,
  settle,
  uploadChunk,
  type World,
} from './fixtures.js';

let w: World | null = null;
afterEach(async () => {
  await w?.app.close();
  w = null;
});

const bytes = (s: string) => new TextEncoder().encode(s);

describe('witnesses + start + beacon (§7.1, §7.5, §12.4)', () => {
  it('needs a camera, starts as the oracle, broadcasts WS start with a decodable beacon', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass', { huddleMembers: [] });
    await calibrateAndFund(w, bet);
    // Bob (participant) registers a mic; a non-member cannot.
    const mic = await addWitness(w, bet, w.bob, 'audio');
    expect((await api(w, w.carol, 'POST', `/v1/bets/${bet.id}/witnesses`, { witness_key: mic.key.publicKey, kind: 'audio' })).statusCode).toBe(404);
    // Bob is not the creator; Alice has no camera yet.
    expect((await api(w, w.bob, 'POST', `/v1/bets/${bet.id}/start`)).json().error.code).toBe('WRONG_STATE');
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`)).json().error.code).toBe('NO_CAMERA');

    const cam = await addWitness(w, bet, w.alice, 'camera');
    // Idempotent re-registration returns the same label.
    const again = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/witnesses`, { witness_key: cam.key.publicKey, kind: 'camera' });
    expect(again.json()).toEqual({ witness_id: cam.key.publicKey, label: 'cam1' });

    const pub = vi.spyOn(w.ctx.hub, 'publish');
    const r = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`);
    expect(r.json()).toEqual({ ok: true });
    const acct = (await w.ctx.chain.getBet(bet.id))!;
    expect(acct.state).toBe(BET_STATE.Live);
    expect(acct.n_witnesses).toBe(2);
    // The creator's (calibrated) camera is always index 0, whatever the registration order.
    expect(acct.witnesses.slice(0, 2)).toEqual([cam.key.publicKey, mic.key.publicKey]);

    const start = pub.mock.calls.map((c) => c[1]).find((m) => m.type === 'start') as {
      beacon: { slot: number; hash_hex: string; symbols: number[] };
      play_on_user_id: string;
      play_delay_ms: number;
      wav_url: string;
    };
    expect(start.play_on_user_id).toBe(w.alice.user.id);
    expect(start.play_delay_ms).toBe(1500);
    expect(BigInt(start.beacon.slot)).toBe(acct.beacon_slot);
    expect(start.beacon.hash_hex).toBe(acct.beacon_hash);
    expect(start.beacon.symbols).toEqual(beaconSymbols(encodeBeaconPayload(acct.beacon_slot, fromHex(acct.beacon_hash, 32))));
    expect(start.wav_url.endsWith(`/v1/bets/${bet.id}/beacon.wav`)).toBe(true);

    const wav = await api(w, w.bob, 'GET', `/v1/bets/${bet.id}/beacon.wav`);
    expect(wav.headers['content-type']).toBe('audio/wav');
    const dec = decodeWav(new Uint8Array(wav.rawPayload));
    const beacon = decodeBeacon(dec.samples, dec.sampleRate);
    expect(beacon?.slot).toBe(acct.beacon_slot);
    expect((await api(w, w.bob, 'GET', `/v1/bets/${bet.id}/start-sound`)).statusCode).toBe(200);

    // After start the witness list is fixed.
    const late = await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/witnesses`, { witness_key: 'So11111111111111111111111111111111111111112', kind: 'audio' });
    expect(late.json().error.code).toBe('WRONG_STATE');
  });
});

describe('primary camera binding + witness slots', () => {
  it("a counterparty cannot take the primary camera; the creator's camera is index 0", async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await calibrateAndFund(w, bet);
    // Bob (counterparty) tries to register a camera before Alice's calibrated device.
    const early = await api(w, w.bob, 'POST', `/v1/bets/${bet.id}/witnesses`, { witness_key: generateKeypair().publicKey, kind: 'camera' });
    expect(early.json().error.code).toBe('NO_CAMERA');
    const bobMic = await addWitness(w, bet, w.bob, 'audio');
    // One witness per kind per user.
    const second = await api(w, w.bob, 'POST', `/v1/bets/${bet.id}/witnesses`, { witness_key: generateKeypair().publicKey, kind: 'audio' });
    expect(second.json().error.code).toBe('WRONG_STATE');
    const cam = await addWitness(w, bet, w.alice, 'camera');
    const bobCam = await addWitness(w, bet, w.bob, 'camera');
    const labels = lifecycleStores(w.ctx).witnesses.get(bet.id)!.witnesses.map((x) => x.label);
    expect(labels).toEqual(['mic1', 'cam1', 'cam2']);
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`)).statusCode).toBe(200);
    const acct = (await w.ctx.chain.getBet(bet.id))!;
    expect(acct.witnesses.slice(0, 3)).toEqual([cam.key.publicKey, bobMic.key.publicKey, bobCam.key.publicKey]);
    expect(primaryCamera(lifecycleStores(w.ctx), bet.id)?.witness_key).toBe(cam.key.publicKey);
  });

  it("bystanders cannot fill the witness slots reserved for the creator", async () => {
    w = await makeWorld();
    const extra: TestUser[] = [];
    for (let i = 0; i < 8; i++) extra.push(await login(w.app, `bystander${i}@example.com`));
    const bet = await createBet(w, 'ex2_cup_tower_pass', { huddleMembers: [w.alice, w.bob, ...extra] });
    await calibrateAndFund(w, bet);
    await addWitness(w, bet, w.bob, 'audio');
    for (let i = 0; i < 5; i++) await addWitness(w, bet, extra[i]!, 'audio');
    // 6 non-creator witnesses: the last 2 slots are the creator's.
    const full = await api(w, extra[5]!, 'POST', `/v1/bets/${bet.id}/witnesses`, { witness_key: generateKeypair().publicKey, kind: 'audio' });
    expect(full.json().error.code).toBe('HUDDLE_FULL');
    const cam = await addWitness(w, bet, w.alice, 'camera');
    await addWitness(w, bet, w.alice, 'audio');
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`)).statusCode).toBe(200);
    const acct = (await w.ctx.chain.getBet(bet.id))!;
    expect(acct.n_witnesses).toBe(8);
    expect(acct.witnesses[0]).toBe(cam.key.publicKey);
  });
});

describe('start robustness (live record persisted before providers)', () => {
  it('a failing SFX provider still starts the bet with the bundled sound', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await calibrateAndFund(w, bet);
    await addWitness(w, bet, w.alice, 'camera');
    vi.spyOn(w.ctx.providers.sfx, 'startSound').mockRejectedValue(new Error('elevenlabs down'));
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`)).statusCode).toBe(200);
    const s = lifecycleStores(w.ctx);
    expect(s.live.get(bet.id)?.beacon).not.toBeNull();
    expect((await api(w, w.bob, 'GET', `/v1/bets/${bet.id}/start-sound`)).statusCode).toBe(200);
  });

  it('a Live bet without a live record is adopted again by POST /start and by the keeper', async () => {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await calibrateAndFund(w, bet);
    const cam = await addWitness(w, bet, w.alice, 'camera');
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`)).statusCode).toBe(200);
    const s = lifecycleStores(w.ctx);
    const orig = s.live.get(bet.id)!;
    const acct = (await w.ctx.chain.getBet(bet.id))!;

    // Crash right after `start` confirmed: no live record.
    s.live.delete(bet.id);
    const pub = vi.spyOn(w.ctx.hub, 'publish');
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`)).json()).toEqual({ ok: true });
    const rec = s.live.get(bet.id)!;
    expect(rec.beacon).toEqual(orig.beacon); // from the chain's beacon, not a fresh slot hash
    expect(rec.beacon!.hash_hex).toBe(acct.beacon_hash);
    expect(rec.play_on_user_id).toBe(w.alice.user.id);
    expect(pub.mock.calls.some((c) => (c[1] as { type: string }).type === 'start')).toBe(true);

    // Keeper path.
    s.live.delete(bet.id);
    await w.ctx.keeper.tick();
    expect(s.live.get(bet.id)?.beacon?.hash_hex).toBe(acct.beacon_hash);
    expect(s.witnesses.get(bet.id)!.witnesses[0]!.witness_key).toBe(cam.key.publicKey);
  });
});

describe('chunks (§7.2, §12.3)', () => {
  async function started() {
    w = await makeWorld();
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await calibrateAndFund(w, bet);
    const cam = await addWitness(w, bet, w.alice, 'camera');
    const mic = await addWitness(w, bet, w.bob, 'audio');
    expect((await api(w, w.alice, 'POST', `/v1/bets/${bet.id}/start`)).statusCode).toBe(200);
    return { bet, cam, mic };
  }

  it('bounds each witness: chunk duration and session window', async () => {
    const { bet, cam } = await started();
    const tooLong = (await chunkRecord(w!, bet, cam, bytes('x'), 2 * 5000 + 1)).rec;
    expect((await api(w!, w!.alice, 'POST', `/v1/bets/${bet.id}/chunks`, tooLong)).statusCode).toBe(400);
    const tooShort = (await chunkRecord(w!, bet, cam, bytes('x'), 100)).rec;
    expect((await api(w!, w!.alice, 'POST', `/v1/bets/${bet.id}/chunks`, tooShort)).statusCode).toBe(400);
    const { chunkLimits } = await import('../../src/lifecycle/evidence.js');
    const lim = chunkLimits(bet.program.time_limit_s);
    expect(lim.maxIndex).toBeLessThan(2000);
    // A short final chunk is fine.
    await uploadChunk(w!, bet, cam, bytes('frame-0'));
    await uploadChunk(w!, bet, cam, bytes('frame-1'), true, 120);
  });

  it('verifies hash records against the chain, stores bodies, serves them back', async () => {
    const { bet, cam } = await started();
    const body = bytes('chunk-0');
    const { rec, commit } = await chunkRecord(w!, bet, cam, body);
    // Bad signature / bad prev / wrong index / wrong owner are refused.
    expect((await api(w!, w!.alice, 'POST', `/v1/bets/${bet.id}/chunks`, { ...rec, sig_b64: rec.sig_b64.replace(/^./, rec.sig_b64[0] === 'A' ? 'B' : 'A') })).statusCode).toBe(400);
    expect((await api(w!, w!.alice, 'POST', `/v1/bets/${bet.id}/chunks`, { ...rec, prev_hash: '00'.repeat(32) })).statusCode).toBe(400);
    expect((await api(w!, w!.alice, 'POST', `/v1/bets/${bet.id}/chunks`, { ...rec, index: 1 })).statusCode).toBe(400);
    expect((await api(w!, w!.bob, 'POST', `/v1/bets/${bet.id}/chunks`, rec)).statusCode).toBe(404);
    // Camera metadata must match the calibration.
    expect((await api(w!, w!.alice, 'POST', `/v1/bets/${bet.id}/chunks`, { ...rec, width_px: 1280 })).json().error.code).toBe('CAMERA_MISMATCH');

    const ok = await api(w!, w!.alice, 'POST', `/v1/bets/${bet.id}/chunks`, rec);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accepted).toBe(true);
    expect(ok.json().upload_url).toMatch(new RegExp(`/v1/bets/${bet.id}/chunks/${cam.key.publicKey}/0$`));
    // Idempotent re-post.
    expect((await api(w!, w!.alice, 'POST', `/v1/bets/${bet.id}/chunks`, rec)).statusCode).toBe(200);
    commit();

    const put = (payload: Uint8Array) =>
      w!.app.inject({
        method: 'PUT',
        url: `/v1/bets/${bet.id}/chunks/${cam.key.publicKey}/0`,
        headers: { ...auth(w!.alice), 'content-type': 'application/octet-stream' },
        payload: Buffer.from(payload),
      });
    expect((await put(bytes('tampered'))).statusCode).toBe(400);
    expect((await put(body)).json()).toEqual({ stored: true });
    const get = await api(w!, w!.bob, 'GET', `/v1/bets/${bet.id}/chunks/${cam.key.publicKey}/0`);
    expect(Buffer.from(get.rawPayload).toString()).toBe('chunk-0');
    // Body for an unknown record.
    const nope = await w!.app.inject({
      method: 'PUT',
      url: `/v1/bets/${bet.id}/chunks/${cam.key.publicKey}/5`,
      headers: { ...auth(w!.alice), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(body),
    });
    expect(nope.statusCode).toBe(404);
  });

  it('rejects bodies over 20 MiB with CHUNK_TOO_LARGE (413)', async () => {
    const { bet, cam } = await started();
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    const r = await w!.app.inject({
      method: 'PUT',
      url: `/v1/bets/${bet.id}/chunks/${cam.key.publicKey}/0`,
      headers: { ...auth(w!.alice), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(big),
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('CHUNK_TOO_LARGE');
  });

  it('decodes the beacon from audio witness chunks and aligns the same device camera', async () => {
    const { bet, cam, mic } = await started();
    const acct = (await w!.ctx.chain.getBet(bet.id))!;
    const tones = synthBeacon(beaconSymbols(encodeBeaconPayload(acct.beacon_slot, fromHex(acct.beacon_hash, 32))), BEACON_SAMPLE_RATE);
    // 1.7 s of silence (start sound + delay) then the tones, recorded at 48 kHz.
    const pre = Math.round(1.7 * BEACON_SAMPLE_RATE);
    const pcm = new Int16Array(5 * BEACON_SAMPLE_RATE);
    pcm.set(tones, pre);
    await uploadChunk(w!, bet, mic, encodeWav(pcm, BEACON_SAMPLE_RATE));
    const s = lifecycleStores(w!.ctx);
    const m = s.witnesses.get(bet.id)!.witnesses.find((x) => x.witness_key === mic.key.publicKey)!;
    expect(m.synced).toBe(true);
    expect(Math.abs(m.offset_ms! - 3800)).toBeLessThanOrEqual(2);
    // Bob's mic does not align Alice's camera (different device/user).
    expect(s.witnesses.get(bet.id)!.witnesses.find((x) => x.witness_key === cam.key.publicKey)!.synced).toBeNull();
  });

  it('commits rolling evidence roots every 30 s (keeper) and ends with the final heads', async () => {
    const { bet, cam, mic } = await started();
    await uploadChunk(w!, bet, cam, bytes('c0'));
    w!.clock.advance(31_000);
    await w!.ctx.keeper.tick();
    let acct = (await w!.ctx.chain.getBet(bet.id))!;
    expect(acct.evidence_seq).toBe(1);
    expect(acct.witness_heads.slice(0, 2)).toEqual([0, HEAD_INDEX_NONE]);
    // Not due again right away.
    await w!.ctx.keeper.tick();
    expect((await w!.ctx.chain.getBet(bet.id))!.evidence_seq).toBe(1);

    await uploadChunk(w!, bet, cam, bytes('c1'), true);
    // End requested: the mic is not final → wait (≤ 10 s) …
    expect((await api(w!, w!.bob, 'POST', `/v1/bets/${bet.id}/end`)).json()).toEqual({ ok: true });
    expect((await w!.ctx.chain.getBet(bet.id))!.state).toBe(BET_STATE.Live);
    // … until the mic's final chunk arrives.
    await uploadChunk(w!, bet, mic, encodeWav(new Int16Array(1600), 16000), true);
    acct = (await w!.ctx.chain.getBet(bet.id))!;
    expect(acct.state).toBeGreaterThanOrEqual(BET_STATE.Perceiving);
    expect(acct.ended_at).toBeGreaterThan(0n);
    expect(acct.witness_heads.slice(0, 2)).toEqual([1, 0]);
    const s = lifecycleStores(w!.ctx);
    const heads = [cam, mic].map((x) => {
      const recs = s.chunks.filter((c) => c.bet === bet.id && c.witness_key === x.key.publicKey).sort((a, b) => a.index - b.index);
      const last = recs[recs.length - 1]!;
      return { witness_key: x.key.publicKey, index: last.index, hash: fromHex(last.chunk_hash, 32) };
    });
    expect(acct.evidence_root).toBe(Buffer.from(evidenceRoot(heads)).toString('hex'));
    await settle(w!);
  });

  it('the keeper ends a bet 10 s after the time limit + tail even without final chunks', async () => {
    const { bet } = await started();
    w!.clock.advance(30_000 + 2_000 + 10_000);
    await w!.ctx.keeper.tick(); // requests the end (limit + tail passed)
    expect((await w!.ctx.chain.getBet(bet.id))!.state).toBe(BET_STATE.Live);
    w!.clock.advance(10_001);
    await w!.ctx.keeper.tick();
    expect((await w!.ctx.chain.getBet(bet.id))!.state).toBeGreaterThanOrEqual(BET_STATE.Perceiving);
    await settle(w!);
    void lifecycleService;
  });
});
