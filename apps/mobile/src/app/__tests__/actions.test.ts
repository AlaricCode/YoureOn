import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { hashJcs } from '@youre-on/shared/jcs';
import { renderSignCard } from '@youre-on/shared/sign-card';
import { describe, expect, it } from 'vitest';

import { applyBetEvent, fromSnapshot } from '../../bets/store';
import { authorizeLock, checkLockPolicy, concede, sendAttempt, verifiedRuling } from '../actions';
import { authorizeRequest, BET, ev, ruling, snapshot, envelope } from './fixtures';

const signed = (party: 'A' | 'B', kind = 'atomic_lock') => ({
  signature: new Uint8Array(64),
  signatureBase58: '5'.repeat(88),
  publicKey: 'x',
  method: 'faceid_hold' as const,
  authorizedAt: '2026-11-21T18:06:40.000Z',
  authSucceededAtMs: 1000,
  messageSha256: 'ab'.repeat(32),
  prompts: 1 as const,
  policy: {
    ok: true as const,
    kind: kind as never,
    party,
    bet_id: BET,
    terms_hash: envelope().terms_hash,
    message_sha256: 'ab'.repeat(32),
  },
});

describe('lock authorization', () => {
  it('posts the PartyAuthorization the wallet produced, with a pinned Idempotency-Key', async () => {
    const seen: unknown[] = [];
    const req = authorizeRequest();
    const r = await authorizeLock(
      {
        wallet: {
          async authorizeTransaction(request, prompt) {
            seen.push({ request, prompt });
            return signed('B');
          },
        },
        api: {
          async authorizeLock(a, key) {
            seen.push({ a, key });
            return { status: 'recorded', waiting_for: 'A' };
          },
        },
        now: () => 1450,
      },
      req,
      'Lock in $5',
      'k-1',
    );
    expect(seen[0]).toMatchObject({
      request: { screen: 'terms_card', lockMode: 'atomic', request: req },
      prompt: 'Lock in $5',
    });
    expect(r.auth).toEqual({
      bet_id: BET,
      lock_request_id: req.lock_request_id,
      party: 'B',
      terms_hash: envelope().terms_hash,
      method: 'faceid_hold',
      authorized_at: '2026-11-21T18:06:40.000Z',
      ms_since_auth_success: 450,
      message_sha256: 'ab'.repeat(32),
      party_signature: '5'.repeat(88),
    });
    expect((seen[1] as { key: string }).key).toBe('k-1');
  });

  it('the card-mount policy refuses a request that is not a real lock message', () => {
    const v = checkLockPolicy(
      authorizeRequest(),
      'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4',
      Date.now(),
    );
    expect(v.ok).toBe(false);
  });
});

describe('GG (concede)', () => {
  const ruled = () => {
    let m = fromSnapshot(
      snapshot({
        state: 'JUDGING',
        my_party: 'B',
        envelope: envelope(),
        last_seq: 10,
        deadlines: {
          accept_deadline: null,
          resolve_deadline: null,
          appeal_deadline: 1_795_000_100,
          appeal_resolve_deadline: null,
        },
      }),
    );
    const r = ruling('A_WINS');
    m = applyBetEvent(m, ev('ruling.issued', { ruling: r, ruling_hash: hashJcs(r) }, 11));
    return m;
  };

  it('signs with the phone-rendered card and the verified ruling, then posts PartySignature', async () => {
    const m = ruled();
    const calls: unknown[] = [];
    const out = await concede(
      {
        wallet: {
          async authorizeTransaction(request, prompt) {
            calls.push({ request, prompt });
            return signed('B', 'concede');
          },
        },
        api: {
          async getConcede() {
            return { kind: 'concede' } as never;
          },
          async concede(s, key) {
            calls.push({ s, key });
            return { status: 'submitted', signature: '6'.repeat(88) } as never;
          },
        },
      },
      m,
      'Pay Logan',
      'k-2',
    );
    expect(out.signature).toBe('6'.repeat(88));
    const req = (calls[0] as { request: Record<string, unknown> }).request;
    expect(req.screen).toBe('gg');
    expect(req.verifiedRulingOutcome).toBe('A_WINS');
    expect(req.verifiedRulingHash).toBe(m.ruling!.ruling_hash);
    expect(req.renderedCard).toEqual(
      renderSignCard({
        kind: 'concede',
        terms: envelope().terms,
        terms_hash: envelope().terms_hash,
        me: 'B',
        appeal_deadline: 1_795_000_100,
      }),
    );
    expect((calls[1] as { s: unknown }).s).toMatchObject({
      bet_id: BET,
      kind: 'concede',
      party: 'B',
      method: 'faceid_hold',
    });
  });

  it('refuses when the ruling hash does not verify', async () => {
    const m = ruled();
    const forged = { ...m, ruling: { ...m.ruling!, ruling_hash: '00'.repeat(32) } };
    expect(verifiedRuling(forged)).toBeNull();
    await expect(
      concede(
        {
          wallet: { authorizeTransaction: async () => signed('B') },
          api: { getConcede: async () => ({}) as never, concede: async () => ({}) as never },
        },
        forged,
        'x',
        'k',
      ),
    ).rejects.toMatchObject({ code: 'NOT_READY' });
  });
});

describe('attempt upload', () => {
  it('extracts frames, hashes, builds CameraEvidence and uploads with a pinned key', async () => {
    let uploaded: { e: unknown; frames: readonly Uint8Array[]; key: string } | null = null;
    const { evidence } = await sendAttempt(
      {
        api: {
          async uploadFrames(e, frames, key) {
            uploaded = { e, frames, key };
            return { judging: true, frame_hashes: [] };
          },
        },
        readClip: async () => new Uint8Array(4096).fill(1),
        extractFrames: async (_u, ms) =>
          Array.from({ length: 8 }, (_, i) => ({
            t_ms: (ms / 8) * i,
            jpeg: new Uint8Array(500).fill(i),
          })),
        iso: (ms) => new Date(ms).toISOString(),
      },
      {
        bet_id: BET,
        attempt_no: 1,
        recorded_by: 'A',
        clip: { uri: 'file:///c.mov', durationMs: 5200, endedAtMs: Date.UTC(2026, 10, 21, 18, 7) },
        idempotencyKey: 'k-3',
      },
    );
    expect(evidence.mime).toBe('video/quicktime');
    expect(evidence.frames).toHaveLength(8);
    expect(uploaded!.frames).toHaveLength(8);
    expect(uploaded!.key).toBe('k-3');
  });
});

describe('app code rules', () => {
  const src = join(import.meta.dirname, '..', '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return f === '__tests__' ? [] : files(p);
      return /\.tsx?$/.test(f) ? [p] : [];
    });

  it('no simulated Face ID outside src/preview (and its definition)', () => {
    const offenders = files(src).filter(
      (p) =>
        !p.includes('/preview/') &&
        !p.endsWith('device/authorize.ts') &&
        readFileSync(p, 'utf8').includes('simulateIfUnavailable'),
    );
    expect(offenders).toEqual([]);
  });
});
