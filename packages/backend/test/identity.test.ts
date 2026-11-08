import { afterEach, describe, expect, it } from 'vitest';
import { commitmentFromBytes, poseidonCommit, hexToBytes, RECENT_HUDDLE_S } from '@verdict/engine';
import { decryptAesGcm } from '../src/crypto/aes.js';
import { commitTemplate } from '../src/identity/biometrics.js';
import { identityHuddleServices } from '../src/huddles/services.js';
import { MAX_PENDING_JOINS, PENDING_JOIN_TTL_MS } from '../src/huddles/service.js';
import { JOIN_RATE } from '../src/routes/huddles.js';
import { fromBase64 } from '../src/util/bytes.js';
import { auth, login, type TestApp } from './appHelpers.js';
import { b64, crew, enroll, fakeJpeg, fakeWav, get, makeAppWith, post, submitSign } from './identityHelpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

describe('enrollment (§8, §12.3)', () => {
  it('issues a challenge with 2 face prompts and 3 voice phrases', async () => {
    t = await makeAppWith();
    const u = await login(t.app, 'alice@example.com');
    const ch = (await get(t.app, u, '/v1/enroll/challenge')).json();
    expect(typeof ch.challenge_id).toBe('string');
    expect(ch.face_prompts).toHaveLength(2);
    expect(new Set(ch.face_prompts).size).toBe(2);
    for (const p of ch.face_prompts) expect(['left', 'right', 'up', 'down']).toContain(p);
    expect(ch.voice_phrases).toHaveLength(3);
    for (const p of ch.voice_phrases) expect(p).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
  });

  it('enrolls face + voice, seals encrypted templates and commits them on chain', async () => {
    t = await makeAppWith();
    const u = await login(t.app, 'alice@example.com');
    const commits = await enroll(t.app, u, 'Alice');
    expect(commits.face_commit).toMatch(/^[0-9a-f]{64}$/);
    expect(commits.voice_commit).not.toBe('00'.repeat(32));

    const me = (await get(t.app, u, '/v1/me')).json();
    expect(me).toMatchObject({ display_name: 'Alice', enrolled: { face: true, voice: true } });

    // The commitment is §8.4 over the decrypted template + salt.
    const { identity } = identityHuddleServices(t.ctx);
    const face = identity.vault.template(u.user.id, 'face')!;
    expect(face.q).toHaveLength(128);
    expect(commitTemplate(face.q, face.salt)).toBe(commits.face_commit);
    expect(commitmentFromBytes(hexToBytes(commits.face_commit))).toBe(poseidonCommit(face.q, face.salt));

    // At rest: ciphertext only, bound to the wallet (wrong AAD fails).
    const rec = t.ctx.store.collection<{ biometrics: Record<string, string> }>('users').get(u.user.id)!;
    const blob = fromBase64(rec.biometrics['face_template_enc']!);
    expect(blob.length).toBe(12 + 16 + 128);
    const aadOther = new TextEncoder().encode(`verdict/biometric/v1|${u.user.id}|OTHERWALLET|face|template`);
    expect(() => decryptAesGcm(t!.ctx.config.biometricKey, blob, aadOther)).toThrow();
    expect(t.ctx.store.collection('enrollments').get(u.user.id)).toBeUndefined();

    const profile = await t.ctx.chain.getProfile(u.wallet.publicKey);
    expect(profile).toMatchObject({ face_commit: commits.face_commit, voice_commit: commits.voice_commit, display_name: 'Alice', flags: 3 });
  });

  it('fails liveness on replayed frames and non-JPEG input; enforces frame counts', async () => {
    t = await makeAppWith();
    const u = await login(t.app, 'alice@example.com');
    const ch = (await get(t.app, u, '/v1/enroll/challenge')).json();
    const f = fakeJpeg();
    const replay = await post(t.app, u, '/v1/enroll/face', { challenge_id: ch.challenge_id, frames_b64: [f, f, fakeJpeg()].map(b64) });
    expect(replay.statusCode).toBe(422);
    expect(replay.json().error).toEqual({ code: 'LIVENESS_FAILED', message: 'Liveness failed' });
    const png = await post(t.app, u, '/v1/enroll/face', { challenge_id: ch.challenge_id, frames_b64: [new Uint8Array(64), fakeJpeg(), fakeJpeg()].map(b64) });
    expect(png.json().error.code).toBe('LIVENESS_FAILED');
    // A different person turning up in a prompt frame (mock subject switch) fails too.
    const other = await login(t.app, 'mallory@example.com');
    const swap = await post(
      t.app,
      u,
      '/v1/enroll/face',
      { challenge_id: ch.challenge_id, frames_b64: [fakeJpeg(), fakeJpeg(), fakeJpeg()].map(b64) },
      { 'x-mock-subject': other.user.id },
    );
    expect(swap.statusCode).toBe(200); // consistent impostor frames are "live" (identity is checked at match time)
    const few = await post(t.app, u, '/v1/enroll/face', { challenge_id: ch.challenge_id, frames_b64: [fakeJpeg(), fakeJpeg()].map(b64) });
    expect(few.statusCode).toBe(400);
  });

  it('requires each voice phrase to be heard', async () => {
    t = await makeAppWith();
    const u = await login(t.app, 'alice@example.com');
    const ch = (await get(t.app, u, '/v1/enroll/challenge')).json();
    const clips = [fakeWav(), fakeWav(), fakeWav()].map(b64);
    const bad = await post(t.app, u, '/v1/enroll/voice', { challenge_id: ch.challenge_id, clips_b64: clips }, { 'x-mock-transcript': 'hello there' });
    expect(bad.json().error.code).toBe('PHRASE_NOT_HEARD');
    const notWav = await post(t.app, u, '/v1/enroll/voice', { challenge_id: ch.challenge_id, clips_b64: [b64(fakeJpeg()), clips[1], clips[2]] });
    expect(notWav.statusCode).toBe(400);
    const ok = await post(t.app, u, '/v1/enroll/voice', { challenge_id: ch.challenge_id, clips_b64: clips });
    expect(ok.json()).toEqual({ ok: true });
  });

  it('expires challenges and refuses foreign ones', async () => {
    t = await makeAppWith();
    const u = await login(t.app, 'alice@example.com');
    const v = await login(t.app, 'bob@example.com');
    const ch = (await get(t.app, u, '/v1/enroll/challenge')).json();
    const frames = [fakeJpeg(), fakeJpeg(), fakeJpeg()].map(b64);
    const foreign = await post(t.app, v, '/v1/enroll/face', { challenge_id: ch.challenge_id, frames_b64: frames });
    expect(foreign.json().error.code).toBe('CHALLENGE_EXPIRED');
    t.clock.advance(11 * 60_000);
    const late = await post(t.app, u, '/v1/enroll/face', { challenge_id: ch.challenge_id, frames_b64: frames });
    expect(late.statusCode).toBe(410);
    expect(late.json().error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('requires consent and something enrolled to complete', async () => {
    t = await makeAppWith();
    const u = await login(t.app, 'alice@example.com');
    const none = await post(t.app, u, '/v1/enroll/complete', { consent: true, display_name: 'Alice' });
    expect(none.json().error.code).toBe('NOT_ENROLLED');
    const noConsent = await post(t.app, u, '/v1/enroll/complete', { consent: false, display_name: 'Alice' });
    expect(noConsent.statusCode).toBe(400);
    const longName = await post(t.app, u, '/v1/enroll/complete', { consent: true, display_name: 'x'.repeat(33) });
    expect(longName.statusCode).toBe(400);
  });

  it('face-only enrollment commits a zero voice commitment', async () => {
    t = await makeAppWith();
    const u = await login(t.app, 'alice@example.com');
    const c = await enroll(t.app, u, 'Alice', ['face']);
    expect(c.voice_commit).toBe('00'.repeat(32));
    expect((await get(t.app, u, '/v1/me')).json().enrolled).toEqual({ face: true, voice: false });
  });

  it('DELETE /enroll erases every template and zeroes the Profile commitments', async () => {
    t = await makeAppWith();
    const u = await login(t.app, 'alice@example.com');
    await enroll(t.app, u, 'Alice');
    // Voice recordings stored by older builds (acceptance WAVs) are deleted too; others' stay.
    t.ctx.blobs.putBlob('acceptances', `draft1_${u.user.id}.wav`, new Uint8Array([1, 2, 3]));
    t.ctx.blobs.putBlob('acceptances', 'draft1_someone-else.wav', new Uint8Array([4]));
    const r = await t.app.inject({ method: 'DELETE', url: '/v1/enroll', headers: auth(u) });
    expect(t.ctx.blobs.getBlob('acceptances', `draft1_${u.user.id}.wav`)).toBeNull();
    expect(t.ctx.blobs.getBlob('acceptances', 'draft1_someone-else.wav')).not.toBeNull();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.deleted).toBe(true);
    const rec = t.ctx.store.collection<Record<string, unknown>>('users').get(u.user.id)!;
    expect(rec['biometrics']).toBeUndefined();
    expect(JSON.stringify(rec)).not.toMatch(/template|salt|commit/);
    expect(identityHuddleServices(t.ctx).identity.vault.template(u.user.id, 'voice')).toBeNull();
    expect((await get(t.app, u, '/v1/me')).json().enrolled).toEqual({ face: false, voice: false });
    expect((await submitSign(t.app, u, body.sign)).status).toBe('confirmed');
    const profile = await t.ctx.chain.getProfile(u.wallet.publicKey);
    expect(profile).toMatchObject({ face_commit: '00'.repeat(32), voice_commit: '00'.repeat(32), flags: 0 });
  });
});

describe('huddles (§12.3, D-22, D-31)', () => {
  it('creates a huddle with a 6-digit code, joins, scans to confirm', async () => {
    t = await makeAppWith();
    const c = await crew(t, ['Alice', 'Bob', 'Cara'], false);
    const [alice, bob] = c.users as [typeof c.users[0], typeof c.users[0]];
    expect(c.code).toMatch(/^[0-9]{6}$/);
    let view = (await get(t.app, alice, `/v1/huddles/${c.huddleId}`)).json();
    expect(view.members.map((m: { confirmed: boolean }) => m.confirmed)).toEqual([true, false, false]);
    expect(view.creator_user_id).toBe(alice.user.id);

    // only the creator scans
    const notCreator = await post(t.app, bob, `/v1/huddles/${c.huddleId}/scan`, { faces: [{ crop_b64: b64(fakeJpeg()), bbox: [0, 0, 10, 10] }] });
    expect(notCreator.json().error.code).toBe('WRONG_STATE');

    // mock: each crop resolves to the next not-yet-confirmed joined member
    const scan = await post(t.app, alice, `/v1/huddles/${c.huddleId}/scan`, { faces: [{ crop_b64: b64(fakeJpeg()), bbox: [0, 0, 5000, 5000] }] });
    const m = scan.json().matches;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ bbox: [0, 0, 5000, 5000], matched: true, user: { id: bob.user.id, display_name: 'Bob' } });
    expect(m[0].cos_bps).toBeGreaterThanOrEqual(5500);
    view = (await get(t.app, alice, `/v1/huddles/${c.huddleId}`)).json();
    expect(view.members.map((x: { confirmed: boolean }) => x.confirmed)).toEqual([true, true, false]);

    // re-joining is idempotent; a stranger cannot read the huddle
    expect((await post(t.app, bob, '/v1/huddles/join', { code: c.code })).statusCode).toBe(200);
    const stranger = await login(t.app, 'zed@example.com');
    expect((await get(t.app, stranger, `/v1/huddles/${c.huddleId}`)).statusCode).toBe(404);
  });

  it('rejects bad codes, caps the huddle at MAX_HUDDLE and expires codes', async () => {
    t = await makeAppWith();
    const owner = await login(t.app, 'owner@example.com');
    const h = (await post(t.app, owner, '/v1/huddles', {})).json();
    const wrong = h.code === '000000' ? '000001' : '000000';
    expect((await post(t.app, owner, '/v1/huddles/join', { code: wrong })).json().error.code).toBe('CODE_INVALID');
    expect((await post(t.app, owner, '/v1/huddles/join', { code: 'abc' })).json().error.code).toBe('CODE_INVALID');
    const { huddles } = identityHuddleServices(t.ctx);
    for (let i = 0; i < 9; i++) {
      const u = await login(t.app, `m${i}@example.com`);
      expect((await post(t.app, u, '/v1/huddles/join', { code: h.code })).statusCode).toBe(200);
      huddles.confirm(h.huddle_id, [{ user_id: u.user.id, cos_bps: 9000 }]);
    }
    const late = await login(t.app, 'late@example.com');
    expect((await post(t.app, late, '/v1/huddles/join', { code: h.code })).json().error.code).toBe('HUDDLE_FULL');
    t.clock.advance(RECENT_HUDDLE_S * 1000 + 1);
    expect((await post(t.app, late, '/v1/huddles/join', { code: h.code })).json().error.code).toBe('CODE_INVALID');
  });

  it('caps unconfirmed joiners, expires stale ones, and rate-limits code guessing', async () => {
    t = await makeAppWith();
    const owner = await login(t.app, 'owner@example.com');
    const h = (await post(t.app, owner, '/v1/huddles', {})).json();
    // Sybil joiners hold at most MAX_PENDING_JOINS slots: the huddle never fills with them.
    const sybils = [];
    for (let i = 0; i < MAX_PENDING_JOINS; i++) {
      const u = await login(t.app, `sybil${i}@example.com`);
      sybils.push(u);
      expect((await post(t.app, u, '/v1/huddles/join', { code: h.code })).statusCode).toBe(200);
    }
    const friend = await login(t.app, 'friend@example.com');
    expect((await post(t.app, friend, '/v1/huddles/join', { code: h.code })).json().error.code).toBe('HUDDLE_FULL');
    // Unconfirmed joiners see the huddle but not its drafts.
    const sybil = sybils[0]!;
    expect((await get(t.app, sybil, `/v1/huddles/${h.huddle_id}`)).statusCode).toBe(200);
    // Stale pending joiners make room.
    t.clock.advance(PENDING_JOIN_TTL_MS);
    const ok = (await post(t.app, friend, '/v1/huddles/join', { code: h.code })).json();
    expect(ok.members.map((m: { user: { id: string } }) => m.user.id)).toEqual([owner.user.id, friend.user.id]);

    // Enumeration: wrong codes are rate-limited per user (per minute, then per hour).
    const guesser = await login(t.app, 'guesser@example.com');
    const wrong = (i: number) => String((Number(h.code) + 1 + i) % 1_000_000).padStart(6, '0');
    const codes: string[] = [];
    for (let i = 0; i < JOIN_RATE + 1; i++) codes.push((await post(t.app, guesser, '/v1/huddles/join', { code: wrong(i) })).json().error.code);
    expect(codes.slice(0, JOIN_RATE).every((c) => c === 'CODE_INVALID')).toBe(true);
    expect(codes[JOIN_RATE]).toBe('RATE_LIMITED');
    for (let m = 0; m < 3; m++) {
      t.clock.advance(60_000);
      for (let i = 0; i < JOIN_RATE; i++) await post(t.app, guesser, '/v1/huddles/join', { code: wrong(100 + m * 10 + i) });
    }
    t.clock.advance(60_000);
    // ≥ JOIN_FAILURES wrong codes this hour: even the right code is refused now.
    expect((await post(t.app, guesser, '/v1/huddles/join', { code: h.code })).json().error.code).toBe('RATE_LIMITED');
  });

  it('removes members (creator removes others, members leave)', async () => {
    t = await makeAppWith();
    const c = await crew(t, ['Alice', 'Bob', 'Cara'], false);
    const [alice, bob, cara] = c.users as [typeof c.users[0], typeof c.users[0], typeof c.users[0]];
    const del = (u: typeof alice, target: string) => t!.app.inject({ method: 'DELETE', url: `/v1/huddles/${c.huddleId}/members/${target}`, headers: auth(u) });
    expect((await del(bob, cara.user.id)).json().error.code).toBe('WRONG_STATE');
    expect((await del(bob, alice.user.id)).json().error.code).toBe('WRONG_STATE');
    const left = (await del(bob, bob.user.id)).json();
    expect(left.members.map((m: { user: { id: string } }) => m.user.id)).toEqual([alice.user.id, cara.user.id]);
    const removed = (await del(alice, cara.user.id)).json();
    expect(removed.members).toHaveLength(1);
  });
});

