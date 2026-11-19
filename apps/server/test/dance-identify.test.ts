/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// Dance Off face assignment over HTTP + Postgres (docs/planning/DANCE-OFF.md §3):
// POST /v1/bets/:bet_id/dance/identify. Only the device that films the dance off may call it
// (LOCKED: A's judge cam in the room, else A's phone; ATTEMPT: the attempt's recorder); probes are
// compared with the two parties' active enrollments only (the caller's own included, never a third
// room member), with the face-match threshold and margin; at most one face per party; no scores
// in the answer, nothing stored, no face bytes in a log; 30/min per user in `face-match/dance`.
// Skips without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { auditLog, betTermsVersions, createDb, devices, faceEnrollments } from '@youre-on/db';
import { danceIdentifyPath } from '@youre-on/shared/api';
import { ESCROW_ID, USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import { getRoutine } from '@youre-on/shared/dance/routine';
import { danceTermsText } from '@youre-on/shared/dance/terms';
import {
  embeddingToBytes,
  FACE_CONSENT_V1_SHA256,
  FACE_MATCH_MIN_COSINE,
  FACE_MODEL_W600K,
} from '@youre-on/shared/face';
import { jcs } from '@youre-on/shared/jcs';
import { computeTermsHash } from '@youre-on/shared/terms';
import { issueAppSession } from '../src/auth/sessions';
import { danceFacesIdentified } from '../src/judge/dance-faces';
import { createDeps, startServer, type RunningServer } from '../src/server';
import { routeModules } from '../src/routes';
import type { AppDeps } from '../src/context';
import { mkBetRow } from './chain-db';
import { betFacts } from './chain-fixtures';
import { describeDb, newKey, signedHeaders, signUp, testEnv, type SignedUp } from './helpers';

const DIM = 512;
const ROUTINE = getRoutine('wave-pop')!;

/** e_i: synthetic "faces" whose cosines are exact. */
const basis = (i: number) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};
/** A unit vector with cosine c[i] against basis(i), the rest on axis 500. */
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
/** A dense unit vector, so its base64 is distinctive in a log grep. */
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

