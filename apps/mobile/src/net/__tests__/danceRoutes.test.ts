// The Dance Off and double-or-nothing wrappers on the typed API (DANCE-OFF §1, §5, §7):
// POST …/terms/dance, the signed multipart POST …/attempts/:n/dance, and POST …/rematch.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod/v4';

import { getRoutine, routineSha256 } from '@youre-on/shared/dance/routine';
import { poseSha256, type PoseSeries } from '@youre-on/shared/dance/pose';
import type { DanceUpload } from '@youre-on/shared/evidence';

import { createYoApi } from '../api';
import type { ApiClient, RequestOptions } from '../signedFetch';

type Call = { method: string; path: string; opts: RequestOptions<z.ZodType | undefined> };

function fakeClient(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const client = {
    clock: { now: () => 0, sync() {}, offsetMs: 0 },
    async request(method: string, path: string, opts: RequestOptions<z.ZodType | undefined> = {}) {
      calls.push({ method, path, opts });
      const body = responses[`${method} ${path}`];
      return opts.schema ? opts.schema.parse(body) : body;
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const NEW_BET = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const HASH = 'ab'.repeat(32);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Dance Off routes on the typed API', () => {
  it('proposeDanceTerms posts the routine and the amount', async () => {
    const f = fakeClient({
      [`POST /v1/bets/${BET}/terms/dance`]: {
        ok: true,
        kind: 'proposed',
        state: 'TERMS_PROPOSED',
        terms_hash: HASH,
        code: 'abab·abab',
        say: 'Dance off.',
      },
    });
    const r = await createYoApi(f.client).proposeDanceTerms(BET, {
      routine_id: 'wave-pop',
      amount_usd: '5',
    });
    expect(r.kind).toBe('proposed');
    expect(f.calls[0]?.opts.json).toEqual({ routine_id: 'wave-pop', amount_usd: '5' });
  });

  it('uploadDance sends `upload` then the frames, under a boundary pinned by the key', async () => {
    const routine = getRoutine('wave-pop')!;
    const series: PoseSeries = {
      schema_version: 1,
      w: 720,
      h: 1280,
      fps_cap: 30,
      sync_offset_ms: 0,
      frames: [{ t: 0, n: 2, a: null, b: null }],
    };
    const upload: DanceUpload = {
      routine_id: routine.id,
      routine_sha256: routineSha256(routine),
      series,
      pose_sha256: poseSha256(series),
      client_scores: { a: 800, b: 700 },
      clip_sha256: null,
      frames: [0, 1].map((index) => ({
        index,
        t_ms: index * 1000,
        sha256: HASH,
        width: 288,
        height: 512,
        bytes: 3,
      })),
    };
    const path = `/v1/bets/${BET}/attempts/1/dance`;
    const f = fakeClient({
      [`POST ${path}`]: {
        judging: true,
        evidence_hash: HASH,
        pose_sha256: upload.pose_sha256,
        scores: { a: 800, b: 700 },
        client_mismatch: false,
        frame_hashes: [HASH, HASH],
      },
    });
    const api = createYoApi(f.client);
    const frames = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const r = await api.uploadDance(BET, 1, upload, frames, 'Key-1');
    expect(r.scores).toEqual({ a: 800, b: 700 });
    const call = f.calls[0]!;
    expect([call.method, call.path, call.opts.idempotencyKey]).toEqual(['POST', path, 'Key-1']);
    expect(call.opts.raw?.contentType).toBe('multipart/form-data; boundary=yo-key1');
    const body = text(call.opts.raw!.bytes);
    const upAt = body.indexOf('name="upload"');
    const f0 = body.indexOf('name="frame"; filename="00.jpg"');
    const f1 = body.indexOf('name="frame"; filename="01.jpg"');
    expect(upAt).toBeGreaterThan(-1);
    expect(upAt < f0 && f0 < f1).toBe(true);
    expect(body).toContain(JSON.stringify(upload));
    // The same build under the same key is the same bytes (a resend).
    await api.uploadDance(BET, 1, upload, frames, 'Key-1');
    expect(f.calls[1]!.opts.raw!.bytes).toEqual(call.opts.raw!.bytes);
  });

  it('rematch posts under the pinned key and reads the new bet id', async () => {
    const f = fakeClient({
      [`POST /v1/bets/${BET}/rematch`]: { bet_id: NEW_BET, suggested_stake_usd: 10 },
    });
    const r = await createYoApi(f.client).rematch(BET, 'k1');
    expect(r).toEqual({ bet_id: NEW_BET, suggested_stake_usd: 10 });
    expect(f.calls[0]?.opts).toMatchObject({ json: {}, idempotencyKey: 'k1' });
  });
});
