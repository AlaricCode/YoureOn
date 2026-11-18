import { randomFillSync } from 'node:crypto';

import { HDR, requestSigningString } from '@youre-on/shared/api';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { decodeBase64Url, sha256Hex, verifyEd25519 } from '../../../../server/src/crypto';
import { createFakePlatform } from '../../wallet/__tests__/fakes';
import { base58Encode, utf8 } from '../../wallet/bytes';
import { ed } from '../../wallet/noble';
import { createWallet } from '../../wallet/wallet';
import { DEVICE_SEED_KEY, deviceKeyFromSeed, loadDeviceKey, type DeviceKey } from '../deviceKey';
import { base64ToBytes, bytesToBase64, bytesToBase64Url, uuidV4 } from '../encoding';
import { CameraEvidence } from '@youre-on/shared/evidence';

import { createYoApi } from '../api';
import { buildMultipart } from '../multipart';
import { createSessionManager, demoSeedFrom, secureSessionStore, SESSION_KEY } from '../session';
import {
  ApiClientError,
  createApiClient,
  createClock,
  signedHeaders,
  type SessionRef,
} from '../signedFetch';
import { createFakeServer } from './fakeServer';

const rand = (a: Uint8Array) => randomFillSync(a);
const NOW = Date.UTC(2026, 10, 18, 3, 0, 0);

