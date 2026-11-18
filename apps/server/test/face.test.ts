/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// Face addressing over HTTP + Postgres (Beat 1; API-CONTRACT §2.2, §2.4, §2.5; DATA-MODEL §5.3,
// §7.2, §10): consent, enrollment validation and storage, disable / delete, the room-scoped
// top-2 match with synthetic vectors (thresholds, margin, cross-room isolation, self-exclusion,
// opt-out), non-member 403, POST /v1/bets with a face ticket (bound, expiring, tamper-proof),
// head-to-head, the retention sweep and the rate limits. Skips without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, like } from 'drizzle-orm';
import { auditLog, bets, createDb, faceEnrollments, roomMembers, rooms } from '@youre-on/db';
import {
  embeddingToBytes,
  FACE_CONSENT_V1_SHA256,
  FACE_CONSENT_V1_TEXT,
  FACE_MODEL_W600K,
  FaceConsentResponse,
  FaceEnrollmentStatusResponse,
  FaceMatchResponse,
  MATCH_TICKET_TTL_MS,
} from '@youre-on/shared/face';
import { buildApp } from '../src/app';
import { createDeps, startServer } from '../src/server';
import { routeModules } from '../src/routes';
import { purgeExpiredEnrollments } from '../src/face/service';
import {
  describeDb,
  signedHeaders,
  connectWs,
  signUp,
  startTestServer,
  testEnv,
  type Ctx,
  type SignedUp,
} from './helpers';

const DIM = 512;
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** e_i, the i-th standard basis vector: synthetic "faces" whose cosines we control exactly. */
const basis = (i: number) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};
/** A unit vector with cosine `c[i]` against basis(i) for each listed i, the rest on axis 500. */
function probeWith(c: Record<number, number>): Float32Array {
  const v = new Float32Array(DIM);
  let used = 0;
  for (const [i, x] of Object.entries(c)) {
    v[Number(i)] = x;
    used += x * x;
  }
  v[500] = Math.sqrt(1 - used);
  return v;
}
/** A dense unit vector (every value non-zero), so its base64 is distinctive in a log grep. */
function dense(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  let x = seed;
  for (let i = 0; i < DIM; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = x / 2147483648 - 0.5 || 0.1;
  }
  const n = Math.hypot(...v);
  return v.map((y) => y / n);
}
const sealed = (v: Float32Array) => ({
  alg: 'plain-v0' as const,
  epk_b64: null,
  nonce_b64: null,
  ct_b64: Buffer.from(embeddingToBytes(v)).toString('base64'),
});

