import { afterEach, describe, expect, it } from 'vitest';
import { FAUCET_UNITS, ZERO_HASH_HEX } from '@verdict/engine';
import { loginMessage } from '../src/auth/service.js';
import { initProfileIx } from '../src/chain/ixs.js';
import { quickNodeSignature } from '../src/chain/quicknode.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { STUBS } from '../src/routes/index.js';
import { fromBase64, toBase64 } from '../src/util/bytes.js';
import { auth, login, makeApp, type TestApp } from './appHelpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

describe('HTTP basics', () => {
  it('health is public; everything else under /v1 needs a bearer token', async () => {
    t = await makeApp();
    const h = await t.app.inject({ method: 'GET', url: '/v1/health' });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toMatchObject({ ok: true, solana_mode: 'mock', spend_allowed: false });

    const me = await t.app.inject({ method: 'GET', url: '/v1/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Signed out' } });

    const bogus = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer nope' } });
    expect(bogus.statusCode).toBe(401);
  });

  it('unknown routes answer NOT_FOUND with the fixed message', async () => {
    t = await makeApp();
    const r = await t.app.inject({ method: 'GET', url: '/nothing' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  it('malformed JSON is a 400 with a §12.8 body', async () => {
    t = await makeApp();
    const r = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/session',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('WRONG_STATE');
  });

  it('registers every §12.3 route (service stubs answer 501 after auth)', async () => {
    t = await makeApp();
    const u = await login(t.app, 'stub@example.com');
    const routes = t.app.printRoutes({ commonPrefix: false });
    for (const s of STUBS) {
      const url = s.url.replace(/:[a-z_]+/g, 'x');
      const r = await t.app.inject({ method: s.method as 'GET', url, headers: auth(u) });
      expect(r.statusCode, `${s.method} ${s.url}`).toBe(501);
      expect(r.json().error.code).toBe('INTERNAL');
    }
    // STUBS shrinks as service agents replace their stubs with real routes.
    expect(routes).toContain('/v1/tx/:tx_id/submit');
  });
});

describe('auth (§12.1, §12.3)', () => {
  it('logs in with a wallet signature, binds the wallet, serves /me', async () => {
    t = await makeApp();
    const u = await login(t.app, 'alice@example.com');
    expect(u.user.display_name).toBe('Alice');
    const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: auth(u) });
    expect(me.json()).toEqual({ id: u.user.id, wallet: u.wallet.publicKey, display_name: 'Alice', enrolled: { face: false, voice: false } });

    // same identity, same wallet → same user
    const again = await login(t.app, 'alice@example.com', u.wallet);
    expect(again.user.id).toBe(u.user.id);
    // same identity, different wallet → WALLET_MISMATCH
    await expect(login(t.app, 'alice@example.com')).rejects.toThrow(/403.*WALLET_MISMATCH/);
    // a wallet already bound to another user → WALLET_MISMATCH
    await expect(login(t.app, 'bob@example.com', u.wallet)).rejects.toThrow(/WALLET_MISMATCH/);
  });

  it('rejects a bad wallet signature and reused nonces', async () => {
    t = await makeApp();
    const w = generateKeypair();
    const other = generateKeypair();
    const { nonce } = (await t.app.inject({ method: 'GET', url: '/v1/auth/nonce' })).json();
    const body = (sigKey = w) => ({
      provider: 'google',
      credential: 'mock:carol@example.com',
      wallet: w.publicKey,
      nonce,
      wallet_sig_b64: toBase64(sigKey.sign(loginMessage(nonce))),
    });
    const bad = await t.app.inject({ method: 'POST', url: '/v1/auth/session', payload: body(other) });
    expect(bad.statusCode).toBe(401);
    // the nonce was consumed by the failed attempt
    const reuse = await t.app.inject({ method: 'POST', url: '/v1/auth/session', payload: body() });
    expect(reuse.json().error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('email login with the mock code', async () => {
    t = await makeApp();
    const w = generateKeypair();
    const start = await t.app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'Dan@Example.com' } });
    expect(start.json()).toEqual({ sent: true });
    const session = async (code: string) => {
      const { nonce } = (await t!.app.inject({ method: 'GET', url: '/v1/auth/nonce' })).json();
      return t!.app.inject({
        method: 'POST',
        url: '/v1/auth/session',
        payload: {
          provider: 'email',
          credential: 'dan@example.com',
          email_code: code,
          wallet: w.publicKey,
          nonce,
          wallet_sig_b64: toBase64(w.sign(loginMessage(nonce))),
        },
      });
    };
    expect((await session('123456')).json().error.code).toBe('CODE_INVALID');
    const ok = await session('000000');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.display_name).toBe('Dan');
  });
});

