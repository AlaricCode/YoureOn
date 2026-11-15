// D0-M4 server side, against Postgres (skips without DATABASE_URL):
//   challenge -> signup / login; replayed nonce and wrong key -> 401; no 18+ -> AGE_REQUIRED;
//   an existing key logs in after a reinstall; sessions; request signing + idempotency.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apiSessions, auditLog, devices, users } from '@youre-on/db';
import { ApiError, Session, WS_CLOSE } from '@youre-on/shared/api';
import { HttpError } from '../src/errors';
import { requireSignedRequest, appAuth } from '../src/auth/middleware';
import type { RouteModule } from '../src/context';
import { readBody } from '../src/http/body';
import { routeModules } from '../src/routes';
import { sha256Hex } from '../src/crypto';
import { z } from 'zod/v4';
import {
  connectWs,
  describeDb,
  getChallenge,
  loginBody,
  newKey,
  postJson,
  signedHeaders,
  signUp,
  signupBody,
  startTestServer,
  type Ctx,
} from './helpers';

const code = (j: unknown) => ApiError.parse(j).error.code;

// A signed-write route module, standing in for the rooms/bets streams.
const signedProbe: RouteModule = {
  name: 'signed-probe',
  register(app) {
    app.post('/v1/_probe/signed', requireSignedRequest, async (c) => {
      const body = await readBody(c, z.object({ n: z.number() }));
      return c.json({ user_id: appAuth(c).user_id, n: body.n, nonce: randomUUID() }, 201);
    });
    // Two empty-body signed routes (like invite/accept and lock/decline).
    app.post('/v1/_probe/accept', requireSignedRequest, (c) => c.json({ did: 'accept' }, 200));
    app.post('/v1/_probe/decline', requireSignedRequest, (c) => c.json({ did: 'decline' }, 200));
    // 429 on the first call, then success: a 429 must not be stored as the replay.
    let flakyCalls = 0;
    app.post('/v1/_probe/flaky', requireSignedRequest, (c) => {
      if (flakyCalls++ === 0)
        throw new HttpError('RATE_LIMITED', undefined, undefined, {
          headers: { 'Retry-After': '1' },
        });
      return c.json({ ok: true }, 201);
    });
  },
};

