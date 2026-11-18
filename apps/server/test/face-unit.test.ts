// Face module units (no DB): config resolution (KEK ring, ticket key), the at-rest vault and
// request-embedding checks, and match tickets (issue / verify / expiry / tamper / binding).
import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FACE_MODEL_W600K, MATCH_TICKET_TTL_MS, embeddingToBytes } from '@youre-on/shared/face';
import type { Env } from '../src/env';
import { HttpError } from '../src/errors';
import { DEV_KEK_ID, faceConfigOf, parseKey32, resolveFaceConfig } from '../src/face/config';
import { issueMatchTicket, verifyMatchTicketWithKey } from '../src/face/ticket';
import { atRestAad, openAtRest, openRequestEmbedding, sealAtRest } from '../src/face/vault';
import { verifyMatchTicket } from '../src/bets/match-ticket';
import { oneInFlight } from '../src/face/routes';
import { testEnv } from './helpers';

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const KEY_HEX = 'ab'.repeat(32);
const prodEnv = (over: Partial<Env> = {}): Env => ({
  ...testEnv(),
  NODE_ENV: 'production',
  ...over,
});

const unit = (dim: number, i = 0) => {
  const v = new Float32Array(dim);
  v[i] = 1;
  return v;
};
const plain = (v: Float32Array) =>
  ({
    alg: 'plain-v0',
    epk_b64: null,
    nonce_b64: null,
    ct_b64: Buffer.from(embeddingToBytes(v)).toString('base64'),
  }) as const;

function httpCode(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof HttpError) return e.code;
    throw e;
  }
  throw new Error('expected an HttpError');
}

describe('face config', () => {
  it('parses 32-byte keys from base64 or hex only', () => {
    expect(parseKey32(KEY_B64)).toEqual(new Uint8Array(32).fill(7));
    expect(parseKey32(KEY_HEX)?.[0]).toBe(0xab);
    expect(parseKey32('short')).toBeNull();
    expect(parseKey32(Buffer.alloc(16).toString('base64'))).toBeNull();
    expect(parseKey32(`${KEY_B64.slice(0, -1)}`)).toBeNull();
  });

  it('outside production: a dev KEK and a dev ticket secret by default', () => {
    const c = resolveFaceConfig(testEnv());
    expect(c.activeKeyId).toBe(DEV_KEK_ID);
    expect(c.keyring.get(DEV_KEK_ID)?.length).toBe(32);
    expect(c.ticketKeySource).toBe('dev-default');
    expect(c.sealRequired).toBe(false);
    expect(c.warnings).toEqual([]);
  });

  it('a configured KEK wins and becomes active; FACE_KEK_ACTIVE must name a usable key', () => {
    const c = resolveFaceConfig(testEnv({ FACE_KEK_2026_11_A: KEY_B64 }));
    expect(c.activeKeyId).toBe('face-kek-2026-11-a');
    const named = resolveFaceConfig(
      testEnv({ FACE_KEK_ACTIVE: 'face-kek-2026-11-a', FACE_KEK_2026_11_A: KEY_HEX }),
    );
    expect(named.activeKeyId).toBe('face-kek-2026-11-a');
    const bad = resolveFaceConfig(testEnv({ FACE_KEK_ACTIVE: 'face-kek-nope' }));
    expect(bad.warnings.join(' ')).toMatch(/FACE_KEK_ACTIVE/);
    expect(bad.activeKeyId).toBe(DEV_KEK_ID); // dev fallback, never in production
  });

  it('production has no defaults: no KEK disables enrollment; the ticket key is per process', () => {
    const c = resolveFaceConfig(prodEnv());
    expect(c.activeKeyId).toBeNull();
    expect(c.keyring.has(DEV_KEK_ID)).toBe(false);
    expect(c.ticketKeySource).toBe('ephemeral');
    expect(c.warnings.length).toBe(2);
    expect(c.warnings.join(' ')).not.toContain(KEY_B64);
    // Each resolution of an ephemeral key is different...
    expect(Buffer.from(resolveFaceConfig(prodEnv()).ticketKey)).not.toEqual(
      Buffer.from(c.ticketKey),
    );
    // ...but one Env shares one config (face routes and POST /v1/bets agree).
    const env = prodEnv();
    expect(faceConfigOf(env)).toBe(faceConfigOf(env));
  });

  it('ticket key: FACE_TICKET_SECRET, then SESSION_SECRET; bad KEKs are reported, not used', () => {
    expect(resolveFaceConfig(prodEnv({ SESSION_SECRET: 's' })).ticketKeySource).toBe(
      'SESSION_SECRET',
    );
    expect(
      resolveFaceConfig(prodEnv({ SESSION_SECRET: 's', FACE_TICKET_SECRET: 't' })).ticketKeySource,
    ).toBe('FACE_TICKET_SECRET');
    const same = (a: Env, b: Env) =>
      Buffer.from(resolveFaceConfig(a).ticketKey).equals(
        Buffer.from(resolveFaceConfig(b).ticketKey),
      );
    expect(same(prodEnv({ SESSION_SECRET: 's' }), prodEnv({ SESSION_SECRET: 's' }))).toBe(true);
    // Domain-separated: the ticket key is not the raw secret.
    expect(
      Buffer.from(resolveFaceConfig(prodEnv({ SESSION_SECRET: 's' })).ticketKey).toString(),
    ).not.toBe('s');
    const bad = resolveFaceConfig(prodEnv({ FACE_KEK_2026_11_A: 'not-a-key' }));
    expect(bad.activeKeyId).toBeNull();
    expect(bad.warnings.join(' ')).toMatch(/FACE_KEK_2026_11_A is not 32 bytes/);
    expect(bad.warnings.join(' ')).not.toContain('not-a-key');
    expect(resolveFaceConfig(prodEnv({ FACE_SEAL_REQUIRED: true })).sealRequired).toBe(true);
  });
});