describe('encoding', () => {
  it('base64 / base64url round-trip and match Node', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 64, 100]) {
      const b = rand(new Uint8Array(n));
      expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
      expect(bytesToBase64Url(b)).toBe(Buffer.from(b).toString('base64url'));
      expect(Buffer.from(base64ToBytes(bytesToBase64(b))).equals(Buffer.from(b))).toBe(true);
    }
  });
  it('uuidV4 is a lowercase v4', () => {
    expect(uuidV4(rand)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('device key', () => {
  it('is created once, stored under its own item, and reloads the same key', async () => {
    const p = createFakePlatform();
    const a = await loadDeviceKey(p);
    const b = await loadDeviceKey(p);
    expect(b).toBe(a);
    expect(p.items.get(DEVICE_SEED_KEY)).toMatch(/^[0-9a-f]{64}$/);
    const p2 = { ...p, secureStore: { ...p.secureStore } };
    const c = await loadDeviceKey(p2);
    expect(c.publicKey).toBe(a.publicKey);
  });
});

describe('signedHeaders (cross-checked with the server verifier)', () => {
  const key = deviceKeyFromSeed(rand(new Uint8Array(32)));
  const session: SessionRef = {
    token: `yo_s_${'a'.repeat(43)}`,
    session_id: '11111111-1111-4111-8111-111111111111',
    device_id: '22222222-2222-4222-8222-222222222222',
  };

  it('signs yo-req-v1 exactly as requireSignedRequest verifies it', () => {
    const body = utf8(JSON.stringify({ code: 'UBC26X' }));
    const h = signedHeaders({
      method: 'post',
      pathAndQuery: '/v1/rooms/join?x=1',
      body,
      session,
      key,
      timestampMs: NOW + 0.7,
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    });
    expect(h[HDR.authorization]).toBe(`Bearer ${session.token}`);
    expect(h[HDR.device]).toBe(session.device_id);
    expect(h[HDR.timestamp]).toBe(String(NOW));
    expect(h[HDR.signature]).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const signed = requestSigningString({
      method: 'POST',
      path_and_query: '/v1/rooms/join?x=1',
      timestamp_ms: h[HDR.timestamp]!,
      idempotency_key: h[HDR.idempotencyKey]!,
      session_id: session.session_id,
      body_sha256_hex: sha256Hex(body),
    });
    expect(verifyEd25519(key.publicKey, signed, decodeBase64Url(h[HDR.signature]!))).toBe(true);
    // Any other path, body or session fails.
    const other = signed.replace('/v1/rooms/join?x=1', '/v1/rooms/join');
    expect(verifyEd25519(key.publicKey, other, decodeBase64Url(h[HDR.signature]!))).toBe(false);
  });

  it('an empty body hashes the empty byte string', () => {
    const h = signedHeaders({
      method: 'POST',
      pathAndQuery: '/v1/bets/x/invite/accept',
      body: new Uint8Array(0),
      session,
      key,
      timestampMs: NOW,
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    });
    const signed = requestSigningString({
      method: 'POST',
      path_and_query: '/v1/bets/x/invite/accept',
      timestamp_ms: NOW,
      idempotency_key: '33333333-3333-4333-8333-333333333333',
      session_id: session.session_id,
      body_sha256_hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(verifyEd25519(key.publicKey, signed, decodeBase64Url(h[HDR.signature]!))).toBe(true);
  });
});

function world(opts: { demo?: boolean } = {}) {
  let now = NOW;
  const demoSeed = rand(new Uint8Array(32));
  const demoPubkey = base58Encode(ed.getPublicKey(demoSeed));
  const server = createFakeServer({
    now: () => now,
    ...(opts.demo ? { demoSeed: Uint8Array.from(demoSeed), demoPubkey } : {}),
  });
  const platform = createFakePlatform();
  const wallet = createWallet(platform);
  const clock = createClock(() => now);
  let key: DeviceKey | null = null;
  let mgr: ReturnType<typeof createSessionManager> | null = null;
  const api = createApiClient({
    baseUrl: 'http://yo.test/',
    fetch: server.fetch,
    deviceKey: () => key,
    clock,
    uuid: () => uuidV4(rand),
    appVersion: '1.0.0+1',
    session: () => mgr?.current() ?? null,
    refreshSession: async () => (await mgr!.login()) ?? null,
  });
  return {
    server,
    platform,
    wallet,
    clock,
    api,
    demoSeed,
    demoPubkey,
    setNow: (t: number) => (now = t),
    async init() {
      key = await loadDeviceKey(platform);
      mgr = createSessionManager({
        api,
        deviceKey: key,
        wallet,
        store: secureSessionStore(platform.secureStore),
        clock,
        appVersion: '1.0.0+1',
      });
      return { key, mgr };
    },
  };
}

const fields = {
  display_name: 'Logan',
  age_attestation: { is_18_plus: true as const, attested_at: new Date(NOW).toISOString() },
};
const Echo = z.object({
  ok: z.literal(true),
  path: z.string(),
  body_sha256: z.string().optional(),
});

describe('session + signed client against the fake server', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world({ demo: true });
  });

  it('signs up with device_sig + wallet_sig (verified server-side), stores the session, sends signed writes', async () => {
    const { mgr, key } = await w.init();
    const s = await mgr.signup(fields);
    expect(s.user.display_name).toBe('Logan');
    expect(s.user.pubkey).toBe(await w.wallet.getPublicKey());
    expect(s.user.pubkey).not.toBe(key.publicKey);
    expect(w.platform.items.get(SESSION_KEY)).toContain(s.token);
    // The signup wallet_sig needed no Face ID.
    expect(w.platform.events.some((e) => e.kind === 'auth')).toBe(false);

    const r = await w.api.request('POST', '/v1/rooms/join', {
      json: { code: 'UBC26X' },
      schema: Echo,
    });
    expect(r.ok).toBe(true);
    const call = w.server.calls.at(-1)!;
    expect(call.headers[HDR.idempotencyKey]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers[HDR.appVersion]).toBe('1.0.0+1');
    expect(call.headers[HDR.schemaVersion]).toBe('1');
    // GET carries the bearer only.
    await w.api.request('GET', '/v1/me/balance');
    const get = w.server.calls.at(-1)!;
    expect(get.headers[HDR.authorization]).toBe(`Bearer ${s.token}`);
    expect(get.headers[HDR.signature]).toBeUndefined();
  });

  it('signs multipart bodies over the exact bytes sent', async () => {
    const { mgr } = await w.init();
    await mgr.signup(fields);
    const mp = buildMultipart([
      { name: 'evidence', contentType: 'application/json', body: '{"a":1}' },
      {
        name: 'frame',
        filename: '00.jpg',
        contentType: 'image/jpeg',
        body: new Uint8Array([0xff, 0xd8, 0, 1, 2, 0xff, 0xd9]),
      },
    ]);
    const r = await w.api.request('POST', '/v1/bets/b/attempts/1/frames', {
      raw: mp,
      schema: Echo,
    });
    expect(r.body_sha256).toBe(sha256Hex(mp.bytes));
    expect(w.server.calls.at(-1)!.headers['Content-Type']).toMatch(
      /^multipart\/form-data; boundary=yo-/,
    );
  });

  it('frames upload: the same parts under the same key are the same bytes (a resend matches)', async () => {
    const { mgr } = await w.init();
    await mgr.signup(fields);
    const api = createYoApi(w.api);
    const key = '77777777-7777-4777-8777-777777777777';
    const evidence = CameraEvidence.parse({
      schema_version: 1,
      kind: 'camera',
      bet_id: '11111111-1111-4111-8111-111111111111',
      attempt_no: 1,
      clip_sha256: 'ab'.repeat(32),
      clip_bytes: 10,
      mime: 'video/quicktime',
      duration_ms: 5000,
      recorded_by: 'A',
      recorded_at: new Date(NOW).toISOString(),
      frames: Array.from({ length: 8 }, (_, i) => ({
        index: i,
        t_ms: i * 100,
        sha256: sha256Hex(new Uint8Array([i])),
      })),
    });
    const jpegs = Array.from({ length: 8 }, (_, i) => new Uint8Array([i]));
    for (let i = 0; i < 2; i++) await api.uploadFrames(evidence, jpegs, key).catch(() => undefined);
    const [a, b] = w.server.calls.filter((c) => c.path.endsWith('/frames'));
    expect(a!.headers[HDR.idempotencyKey]).toBe(key);
    expect(b!.headers['Content-Type']).toBe(a!.headers['Content-Type']);
    expect(sha256Hex(b!.body as Uint8Array)).toBe(sha256Hex(a!.body as Uint8Array));
  });

  it('CLOCK_SKEW: re-syncs the clock and resends with the same Idempotency-Key', async () => {
    const { mgr } = await w.init();
    await mgr.signup(fields);
    w.server.skewOnce();
    await w.api.request('POST', '/v1/rooms', {
      json: {},
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    });
    const [a, b] = w.server.calls.slice(-2);
    expect(a!.headers[HDR.idempotencyKey]).toBe('44444444-4444-4444-8444-444444444444');
    expect(b!.headers[HDR.idempotencyKey]).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('corrects a skewed device clock from server_time', async () => {
    const { mgr } = await w.init();
    await mgr.signup(fields);
    // The device clock runs 5 min fast; the server is at NOW.
    const fast = createClock(() => NOW + 300_000);
    fast.sync(new Date(NOW).toISOString());
    expect(Math.abs(fast.now() - NOW)).toBeLessThan(5);
  });

  it('SESSION_EXPIRED: logs in silently with the device key and resends', async () => {
    const { mgr } = await w.init();
    const first = await mgr.signup(fields);
    w.server.expireOnce();
    await w.api.request('POST', '/v1/rooms', { json: {} });
    expect(mgr.current()!.token).not.toBe(first.token);
    expect(w.server.calls.some((c) => c.path === '/v1/auth/session')).toBe(true);
  });

  it('AUTH_REQUIRED on a stored token the server forgot: re-login once, resend the same key', async () => {
    const { mgr } = await w.init();
    const first = await mgr.signup(fields);
    w.server.reseed(); // sessions gone, device still registered
    const key = '66666666-6666-4666-8666-666666666666';
    const r = await w.api.request('POST', '/v1/rooms', {
      json: {},
      idempotencyKey: key,
      schema: Echo,
    });
    expect(r.ok).toBe(true);
    expect(mgr.current()!.token).not.toBe(first.token);
    const writes = w.server.calls.filter((c) => c.path === '/v1/rooms');
    expect(writes.map((c) => c.headers[HDR.idempotencyKey])).toEqual([key, key]);
    // GETs (bearer only) recover the same way.
    w.server.reseed();
    await w.api.request('GET', '/v1/me/balance');
    expect(w.server.calls.filter((c) => c.path === '/v1/auth/session')).toHaveLength(2);
  });

  it('a reseeded DB (device unknown): the stored session is cleared and the app signs out', async () => {
    const { mgr } = await w.init();
    await mgr.signup(fields);
    const seen: (string | null)[] = [];
    mgr.onChange((s) => seen.push(s?.token ?? null));
    w.server.reseed({ devices: true });
    const e = (await w.api
      .request('POST', '/v1/rooms', { json: {} })
      .catch((x: unknown) => x)) as ApiClientError;
    expect(e).toBeInstanceOf(ApiClientError);
    expect(e.code).toBe('AUTH_REQUIRED');
    expect(mgr.current()).toBeNull();
    expect(seen).toEqual([null]);
    expect(w.platform.items.has(SESSION_KEY)).toBe(false);
    // Only one refresh attempt, then the error: no loop.
    expect(w.server.calls.filter((c) => c.path === '/v1/rooms')).toHaveLength(1);
    // Next boot goes to signup.
    expect(await mgr.restore()).toBeNull();
  });

  it('parallel 401s share one silent re-login', async () => {
    const { mgr } = await w.init();
    await mgr.signup(fields);
    w.server.reseed();
    const before = w.server.calls.filter((c) => c.path === '/v1/auth/session').length;
    await Promise.all([
      w.api.request('GET', '/v1/me/balance'),
      w.api.request('GET', '/v1/me/bets'),
      w.api.request('POST', '/v1/rooms', { json: {} }),
    ]);
    expect(w.server.calls.filter((c) => c.path === '/v1/auth/session').length - before).toBe(1);
  });

  it('surfaces §1.5 errors as ApiClientError with the code', async () => {
    const { mgr } = await w.init();
    await mgr.signup(fields);
    const key = '55555555-5555-4555-8555-555555555555';
    await w.api.request('POST', '/v1/rooms', { json: { a: 1 }, idempotencyKey: key });
    const e = await w.api
      .request('POST', '/v1/rooms', { json: { a: 2 }, idempotencyKey: key })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiClientError);
    expect((e as ApiClientError).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((e as ApiClientError).status).toBe(409);
  });

  it('a network failure is NETWORK, retryable', async () => {
    const api = createApiClient({
      baseUrl: 'http://x',
      fetch: async () => {
        throw new Error('offline');
      },
      deviceKey: () => null,
      clock: createClock(),
      uuid: () => uuidV4(rand),
      appVersion: '1',
      session: () => null,
    });
    const e = (await api
      .request('POST', '/v1/auth/challenge', { json: {} })
      .catch((x: unknown) => x)) as ApiClientError;
    expect(e.code).toBe('NETWORK');
    expect(e.retryable).toBe(true);
  });

  it('restore: reuses a stored session, else logs in; an unknown device returns null', async () => {
    const { mgr } = await w.init();
    expect(await mgr.restore()).toBeNull();
    const s = await mgr.signup(fields);
    const w2mgr = createSessionManager({
      api: w.api,
      deviceKey: (await w.init()).key,
      wallet: w.wallet,
      store: secureSessionStore(w.platform.secureStore),
      clock: w.clock,
      appVersion: '1',
    });
    expect((await w2mgr.restore())?.token).toBe(s.token);
    // Stored session expired -> silent login.
    w.setNow(NOW + 8 * 86400_000);
    const again = await w2mgr.restore();
    expect(again?.token).not.toBe(s.token);
  });

  it('demo-claim imports the custodial seed so the wallet IS the demo party (D-A)', async () => {
    const { mgr } = await w.init();
    await w.wallet.ensureWallet(); // an own wallet already on the phone is replaced
    const s = await mgr.demoClaim('demo-a-token');
    expect(s.user.pubkey).toBe(w.demoPubkey);
    expect(await w.wallet.getPublicKey()).toBe(w.demoPubkey);
    expect(JSON.stringify(s)).not.toContain('wallet_seed_b64');
    expect(w.platform.items.get(SESSION_KEY)).not.toContain('wallet_seed_b64');
    // The imported key signs (one Face ID) and verifies under the demo pubkey.
    const r = await w.wallet.authorize(new Uint8Array([1, 2, 3]), 'x');
    expect(ed.verify(r.signature, new Uint8Array([1, 2, 3]), ed.getPublicKey(w.demoSeed))).toBe(
      true,
    );
  });

  it('demo seeds: 32-byte seeds and 64-byte keygen secrets', () => {
    const seed = rand(new Uint8Array(32));
    const pk = ed.getPublicKey(seed);
    expect(demoSeedFrom(bytesToBase64(seed))).toEqual(seed);
    expect(demoSeedFrom(bytesToBase64(new Uint8Array([...seed, ...pk])))).toEqual(seed);
    expect(() => demoSeedFrom(bytesToBase64(new Uint8Array([...seed, ...seed])))).toThrow();
    expect(() => demoSeedFrom(bytesToBase64(new Uint8Array(16)))).toThrow();
  });
});

describe('wallet.signWalletBinding', () => {
  it('signs only a yo-bind-v1 message for this wallet, without Face ID', async () => {
    const p = createFakePlatform();
    const wallet = createWallet(p);
    const { publicKey } = await wallet.ensureWallet();
    const dev = deviceKeyFromSeed(rand(new Uint8Array(32))).publicKey;
    const nonce = 'n'.repeat(43);
    const msg = `yo-bind-v1\nwallet=${publicKey}\ndevice=${dev}\nchallenge=${nonce}\n`;
    const sig = await wallet.signWalletBinding(msg);
    expect(verifyEd25519(publicKey, msg, sig)).toBe(true);
    expect(p.events.some((e) => e.kind === 'auth')).toBe(false);
    await expect(wallet.signWalletBinding(msg.replace(publicKey, dev))).rejects.toMatchObject({
      code: 'BAD_MESSAGE',
    });
    await expect(wallet.signWalletBinding('yo-req-v1\nPOST\n/x')).rejects.toMatchObject({
      code: 'BAD_MESSAGE',
    });
    await expect(wallet.signWalletBinding(msg + 'x')).rejects.toMatchObject({
      code: 'BAD_MESSAGE',
    });
  });
});
