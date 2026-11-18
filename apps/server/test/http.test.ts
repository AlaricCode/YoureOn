// No-DB tests: /health, the error envelope, env validation, and the in-process stores.
import { describe, expect, it } from 'vitest';
import {
  authChallengeMessage,
  requestSigningString,
  walletBindMessage,
  ApiError,
} from '@youre-on/shared/api';
import { buildApp } from '../src/app';
import { ChallengeStore } from '../src/auth/challenges';
import type { RouteModule } from '../src/context';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import { EnvError, loadEnv } from '../src/env';
import { HttpError } from '../src/errors';
import { readBody } from '../src/http/body';
import { IdempotencyCache } from '../src/http/idempotency';
import { RateLimiter } from '../src/http/rate-limit';
import { createDeps } from '../src/server';
import { routeModules } from '../src/routes';
import { z } from 'zod/v4';
import { newKey, testEnv } from './helpers';

// createDb is lazy (postgres.js connects on first query), so these deps never touch a DB.
const { deps } = createDeps({
  env: testEnv({ DATABASE_URL: 'postgres://unused@127.0.0.1:1/none' }),
  rateLimit: false,
});

const probe: RouteModule = {
  name: 'probe',
  bodyLimits: [{ path: /^\/probe\/big$/, maxBytes: 200 * 1024 }],
  register(app) {
    app.post('/probe/echo', async (c) =>
      c.json(await readBody(c, z.object({ n: z.number().int() }))),
    );
    app.post('/probe/big', async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    app.get('/probe/throw', () => {
      throw new Error('boom');
    });
    app.get('/probe/conflict', () => {
      throw new HttpError('INVALID_STATE', 'Nope.', { state: 'LOCKED' });
    });
  },
};
const app = buildApp(deps, [...routeModules, probe]);

describe('GET /health', () => {
  it('returns 200 without a database', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; server_time: string };
    expect(body.ok).toBe(true);
    expect(new Date(body.server_time).toISOString()).toBe(body.server_time);
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/);
  });

  it('echoes a client X-Request-Id', async () => {
    const res = await app.request('/health', { headers: { 'X-Request-Id': 'abc-123' } });
    expect(res.headers.get('X-Request-Id')).toBe('abc-123');
  });
});

