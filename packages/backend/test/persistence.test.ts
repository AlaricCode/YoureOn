import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_CHUNK_BODY_BYTES } from '@verdict/engine';
import { decryptAesGcm, encryptAesGcm } from '../src/crypto/aes.js';
import { ApiError, ERROR_CODES, ERROR_MESSAGES, ERROR_STATUS, errorBody } from '../src/errors.js';
import { BlobStore } from '../src/persistence/blobs.js';
import { FLUSH_DELAY_MS, JsonStore } from '../src/persistence/store.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { tempDir } from './helpers.js';

describe('error codes (§12.8)', () => {
  it('has exactly the normative table', () => {
    expect(ERROR_CODES).toHaveLength(27);
    expect(ERROR_MESSAGES.UNAUTHORIZED).toBe('Signed out');
    expect(ERROR_MESSAGES.SPEND_DISABLED).toBe('Spending disabled');
    expect(ERROR_MESSAGES.CALIBRATION_INCOMPLETE).toBe('Place regions');
    expect(ERROR_MESSAGES.INSUFFICIENT_FUNDS).toBe('Insufficient balance');
    expect(ERROR_STATUS.CALIBRATION_LOCKED).toBe(409);
    expect(ERROR_STATUS.CHUNK_TOO_LARGE).toBe(413);
    for (const c of ERROR_CODES) expect(ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
  });

  it('serializes with the fixed message, never the detail', () => {
    const e = new ApiError('WRONG_STATE', 'bet 123 is live');
    expect(e.toBody()).toEqual({ error: { code: 'WRONG_STATE', message: 'Not available' } });
    expect(errorBody('TX_EXPIRED')).toEqual({ error: { code: 'TX_EXPIRED', message: 'Request expired' } });
  });
});

describe('JsonStore (§12.7)', () => {
  it('coalesces writes and flushes on a timer', async () => {
    const [dir, cleanup] = tempDir();
    try {
      const s = new JsonStore({ dataDir: dir });
      const c = s.collection<{ n: number }>('chunks');
      for (let i = 0; i < 500; i++) c.set(`k${i}`, { n: i });
      expect(existsSync(join(dir, 'db', 'chunks.json'))).toBe(false);
      await new Promise((r) => setTimeout(r, FLUSH_DELAY_MS + 50));
      expect(Object.keys(JSON.parse(readFileSync(join(dir, 'db', 'chunks.json'), 'utf8')))).toHaveLength(500);
      s.close();
    } finally {
      cleanup();
    }
  });

  it('persists collections atomically and reloads them', () => {
    const [dir, cleanup] = tempDir();
    try {
      const s1 = new JsonStore({ dataDir: dir });
      const users = s1.collection<{ id: string; n: number }>('users');
      users.set('a', { id: 'a', n: 1 });
      expect(users.insert('a', { id: 'a', n: 9 })).toBe(false);
      users.update('a', (u) => ({ ...u, n: 2 }));
      users.set('b', { id: 'b', n: 3 });
      users.delete('b');
      // Writes are coalesced (one file write per FLUSH_DELAY_MS, not per mutation); flush() forces them.
      expect(existsSync(join(dir, 'db', 'users.json'))).toBe(false);
      s1.flush();
      expect(existsSync(join(dir, 'db', 'users.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'db', 'users.json'), 'utf8'))).toEqual({ a: { id: 'a', n: 2 } });

      const s2 = new JsonStore({ dataDir: dir });
      expect(s2.collection<{ id: string; n: number }>('users').get('a')).toEqual({ id: 'a', n: 2 });
    } finally {
      cleanup();
    }
  });

  it('returns copies, rejects non-JSON values and unknown ids', () => {
    const s = new JsonStore({ dataDir: null });
    const c = s.collection<{ v: unknown }>('things');
    c.set('x', { v: [1] });
    const got = c.get('x')!;
    (got.v as number[]).push(2);
    expect(c.get('x')).toEqual({ v: [1] });
    expect(() => c.set('y', { v: 1n })).toThrow(/bigint/);
    expect(() => c.set('y', { v: new Uint8Array(1) })).toThrow(/bytes/);
    expect(() => c.require('missing')).toThrow(ApiError);
    expect(() => s.collection('Bad-Name')).toThrow();
    expect(c.filter(() => true)).toHaveLength(1);
  });
});

describe('BlobStore', () => {
  const bet = generateKeypair().publicKey;
  const wit = generateKeypair().publicKey;

  it('stores chunks at DATA_DIR/chunks/<bet>/<witness>/<index> and exhibits', () => {
    const [dir, cleanup] = tempDir();
    try {
      const b = new BlobStore(dir);
      const digest = b.putChunk(bet, wit, 0, new Uint8Array([1, 2, 3]));
      expect(digest).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
      expect(existsSync(join(dir, 'chunks', bet, wit, '0'))).toBe(true);
      expect(Array.from(b.getChunk(bet, wit, 0)!)).toEqual([1, 2, 3]);
      expect(b.getChunk(bet, wit, 1)).toBeNull();
      b.putExhibit(bet, 'E1', new Uint8Array([9]));
      expect(existsSync(join(dir, 'exhibits', bet, 'E1'))).toBe(true);
      b.deleteBetChunks(bet);
      expect(b.hasChunk(bet, wit, 0)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rejects path escapes and oversize chunks', () => {
    const b = new BlobStore(null);
    expect(() => b.putChunk('../../etc', wit, 0, new Uint8Array(1))).toThrow(ApiError);
    expect(() => b.putExhibit(bet, '../x', new Uint8Array(1))).toThrow(ApiError);
    expect(() => b.putBlob('crops', '..', new Uint8Array(1))).toThrow(ApiError);
    expect(() => b.putChunk(bet, wit, -1, new Uint8Array(1))).toThrow(ApiError);
    try {
      b.putChunk(bet, wit, 0, new Uint8Array(MAX_CHUNK_BODY_BYTES + 1));
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).code).toBe('CHUNK_TOO_LARGE');
      expect((e as ApiError).status).toBe(413);
    }
  });
});

describe('AES-256-GCM (BIOMETRIC_KEY)', () => {
  it('round-trips and detects tampering', () => {
    const key = new Uint8Array(32).fill(7);
    const ct = encryptAesGcm(key, new Uint8Array([1, 2, 3]), new Uint8Array([5]));
    expect(Array.from(decryptAesGcm(key, ct, new Uint8Array([5])))).toEqual([1, 2, 3]);
    ct[ct.length - 1]! ^= 1;
    expect(() => decryptAesGcm(key, ct, new Uint8Array([5]))).toThrow();
  });
});

describe('housekeeping (hot collection pruning)', () => {
  it('drops old processed events, settled/expired txs and expired challenges', async () => {
    const { makeApp } = await import('./appHelpers.js');
    const { pruneHotCollections, PROCESSED_RETENTION_MS, TX_RETENTION_MS } = await import('../src/persistence/housekeeping.js');
    const { PENDING_ENROLLMENT_TTL_MS } = await import('../src/identity/biometrics.js');
    const t = await makeApp();
    try {
      const now = t.clock.nowMs();
      const ev = t.ctx.store.collection<Record<string, unknown>>('chain_events');
      ev.set('old:0', { key: 'old:0', name: 'Funded', bet: null, slot: 1, at_ms: now - PROCESSED_RETENTION_MS - 1 });
      ev.set('new:0', { key: 'new:0', name: 'Funded', bet: null, slot: 2, at_ms: now });
      const txs = t.ctx.store.collection<Record<string, unknown>>('txs');
      const tx = (id: string, status: string, updated: number, expires: number) =>
        txs.set(id, { tx_id: id, user_id: 'u', signer: 's', kind: 'fund', message_b64: '', expires_at_ms: expires, summary: '', status, signature: null, error: null, meta: {}, created_at_ms: 0, updated_at_ms: updated });
      tx('t-old', 'confirmed', now - TX_RETENTION_MS - 1, 0);
      tx('t-new', 'confirmed', now, 0);
      tx('t-stale-pending', 'pending', 0, now - 2 * 86_400_000);
      tx('t-pending', 'pending', now, now + 60_000);
      const ch = t.ctx.store.collection<Record<string, unknown>>('challenges');
      ch.set('c-old', { id: 'c-old', expires_at_ms: now - 2 * 86_400_000 });
      ch.set('c-new', { id: 'c-new', expires_at_ms: now + 60_000 });
      const en = t.ctx.store.collection<Record<string, unknown>>('enrollments');
      en.set('u-old', { user_id: 'u-old', wallet: 'w', challenge_id: 'c', updated_at_ms: now - PENDING_ENROLLMENT_TTL_MS - 1 });
      en.set('u-new', { user_id: 'u-new', wallet: 'w', challenge_id: 'c', updated_at_ms: now });
      expect(pruneHotCollections(t.ctx, now)).toEqual({ events: 1, txs: 2, challenges: 1, enrollments: 1 });
      expect([...en.entries()].map(([k]) => k)).toEqual(['u-new']);
      expect([...ev.entries()].map(([k]) => k)).toEqual(['new:0']);
      expect([...txs.entries()].map(([k]) => k).sort()).toEqual(['t-new', 't-pending']);
      expect([...ch.entries()].map(([k]) => k)).toEqual(['c-new']);
    } finally {
      await t.app.close();
    }
  });
});
