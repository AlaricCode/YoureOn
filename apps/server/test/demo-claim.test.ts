/* eslint-disable @typescript-eslint/no-explicit-any -- the mobile modules are loaded untyped (see the cross-check) */
// Demo claim (API-CONTRACT §1.3, §2.1, §2.17; decision D-A):
//   POST /v1/demo/claim-tokens (DEMO_MODE + X-YO-Demo-Key) -> youreon://<word>/<token>
//   POST /v1/auth/demo-claim -> Session + wallet_seed_b64 of demo-a / demo-b
// Unit tests for the token store and key parsing run without Postgres; the rest skip without it.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { getAddressDecoder, getAddressEncoder, getBase58Decoder, type Address } from '@solana/kit';
import { and, desc, eq } from 'drizzle-orm';
import { apiSessions, auditLog, devices, users } from '@youre-on/db';
import {
  ApiError,
  authChallengeMessage,
  DemoClaimResponse,
  DemoClaimTokenResponse,
  demoClaimTokenFromQr,
  type AuthChallengeResponse,
} from '@youre-on/shared/api';
import { requireAppSession, requireSignedRequest, appAuth } from '../src/auth/middleware';
import type { RouteModule } from '../src/context';
import { ClaimTokenStore, demoPartyKey } from '../src/demo/claim-tokens';
import { RateLimiter } from '../src/http/rate-limit';
import { routeModules } from '../src/routes';
import '../src/crypto'; // noble sha512
import {
  b64,
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
  type TestKey,
} from './helpers';

const code = (j: unknown) => ApiError.parse(j).error.code;
const ADMIN = 'test-demo-admin-token';
const STAGE_KEY = 'test-stage-key';
const b58 = getBase58Decoder();
const addr = getAddressDecoder();
const addrEnc = getAddressEncoder();

/** A fresh custodial party key: seed + pubkey + the env encodings scripts/keys.ts produces. */
function partyKey() {
  const seed = new Uint8Array(randomBytes(32));
  const pub = ed.getPublicKey(seed);
  const secret64 = new Uint8Array([...seed, ...pub]);
  return {
    seed,
    pubkey: addr.decode(pub) as string,
    base58_64: b58.decode(secret64),
    base58_32: b58.decode(seed),
    json64: JSON.stringify([...secret64]),
  };
}

function claimBody(
  ch: Pick<AuthChallengeResponse, 'challenge_id' | 'nonce'>,
  device: TestKey,
  claim_token: string,
  over: { signer?: TestKey; purpose?: 'demo-claim' | 'login'; challenge_id?: string | null } = {},
) {
  const msg = authChallengeMessage({
    purpose: over.purpose ?? 'demo-claim',
    nonce: ch.nonce,
    device_pubkey: device.pubkey,
    wallet_pubkey: null,
  });
  return {
    ...(over.challenge_id === null ? {} : { challenge_id: over.challenge_id ?? ch.challenge_id }),
    claim_token,
    device_pubkey: device.pubkey,
    device_sig: b64((over.signer ?? device).sign(msg)),
  };
}

// ---------------------------------------------------------------------------------------------