describe('error envelope (API-CONTRACT §1.5)', () => {
  const env = async (res: Response) => ApiError.parse(await res.json()).error;

  it('unknown route -> 404 NOT_FOUND', async () => {
    const res = await app.request('/v1/nope');
    expect(res.status).toBe(404);
    expect((await env(res)).code).toBe('NOT_FOUND');
  });

  it('demo-claim is 404 while DEMO_MODE=false (handler PENDING)', async () => {
    const res = await app.request('/v1/auth/demo-claim', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('bad JSON and schema failures -> 422 VALIDATION_FAILED with issues', async () => {
    const r1 = await app.request('/probe/echo', { method: 'POST', body: '{not json' });
    expect(r1.status).toBe(422);
    expect((await env(r1)).code).toBe('VALIDATION_FAILED');
    const r2 = await app.request('/probe/echo', {
      method: 'POST',
      body: JSON.stringify({ n: 'x' }),
    });
    const e2 = await env(r2);
    expect(e2.code).toBe('VALIDATION_FAILED');
    expect(e2.details?.issues).toEqual([expect.objectContaining({ path: 'n' })]);
    expect(e2.retryable).toBe(false);
  });

  it('bodies over 64 KB -> 413 PAYLOAD_TOO_LARGE; per-route overrides apply', async () => {
    const big = 'x'.repeat(70 * 1024);
    const r1 = await app.request('/probe/echo', { method: 'POST', body: big });
    expect(r1.status).toBe(413);
    expect((await env(r1)).code).toBe('PAYLOAD_TOO_LARGE');
    const r2 = await app.request('/probe/big', { method: 'POST', body: big });
    expect(r2.status).toBe(200);
  });

  it('HttpError carries code, status, details; unknown errors -> 500 INTERNAL', async () => {
    const r1 = await app.request('/probe/conflict');
    expect(r1.status).toBe(409);
    expect(await env(r1)).toMatchObject({
      code: 'INVALID_STATE',
      message: 'Nope.',
      details: { state: 'LOCKED' },
    });
    const r2 = await app.request('/probe/throw');
    expect(r2.status).toBe(500);
    expect(await env(r2)).toMatchObject({ code: 'INTERNAL', retryable: true });
  });

  it('auth endpoints reject a missing 18+ attestation before anything else', async () => {
    const res = await app.request('/v1/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ display_name: 'x' }),
    });
    expect(res.status).toBe(403);
    expect((await env(res)).code).toBe('AGE_REQUIRED');
  });

  it('a bearer-only route without a token -> 401 AUTH_REQUIRED', async () => {
    const res = await app.request('/v1/auth/session', { method: 'DELETE' });
    expect(res.status).toBe(401);
    expect((await env(res)).code).toBe('AUTH_REQUIRED');
  });
});

describe('env (SETUP-CHECKLIST §7 names)', () => {
  it('applies defaults and treats empty strings as unset', () => {
    const e = loadEnv({ DATABASE_URL: 'postgres://x', PORT: '', LOCK_MODE: '', DEMO_MODE: '' });
    expect(e).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
      LOCK_MODE: 'atomic',
      DEMO_MODE: false,
    });
  });
  it('requires DATABASE_URL and validates formats', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    expect(() => loadEnv({ DATABASE_URL: 'x', USDC_MINT: 'not-a-key' })).toThrow(/USDC_MINT/);
    expect(() => loadEnv({ DATABASE_URL: 'x', LOCK_MODE: 'fast' })).toThrow(/LOCK_MODE/);
    expect(
      loadEnv({ DATABASE_URL: 'x', USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' })
        .USDC_MINT,
    ).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });
  it('PROGRAM_ID must equal the pinned ESCROW_ID (packages/shared)', () => {
    expect(loadEnv({ DATABASE_URL: 'x', PROGRAM_ID: ESCROW_ID }).PROGRAM_ID).toBe(ESCROW_ID);
    expect(() =>
      loadEnv({ DATABASE_URL: 'x', PROGRAM_ID: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' }),
    ).toThrow(/PROGRAM_ID/);
  });
  it('production requires PUBLIC_BASE_URL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'x', NODE_ENV: 'production' })).toThrow(/PUBLIC_BASE_URL/);
  });
});

describe('signed strings (API-CONTRACT §1.3)', () => {
  it('are byte-exact', () => {
    expect(
      authChallengeMessage({
        purpose: 'signup',
        nonce: 'N',
        device_pubkey: 'D',
        wallet_pubkey: 'W',
      }),
    ).toBe('yo-auth-v1\npurpose=signup\nchallenge=N\ndevice=D\nwallet=W\n');
    expect(
      authChallengeMessage({
        purpose: 'login',
        nonce: 'N',
        device_pubkey: 'D',
        wallet_pubkey: null,
      }),
    ).toBe('yo-auth-v1\npurpose=login\nchallenge=N\ndevice=D\nwallet=-\n');
    expect(walletBindMessage({ wallet_pubkey: 'W', device_pubkey: 'D', nonce: 'N' })).toBe(
      'yo-bind-v1\nwallet=W\ndevice=D\nchallenge=N\n',
    );
    expect(
      requestSigningString({
        method: 'post',
        path_and_query: '/v1/rooms?x=1',
        timestamp_ms: 1,
        idempotency_key: 'K',
        session_id: 'S',
        body_sha256_hex: 'H',
      }),
    ).toBe('yo-req-v1\nPOST\n/v1/rooms?x=1\n1\nK\nS\nH');
  });
  it('start with 0x79 ("y"), so none can parse as a Solana message (domain separation)', () => {
    expect('yo-auth-v1'.charCodeAt(0)).toBe(0x79);
  });
});

describe('ChallengeStore', () => {
  it('is single-use and expires after the TTL', () => {
    let t = 1_000;
    const s = new ChallengeStore(() => t, 60_000);
    const a = s.issue('dev');
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.consume(a.challenge_id)).toMatchObject({ ok: true });
    expect(s.consume(a.challenge_id)).toEqual({ ok: false, reason: 'unknown' });
    const b = s.issue('dev');
    t += 60_001;
    expect(s.consume(b.challenge_id)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('IdempotencyCache', () => {
  it('replays the same body, rejects a different one, and expires after 24 h', () => {
    let t = 0;
    const c = new IdempotencyCache({ now: () => t });
    expect(c.begin('d', 'k', 'h1')).toEqual({ kind: 'new' });
    expect(c.begin('d', 'k', 'h1')).toEqual({ kind: 'in_flight' });
    c.complete('d', 'k', { status: 201, body: '{"ok":1}', contentType: 'application/json' });
    expect(c.begin('d', 'k', 'h1')).toMatchObject({ kind: 'replay', response: { status: 201 } });
    expect(c.begin('d', 'k', 'h2')).toEqual({ kind: 'mismatch' });
    expect(c.begin('other-device', 'k', 'h2')).toEqual({ kind: 'new' });
    t += 24 * 3600_000 + 1;
    expect(c.begin('d', 'k', 'h2')).toEqual({ kind: 'new' });
  });
});

describe('RateLimiter', () => {
  it('allows the bucket then throws RATE_LIMITED with Retry-After, and refills', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const spec = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) rl.take('auth', 'ip', spec);
    try {
      rl.take('auth', 'ip', spec);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).code).toBe('RATE_LIMITED');
      expect(Number((e as HttpError).headers?.['Retry-After'])).toBeGreaterThanOrEqual(1);
    }
    t += 20_000;
    rl.take('auth', 'ip', spec);
  });

  it('holds at most maxBuckets keys: a flood of fresh keys evicts the least recently used', () => {
    const t = 0;
    const rl = new RateLimiter(() => t, 10);
    const spec = { limit: 3, windowMs: 60_000 };
    const keep = { limit: 2, windowMs: 60_000 };
    rl.take('auth', 'oldest', keep);
    for (let i = 0; i < 50; i++) rl.take('auth', `flood-${i}`, spec);
    expect(rl.size).toBeLessThanOrEqual(10);
    // The oldest key was evicted: it is a fresh bucket (2 tokens) again, not the 1 it had left.
    rl.take('auth', 'oldest', keep);
    rl.take('auth', 'oldest', keep);
    expect(() => rl.take('auth', 'oldest', keep)).toThrow(HttpError);
  });
});

describe('auth rate limit keys (inputs-2)', () => {
  // A real limiter: the device bucket must never be keyed on an unvalidated string.
  const { deps: limited } = createDeps({
    env: testEnv({ DATABASE_URL: 'postgres://unused@127.0.0.1:1/none' }),
  });
  const limitedApp = buildApp(limited);
  const challenge = (device_pubkey: unknown) =>
    limitedApp.request('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ device_pubkey }),
    });

  it('a malformed device_pubkey (any 60 KB string) is 422 and leaves no bucket behind', async () => {
    const before = limited.rateLimit!.size;
    for (let i = 0; i < 4; i++) {
      const res = await challenge(`${i}`.padEnd(60_000, 'x'));
      expect(res.status).toBe(422);
    }
    // Only the per-IP bucket was added, not one per junk key.
    expect(limited.rateLimit!.size - before).toBeLessThanOrEqual(1);
    const res = await challenge(newKey().pubkey);
    expect(res.status).toBe(200);
    expect(limited.rateLimit!.size - before).toBe(2); // + auth/device for a real key
  });
});