describe('wallet + signing (§12.1)', () => {
  it('faucet drips FAUCET_UNITS once per day; balance reads the chain', async () => {
    t = await makeApp();
    const u = await login(t.app, 'erin@example.com');
    expect((await t.app.inject({ method: 'GET', url: '/v1/balance', headers: auth(u) })).json()).toEqual({ usdc_units: 0 });
    const f1 = await t.app.inject({ method: 'POST', url: '/v1/faucet', headers: auth(u) });
    expect(f1.json()).toEqual({ usdc_units: FAUCET_UNITS });
    const f2 = await t.app.inject({ method: 'POST', url: '/v1/faucet', headers: auth(u) });
    expect(f2.json()).toEqual({ usdc_units: FAUCET_UNITS });
    t.clock.advance(86_400_000);
    const f3 = await t.app.inject({ method: 'POST', url: '/v1/faucet', headers: auth(u) });
    expect(f3.json()).toEqual({ usdc_units: 2 * FAUCET_UNITS });
  });

  it('sign payload → user signature → submit → confirmed (idempotent); wrong signer, other user, expiry', async () => {
    t = await makeApp();
    const u = await login(t.app, 'fay@example.com');
    const env = { programId: t.ctx.chain.programId, mint: t.ctx.chain.mint, feePayer: t.ctx.chain.feePayer, oracle: t.ctx.chain.oracle };
    const mk = () =>
      t!.ctx.txs.request({
        user: { id: u.user.id, wallet: u.wallet.publicKey },
        kind: 'init_profile',
        ixs: [initProfileIx(env, u.wallet.publicKey, { face_commit: ZERO_HASH_HEX, voice_commit: ZERO_HASH_HEX, display_name: 'Fay' })],
        summary: 'Save profile',
      });
    const hooked: string[] = [];
    t.ctx.txs.onConfirmed('init_profile', (tx) => {
      hooked.push(tx.tx_id);
    });

    const { sign } = await mk();
    expect(sign.summary).toBe('Save profile');
    const msg = fromBase64(sign.message_b64);

    // wrong key
    const bad = await t.app.inject({
      method: 'POST',
      url: `/v1/tx/${sign.tx_id}/submit`,
      headers: auth(u),
      payload: { signature_b64: toBase64(generateKeypair().sign(msg)) },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('TX_FAILED');

    // another user cannot submit it
    const other = await login(t.app, 'gus@example.com');
    const nf = await t.app.inject({
      method: 'POST',
      url: `/v1/tx/${sign.tx_id}/submit`,
      headers: auth(other),
      payload: { signature_b64: toBase64(u.wallet.sign(msg)) },
    });
    expect(nf.statusCode).toBe(404);

    const ok = await t.app.inject({
      method: 'POST',
      url: `/v1/tx/${sign.tx_id}/submit`,
      headers: auth(u),
      payload: { signature_b64: toBase64(u.wallet.sign(msg)) },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.status).toBe('confirmed');
    expect(typeof body.signature).toBe('string');
    expect(body.error).toBeNull();
    expect(hooked).toEqual([sign.tx_id]);
    expect((await t.ctx.chain.getProfile(u.wallet.publicKey))?.display_name).toBe('Fay');

    const again = await t.app.inject({
      method: 'POST',
      url: `/v1/tx/${sign.tx_id}/submit`,
      headers: auth(u),
      payload: { signature_b64: toBase64(u.wallet.sign(msg)) },
    });
    expect(again.json()).toEqual(body);
    expect(hooked).toHaveLength(1);

    // expired sign payload ⇒ TX_EXPIRED (the app re-requests once)
    const late = await mk();
    t.clock.set(late.sign.expires_at_ms + 1);
    const exp = await t.app.inject({
      method: 'POST',
      url: `/v1/tx/${late.sign.tx_id}/submit`,
      headers: auth(u),
      payload: { signature_b64: toBase64(u.wallet.sign(fromBase64(late.sign.message_b64))) },
    });
    expect(exp.statusCode).toBe(410);
    expect(exp.json()).toEqual({ error: { code: 'TX_EXPIRED', message: 'Request expired' } });
  });
});

describe('world events (passthrough)', () => {
  it('lists fixtures and gets one', async () => {
    t = await makeApp();
    const u = await login(t.app, 'hal@example.com');
    const list = (await t.app.inject({ method: 'GET', url: '/v1/world/events?q=crypto&limit=5', headers: auth(u) })).json();
    expect(list.events.length).toBeGreaterThan(0);
    const id = list.events[0].id;
    const one = await t.app.inject({ method: 'GET', url: `/v1/world/events/${id}`, headers: auth(u) });
    expect(one.json().id).toBe(id);
    const nf = await t.app.inject({ method: 'GET', url: '/v1/world/events/none', headers: auth(u) });
    expect(nf.statusCode).toBe(404);
  });
});

describe('webhooks', () => {
  const secret = 'qn-secret';

  it('QuickNode: HMAC verified, stale/invalid rejected, idempotent on (signature, index)', async () => {
    t = await makeApp({ SOLANA_MODE: 'devnet', CHAIN_EVENTS_SOURCE: 'quicknode', QUICKNODE_SECRET: secret });
    const seen: string[] = [];
    t.ctx.events.on('PreRuled', (e) => {
      seen.push(`${e.signature}:${e.index}`);
    });
    const bet = generateKeypair().publicKey;
    const payload = JSON.stringify({
      stream: 'verdict-devnet',
      events: [
        {
          signature: 'sig1',
          slot: 123,
          block_time: 1700000000,
          index: 0,
          name: 'PreRuled',
          data: { bet, preruling: 1, reason: 0, winner_mask: 2, leg_results: [1, 255, 255, 255, 255, 255, 255, 255], consent_deadline: '1700000120' },
        },
      ],
    });
    const send = (ts: number, sig?: string) =>
      t!.app.inject({
        method: 'POST',
        url: '/v1/webhooks/quicknode',
        headers: {
          'content-type': 'application/json',
          'x-qn-nonce': 'n1',
          'x-qn-timestamp': String(ts),
          'x-qn-signature': sig ?? quickNodeSignature(secret, 'n1', String(ts), Buffer.from(payload)),
        },
        payload,
      });
    const now = Math.floor(t.clock.nowMs() / 1000);
    expect((await send(now, 'ab'.repeat(32))).statusCode).toBe(401);
    expect((await send(now - 301)).statusCode).toBe(401);
    expect((await send(now)).statusCode).toBe(204);
    expect((await send(now)).statusCode).toBe(204);
    expect(seen).toEqual(['sig1:0']);
  });

  it('QuickNode webhook is disabled unless CHAIN_EVENTS_SOURCE=quicknode', async () => {
    t = await makeApp();
    const r = await t.app.inject({ method: 'POST', url: '/v1/webhooks/quicknode', payload: { events: [] } });
    expect(r.statusCode).toBe(404);
  });

  it('ElevenLabs tool webhook checks the shared secret, then calls the compile hook', async () => {
    t = await makeApp();
    const r1 = await t.app.inject({ method: 'POST', url: '/v1/webhooks/elevenlabs/tool', payload: { huddle_id: 'h', transcript: 'x' } });
    expect(r1.statusCode).toBe(401);
    const headers = { 'x-verdict-tool-secret': 'tool-secret' };
    const r2 = await t.app.inject({ method: 'POST', url: '/v1/webhooks/elevenlabs/tool', headers, payload: { huddle_id: 'h', transcript: 'x' } });
    // the drafts service wires the hook; an unknown huddle is NOT_FOUND
    expect(r2.statusCode).toBe(404);
    t.ctx.hooks.compileTool = async (b) => ({ echoed: b });
    const r3 = await t.app.inject({ method: 'POST', url: '/v1/webhooks/elevenlabs/tool', headers, payload: { huddle_id: 'h', transcript: 'x' } });
    expect(r3.json()).toEqual({ echoed: { huddle_id: 'h', transcript: 'x' } });
  });
});