describe('face vault', () => {
  const kek = new Uint8Array(32).fill(1);
  const user = randomUUID();
  const aad = atRestAad(user, FACE_MODEL_W600K);

  it('AES-256-GCM round trip: ciphertext = dim*4 + 16 bytes, 12-byte nonce, never the plaintext', () => {
    const bytes = embeddingToBytes(unit(512, 5));
    const s = sealAtRest(kek, aad, bytes);
    expect(s.ciphertext.length).toBe(512 * 4 + 16);
    expect(s.nonce.length).toBe(12);
    expect(Buffer.from(s.ciphertext).includes(Buffer.from(bytes.subarray(16, 32)))).toBe(false);
    expect(Buffer.from(openAtRest(kek, aad, s)!)).toEqual(Buffer.from(bytes));
    // A fresh nonce per write.
    expect(Buffer.from(sealAtRest(kek, aad, bytes).nonce)).not.toEqual(Buffer.from(s.nonce));
  });

  it('a ciphertext moved to another user or model, a wrong key or a flipped bit fails', () => {
    const s = sealAtRest(kek, aad, embeddingToBytes(unit(512)));
    expect(openAtRest(kek, atRestAad(randomUUID(), FACE_MODEL_W600K), s)).toBeNull();
    expect(
      openAtRest(kek, atRestAad(user, { ...FACE_MODEL_W600K, version: 'other' }), s),
    ).toBeNull();
    expect(openAtRest(new Uint8Array(32).fill(2), aad, s)).toBeNull();
    const flipped = Uint8Array.from(s.ciphertext);
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    expect(openAtRest(kek, aad, { ...s, ciphertext: flipped })).toBeNull();
    expect(openAtRest(kek, aad, { ...s, nonce: new Uint8Array(8) })).toBeNull();
  });

  it('request embeddings: plain-v0 only, exact length, finite, L2-normalized', () => {
    const opts = { sealRequired: false, path: 'probe' as const };
    expect(Array.from(openRequestEmbedding(plain(unit(512)), FACE_MODEL_W600K, opts)).at(0)).toBe(
      1,
    );
    expect(
      httpCode(() =>
        openRequestEmbedding(
          {
            alg: 'x25519-hkdf-sha256-chacha20poly1305-v1',
            epk_b64: 'a',
            nonce_b64: 'b',
            ct_b64: 'c',
          },
          FACE_MODEL_W600K,
          opts,
        ),
      ),
    ).toBe('FACE_SEAL_INVALID');
    expect(
      httpCode(() =>
        openRequestEmbedding(plain(unit(512)), FACE_MODEL_W600K, { ...opts, sealRequired: true }),
      ),
    ).toBe('FACE_SEAL_INVALID');
    expect(httpCode(() => openRequestEmbedding(plain(unit(128)), FACE_MODEL_W600K, opts))).toBe(
      'FACE_SEAL_INVALID',
    );
    expect(
      httpCode(() =>
        openRequestEmbedding(
          { ...plain(unit(512)), ct_b64: 'not base64!' },
          FACE_MODEL_W600K,
          opts,
        ),
      ),
    ).toBe('FACE_SEAL_INVALID');
    const long = unit(512);
    long[0] = 2;
    expect(httpCode(() => openRequestEmbedding(plain(long), FACE_MODEL_W600K, opts))).toBe(
      'VALIDATION_FAILED',
    );
    const nan = unit(512);
    nan[9] = Number.NaN;
    expect(httpCode(() => openRequestEmbedding(plain(nan), FACE_MODEL_W600K, opts))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('match tickets', () => {
  const key = new Uint8Array(32).fill(9);
  const b = {
    room_id: randomUUID(),
    scanner_user_id: randomUUID(),
    candidate_user_id: randomUUID(),
  };
  const t0 = 1_800_000_000_000;

  it('verify ok within the TTL, expired at exactly exp', () => {
    const { ticket, expires_at_ms } = issueMatchTicket(key, b, t0);
    expect(expires_at_ms).toBe(t0 + MATCH_TICKET_TTL_MS);
    expect(ticket).toMatch(/^mt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(ticket.length).toBeLessThanOrEqual(512); // CreateBetRequest.match_ticket max
    expect(verifyMatchTicketWithKey(key, ticket, b, t0)).toEqual({ ok: true, expires_at_ms });
    expect(verifyMatchTicketWithKey(key, ticket, b, expires_at_ms - 1).ok).toBe(true);
    expect(verifyMatchTicketWithKey(key, ticket, b, expires_at_ms)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('binds room, challenger and target', () => {
    const { ticket } = issueMatchTicket(key, b, t0);
    for (const other of [
      { ...b, room_id: randomUUID() },
      { ...b, scanner_user_id: randomUUID() },
      { ...b, candidate_user_id: randomUUID() },
      { ...b, scanner_user_id: b.candidate_user_id, candidate_user_id: b.scanner_user_id },
    ]) {
      expect(verifyMatchTicketWithKey(key, ticket, other, t0)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });

  it('refuses a tampered payload or MAC, another key, and garbage', () => {
    const { ticket } = issueMatchTicket(key, b, t0);
    const [p, payload, sig] = ticket.split('.') as [string, string, string];
    // Re-signing nothing: extend the expiry inside the payload, keep the old MAC.
    const forged = Buffer.from(
      JSON.stringify({ r: b.room_id, a: b.scanner_user_id, b: b.candidate_user_id, e: t0 + 1e9 }),
    ).toString('base64url');
    const bad = [
      `${p}.${forged}.${sig}`,
      `${p}.${payload}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BA' : 'AA'}`,
      `mt2.${payload}.${sig}`,
      'mt_forged',
      `${p}.${payload}`,
    ];
    for (const t of bad) {
      expect(verifyMatchTicketWithKey(key, t, b, t0)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(verifyMatchTicketWithKey(new Uint8Array(32).fill(8), ticket, b, t0)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyMatchTicketWithKey(key, null, b, t0)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyMatchTicketWithKey(key, '', b, t0)).toEqual({ ok: false, reason: 'missing' });
  });

  it('a validly signed payload of the wrong shape is invalid', () => {
    const payload = Buffer.from(JSON.stringify({ r: 'x', a: 1 })).toString('base64url');
    const sig = createHmac('sha256', key).update(`mt1.${payload}`).digest('base64url');
    expect(verifyMatchTicketWithKey(key, `mt1.${payload}.${sig}`, b, t0)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('bets/match-ticket verifies with the Env face config key', () => {
    const env = testEnv();
    const { ticket } = issueMatchTicket(faceConfigOf(env).ticketKey, b, t0);
    expect(verifyMatchTicket(ticket, { ...b, now_ms: t0 }, env)).toEqual({ ok: true });
    expect(verifyMatchTicket(ticket, { ...b, now_ms: t0 + MATCH_TICKET_TTL_MS }, env)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyMatchTicket(undefined, { ...b, now_ms: t0 }, env)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });
});

describe('face-match: one in flight per user', () => {
  it('refuses a concurrent second call for the same key with 429, and frees the key after', async () => {
    const guard = oneInFlight();
    let release!: () => void;
    const slow = guard('u1', () => new Promise<string>((r) => (release = () => r('first'))));
    await expect(guard('u1', async () => 'second')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      headers: { 'Retry-After': '1' },
    });
    // Another user is not affected.
    expect(await guard('u2', async () => 'other')).toBe('other');
    release();
    expect(await slow).toBe('first');
    expect(await guard('u1', async () => 'again')).toBe('again');
    // A failure frees the key too.
    await expect(
      guard('u1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await guard('u1', async () => 'after')).toBe('after');
  });
});
