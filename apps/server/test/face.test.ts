/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// Face enrollment and face match (TASKS D3-M3, D4-M1; API-CONTRACT §2.2, §2.4; DATA-MODEL §5.3,
// §7.2, §10). Pure parts run everywhere; the routes run against Postgres (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLog, faceEnrollments } from '@youre-on/db';
import { RoomPresenceResponse } from '@youre-on/shared/api';
import {
  decideFaceMatch,
  FACE_CONSENT_V1,
  FACE_CONSENT_V1_SHA256,
  FaceConsentResponse,
  FaceMatchResponse,
  float32ToLe,
  MeResponse,
} from '@youre-on/shared/face';
import { issueMatchTicket, verifyMatchTicket } from '../src/bets/match-ticket';
import { kekEnvName, keyringFrom, openAtRest, sealAtRest } from '../src/face/crypto';
import { openEmbedding } from '../src/face/probe';
import { HttpError } from '../src/errors';
import {
  describeDb,
  signedHeaders,
  signUp,
  startTestServer,
  testEnv,
  type Ctx,
  type SignedUp,
} from './helpers';

const MODEL = { name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 } as const;

/** A deterministic unit vector per seed; `mix` blends in another seed's direction. */
function unit(seed: number, mix?: { seed: number; amount: number }): Float32Array {
  const v = new Float32Array(512);
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < v.length; i++) v[i] = next();
  if (mix) {
    const o = unit(mix.seed);
    for (let i = 0; i < v.length; i++)
      v[i] = (v[i] as number) * (1 - mix.amount) + (o[i] as number) * mix.amount;
  }
  let n = 0;
  for (const y of v) n += y * y;
  n = Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / n;
  return v;
}

const plain = (v: Float32Array) => ({
  alg: 'plain-v0' as const,
  epk_b64: null,
  nonce_b64: null,
  ct_b64: Buffer.from(float32ToLe(v)).toString('base64'),
});

// ---- pure ------------------------------------------------------------------------------

describe('match rule (cos ≥ 0.30, margin ≥ 0.05, else abstain)', () => {
  const p = unit(1);
  it('accepts a clear top-1', () => {
    expect(
      decideFaceMatch(p, [
        { id: 'a', embedding: unit(1, { seed: 9, amount: 0.3 }) },
        { id: 'b', embedding: unit(2) },
      ]),
    ).toBe('a');
  });
  it('abstains below the threshold', () => {
    expect(decideFaceMatch(p, [{ id: 'a', embedding: unit(3) }])).toBeNull();
  });
  it('abstains when the runner-up is too close', () => {
    const a = unit(1, { seed: 7, amount: 0.2 });
    const b = unit(1, { seed: 8, amount: 0.2 });
    expect(
      decideFaceMatch(p, [
        { id: 'a', embedding: a },
        { id: 'b', embedding: b },
      ]),
    ).toBeNull();
  });
  it('abstains with no candidates; a lone strong candidate is accepted', () => {
    expect(decideFaceMatch(p, [])).toBeNull();
    expect(decideFaceMatch(p, [{ id: 'a', embedding: unit(1) }])).toBe('a');
  });
});