describe('pay by face / voice (§8.3, §12.3)', () => {
  it('matches recent co-members only, checks liveness and pays', async () => {
    t = await makeAppWith();
    const c = await crew(t, ['Alice', 'Bob']);
    const [alice, bob] = c.users as [typeof c.users[0], typeof c.users[0]];
    const outsider = await login(t.app, 'olive@example.com');
    await enroll(t.app, outsider, 'Olive');

    const ch = (await get(t.app, alice, '/v1/pay/challenge')).json();
    expect(['left', 'right', 'up', 'down']).toContain(ch.face_prompt);
    const scan = (await post(t.app, alice, '/v1/pay/scan', { challenge_id: ch.challenge_id, faces_b64: [fakeJpeg(), fakeJpeg()].map(b64) })).json();
    expect(scan.liveness).toBe(true);
    expect(scan.matches).toHaveLength(1); // closed set: Bob only (caller excluded, Olive not a co-member)
    expect(scan.matches[0]).toMatchObject({ matched: true, user: { id: bob.user.id } });

    // an outsider's face matches nobody in the closed set
    const ch2 = (await get(t.app, alice, '/v1/pay/challenge')).json();
    const imp = (
      await post(t.app, alice, '/v1/pay/scan', { challenge_id: ch2.challenge_id, faces_b64: [fakeJpeg(), fakeJpeg()].map(b64) }, { 'x-mock-subject': outsider.user.id })
    ).json();
    expect(imp.matches[0].matched).toBe(false);
    // challenges are single-use
    const reuse = await post(t.app, alice, '/v1/pay/scan', { challenge_id: ch2.challenge_id, faces_b64: [fakeJpeg(), fakeJpeg()].map(b64) });
    expect(reuse.json().error.code).toBe('CHALLENGE_EXPIRED');
    // replayed crop → no liveness, no match
    const ch3 = (await get(t.app, alice, '/v1/pay/challenge')).json();
    const f = b64(fakeJpeg());
    const still = (await post(t.app, alice, '/v1/pay/scan', { challenge_id: ch3.challenge_id, faces_b64: [f, f] })).json();
    expect(still.liveness).toBe(false);
    expect(still.matches[0].matched).toBe(false);

    const voice = (await post(t.app, alice, '/v1/pay/voice', { audio_b64: b64(fakeWav()) })).json();
    expect(voice.matches[0]).toMatchObject({ matched: true, user: { id: bob.user.id } });

    // pay: balance checks, recipient must be a recent co-member
    expect((await post(t.app, alice, '/v1/pay', { to_user_id: bob.user.id, amount_units: 1_000_000 })).json().error.code).toBe('INSUFFICIENT_FUNDS');
    await post(t.app, alice, '/v1/faucet', {});
    expect((await post(t.app, alice, '/v1/pay', { to_user_id: outsider.user.id, amount_units: 1 })).statusCode).toBe(404);
    expect((await post(t.app, alice, '/v1/pay', { to_user_id: bob.user.id, amount_units: 0 })).json().error.code).toBe('BAD_STAKE');
    const pay = (await post(t.app, alice, '/v1/pay', { to_user_id: bob.user.id, amount_units: 2_500_000 })).json();
    expect(pay.sign.summary).toBe('Pay $2.50');
    expect((await submitSign(t.app, alice, pay.sign)).status).toBe('confirmed');
    expect(await t.ctx.chain.getUsdcBalance(bob.wallet.publicKey)).toBe(2_500_000n);

    // after RECENT_HUDDLE_S the closed set is empty
    t.clock.advance(RECENT_HUDDLE_S * 1000 + 1);
    expect((await post(t.app, alice, '/v1/pay/voice', { audio_b64: b64(fakeWav()) })).json().matches).toEqual([]);
  });
});