describeDb('auth (API-CONTRACT §1.3, §2.1)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startTestServer({ modules: [...routeModules, signedProbe] });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  it('POST /v1/auth/challenge returns a 60 s nonce', async () => {
    const ch = await getChallenge(ctx.base, newKey());
    expect(ch.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(ch.expires_at) - Date.parse(ch.server_time)).toBeGreaterThanOrEqual(59_000);
    expect(Date.parse(ch.expires_at) - Date.parse(ch.server_time)).toBeLessThanOrEqual(61_000);
    const bad = await postJson(ctx.base, '/v1/auth/challenge', { device_pubkey: 'nope' });
    expect(bad.status).toBe(422);
    expect(code(bad.json)).toBe('VALIDATION_FAILED');
  });

  it('signup: a valid device + wallet signature gets a 201 Session and writes users/devices/audit_log', async () => {
    const device = newKey();
    const wallet = newKey();
    const ch = await getChallenge(ctx.base, device);
    const r = await postJson(ctx.base, '/v1/auth/signup', signupBody(ch, device, wallet));
    expect(r.status).toBe(201);
    const s = Session.parse(r.json);
    expect(s.user).toMatchObject({ pubkey: wallet.pubkey, display_name: 'Jake', avatar_url: null });
    expect(Date.parse(s.expires_at) - Date.parse(s.server_time)).toBeGreaterThan(
      6.9 * 24 * 3600_000,
    );

    const db = ctx.deps.db;
    const [u] = await db.select().from(users).where(eq(users.id, s.user.user_id));
    expect(u).toMatchObject({
      age_attested_18plus: true,
      wallet_kind: 'device_keypair',
      wallet_pubkey: wallet.pubkey,
    });
    expect(u!.attested_at).toBeInstanceOf(Date);
    const [d] = await db.select().from(devices).where(eq(devices.id, s.device_id));
    expect(d).toMatchObject({
      device_pubkey: device.pubkey,
      platform: 'ios',
      role: 'phone',
      user_id: s.user.user_id,
    });
    const [sess] = await db.select().from(apiSessions).where(eq(apiSessions.id, s.session_id));
    expect(sess!.token_sha256).toBe(sha256Hex(s.token)); // only the hash is stored
    expect(sess!.scopes).toEqual(['app']);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subject_user_id, s.user.user_id));
    expect(audits.map((a) => a.action)).toEqual(['user.signed_up']);
  });

  it('signup without the 18+ attestation (missing or false) -> 403 AGE_REQUIRED', async () => {
    const device = newKey();
    const wallet = newKey();
    for (const age_attestation of [
      undefined,
      null,
      { is_18_plus: false, attested_at: new Date().toISOString() },
    ]) {
      const ch = await getChallenge(ctx.base, device);
      const r = await postJson(
        ctx.base,
        '/v1/auth/signup',
        signupBody(ch, device, wallet, { age_attestation }),
      );
      expect(r.status).toBe(403);
      expect(code(r.json)).toBe('AGE_REQUIRED');
    }
    const rows = await ctx.deps.db
      .select()
      .from(users)
      .where(eq(users.wallet_pubkey, wallet.pubkey));
    expect(rows).toHaveLength(0);
  });

  it('signup: an invalid display name -> 422 VALIDATION_FAILED', async () => {
    const device = newKey();
    const ch = await getChallenge(ctx.base, device);
    const r = await postJson(
      ctx.base,
      '/v1/auth/signup',
      signupBody(ch, device, newKey(), { display_name: '  Jake  ' }),
    );
    expect(r.status).toBe(422);
    expect(code(r.json)).toBe('VALIDATION_FAILED');
  });

  it('signup: a bad wallet_sig or device_sig -> 401 SIGNATURE_INVALID', async () => {
    const device = newKey();
    const wallet = newKey();
    let ch = await getChallenge(ctx.base, device);
    let body = signupBody(ch, device, wallet);
    body.wallet_sig = signupBody(ch, device, newKey()).wallet_sig; // signed by another key
    let r = await postJson(ctx.base, '/v1/auth/signup', body);
    expect([r.status, code(r.json)]).toEqual([401, 'SIGNATURE_INVALID']);

    ch = await getChallenge(ctx.base, device);
    body = signupBody(ch, device, wallet);
    body.device_sig = signupBody(ch, newKey(), wallet).device_sig;
    r = await postJson(ctx.base, '/v1/auth/signup', body);
    expect([r.status, code(r.json)]).toEqual([401, 'SIGNATURE_INVALID']);
  });

  it('login: a valid challenge signature gets a Session', async () => {
    const u = await signUp(ctx.base, 'Logan');
    const ch = await getChallenge(ctx.base, u.device);
    const r = await postJson(ctx.base, '/v1/auth/session', loginBody(ch, u.device));
    expect(r.status).toBe(200);
    const s = Session.parse(r.json);
    expect(s.user.user_id).toBe(u.session.user.user_id);
    expect(s.device_id).toBe(u.session.device_id);
    expect(s.token).not.toBe(u.session.token);
  });

  it('login: a replayed nonce -> 401 CHALLENGE_EXPIRED', async () => {
    const u = await signUp(ctx.base);
    const ch = await getChallenge(ctx.base, u.device);
    const body = loginBody(ch, u.device);
    expect((await postJson(ctx.base, '/v1/auth/session', body)).status).toBe(200);
    const again = await postJson(ctx.base, '/v1/auth/session', body);
    expect(again.status).toBe(401);
    expect(code(again.json)).toBe('CHALLENGE_EXPIRED');
  });

  it('login: the wrong key -> 401 (SIGNATURE_INVALID), and a failed attempt burns the nonce', async () => {
    const u = await signUp(ctx.base);
    const ch = await getChallenge(ctx.base, u.device);
    const wrong = await postJson(ctx.base, '/v1/auth/session', loginBody(ch, u.device, newKey()));
    expect(wrong.status).toBe(401);
    expect(code(wrong.json)).toBe('SIGNATURE_INVALID');
    const retry = await postJson(ctx.base, '/v1/auth/session', loginBody(ch, u.device));
    expect([retry.status, code(retry.json)]).toEqual([401, 'CHALLENGE_EXPIRED']);

    // The wallet key is not a device key: it can't log in.
    const ch2 = await getChallenge(ctx.base, u.wallet);
    const walletLogin = await postJson(ctx.base, '/v1/auth/session', loginBody(ch2, u.wallet));
    expect(walletLogin.status).toBe(401);
    expect(walletLogin.json?.error.details).toEqual({ reason: 'unknown_device' });

    // A challenge issued for another device key can't be used.
    const other = newKey();
    const ch3 = await getChallenge(ctx.base, other);
    const swapped = await postJson(ctx.base, '/v1/auth/session', {
      ...loginBody(ch3, u.device),
      challenge_id: ch3.challenge_id,
    });
    expect([swapped.status, code(swapped.json)]).toEqual([401, 'SIGNATURE_INVALID']);
  });

  it('login: an expired challenge -> 401 CHALLENGE_EXPIRED', async () => {
    let t = Date.now();
    const local = await startTestServer({ now: () => t });
    try {
      const u = await signUp(local.base);
      const ch = await getChallenge(local.base, u.device);
      t += 61_000;
      const r = await postJson(local.base, '/v1/auth/session', loginBody(ch, u.device));
      expect([r.status, code(r.json)]).toEqual([401, 'CHALLENGE_EXPIRED']);
    } finally {
      await local.server.close();
    }
  });

  it('reinstall: the surviving device key logs in, and a repeat signup with the same keys returns the same user', async () => {
    const u = await signUp(ctx.base, 'Reinstall');
    // A fresh install finds the old Keychain items: login with the existing device key.
    const ch = await getChallenge(ctx.base, u.device);
    const login = await postJson(ctx.base, '/v1/auth/session', loginBody(ch, u.device));
    expect(login.status).toBe(200);
    expect(login.json!.user.user_id).toBe(u.session.user.user_id);
    // Or it re-runs signup with the same wallet + device keys: idempotent, same user.
    const ch2 = await getChallenge(ctx.base, u.device);
    const again = await postJson(
      ctx.base,
      '/v1/auth/signup',
      signupBody(ch2, u.device, u.wallet, { display_name: 'Reinstall' }),
    );
    expect(again.status).toBe(201);
    expect(again.json!.user.user_id).toBe(u.session.user.user_id);
    expect(again.json!.device_id).toBe(u.session.device_id);
    const rows = await ctx.deps.db
      .select()
      .from(users)
      .where(eq(users.wallet_pubkey, u.wallet.pubkey));
    expect(rows).toHaveLength(1);
  });

  it('signup with an already-registered wallet on a new device key -> 409 INVALID_STATE', async () => {
    const u = await signUp(ctx.base);
    const newDevice = newKey();
    const ch = await getChallenge(ctx.base, newDevice);
    const r = await postJson(ctx.base, '/v1/auth/signup', signupBody(ch, newDevice, u.wallet));
    expect(r.status).toBe(409);
    expect(r.json!.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'wallet_registered' },
    });
  });

  it('a revoked device -> 403 DEVICE_REVOKED at login', async () => {
    const u = await signUp(ctx.base);
    await ctx.deps.db
      .update(devices)
      .set({ revoked_at: new Date() })
      .where(eq(devices.id, u.session.device_id));
    const ch = await getChallenge(ctx.base, u.device);
    const r = await postJson(ctx.base, '/v1/auth/session', loginBody(ch, u.device));
    expect([r.status, code(r.json)]).toEqual([403, 'DEVICE_REVOKED']);
  });

  it('DELETE /v1/auth/session revokes the bearer', async () => {
    const u = await signUp(ctx.base);
    const auth = { Authorization: `Bearer ${u.session.token}` };
    const del = await fetch(ctx.base + '/v1/auth/session', { method: 'DELETE', headers: auth });
    expect(del.status).toBe(204);
    const again = await fetch(ctx.base + '/v1/auth/session', { method: 'DELETE', headers: auth });
    expect(again.status).toBe(401);
    expect(code(await again.json())).toBe('AUTH_REQUIRED');
  });

  it('a bearer whose device was revoked -> 403 DEVICE_REVOKED', async () => {
    const u = await signUp(ctx.base);
    await ctx.deps.db
      .update(devices)
      .set({ revoked_at: new Date() })
      .where(eq(devices.id, u.session.device_id));
    const r = await fetch(ctx.base + '/v1/auth/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    expect([r.status, code(await r.json())]).toEqual([403, 'DEVICE_REVOKED']);
  });

  it("DELETE /v1/auth/session also closes that session's open WebSocket (4401)", async () => {
    const u = await signUp(ctx.base);
    const ws = await connectWs(ctx.wsUrl);
    ws.send({ op: 'hello', token: u.session.token, device_id: u.session.device_id, subs: [] });
    await ws.next((f) => f.op === 'welcome');
    const del = await fetch(ctx.base + '/v1/auth/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    expect(del.status).toBe(204);
    expect((await ws.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('concurrent signups with the same keys never 500: one user row, the rest 201 or 409', async () => {
    const device = newKey();
    const wallet = newKey();
    const chs = await Promise.all([1, 2, 3, 4].map(() => getChallenge(ctx.base, device)));
    const rs = await Promise.all(
      chs.map((ch) => postJson(ctx.base, '/v1/auth/signup', signupBody(ch, device, wallet))),
    );
    for (const r of rs) expect([201, 409]).toContain(r.status);
    expect(rs.some((r) => r.status === 201)).toBe(true);
    const rows = await ctx.deps.db
      .select()
      .from(users)
      .where(eq(users.wallet_pubkey, wallet.pubkey));
    expect(rows).toHaveLength(1);
  });

  it('an expired session -> 401 SESSION_EXPIRED', async () => {
    const u = await signUp(ctx.base);
    await ctx.deps.db
      .update(apiSessions)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(apiSessions.id, u.session.session_id));
    const r = await fetch(ctx.base + '/v1/auth/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    expect([r.status, code(await r.json())]).toEqual([401, 'SESSION_EXPIRED']);
  });
});

describeDb('signed writes (API-CONTRACT §1.3 request signing, §1.6 idempotency)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startTestServer({ modules: [...routeModules, signedProbe] });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });
  const path = '/v1/_probe/signed?x=1';

  it('accepts a valid signature and replays the stored response for the same key + body', async () => {
    const u = await signUp(ctx.base);
    const body = JSON.stringify({ n: 7 });
    const h = signedHeaders(u, 'POST', path, body);
    const r1 = await postJson(ctx.base, path, body, h);
    expect(r1.status).toBe(201);
    expect(r1.json).toMatchObject({ user_id: u.session.user.user_id, n: 7 });
    const r2 = await postJson(ctx.base, path, body, h);
    expect(r2.status).toBe(201);
    expect(r2.res.headers.get('Idempotent-Replayed')).toBe('true');
    expect(r2.json).toEqual(r1.json); // same nonce => the stored response, not a re-run
  });

  it('same Idempotency-Key with a different body -> 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const u = await signUp(ctx.base);
    const idem = randomUUID();
    const a = JSON.stringify({ n: 1 });
    const b = JSON.stringify({ n: 2 });
    expect(
      (await postJson(ctx.base, path, a, signedHeaders(u, 'POST', path, a, { idem }))).status,
    ).toBe(201);
    const r = await postJson(ctx.base, path, b, signedHeaders(u, 'POST', path, b, { idem }));
    expect([r.status, code(r.json)]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('rejects a wrong key, a tampered body or path, and clock skew', async () => {
    const u = await signUp(ctx.base);
    const body = JSON.stringify({ n: 1 });
    let r = await postJson(
      ctx.base,
      path,
      body,
      signedHeaders(u, 'POST', path, body, { signer: u.wallet }),
    );
    expect([r.status, code(r.json)]).toEqual([401, 'SIGNATURE_INVALID']);
    r = await postJson(
      ctx.base,
      path,
      JSON.stringify({ n: 2 }),
      signedHeaders(u, 'POST', path, body),
    );
    expect([r.status, code(r.json)]).toEqual([401, 'SIGNATURE_INVALID']);
    r = await postJson(
      ctx.base,
      '/v1/_probe/signed?x=2',
      body,
      signedHeaders(u, 'POST', path, body),
    );
    expect([r.status, code(r.json)]).toEqual([401, 'SIGNATURE_INVALID']);
    r = await postJson(
      ctx.base,
      path,
      body,
      signedHeaders(u, 'POST', path, body, { ts: Date.now() - 61_000 }),
    );
    expect(r.status).toBe(401);
    expect(r.json!.error).toMatchObject({
      code: 'CLOCK_SKEW',
      details: { server_time: expect.any(String) },
    });
    r = await postJson(ctx.base, path, body, {
      ...signedHeaders(u, 'POST', path, body),
      'Idempotency-Key': 'nope',
    });
    expect([r.status, code(r.json)]).toEqual([422, 'VALIDATION_FAILED']);
    r = await postJson(ctx.base, path, body, { 'Content-Type': 'application/json' });
    expect([r.status, code(r.json)]).toEqual([401, 'AUTH_REQUIRED']);
  });

  it('an Idempotency-Key reused on another route (same empty body) -> 409, never a cross-route replay', async () => {
    const u = await signUp(ctx.base);
    const idem = randomUUID();
    const a = await postJson(
      ctx.base,
      '/v1/_probe/accept',
      '',
      signedHeaders(u, 'POST', '/v1/_probe/accept', '', { idem }),
    );
    expect([a.status, a.json]).toEqual([200, { did: 'accept' }]);
    const d = await postJson(
      ctx.base,
      '/v1/_probe/decline',
      '',
      signedHeaders(u, 'POST', '/v1/_probe/decline', '', { idem }),
    );
    expect([d.status, code(d.json)]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('a 429 from the handler is not stored: the same-key retry runs again', async () => {
    const u = await signUp(ctx.base);
    const idem = randomUUID();
    const p = '/v1/_probe/flaky';
    const r1 = await postJson(ctx.base, p, '', signedHeaders(u, 'POST', p, '', { idem }));
    expect([r1.status, code(r1.json)]).toEqual([429, 'RATE_LIMITED']);
    const r2 = await postJson(ctx.base, p, '', signedHeaders(u, 'POST', p, '', { idem }));
    expect([r2.status, r2.json]).toEqual([201, { ok: true }]);
    expect(r2.res.headers.get('Idempotent-Replayed')).toBeNull();
  });

  it('a stage (non-app) session cannot make signed writes', async () => {
    const token = 'yo_s_' + randomUUID().replaceAll('-', '').padEnd(43, 'x').slice(0, 43);
    await ctx.deps.db
      .insert(apiSessions)
      .values({ token_sha256: sha256Hex(token), scopes: ['stage'] });
    const r = await postJson(ctx.base, path, '{"n":1}', {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
    expect([r.status, code(r.json)]).toEqual([401, 'AUTH_REQUIRED']);
  });
});