describeDb('dance identify: POST /v1/bets/:bet_id/dance/identify (DB)', () => {
  let clock = Date.now();
  let deps: AppDeps;
  let server: RunningServer;
  let base = '';
  const lines: string[] = [];
  let A: SignedUp;
  let B: SignedUp;
  let C: SignedUp; // a third room member, enrolled: never compared
  let CAM: SignedUp; // A's second device
  let roomId = '';
  const uid = (u: SignedUp) => u.session.user.user_id;

  const call = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(base + path, {
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
  const enroll = (u: SignedUp, v: Float32Array) =>
    call(u, 'POST', '/v1/face/enrollment', {
      consent: {
        consent_version: 'face-consent-v1',
        consent_text_sha256: FACE_CONSENT_V1_SHA256,
        consent_at: new Date(clock - 30_000).toISOString(),
      },
      liveness: { method: 'head_turn', passed_at: new Date(clock - 5_000).toISOString() },
      model: FACE_MODEL_W600K,
      embedding: sealed(v),
      shots: 3,
    });
  const identify = (u: SignedUp, betId: string, faces: Float32Array[], over: object = {}) =>
    call(u, 'POST', danceIdentifyPath(betId), {
      model: FACE_MODEL_W600K,
      faces: faces.map((f) => ({ embedding: sealed(f) })),
      ...over,
    });

  beforeAll(async () => {
    const env = testEnv();
    const dbHandle = createDb({ url: env.DATABASE_URL, max: 4 });
    const capture = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
      void lines.push(JSON.stringify({ level, msg, ...fields }));
    const log = {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    };
    ({ deps } = createDeps({ env, dbHandle, rateLimit: true, now: () => clock, log }));
    server = await startServer(deps, {
      port: 0,
      hostname: '127.0.0.1',
      modules: routeModules,
      onClose: () => dbHandle.close(),
    });
    base = `http://127.0.0.1:${server.port}`;
    A = await signUp(base, 'Logan');
    B = await signUp(base, 'Jake');
    C = await signUp(base, 'Mia');
    const r = await call(A, 'POST', '/v1/rooms', { name: 'Dance floor', kind: 'session' });
    roomId = r.json!.room_id;
    for (const u of [B, C])
      expect((await call(u, 'POST', '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    expect((await enroll(A, basis(1))).status).toBe(201);
    expect((await enroll(B, basis(2))).status).toBe(201);
    expect((await enroll(C, basis(3))).status).toBe(201);
    const camKey = newKey();
    const [dev] = await deps.db
      .insert(devices)
      .values({ user_id: uid(A), device_pubkey: camKey.pubkey })
      .returning({ id: devices.id });
    const s = await issueAppSession(deps.db, { user_id: uid(A), device_id: dev!.id, now: clock });
    CAM = {
      device: camKey,
      wallet: A.wallet,
      session: { ...A.session, token: s.token, session_id: s.session_id, device_id: dev!.id },
    };
  });
  afterAll(async () => {
    await server?.close();
  });

  /** A bet A vs B in the room with frozen terms (`over`: other terms fields), in `state`. */
  async function bet(
    state: 'LOCKED' | 'DRAFTING' = 'LOCKED',
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const betId = randomUUID();
    const t = danceTermsText(ROUTINE, '5000000');
    const { terms, terms_hash } = computeTermsHash({
      schema_version: 1,
      bet_id: betId,
      escrow: { cluster: 'devnet', program_id: ESCROW_ID, mint: USDC_MINT_DEVNET },
      party_a: { pubkey: A.wallet.pubkey, display_name: 'Logan' },
      party_b: { pubkey: B.wallet.pubkey, display_name: 'Jake' },
      type: 'dance_off',
      claim: t.claim,
      performer: null,
      yes_party: 'A',
      attempts: { count: 1, rule: 'single' },
      success_criteria: [...t.success_criteria],
      failure_criteria: [],
      edge_cases: [],
      evidence_source: 'camera',
      market: null,
      stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
      deadline: new Date(Math.ceil(clock / 1000) * 1000 + 3600_000).toISOString(),
      created_at: new Date(clock).toISOString(),
      ...over,
    });
    await mkBetRow(
      deps.db,
      betFacts({
        bet_id: betId,
        party_a: A.wallet.pubkey,
        party_b: B.wallet.pubkey,
        terms_hash,
      }),
      {
        partyA: uid(A),
        partyB: uid(B),
        room_id: roomId,
        state,
        extra: state === 'LOCKED' ? { onchain_status: 'locked', locked_at: new Date(clock) } : {},
      },
    );
    await deps.db.insert(betTermsVersions).values({
      bet_id: betId,
      version: 1,
      canonical_json: jcs(terms),
      terms_hash,
      is_final: true,
    });
    return betId;
  }
  const bindCam = (on: boolean) =>
    deps.db
      .update(devices)
      .set(
        on ? { role: 'judge_cam', judge_room_id: roomId } : { role: 'phone', judge_room_id: null },
      )
      .where(eq(devices.id, CAM.session.device_id));

  it("A's phone, LOCKED: which face is which party (B may be face 0); no scores in the answer", async () => {
    await bindCam(false);
    const betId = await bet();
    const r = await identify(A, betId, [probeWith({ 2: 0.62 }), probeWith({ 1: 0.7 })]);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      assignments: [
        { face_index: 1, party: 'A' },
        { face_index: 0, party: 'B' },
      ],
    });
    expect(r.text).not.toMatch(/0\.6|0\.7|score|user/);
    // Both identified: the upload may start A on the right (judge/dance-faces).
    expect(danceFacesIdentified(deps, betId)).toBe(true);
    // A third person in the picture is never anyone (C is enrolled and in the room).
    const third = await identify(A, betId, [basis(3), probeWith({ 1: 0.7 })]);
    expect(third.json).toEqual({ assignments: [{ face_index: 1, party: 'A' }] });
    // A later answer without both drops the note: the left / right rule again.
    expect(danceFacesIdentified(deps, betId)).toBe(false);
    expect(danceFacesIdentified(deps, await bet())).toBe(false);
  });

  it('the face-match threshold and margin apply; one face per party', async () => {
    await bindCam(false);
    const betId = await bet();
    const below = FACE_MATCH_MIN_COSINE - 0.02;
    expect((await identify(A, betId, [probeWith({ 1: below })])).json).toEqual({
      assignments: [],
    });
    // looks like both parties: nobody
    expect((await identify(A, betId, [probeWith({ 1: 0.5, 2: 0.48 })])).json).toEqual({
      assignments: [],
    });
    // two faces that both look like A: A gets neither, B still gets its face
    const both = await identify(A, betId, [
      probeWith({ 1: 0.6 }),
      probeWith({ 1: 0.58 }),
      probeWith({ 2: 0.7 }),
    ]);
    expect(both.json).toEqual({ assignments: [{ face_index: 2, party: 'B' }] });
  });

  it('a disabled enrollment is never compared', async () => {
    await bindCam(false);
    const betId = await bet();
    expect((await call(B, 'PATCH', '/v1/face/enrollment', { status: 'disabled' })).status).toBe(
      200,
    );
    try {
      const r = await identify(A, betId, [probeWith({ 2: 0.9 }), probeWith({ 1: 0.9 })]);
      expect(r.json).toEqual({ assignments: [{ face_index: 1, party: 'A' }] });
    } finally {
      expect((await call(B, 'PATCH', '/v1/face/enrollment', { status: 'active' })).status).toBe(
        200,
      );
    }
  });

  it("only the filming device: B's phone and a stranger are refused; a judge cam takes over", async () => {
    await bindCam(false);
    const betId = await bet();
    const faces = [probeWith({ 1: 0.7 })];
    const asB = await identify(B, betId, faces);
    expect(asB.status).toBe(403);
    expect(asB.json!.error).toMatchObject({
      code: 'NOT_A_PARTY',
      details: { reason: 'not_recorder' },
    });
    const asC = await identify(C, betId, faces);
    expect(asC.status).toBe(403);
    expect(asC.json!.error.code).toBe('NOT_A_PARTY');
    // No judge cam: any of A's own phones may film it (POST …/attempts 'self' names the caller).
    expect((await identify(CAM, betId, faces)).status).toBe(200);
    await bindCam(true);
    try {
      expect((await identify(A, betId, faces)).status).toBe(403);
      const cam = await identify(CAM, betId, faces);
      expect(cam.status).toBe(200);
      expect(cam.json).toEqual({ assignments: [{ face_index: 0, party: 'A' }] });
    } finally {
      await bindCam(false);
    }
    expect((await identify(A, 'not-a-uuid', faces)).status).toBe(404);
  });

  it("ATTEMPT: the attempt's recorder only", async () => {
    await bindCam(false);
    const betId = await bet();
    const started = await call(A, 'POST', `/v1/bets/${betId}/attempts`, {
      attempt_no: 1,
      recorder: 'self',
    });
    expect(started.status).toBe(201);
    const faces = [probeWith({ 2: 0.7 })];
    const r = await identify(A, betId, faces);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ assignments: [{ face_index: 0, party: 'B' }] });
    expect((await identify(CAM, betId, faces)).status).toBe(403);
  });

  it('only a dance off, only while LOCKED or in ATTEMPT; a bad body is 422', async () => {
    await bindCam(false);
    const faces = [probeWith({ 1: 0.7 })];
    const drafting = await bet('DRAFTING');
    const d = await identify(A, drafting, faces);
    expect(d.status).toBe(409);
    expect(d.json!.error).toMatchObject({ code: 'INVALID_STATE', details: { state: 'DRAFTING' } });
    const skill = await bet('LOCKED', {
      type: 'skill',
      claim: 'Jake lands a bottle flip upright on its base.',
      performer: 'B',
      yes_party: 'B',
      success_criteria: ['The bottle comes to rest standing upright on its base.'],
    });
    const s = await identify(A, skill, faces);
    expect(s.status).toBe(409);
    expect(s.json!.error.details.reason).toBe('not_dance');
    const locked = await bet();
    expect((await identify(A, locked, [])).status).toBe(422);
    const five = Array.from({ length: 5 }, () => basis(1));
    expect((await identify(A, locked, five)).status).toBe(422);
    const unnormalized = new Float32Array(DIM).fill(0.5);
    const bad = await identify(A, locked, [unnormalized]);
    expect(bad.status).toBe(422);
    expect(bad.text).toContain('faces.0.embedding');
    const model = await identify(A, locked, faces, {
      model: { name: 'x', version: '1', dim: 512 },
    });
    expect(model.json!.error.code).toBe('FACE_MODEL_UNSUPPORTED');
  });

  it('stores nothing: no last_used_at, no audit row; no face bytes in any log', async () => {
    await bindCam(false);
    const betId = await bet();
    const before = await deps.db
      .select({ u: faceEnrollments.user_id, last: faceEnrollments.last_used_at })
      .from(faceEnrollments)
      .where(eq(faceEnrollments.user_id, uid(A)));
    // Only this test's rows: the other test files write audit rows to the same database at the
    // same time (vitest runs them in parallel).
    const ours = async () =>
      (
        await deps.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            or(
              inArray(auditLog.actor_user_id, [uid(A), uid(B)]),
              inArray(auditLog.subject_user_id, [uid(A), uid(B)]),
              eq(auditLog.bet_id, betId),
            ),
          )
      ).length;
    const audits = await ours();
    const probes = [dense(71), dense(72)];
    expect((await identify(A, betId, probes)).status).toBe(200);
    expect((await identify(A, betId, [probeWith({ 1: 0.8 })])).json!.assignments).toHaveLength(1);
    const after = await deps.db
      .select({ u: faceEnrollments.user_id, last: faceEnrollments.last_used_at })
      .from(faceEnrollments)
      .where(eq(faceEnrollments.user_id, uid(A)));
    expect(after).toEqual(before);
    expect(await ours()).toBe(audits);
    for (const v of probes) {
      const b64 = sealed(v).ct_b64;
      for (const line of lines) {
        expect(line).not.toContain(b64.slice(0, 32));
        expect(line).not.toContain(b64.slice(-32));
      }
    }
    expect(lines.join('\n')).not.toMatch(/ct_b64|embedding_ciphertext/);
  });

  it('rate limit: 30/min per user in its own bucket (face-match/dance)', async () => {
    await bindCam(false);
    clock += 120_000; // a fresh window for A
    const betId = await bet();
    const faces = [probeWith({ 1: 0.7 })];
    for (let i = 0; i < 30; i++) expect((await identify(A, betId, faces)).status).toBe(200);
    const over = await identify(A, betId, faces);
    expect(over.status).toBe(429);
    expect(over.json!.error.details.bucket).toBe('face-match/dance');
    // The scan path is untouched by it.
    const scan = await call(A, 'POST', `/v1/rooms/${roomId}/face-match`, {
      probe: sealed(probeWith({ 2: 0.7 })),
      model: FACE_MODEL_W600K,
    });
    expect(scan.status).toBe(200);
    clock += 60_000;
    expect((await identify(A, betId, faces)).status).toBe(200);
  });
});