describe('ClaimTokenStore', () => {
  it('issues yo_dc_ tokens with a youreon://<word>/<token> QR, single use, 10 min', () => {
    let now = 1_000_000;
    const s = new ClaimTokenStore(() => now);
    const t = s.issue({ party: 'a', display_name: 'Logan' });
    expect(DemoClaimTokenResponse.shape.token.safeParse(t.token).success).toBe(true);
    expect(t.qr).toBe(`youreon://${t.word}/${t.token}`);
    expect(demoClaimTokenFromQr(t.qr)).toBe(t.token);
    expect(demoClaimTokenFromQr(` ${t.token}\n`)).toBe(t.token);
    expect(t.entry.expires_at - t.entry.issued_at).toBe(10 * 60 * 1000);

    const first = s.consume(t.token);
    expect(first).toMatchObject({ ok: true, entry: { party: 'a', display_name: 'Logan' } });
    expect(s.consume(t.token)).toEqual({ ok: false, reason: 'used' });
    expect(s.consume('yo_dc_' + 'x'.repeat(43))).toEqual({ ok: false, reason: 'unknown' });

    const late = s.issue({ party: 'b' });
    now += 10 * 60 * 1000 + 1;
    expect(s.consume(late.token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('stores only the sha256 of a token', () => {
    const s = new ClaimTokenStore();
    const t = s.issue({ party: 'a' });
    const keys = [...(s as unknown as { map: Map<string, unknown> }).map.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...(s as any).map.entries()])).not.toContain(t.token);
  });
});

describe('demoPartyKey', () => {
  it('reads base58 64-byte, base58 32-byte seed and keygen JSON, all to the same seed + pubkey', () => {
    const k = partyKey();
    for (const raw of [k.base58_64, k.base58_32, k.json64]) {
      const r = demoPartyKey({ DEMO_A_SECRET_KEY: raw, DEMO_B_SECRET_KEY: undefined }, 'a');
      expect(r?.pubkey).toBe(k.pubkey);
      expect(Buffer.from(r!.seed).equals(Buffer.from(k.seed))).toBe(true);
    }
    expect(
      demoPartyKey({ DEMO_A_SECRET_KEY: k.base58_64, DEMO_B_SECRET_KEY: undefined }, 'b'),
    ).toBe(null);
  });

  it('refuses a 64-byte secret whose halves disagree', () => {
    const k = partyKey();
    const other = partyKey();
    const bad = JSON.stringify([...k.seed, ...addrEnc.encode(other.pubkey as Address)]);
    expect(() =>
      demoPartyKey({ DEMO_A_SECRET_KEY: bad, DEMO_B_SECRET_KEY: undefined }, 'a'),
    ).toThrow(/halves disagree/);
  });
});

// ---------------------------------------------------------------------------------------------

// Bearer- and request-signed probes: the claimed session works like any other app session.
const probe: RouteModule = {
  name: 'demo-claim-probe',
  register(app) {
    app.get('/v1/_probe/whoami', requireAppSession, (c) => {
      const a = appAuth(c);
      return c.json({ user_id: a.user_id, device_id: a.device_id }, 200);
    });
    app.post('/v1/_probe/signed-whoami', requireSignedRequest, (c) =>
      c.json({ user_id: appAuth(c).user_id }, 201),
    );
  },
};

describeDb('demo claim (API-CONTRACT §1.3, §2.17)', () => {
  let ctx: Ctx;
  let off: Ctx;
  let now = Date.now();
  const A = partyKey();
  const B = partyKey();

  beforeAll(async () => {
    ctx = await startTestServer({
      modules: [...routeModules, probe],
      now: () => now,
      env: {
        DEMO_MODE: 'true',
        DEMO_ADMIN_TOKEN: ADMIN,
        STAGE_KEY,
        DEMO_A_SECRET_KEY: A.base58_64,
        DEMO_B_SECRET_KEY: B.json64,
      },
    });
    off = await startTestServer({
      env: { DEMO_MODE: 'false', DEMO_ADMIN_TOKEN: ADMIN, DEMO_A_SECRET_KEY: A.base58_64 },
    });
  });
  afterAll(async () => {
    await ctx?.server.close();
    await off?.server.close();
  });

  const issue = async (body: unknown, base = ctx.base, key = ADMIN) =>
    postJson(base, '/v1/demo/claim-tokens', body, { 'X-YO-Demo-Key': key });
  const issueToken = async (party: 'a' | 'b', display_name?: string) => {
    const r = await issue({ party, ...(display_name ? { display_name } : {}) });
    expect(r.status).toBe(201);
    return DemoClaimTokenResponse.parse(r.json);
  };
  const claim = async (
    device: TestKey,
    token: string,
    over: Parameters<typeof claimBody>[3] = {},
  ) => {
    const ch = await getChallenge(ctx.base, device);
    return postJson(ctx.base, '/v1/auth/demo-claim', claimBody(ch, device, token, over));
  };
  const whoami = (token: string) =>
    fetch(`${ctx.base}/v1/_probe/whoami`, { headers: { Authorization: `Bearer ${token}` } });

  it('DEMO_MODE=false: both routes are 404 (they do not exist)', async () => {
    const t = await issue({ party: 'a' }, off.base);
    expect(t.status).toBe(404);
    const device = newKey();
    const ch = await getChallenge(off.base, device);
    const r = await postJson(
      off.base,
      '/v1/auth/demo-claim',
      claimBody(ch, device, 'yo_dc_' + 'a'.repeat(43)),
    );
    expect(r.status).toBe(404);
    expect(code(r.json)).toBe('NOT_FOUND');
  });

  it('issuer: needs X-YO-Demo-Key, a known party, and that party key on the server', async () => {
    expect((await issue({ party: 'a' }, ctx.base, 'wrong')).status).toBe(404);
    expect((await postJson(ctx.base, '/v1/demo/claim-tokens', { party: 'a' })).status).toBe(404);
    const bad = await issue({ party: 'c' });
    expect(bad.status).toBe(422);
    expect(code(bad.json)).toBe('VALIDATION_FAILED');

    const t = await issueToken('a');
    expect(t.party).toBe('a');
    expect(t.pubkey).toBe(A.pubkey);
    expect(t.qr).toBe(`youreon://${t.word}/${t.token}`);
    expect(Date.parse(t.expires_at) - now).toBe(10 * 60 * 1000);
    // Issuance is audited, the token itself never.
    const [row] = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'demo.claim_token_issued'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(row?.details).toMatchObject({ party: 'a', pubkey: A.pubkey, word: t.word });
    expect(JSON.stringify(row?.details)).not.toContain(t.token);
  });

  it('issuer: a party whose key is not configured is refused (409)', async () => {
    const solo = await startTestServer({
      env: { DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: ADMIN, DEMO_A_SECRET_KEY: A.base58_64 },
    });
    try {
      const r = await issue({ party: 'b' }, solo.base);
      expect(r.status).toBe(409);
      expect(r.json?.error?.details?.reason).toBe('demo_key_missing');
    } finally {
      await solo.server.close();
    }
  });

  it('claim: Session + the seed that derives session.user.pubkey; the session works; audited', async () => {
    const t = await issueToken('a', 'Logan');
    const device = newKey();
    const r = await claim(device, t.token);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    const s = DemoClaimResponse.parse(r.json);
    expect(s.user.pubkey).toBe(A.pubkey);
    expect(s.user.display_name).toBe('Logan');
    const seed = Buffer.from(s.wallet_seed_b64, 'base64');
    expect(seed.length).toBe(32);
    expect(addr.decode(ed.getPublicKey(new Uint8Array(seed)))).toBe(s.user.pubkey);

    const me = await whoami(s.token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user_id: s.user.user_id, device_id: s.device_id });
    // Request signing with the device key under the claimed session.
    const signed = await postJson(
      ctx.base,
      '/v1/_probe/signed-whoami',
      '{}',
      signedHeaders(
        { device, wallet: device, session: s },
        'POST',
        '/v1/_probe/signed-whoami',
        '{}',
        { ts: now },
      ),
    );
    expect(signed.status).toBe(201);
    expect(signed.json?.user_id).toBe(s.user.user_id);

    const [u] = await ctx.deps.db.select().from(users).where(eq(users.id, s.user.user_id));
    expect(u).toMatchObject({ wallet_pubkey: A.pubkey, is_demo: true, age_attested_18plus: true });
    const [a] = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.demo_claimed'), eq(auditLog.actor_user_id, u!.id)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(a?.details).toMatchObject({ party: 'a', device_id: s.device_id, created_user: true });
    expect(JSON.stringify(a?.details)).not.toContain(s.wallet_seed_b64);
    expect(JSON.stringify(a?.details)).not.toContain(t.token);

    // A plain login with that device key now lands on the demo user.
    const ch = await getChallenge(ctx.base, device);
    const login = await postJson(ctx.base, '/v1/auth/session', loginBody(ch, device));
    expect(login.status).toBe(200);
    expect(login.json?.user?.pubkey).toBe(A.pubkey);
  });

  it('a token is single use; an unknown or expired one is 404', async () => {
    const t = await issueToken('a');
    expect((await claim(newKey(), t.token)).status).toBe(200);
    const again = await claim(newKey(), t.token);
    expect(again.status).toBe(404);
    expect(again.json?.error?.details?.reason).toBe('claim_token_used');

    const unknown = await claim(newKey(), 'yo_dc_' + 'q'.repeat(43));
    expect(unknown.status).toBe(404);
    expect(unknown.json?.error?.details?.reason).toBe('claim_token_unknown');

    const late = await issueToken('b');
    const saved = now;
    now += 10 * 60 * 1000 + 1;
    try {
      const r = await claim(newKey(), late.token);
      expect(r.status).toBe(404);
      expect(r.json?.error?.details?.reason).toBe('claim_token_expired');
    } finally {
      now = saved;
    }
    const refused = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'demo.claim_refused'))
      .orderBy(desc(auditLog.id))
      .limit(3);
    expect(refused.map((r) => (r.details as { reason: string }).reason).sort()).toEqual([
      'expired',
      'unknown',
      'used',
    ]);
  });

  it('party a and party b tokens claim their own wallets; a repeat claim reuses the user', async () => {
    const ta = await issueToken('a');
    const tb = await issueToken('b');
    const ra = DemoClaimResponse.parse((await claim(newKey(), ta.token)).json);
    const rb = DemoClaimResponse.parse((await claim(newKey(), tb.token)).json);
    expect(ra.user.pubkey).toBe(A.pubkey);
    expect(rb.user.pubkey).toBe(B.pubkey);
    expect(rb.user.display_name).toBe('Demo B');
    expect(Buffer.from(rb.wallet_seed_b64, 'base64').equals(Buffer.from(B.seed))).toBe(true);
    // Party A was created by the first claim test: same user, a second device.
    const again = DemoClaimResponse.parse(
      (await claim(newKey(), (await issueToken('a')).token)).json,
    );
    expect(again.user.user_id).toBe(ra.user.user_id);
    expect(again.device_id).not.toBe(ra.device_id);
    const rows = await ctx.deps.db.select().from(users).where(eq(users.wallet_pubkey, A.pubkey));
    expect(rows).toHaveLength(1);
  });

  it('signature checks: wrong key, wrong purpose, replayed or foreign challenge; none burns the token', async () => {
    const t = await issueToken('b');
    const device = newKey();
    const wrongKey = await claim(device, t.token, { signer: newKey() });
    expect(wrongKey.status).toBe(401);
    expect(code(wrongKey.json)).toBe('SIGNATURE_INVALID');
    const wrongPurpose = await claim(device, t.token, { purpose: 'login' });
    expect(code(wrongPurpose.json)).toBe('SIGNATURE_INVALID');

    // A challenge issued for another device key.
    const other = newKey();
    const foreign = await getChallenge(ctx.base, other);
    const f = await postJson(ctx.base, '/v1/auth/demo-claim', claimBody(foreign, device, t.token));
    expect(code(f.json)).toBe('SIGNATURE_INVALID');

    // Replay: the challenge is single use.
    const ch = await getChallenge(ctx.base, device);
    const body = claimBody(ch, device, 'yo_dc_' + 'z'.repeat(43));
    expect((await postJson(ctx.base, '/v1/auth/demo-claim', body)).status).toBe(404);
    const replay = await postJson(ctx.base, '/v1/auth/demo-claim', {
      ...body,
      claim_token: t.token,
    });
    expect(replay.status).toBe(401);
    expect(code(replay.json)).toBe('CHALLENGE_EXPIRED');

    // Bad body.
    const bad = await postJson(ctx.base, '/v1/auth/demo-claim', { claim_token: t.token });
    expect(bad.status).toBe(422);

    // The token survived all of that.
    const ok = await claim(device, t.token);
    expect(ok.status).toBe(200);
    expect(ok.json?.user?.pubkey).toBe(B.pubkey);
  });

  it('without challenge_id the newest challenge of the device key is used (the contract body)', async () => {
    const t = await issueToken('a');
    const device = newKey();
    await getChallenge(ctx.base, device); // an older one
    const ch = await getChallenge(ctx.base, device);
    const r = await postJson(
      ctx.base,
      '/v1/auth/demo-claim',
      claimBody(ch, device, t.token, { challenge_id: null }),
    );
    expect(r.status).toBe(200);
    expect(r.json?.user?.pubkey).toBe(A.pubkey);
  });

  it("re-bind: a device key registered to another user moves to the demo user; the old user's sessions on it die", async () => {
    const jake = await signUp(ctx.base, 'Jake');
    expect((await whoami(jake.session.token)).status).toBe(200);
    const t = await issueToken('b');
    const r = await claim(jake.device, t.token);
    expect(r.status).toBe(200);
    const s = DemoClaimResponse.parse(r.json);
    expect(s.user.pubkey).toBe(B.pubkey);
    expect(s.device_id).toBe(jake.session.device_id); // same device row, moved
    expect(s.user.user_id).not.toBe(jake.session.user.user_id);

    expect((await whoami(jake.session.token)).status).toBe(401);
    expect((await whoami(s.token)).status).toBe(200);
    const [dev] = await ctx.deps.db
      .select()
      .from(devices)
      .where(eq(devices.device_pubkey, jake.device.pubkey));
    expect(dev?.user_id).toBe(s.user.user_id);
    const [old] = await ctx.deps.db
      .select()
      .from(apiSessions)
      .where(eq(apiSessions.id, jake.session.session_id));
    expect(old?.revoked_at).not.toBeNull();

    const [audit] = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'device.rebound'),
          eq(auditLog.subject_user_id, jake.session.user.user_id),
        ),
      );
    expect(audit?.details).toMatchObject({
      device_id: s.device_id,
      from_user_id: jake.session.user.user_id,
      to_user_id: s.user.user_id,
      via: 'demo-claim',
      revoked_sessions: 1,
    });
  });

  it('a wallet already signed up as demo-a (cp1-drive) is the account that gets claimed', async () => {
    // A server whose party b key nobody has used yet.
    const C = partyKey();
    const c2 = await startTestServer({
      env: { DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: ADMIN, DEMO_B_SECRET_KEY: C.base58_32 },
    });
    try {
      const wallet: TestKey = {
        secret: C.seed,
        pubkey: C.pubkey,
        sign: (m) => ed.sign(new TextEncoder().encode(m), C.seed),
      };
      const cpDevice = newKey();
      const ch = await getChallenge(c2.base, cpDevice);
      const su = await postJson(
        c2.base,
        '/v1/auth/signup',
        signupBody(ch, cpDevice, wallet, { display_name: 'Jake' }),
      );
      expect(su.status).toBe(201);
      const t = DemoClaimTokenResponse.parse(
        (
          await postJson(
            c2.base,
            '/v1/demo/claim-tokens',
            { party: 'b' },
            { 'X-YO-Demo-Key': ADMIN },
          )
        ).json,
      );
      const phone = newKey();
      const ch2 = await getChallenge(c2.base, phone);
      const r = await postJson(c2.base, '/v1/auth/demo-claim', claimBody(ch2, phone, t.token));
      expect(r.status).toBe(200);
      expect(r.json?.user?.user_id).toBe(su.json?.user?.user_id);
      expect(r.json?.user?.display_name).toBe('Jake');
      // cp1-drive's device still logs in (other devices of the demo user stay bound).
      const ch3 = await getChallenge(c2.base, cpDevice);
      expect((await postJson(c2.base, '/v1/auth/session', loginBody(ch3, cpDevice))).status).toBe(
        200,
      );
    } finally {
      await c2.server.close();
    }
  });

  it('is rate limited per IP (5 / min on top of the auth buckets)', async () => {
    const saved = ctx.deps.rateLimit;
    ctx.deps.rateLimit = new RateLimiter(() => now);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const device = newKey();
        // Issued directly: the HTTP challenge route would spend the auth/ip bucket too.
        const ch = ctx.deps.challenges.issue(device.pubkey);
        const r = await postJson(
          ctx.base,
          '/v1/auth/demo-claim',
          claimBody(ch, device, 'yo_dc_' + 'r'.repeat(43)),
        );
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
      expect(statuses[5]).toBe(429);
    } finally {
      ctx.deps.rateLimit = saved;
    }
  });

  // ---- the admin key's reach (data-1) -------------------------------------------------------

  const addDevice = (userId: string, device_pubkey: string) =>
    postJson(
      ctx.base,
      `/v1/demo/users/${userId}/devices`,
      { device_pubkey },
      { 'X-YO-Demo-Key': ADMIN },
    );

  it('POST /v1/demo/users/:id/devices adds a device to a demo account only, never a real one', async () => {
    const real = await signUp(ctx.base, 'Rita');
    const refused = await addDevice(real.session.user.user_id, newKey().pubkey);
    expect(refused.status).toBe(409);
    expect(ApiError.parse(refused.json).error.details).toMatchObject({ reason: 'not_demo_user' });
    expect(
      await ctx.deps.db
        .select()
        .from(devices)
        .where(eq(devices.user_id, real.session.user.user_id)),
    ).toHaveLength(1);

    // Demo A (the judge cam is a device of A) still gets one.
    const claimed = await claim(newKey(), (await issueToken('a')).token);
    expect(claimed.status).toBe(200);
    const demoA = DemoClaimResponse.parse(claimed.json).user.user_id;
    const cam = newKey();
    expect((await addDevice(demoA, cam.pubkey)).status).toBe(201);
    const ch = await getChallenge(ctx.base, cam);
    const login = await postJson(ctx.base, '/v1/auth/session', loginBody(ch, cam));
    expect(login.status).toBe(200);
    expect((login.json as any).user.user_id).toBe(demoA);
  });

  it("GET /v1/demo/health takes the projector's stage session instead of the admin key", async () => {
    const health = (headers: Record<string, string>) =>
      fetch(`${ctx.base}/v1/demo/health`, { headers });
    const u = await signUp(ctx.base, 'Host');
    const raw = JSON.stringify({ name: 'Stage room', kind: 'session' });
    const room = await fetch(`${ctx.base}/v1/rooms`, {
      method: 'POST',
      headers: signedHeaders(u, 'POST', '/v1/rooms', raw, { ts: now }),
      body: raw,
    });
    expect(room.status).toBe(201);
    const st = await postJson(ctx.base, '/v1/stage/session', {
      stage_key: STAGE_KEY,
      room_id: ((await room.json()) as any).room_id,
    });
    expect(st.status).toBe(201);
    expect((st.json as any).scopes).toEqual(['stage', 'demo']);

    expect((await health({ Authorization: `Bearer ${(st.json as any).token}` })).status).toBe(200);
    expect((await health({ 'X-YO-Demo-Key': ADMIN })).status).toBe(200);
    // An app session, a wrong key, nothing: the route does not exist for them.
    expect((await health({ Authorization: `Bearer ${u.session.token}` })).status).toBe(404);
    expect((await health({ 'X-YO-Demo-Key': 'wrong' })).status).toBe(404);
    expect((await health({})).status).toBe(404);
    // and the stage session opens nothing else of the demo surface
    const reset = await fetch(`${ctx.base}/v1/demo/reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${(st.json as any).token}` },
      body: '{}',
    });
    expect(reset.status).toBe(404);
  });

  // -------------------------------------------------------------------------------------------
  // Cross-check: the phone's own code (apps/mobile/src/net/session.ts demoClaim, its API client,
  // device key and wallet) against this server. Loaded through variable specifiers so the server's
  // tsc does not type-check the mobile tree; vitest transforms it like any TS module.
  it("the mobile client's demoClaim is accepted and its wallet becomes the demo party", async () => {
    const m = (p: string) => import(/* @vite-ignore */ new URL(p, import.meta.url).href);
    const [session, signed, deviceKey, wallet, fakes, enc] = (await Promise.all([
      m('../../mobile/src/net/session.ts'),
      m('../../mobile/src/net/signedFetch.ts'),
      m('../../mobile/src/net/deviceKey.ts'),
      m('../../mobile/src/wallet/wallet.ts'),
      m('../../mobile/src/wallet/__tests__/fakes.ts'),
      m('../../mobile/src/net/encoding.ts'),
    ])) as any[];

    const t = await issueToken('b');
    const platform = fakes.createFakePlatform();
    const w = wallet.createWallet(platform);
    await w.ensureWallet(); // the phone's own wallet gets replaced by the demo seed
    const key = deviceKey.deviceKeyFromSeed(new Uint8Array(randomBytes(32)));
    const clock = signed.createClock(() => now);
    let mgr: any = null;
    const api = signed.createApiClient({
      baseUrl: ctx.base,
      fetch: async (url: string, init: any) => {
        const res = await fetch(url, init);
        return { status: res.status, headers: res.headers, text: () => res.text() };
      },
      deviceKey: () => key,
      clock,
      uuid: () => enc.uuidV4((a: Uint8Array) => new Uint8Array(randomBytes(a.length))),
      appVersion: '1.0.0+1',
      session: () => mgr?.current() ?? null,
    });
    const stored: { s: unknown } = { s: null };
    mgr = session.createSessionManager({
      api,
      deviceKey: key,
      wallet: w,
      store: {
        load: async () => stored.s,
        save: async (s: unknown) => void (stored.s = s),
        clear: async () => void (stored.s = null),
      },
      clock,
      appVersion: '1.0.0+1',
    });
    // DemoApp strips the youreon://<word>/ prefix the same way.
    const token = t.qr.trim().replace(/^youreon:\/\/[a-z-]+\//i, '');
    expect(token).toBe(t.token);
    const s = await mgr.demoClaim(token);
    expect(s.user.pubkey).toBe(B.pubkey);
    expect(await w.getPublicKey()).toBe(B.pubkey);
    expect(JSON.stringify(stored.s)).not.toContain('wallet_seed_b64');
    expect((await whoami(s.token)).status).toBe(200);
    // And the phone's silent re-login lands on the same demo user.
    const again = await mgr.login();
    expect(again.user.user_id).toBe(s.user.user_id);
  });
});