describeDb('face addressing API over Postgres', () => {
  let ctx: Ctx;
  let clock = Date.now();

  beforeAll(async () => {
    ctx = await startTestServer({ now: () => clock });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  const uid = (u: SignedUp) => u.session.user.user_id;
  const call = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(ctx.base + path, {
      method,
      headers: signedHeaders(u, method, path, raw, { ts: clock }),
      ...(method === 'GET' ? {} : { body: raw }),
    }).then(async (res) => {
      const text = await res.text();
      return {
        status: res.status,
        text,
        json: text ? (JSON.parse(text) as Record<string, any>) : null,
      };
    });
  };
  const get = (u: SignedUp, path: string) =>
    fetch(ctx.base + path, { headers: { Authorization: `Bearer ${u.session.token}` } }).then(
      async (res) => ({ status: res.status, json: (await res.json()) as Record<string, any> }),
    );

  const enrollBody = (v: Float32Array, over: Record<string, unknown> = {}) => ({
    consent: {
      consent_version: 'face-consent-v1',
      consent_text_sha256: FACE_CONSENT_V1_SHA256,
      consent_at: new Date(clock - 30_000).toISOString(),
    },
    liveness: { method: 'head_turn', passed_at: new Date(clock - 5_000).toISOString() },
    model: FACE_MODEL_W600K,
    embedding: sealed(v),
    shots: 3,
    ...over,
  });
  const enroll = (u: SignedUp, v: Float32Array, over: Record<string, unknown> = {}) =>
    call(u, 'POST', '/v1/face/enrollment', enrollBody(v, over));
  const match = (
    u: SignedUp,
    roomId: string,
    v: Float32Array,
    over: Record<string, unknown> = {},
  ) =>
    call(u, 'POST', `/v1/rooms/${roomId}/face-match`, {
      probe: sealed(v),
      model: FACE_MODEL_W600K,
      capture: { captured_at: new Date(clock).toISOString(), eye_distance_px: 90, yaw_deg: 2 },
      ...over,
    });

  async function newRoom(owner: SignedUp, ...members: SignedUp[]) {
    const r = await call(owner, 'POST', '/v1/rooms', { name: 'Face room', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members) {
      expect((await call(m, 'POST', '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    }
    return r.json as { room_id: string; code: string };
  }

  const rowOf = async (u: SignedUp) =>
    (
      await ctx.deps.db
        .select()
        .from(faceEnrollments)
        .where(eq(faceEnrollments.user_id, uid(u)))
    )[0];
  const auditsOf = async (u: SignedUp) =>
    ctx.deps.db
      .select({ action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.subject_user_id, uid(u)), like(auditLog.action, 'face.%')))
      .orderBy(asc(auditLog.id));

  // ---- consent ------------------------------------------------------------------------

  it('GET /v1/face/consent serves the exact text, its hash and the accepted models', async () => {
    const a = await signUp(ctx.base, 'Ana');
    const r = await get(a, '/v1/face/consent');
    expect(r.status).toBe(200);
    const body = FaceConsentResponse.parse(r.json);
    expect(body.text).toBe(FACE_CONSENT_V1_TEXT);
    expect(body.text_sha256).toBe(FACE_CONSENT_V1_SHA256);
    expect(body.consent_version).toBe('face-consent-v1');
    expect(body.accepted_models).toContainEqual(FACE_MODEL_W600K);
    expect(body.face_seal_pubkey).toBeNull();
    const anon = await fetch(`${ctx.base}/v1/face/consent`);
    expect(anon.status).toBe(401);
  });

  // ---- enrollment ---------------------------------------------------------------------

  it('enrolls opt-in only: encrypted at rest, audited consent-then-enroll, status readable', async () => {
    const a = await signUp(ctx.base, 'Bea');
    expect((await get(a, '/v1/face/enrollment')).json).toEqual({
      status: 'none',
      consent_version: null,
      model: null,
      enrolled_at: null,
      disabled_at: null,
    });
    const v = basis(1);
    const r = await enroll(a, v);
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ status: 'active', enrolled_at: new Date(clock).toISOString() });

    const st = FaceEnrollmentStatusResponse.parse((await get(a, '/v1/face/enrollment')).json);
    expect(st).toMatchObject({ status: 'active', consent_version: 'face-consent-v1' });
    expect(st.model).toEqual(FACE_MODEL_W600K);

    const row = (await rowOf(a))!;
    expect(row.embedding_ciphertext.length).toBe(DIM * 4 + 16);
    expect(row.embedding_nonce.length).toBe(12);
    expect(row.key_id).toBe('face-kek-dev');
    expect(row.liveness_method).toBe('head_turn');
    expect(row.consent_text_sha256).toBe(FACE_CONSENT_V1_SHA256);
    // Not the plaintext: the float32 1.0 at index 1 (00 00 80 3f) is nowhere in the row.
    const plain = Buffer.from(embeddingToBytes(v));
    expect(Buffer.from(row.embedding_ciphertext).includes(plain.subarray(0, 12))).toBe(false);

    const audits = await auditsOf(a);
    expect(audits.map((x) => x.action)).toEqual(['face.consented', 'face.enrolled']);
    expect(audits[1]!.details).toMatchObject({ model_name: 'w600k_mbf', replaced: false });
    expect(JSON.stringify(audits)).not.toMatch(/ct_b64|embedding_c|nonce"/);
  });

  it('rejects bad consent, a capture before consent, unsupported models and bad vectors; stores nothing', async () => {
    const a = await signUp(ctx.base, 'Cal');
    const v = basis(2);
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [
        {
          consent: {
            consent_version: 'face-consent-v0',
            consent_text_sha256: FACE_CONSENT_V1_SHA256,
            consent_at: new Date(clock).toISOString(),
          },
        },
        412,
        'FACE_CONSENT_REQUIRED',
      ],
      [
        {
          consent: {
            consent_version: 'face-consent-v1',
            consent_text_sha256: 'b'.repeat(64),
            consent_at: new Date(clock).toISOString(),
          },
        },
        412,
        'FACE_CONSENT_REQUIRED',
      ],
      [
        {
          consent: {
            consent_version: 'face-consent-v1',
            consent_text_sha256: FACE_CONSENT_V1_SHA256,
            consent_at: new Date(clock + 120_000).toISOString(),
          },
          liveness: { method: 'head_turn', passed_at: new Date(clock + 120_000).toISOString() },
        },
        412,
        'FACE_CONSENT_REQUIRED',
      ],
      [
        { liveness: { method: 'head_turn', passed_at: new Date(clock - 60_000).toISOString() } },
        412,
        'FACE_CONSENT_REQUIRED',
      ],
      [{ model: { ...FACE_MODEL_W600K, dim: 128 } }, 422, 'FACE_MODEL_UNSUPPORTED'],
      [{ model: { name: 'arcface_r100', version: 'x', dim: 512 } }, 422, 'FACE_MODEL_UNSUPPORTED'],
      [{ embedding: sealed(basis(2).subarray(0, 256)) }, 400, 'FACE_SEAL_INVALID'],
      [{ embedding: { ...sealed(v), ct_b64: '!!!' } }, 400, 'FACE_SEAL_INVALID'],
      [
        {
          embedding: {
            alg: 'x25519-hkdf-sha256-chacha20poly1305-v1',
            epk_b64: 'AA==',
            nonce_b64: 'AA==',
            ct_b64: 'AA==',
          },
        },
        400,
        'FACE_SEAL_INVALID',
      ],
      [{ embedding: sealed(probeWith({ 2: 0.5 }).map((x) => x * 2)) }, 422, 'VALIDATION_FAILED'],
      [
        { embedding: sealed(Float32Array.from(v, (x, i) => (i === 7 ? NaN : x))) },
        422,
        'VALIDATION_FAILED',
      ],
      [{ shots: 0 }, 422, 'VALIDATION_FAILED'],
    ];
    for (const [over, status, code] of cases) {
      const r = await enroll(a, v, over);
      expect({ status: r.status, code: r.json?.error?.code }).toEqual({ status, code });
      // Error bodies never echo the vector.
      expect(r.text).not.toContain(sealed(v).ct_b64.slice(0, 40));
    }
    expect(await rowOf(a)).toBeUndefined();
    expect(await auditsOf(a)).toEqual([]);
  });

  it('re-enrolling replaces the row (one row per user)', async () => {
    const a = await signUp(ctx.base, 'Dee');
    expect((await enroll(a, basis(3))).status).toBe(201);
    const first = (await rowOf(a))!;
    expect((await enroll(a, basis(4))).status).toBe(201);
    const rows = await ctx.deps.db
      .select({ id: faceEnrollments.id })
      .from(faceEnrollments)
      .where(eq(faceEnrollments.user_id, uid(a)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).not.toBe(first.id);
    const audits = await auditsOf(a);
    expect(audits.at(-1)!.details).toMatchObject({ replaced: true });
  });

  it('PATCH disables and re-enables; DELETE really deletes and is idempotent', async () => {
    const a = await signUp(ctx.base, 'Eli');
    const none = await call(a, 'PATCH', '/v1/face/enrollment', { status: 'disabled' });
    expect(none.status).toBe(409);
    expect(none.json!.error.code).toBe('FACE_NOT_ENROLLED');

    await enroll(a, basis(5));
    const off = await call(a, 'PATCH', '/v1/face/enrollment', { status: 'disabled' });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({
      status: 'disabled',
      disabled_at: new Date(clock).toISOString(),
    });
    const on = await call(a, 'PATCH', '/v1/face/enrollment', { status: 'active' });
    expect(on.json).toMatchObject({ status: 'active', disabled_at: null });
    // Same status again: no change, no audit row.
    await call(a, 'PATCH', '/v1/face/enrollment', { status: 'active' });

    const del = await call(a, 'DELETE', '/v1/face/enrollment');
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    expect(await rowOf(a)).toBeUndefined();
    const again = await call(a, 'DELETE', '/v1/face/enrollment');
    expect(again.status).toBe(204);
    const actions = (await auditsOf(a)).map((x) => x.action);
    expect(actions).toEqual([
      'face.consented',
      'face.enrolled',
      'face.disabled',
      'face.enabled',
      'face.deleted',
    ]);
    const deleted = (await auditsOf(a)).at(-1)!.details;
    expect(deleted).toMatchObject({ reason: 'user', model_name: 'w600k_mbf' });
    expect((await get(a, '/v1/face/enrollment')).json!.status).toBe('none');
  });

  // ---- matching -----------------------------------------------------------------------

  it('matches only a confident, opted-in member of the same room, and never reveals scores', async () => {
    const A = await signUp(ctx.base, 'Logan');
    const B = await signUp(ctx.base, 'Jake');
    const C = await signUp(ctx.base, 'Sam');
    const D = await signUp(ctx.base, 'Priya'); // enrolled, other room
    const E = await signUp(ctx.base, 'Noor'); // in the room, never enrolled
    const room = await newRoom(A, B, C, E);
    await newRoom(D);
    for (const [u, i] of [
      [A, 10],
      [B, 11],
      [C, 12],
      [D, 13],
    ] as const) {
      expect((await enroll(u, basis(i))).status).toBe(201);
    }

    // Presence reports who opted in.
    const presence = await get(A, `/v1/rooms/${room.room_id}/presence`);
    const enrolled = Object.fromEntries(
      presence.json.members.map((m: any) => [m.user.display_name, m.face_enrolled]),
    );
    expect(enrolled).toMatchObject({ Logan: true, Jake: true, Sam: true, Noor: false });

    // Confident: 0.42 vs Jake, 0 vs Sam.
    const hit = await match(A, room.room_id, probeWith({ 11: 0.42 }));
    expect(hit.status).toBe(200);
    const m = FaceMatchResponse.parse(hit.json).match!;
    expect(m.user.user_id).toBe(uid(B));
    expect(m.user.display_name).toBe('Jake');
    expect(m.ticket_expires_at).toBe(new Date(clock + MATCH_TICKET_TTL_MS).toISOString());
    expect(m.head_to_head).toMatchObject({ wins: 0, losses: 0, pushes: 0, net: '0' });
    expect(hit.text).not.toMatch(/score|cosine|0\.42/);
    // last_used_at bumped, truncated to the day.
    const used = (await rowOf(B))!.last_used_at!;
    expect(used.getTime() % 86_400_000).toBe(0);
    expect(clock - used.getTime()).toBeLessThan(86_400_000);

    // Below threshold, and ambiguous between two members: nothing.
    expect((await match(A, room.room_id, probeWith({ 11: 0.29 }))).json).toEqual({ match: null });
    expect((await match(A, room.room_id, probeWith({ 11: 0.42, 12: 0.4 }))).json).toEqual({
      match: null,
    });
    // Margin met: 0.5 vs 0.44.
    expect(
      (await match(A, room.room_id, probeWith({ 11: 0.5, 12: 0.44 }))).json!.match.user.user_id,
    ).toBe(uid(B));

    // Someone enrolled in another room is never a candidate, however close.
    expect((await match(A, room.room_id, probeWith({ 13: 0.95 }))).json).toEqual({ match: null });
    // Nor is the scanner.
    expect((await match(A, room.room_id, probeWith({ 10: 0.95 }))).json).toEqual({ match: null });
    // Another member scanning finds the scanner's own face fine (A is a candidate for B).
    expect((await match(B, room.room_id, probeWith({ 10: 0.9 }))).json!.match.user.user_id).toBe(
      uid(A),
    );

    // Opt-out takes effect on the very next match; opting back in restores it.
    await call(B, 'PATCH', '/v1/face/enrollment', { status: 'disabled' });
    expect((await match(A, room.room_id, probeWith({ 11: 0.9 }))).json).toEqual({ match: null });
    await call(B, 'PATCH', '/v1/face/enrollment', { status: 'active' });
    expect((await match(A, room.room_id, probeWith({ 11: 0.9 }))).json!.match).not.toBeNull();

    // A member who left is not a candidate.
    expect((await call(C, 'POST', `/v1/rooms/${room.room_id}/leave`)).status).toBe(204);
    expect((await match(A, room.room_id, probeWith({ 12: 0.9 }))).json).toEqual({ match: null });

    // After DELETE, gone for good.
    await call(B, 'DELETE', '/v1/face/enrollment');
    expect((await match(A, room.room_id, probeWith({ 11: 0.9 }))).json).toEqual({ match: null });
  });

  it('a scan that finds nobody stores nothing (no audit row, no last_used_at)', async () => {
    const A = await signUp(ctx.base, 'Ira');
    const B = await signUp(ctx.base, 'Jun');
    const room = await newRoom(A, B);
    await enroll(B, basis(70));
    const before = (await auditsOf(B)).length;
    const scannerRows = () =>
      ctx.deps.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.actor_user_id, uid(A)));
    const scannerBefore = (await scannerRows()).length;
    for (let i = 0; i < 5; i++) {
      // Strangers: nobody in the room looks like these.
      const r = await match(A, room.room_id, probeWith({ [71 + i]: 0.95 }));
      expect(r.json).toEqual({ match: null });
    }
    expect((await auditsOf(B)).length).toBe(before);
    expect((await scannerRows()).length).toBe(scannerBefore);
    expect((await rowOf(B))!.last_used_at).toBeNull();
  });

  it('non-members get 403, unknown rooms 404, closed rooms 410; bad probes are refused', async () => {
    const A = await signUp(ctx.base, 'Ola');
    const B = await signUp(ctx.base, 'Pat');
    const outsider = await signUp(ctx.base, 'Quinn');
    const room = await newRoom(A, B);
    await enroll(B, basis(20));

    const no = await match(outsider, room.room_id, probeWith({ 20: 0.9 }));
    expect(no.status).toBe(403);
    expect(no.json!.error.code).toBe('NOT_IN_ROOM');
    expect(no.text).not.toContain('Pat');

    expect((await match(A, randomUUID(), basis(20))).status).toBe(404);
    expect(
      (await match(A, room.room_id, basis(20), { model: { ...FACE_MODEL_W600K, version: 'v9' } }))
        .json!.error.code,
    ).toBe('FACE_MODEL_UNSUPPORTED');
    expect(
      (await match(A, room.room_id, basis(20), { probe: sealed(basis(20).subarray(0, 64)) })).json!
        .error.code,
    ).toBe('FACE_SEAL_INVALID');
    expect(
      (
        await match(
          A,
          room.room_id,
          basis(20).map((x) => x * 3),
        )
      ).json!.error.code,
    ).toBe('VALIDATION_FAILED');

    await ctx.deps.db
      .update(rooms)
      .set({ closed_at: new Date(clock) })
      .where(eq(rooms.id, room.room_id));
    const closed = await match(A, room.room_id, probeWith({ 20: 0.9 }));
    expect(closed.status).toBe(410);
    expect(closed.json!.error.code).toBe('ROOM_EXPIRED');
  });

  // ---- the ticket in POST /v1/bets ------------------------------------------------------

  it("POST /v1/bets accepts challenge_method 'face' only with a bound, unexpired, untampered ticket", async () => {
    const A = await signUp(ctx.base, 'Rae');
    const B = await signUp(ctx.base, 'Sol');
    const C = await signUp(ctx.base, 'Tam');
    const room = await newRoom(A, B, C);
    await enroll(B, basis(30));
    await enroll(C, basis(31));
    const ticketFor = async (scanner: SignedUp, i: number) =>
      (await match(scanner, room.room_id, probeWith({ [i]: 0.8 }))).json!.match
        .match_ticket as string;
    const challenge = (a: SignedUp, b: SignedUp, ticket: string | undefined) =>
      call(a, 'POST', '/v1/bets', {
        room_id: room.room_id,
        opponent_user_id: uid(b),
        challenge_method: 'face',
        ...(ticket === undefined ? {} : { match_ticket: ticket }),
      });
    const refused = async (r: Awaited<ReturnType<typeof challenge>>, why: string) => {
      expect(r.status).toBe(422);
      expect(r.json!.error.details.reason).toBe('match_ticket_invalid');
      expect(r.json!.error.details.issues[0].message).toBe(`match_ticket ${why}`);
    };

    const tB = await ticketFor(A, 30);
    // The ticket names Sol: it can't address Tam, and Tam can't spend it.
    await refused(await challenge(A, C, tB), 'invalid');
    await refused(await challenge(C, B, tB), 'invalid');
    await refused(await challenge(A, B, undefined), 'missing');
    await refused(
      await challenge(A, B, `${tB.slice(0, -3)}${tB.endsWith('AAA') ? 'BBB' : 'AAA'}`),
      'invalid',
    );

    // Beat 1 end to end: B's phone is listening when A taps "Challenge Sol?".
    const b = await connectWs(ctx.wsUrl);
    try {
      b.send({ op: 'hello', token: B.session.token, device_id: B.session.device_id });
      await b.next((f) => f.op === 'welcome');
      const ok = await challenge(A, B, tB);
      expect(ok.status).toBe(201);
      const [row] = await ctx.deps.db.select().from(bets).where(eq(bets.id, ok.json!.bet.bet_id));
      expect(row!.challenge_method).toBe('face');
      expect(row!.party_b_id).toBe(uid(B));
      const invited = await b.next((f) => f.type === 'bet.invited');
      expect(invited).toMatchObject({
        bet_id: ok.json!.bet.bet_id,
        seq: 1,
        payload: { challenger: { user_id: uid(A), display_name: 'Rae' }, room_id: room.room_id },
      });
    } finally {
      b.close();
    }

    // Expiry: a ticket for Tam, used 60 s later.
    const tC = await ticketFor(A, 31);
    clock += MATCH_TICKET_TTL_MS;
    try {
      await refused(await challenge(A, C, tC), 'expired');
    } finally {
      clock -= MATCH_TICKET_TTL_MS;
    }
    expect((await challenge(A, C, tC)).status).toBe(201);
  });

  // ---- head-to-head -------------------------------------------------------------------

  it('returns the head-to-head record from settled bets (seed history labelled)', async () => {
    const A = await signUp(ctx.base, 'Uma');
    const B = await signUp(ctx.base, 'Vic');
    const room = await newRoom(A, B);
    await enroll(B, basis(40));
    const settled = (a: SignedUp, b: SignedUp, outcome: 'party_a' | 'party_b' | 'split') => ({
      party_a_id: uid(a),
      party_b_id: uid(b),
      room_id: room.room_id,
      mint: MINT,
      state: 'PAID' as const,
      onchain_status: 'settled' as const,
      terms_hash: 'c'.repeat(64),
      evidence_source: 'camera' as const,
      stake_a: 5_000_000n,
      stake_b: 5_000_000n,
      outcome,
      payout_a: outcome === 'party_a' ? 10_000_000n : outcome === 'split' ? 5_000_000n : 0n,
      payout_b: outcome === 'party_b' ? 10_000_000n : outcome === 'split' ? 5_000_000n : 0n,
      settled_at: new Date(clock - 3_600_000),
      is_seed: true,
    });
    await ctx.deps.db.insert(bets).values([
      settled(A, B, 'party_a'), // Uma wins as A
      settled(B, A, 'party_a'), // Vic wins as A
      settled(B, A, 'party_a'), // Vic wins as A
      settled(A, B, 'split'),
    ]);
    const m = (await match(A, room.room_id, probeWith({ 40: 0.7 }))).json!.match;
    expect(m.head_to_head).toEqual({
      wins: 1,
      losses: 2,
      pushes: 1,
      net: '-5000000',
      net_display: '−$5',
      last_settled_at: new Date(clock - 3_600_000).toISOString(),
      includes_seed: true,
    });
  });

  // ---- retention ----------------------------------------------------------------------

  it('the retention sweep deletes unused and long-disabled enrollments, with audit rows', async () => {
    const fresh = await signUp(ctx.base, 'Wes');
    const stale = await signUp(ctx.base, 'Xia');
    const off = await signUp(ctx.base, 'Yan');
    for (const u of [fresh, stale, off]) await enroll(u, basis(50));
    const day = 86_400_000;
    await ctx.deps.db
      .update(faceEnrollments)
      .set({ last_used_at: new Date(clock - 181 * day) })
      .where(eq(faceEnrollments.user_id, uid(stale)));
    await ctx.deps.db
      .update(faceEnrollments)
      .set({
        status: 'disabled',
        disabled_at: new Date(clock - 31 * day),
        last_used_at: new Date(clock),
      })
      .where(eq(faceEnrollments.user_id, uid(off)));

    const scope = { userIds: [uid(fresh), uid(stale), uid(off)] };
    const r = await purgeExpiredEnrollments(ctx.deps, clock, scope);
    expect(r.deleted).toBe(2);
    expect(await rowOf(fresh)).toBeDefined();
    expect(await rowOf(stale)).toBeUndefined();
    expect(await rowOf(off)).toBeUndefined();
    expect((await auditsOf(stale)).at(-1)).toMatchObject({
      action: 'face.deleted',
      details: { reason: 'retention_unused' },
    });
    expect((await auditsOf(off)).at(-1)).toMatchObject({
      action: 'face.deleted',
      details: { reason: 'retention_disabled' },
    });

    // The hackathon deadline: everything goes (only rows that exist at that point).
    const late = await purgeExpiredEnrollments(
      ctx.deps,
      Date.parse('2026-12-31T00:00:00.000Z'),
      scope,
    );
    expect(late.deleted).toBe(1);
    expect(await rowOf(fresh)).toBeUndefined();
    expect((await auditsOf(fresh)).at(-1)).toMatchObject({
      details: { reason: 'retention_deadline' },
    });
    expect(await purgeExpiredEnrollments(ctx.deps, clock, { userIds: [] })).toEqual({ deleted: 0 });
  });
});

describeDb('face rate limits (§1.7)', () => {
  it('face-match: 30/min per user; enrollment writes 5/h, but disable and delete always work', async () => {
    let clock = Date.now();
    const env = testEnv();
    const dbHandle = createDb({ url: env.DATABASE_URL, max: 2 });
    // Every log line this server writes during the run, to prove no face bytes reach a log.
    const lines: string[] = [];
    const capture = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
      void lines.push(JSON.stringify({ level, msg, ...fields }));
    const log = {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    };
    const { deps } = createDeps({ env, dbHandle, rateLimit: true, now: () => clock, log });
    const server = await startServer(deps, {
      port: 0,
      hostname: '127.0.0.1',
      modules: routeModules,
      onClose: () => dbHandle.close(),
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const a = await signUp(base, 'Zed');
      const b = await signUp(base, 'Ari');
      const send = (u: SignedUp, method: string, path: string, body?: unknown) => {
        const raw = body === undefined ? '' : JSON.stringify(body);
        return fetch(base + path, {
          method,
          headers: signedHeaders(u, method, path, raw, { ts: clock }),
          body: raw,
        });
      };
      const r = await send(a, 'POST', '/v1/rooms', { kind: 'session' });
      const room = (await r.json()) as { room_id: string; code: string };
      await send(b, 'POST', '/v1/rooms/join', { code: room.code });

      const enrollOnce = () =>
        send(a, 'POST', '/v1/face/enrollment', {
          consent: {
            consent_version: 'face-consent-v1',
            consent_text_sha256: FACE_CONSENT_V1_SHA256,
            consent_at: new Date(clock - 1000).toISOString(),
          },
          liveness: { method: 'head_turn', passed_at: new Date(clock).toISOString() },
          model: FACE_MODEL_W600K,
          embedding: sealed(dense(60)),
          shots: 3,
        });
      for (let i = 0; i < 5; i++) expect((await enrollOnce()).status).toBe(201);
      const sixth = await enrollOnce();
      expect(sixth.status).toBe(429);
      expect(sixth.headers.get('Retry-After')).toBeTruthy();
      // Turning it off and deleting are never limited.
      expect((await send(a, 'PATCH', '/v1/face/enrollment', { status: 'disabled' })).status).toBe(
        200,
      );
      expect((await send(a, 'PATCH', '/v1/face/enrollment', { status: 'active' })).status).toBe(
        429,
      );
      expect((await send(a, 'DELETE', '/v1/face/enrollment')).status).toBe(204);

      const probe = { probe: sealed(dense(61)), model: FACE_MODEL_W600K };
      const path = `/v1/rooms/${room.room_id}/face-match`;
      for (let i = 0; i < 30; i++) expect((await send(b, 'POST', path, probe)).status).toBe(200);
      const over = await send(b, 'POST', path, probe);
      expect(over.status).toBe(429);
      expect(((await over.json()) as any).error.details.bucket).toBe('face-match');
      clock += 60_000; // the bucket refills
      expect((await send(b, 'POST', path, probe)).status).toBe(200);
      // Members still listed.
      const members = await deps.db
        .select({ u: roomMembers.user_id })
        .from(roomMembers)
        .where(eq(roomMembers.room_id, room.room_id));
      expect(members.length).toBe(2);
      for (const v of [dense(60), dense(61)]) {
        const b64 = sealed(v).ct_b64;
        for (const line of lines) {
          expect(line).not.toContain(b64.slice(0, 32));
          expect(line).not.toContain(b64.slice(-32));
        }
      }
      expect(lines.join('\n')).not.toMatch(/ct_b64|embedding_ciphertext/);
    } finally {
      await server.close();
    }
  });
});

describeDb('face retention keeper task', () => {
  it('the face routes register face-retention on the server keeper', async () => {
    const env = testEnv();
    const dbHandle = createDb({ url: env.DATABASE_URL, max: 1 });
    const { deps } = createDeps({ env, dbHandle, rateLimit: false, keeper: true });
    try {
      buildApp(deps, routeModules);
      expect(deps.keeper?.taskNames).toContain('face-retention');
    } finally {
      await dbHandle.close();
    }
  });
});