describe('match ticket (HMAC, 60 s, bound to scanner + candidate + room)', () => {
  const b = { scanner_user_id: 'u1', candidate_user_id: 'u2', room_id: 'r1', now_ms: 1_000_000 };
  const { ticket } = issueMatchTicket(b);
  it('verifies for its own binding', () => {
    expect(verifyMatchTicket(ticket, { ...b, now_ms: b.now_ms + 59_000 })).toEqual({ ok: true });
  });
  it('expires after 60 s', () => {
    expect(verifyMatchTicket(ticket, { ...b, now_ms: b.now_ms + 60_000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
  it('refuses another scanner, candidate or room', () => {
    for (const k of ['scanner_user_id', 'candidate_user_id', 'room_id'] as const) {
      expect(verifyMatchTicket(ticket, { ...b, [k]: 'x' })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });
  it('refuses a forged or edited ticket, and a missing one', () => {
    const [p0, payload, mac] = ticket.split('.') as [string, string, string];
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString());
    edited.exp += 3_600_000;
    const forged = `${p0}.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${mac}`;
    expect(verifyMatchTicket(forged, b)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyMatchTicket('mt_forged', b)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyMatchTicket(null, b)).toEqual({ ok: false, reason: 'missing' });
  });
  it('holds no face data', () => {
    const payload = JSON.parse(Buffer.from(ticket.split('.')[1]!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['c', 'exp', 'n', 'r', 's']);
  });
});

describe('encryption at rest (AES-256-GCM, AAD binds user and model)', () => {
  const env = testEnv();
  const ring = keyringFrom(env);
  const v = unit(5);
  const row = sealAtRest(ring, 'user-1', MODEL, v);
  it('round-trips, and the ciphertext is not the vector', () => {
    expect(Buffer.from(row.embedding_ciphertext).length).toBe(512 * 4 + 16);
    expect(Buffer.from(row.embedding_nonce).length).toBe(12);
    expect(Buffer.from(row.embedding_ciphertext).subarray(0, 64)).not.toEqual(
      Buffer.from(float32ToLe(v)).subarray(0, 64),
    );
    expect(Array.from(openAtRest(ring, 'user-1', MODEL, row)!)).toEqual(Array.from(v));
  });
  it('fails to open under another user (a row swap)', () => {
    expect(openAtRest(ring, 'user-2', MODEL, row)).toBeNull();
  });
  it('uses a configured KEK and refuses to run without one in production', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const r = keyringFrom(
      testEnv({ FACE_KEK_ACTIVE: 'face-kek-2026-11-a', FACE_KEK_2026_11_A: key }),
    );
    expect(r.active.id).toBe('face-kek-2026-11-a');
    expect(kekEnvName('face-kek-2026-11-a')).toBe('FACE_KEK_2026_11_A');
    const prod = { ...testEnv(), NODE_ENV: 'production' as const, FACE_KEK_ACTIVE: undefined };
    expect(() => keyringFrom(prod)).toThrow(HttpError);
  });
});

describe('opening a phone embedding', () => {
  const env = testEnv();
  it('accepts plain-v0 unit vectors', () => {
    expect(openEmbedding(env, plain(unit(4)), MODEL)).toHaveLength(512);
  });
  it('refuses sealed, wrong-size, non-unit and (when required) plain embeddings', () => {
    const bad = [
      () =>
        openEmbedding(
          env,
          { ...plain(unit(4)), alg: 'x25519-hkdf-sha256-chacha20poly1305-v1' },
          MODEL,
        ),
      () =>
        openEmbedding(
          env,
          { ...plain(unit(4)), ct_b64: Buffer.alloc(100).toString('base64') },
          MODEL,
        ),
      () => openEmbedding(env, plain(new Float32Array(512).fill(1)), MODEL),
      () => openEmbedding({ FACE_SEAL_REQUIRED: true }, plain(unit(4)), MODEL),
    ];
    for (const f of bad) expect(f).toThrow(expect.objectContaining({ code: 'FACE_SEAL_INVALID' }));
  });
});

// ---- routes over Postgres --------------------------------------------------------------

describeDb('face routes over Postgres', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startTestServer();
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  const send = async (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const res = await fetch(ctx.base + path, {
      method,
      headers: signedHeaders(u, method, path, raw),
      ...(method === 'GET' ? {} : { body: raw }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const get = async (u: SignedUp, path: string) => {
    const res = await fetch(ctx.base + path, {
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const uid = (u: SignedUp) => u.session.user.user_id;

  const enrollBody = (v: Float32Array, over: Record<string, unknown> = {}) => ({
    consent: {
      consent_version: FACE_CONSENT_V1.consent_version,
      consent_text_sha256: FACE_CONSENT_V1_SHA256,
      consent_at: new Date(Date.now() - 5_000).toISOString(),
    },
    liveness: { method: 'head_turn', passed_at: new Date().toISOString() },
    model: MODEL,
    embedding: plain(v),
    shots: 3,
    ...over,
  });
  const probeBody = (v: Float32Array) => ({
    probe: plain(v),
    model: MODEL,
    capture: { captured_at: new Date().toISOString(), eye_distance_px: 120, yaw_deg: 2 },
  });

  async function room(owner: SignedUp, ...members: SignedUp[]) {
    const r = await send(owner, 'POST', '/v1/rooms', { name: 'Face room', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members)
      expect((await send(m, 'POST', '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    return r.json!.room_id as string;
  }

  it('GET /v1/face/consent serves the v1 text, its hash and the accepted model', async () => {
    const A = await signUp(ctx.base, 'Logan');
    const r = await get(A, '/v1/face/consent');
    expect(r.status).toBe(200);
    const body = FaceConsentResponse.parse(r.json);
    expect(body.consent_version).toBe('face-consent-v1');
    expect(body.text_sha256).toBe(FACE_CONSENT_V1_SHA256);
    expect(body.face_seal_pubkey).toBeNull();
    expect(body.accepted_models).toEqual([MODEL]);
  });

  it('enroll → GET /v1/me active → disable → enable → delete (twice); audit rows carry no biometrics', async () => {
    const A = await signUp(ctx.base, 'Logan');
    expect(MeResponse.parse((await get(A, '/v1/me')).json).face.status).toBe('none');

    const r = await send(A, 'POST', '/v1/face/enrollment', enrollBody(unit(11)));
    expect(r.status).toBe(201);
    expect(r.json!.status).toBe('active');
    const [row] = await ctx.deps.db
      .select()
      .from(faceEnrollments)
      .where(eq(faceEnrollments.user_id, uid(A)));
    expect(row!.embedding_dim).toBe(512);
    expect(Buffer.from(row!.embedding_ciphertext).length).toBe(512 * 4 + 16);
    expect(MeResponse.parse((await get(A, '/v1/me')).json).face).toEqual({
      status: 'active',
      consent_version: 'face-consent-v1',
    });

    // Re-enrolling replaces the row.
    expect((await send(A, 'POST', '/v1/face/enrollment', enrollBody(unit(12)))).status).toBe(201);
    const rows = await ctx.deps.db
      .select({ id: faceEnrollments.id })
      .from(faceEnrollments)
      .where(eq(faceEnrollments.user_id, uid(A)));
    expect(rows).toHaveLength(1);

    expect((await send(A, 'PATCH', '/v1/face/enrollment', { status: 'disabled' })).status).toBe(
      200,
    );
    expect(MeResponse.parse((await get(A, '/v1/me')).json).face.status).toBe('disabled');
    expect((await send(A, 'PATCH', '/v1/face/enrollment', { status: 'active' })).status).toBe(200);
    expect((await send(A, 'DELETE', '/v1/face/enrollment')).status).toBe(204);
    expect((await send(A, 'DELETE', '/v1/face/enrollment')).status).toBe(204);
    expect(MeResponse.parse((await get(A, '/v1/me')).json).face.status).toBe('none');
    expect(
      (await send(A, 'PATCH', '/v1/face/enrollment', { status: 'active' })).json!.error.code,
    ).toBe('FACE_NOT_ENROLLED');

    const audit = (
      await ctx.deps.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.subject_user_id, uid(A)))
        .orderBy(auditLog.id)
    ).filter((a) => a.action.startsWith('face.'));
    expect(audit.map((a) => a.action)).toEqual([
      'face.consented',
      'face.enrolled',
      'face.consented',
      'face.enrolled',
      'face.disabled',
      'face.enabled',
      'face.deleted',
    ]);
    const text = JSON.stringify(audit.map((a) => a.details));
    expect(text).not.toMatch(/embedding|ciphertext|nonce|probe/);
  });

  it('refuses enrollment without the current consent, an unknown model, or a bad vector', async () => {
    const A = await signUp(ctx.base, 'Logan');
    const cases: [Record<string, unknown>, string][] = [
      [
        { consent: { ...enrollBody(unit(1)).consent, consent_text_sha256: 'a'.repeat(64) } },
        'FACE_CONSENT_REQUIRED',
      ],
      [
        { consent: { ...enrollBody(unit(1)).consent, consent_version: 'face-consent-v0' } },
        'FACE_CONSENT_REQUIRED',
      ],
      [
        {
          consent: {
            ...enrollBody(unit(1)).consent,
            consent_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
        'FACE_CONSENT_REQUIRED',
      ],
      [{ model: { name: 'sface', version: '2021dec', dim: 128 } }, 'FACE_MODEL_UNSUPPORTED'],
      [{ embedding: plain(new Float32Array(512).fill(0.5)) }, 'FACE_SEAL_INVALID'],
    ];
    for (const [over, code] of cases) {
      const r = await send(A, 'POST', '/v1/face/enrollment', enrollBody(unit(1), over));
      expect(r.json!.error.code, code).toBe(code);
    }
    const n = await ctx.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(faceEnrollments)
      .where(eq(faceEnrollments.user_id, uid(A)));
    expect(n[0]!.n).toBe(0);
  });

  it('face-match: finds the enrolled member, issues a ticket the face challenge accepts, and abstains otherwise', async () => {
    const [A, B, C, D] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Sam'),
      signUp(ctx.base, 'Priya'),
    ]);
    const roomId = await room(A, B, C);
    const jake = unit(101);
    const sam = unit(202);
    expect((await send(B, 'POST', '/v1/face/enrollment', enrollBody(jake))).status).toBe(201);
    expect((await send(C, 'POST', '/v1/face/enrollment', enrollBody(sam))).status).toBe(201);
    // D is enrolled but not in the room: never a candidate.
    expect(
      (
        await send(
          D,
          'POST',
          '/v1/face/enrollment',
          enrollBody(unit(101, { seed: 5, amount: 0.05 })),
        )
      ).status,
    ).toBe(201);

    const presence = RoomPresenceResponse.parse(
      (await get(A, `/v1/rooms/${roomId}/presence`)).json,
    );
    expect(presence.members.find((m) => m.user.user_id === uid(B))!.face_enrolled).toBe(true);
    expect(presence.members.find((m) => m.user.user_id === uid(A))!.face_enrolled).toBe(false);

    const auditBefore = await ctx.deps.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    const path = `/v1/rooms/${roomId}/face-match`;
    const hit = await send(A, 'POST', path, probeBody(unit(101, { seed: 77, amount: 0.25 })));
    expect(hit.status).toBe(200);
    const m = FaceMatchResponse.parse(hit.json).match!;
    expect(m.user.user_id).toBe(uid(B));
    expect(m.user.display_name).toBe('Jake');
    expect(m.head_to_head).toMatchObject({ wins: 0, losses: 0, pushes: 0, net: '0' });
    expect(JSON.stringify(hit.json)).not.toMatch(/score|cos|similar/i);
    // A match writes nothing but the day-truncated last_used_at.
    const auditAfter = await ctx.deps.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    expect(auditAfter[0]!.n).toBe(auditBefore[0]!.n);
    const [jakeRow] = await ctx.deps.db
      .select()
      .from(faceEnrollments)
      .where(eq(faceEnrollments.user_id, uid(B)));
    expect(jakeRow!.last_used_at!.toISOString()).toMatch(/T00:00:00\.000Z$/);

    // The ticket addresses exactly this challenge.
    const bet = await send(A, 'POST', '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(B),
      challenge_method: 'face',
      match_ticket: m.match_ticket,
    });
    expect(bet.status).toBe(201);
    const wrong = await send(A, 'POST', '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(C),
      challenge_method: 'face',
      match_ticket: m.match_ticket,
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json!.error.details.reason).toBe('match_ticket_invalid');

    // A stranger's face: nothing.
    const none = await send(A, 'POST', path, probeBody(unit(999)));
    expect(FaceMatchResponse.parse(none.json).match).toBeNull();

    // Disabled members drop out at once.
    expect((await send(B, 'PATCH', '/v1/face/enrollment', { status: 'disabled' })).status).toBe(
      200,
    );
    const off = await send(A, 'POST', path, probeBody(unit(101, { seed: 77, amount: 0.25 })));
    expect(FaceMatchResponse.parse(off.json).match).toBeNull();

    // Only members may scan.
    const outsider = await send(D, 'POST', path, probeBody(jake));
    expect(outsider.json!.error.code).toBe('NOT_IN_ROOM');
  });

  it('face-match abstains when two members look alike', async () => {
    const [A, B, C] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Twin'),
      signUp(ctx.base, 'Twin Two'),
    ]);
    const roomId = await room(A, B, C);
    expect(
      (
        await send(
          B,
          'POST',
          '/v1/face/enrollment',
          enrollBody(unit(300, { seed: 1, amount: 0.1 })),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await send(
          C,
          'POST',
          '/v1/face/enrollment',
          enrollBody(unit(300, { seed: 2, amount: 0.1 })),
        )
      ).status,
    ).toBe(201);
    const r = await send(A, 'POST', `/v1/rooms/${roomId}/face-match`, probeBody(unit(300)));
    expect(FaceMatchResponse.parse(r.json).match).toBeNull();
  });

  it('a face challenge with a ticket from another room is refused', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const roomId = await room(A, B);
    const { ticket } = issueMatchTicket({
      scanner_user_id: uid(A),
      candidate_user_id: uid(B),
      room_id: randomUUID(),
      now_ms: Date.now(),
    });
    const r = await send(A, 'POST', '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(B),
      challenge_method: 'face',
      match_ticket: ticket,
    });
    expect(r.json!.error.details.reason).toBe('match_ticket_invalid');
  });
});
