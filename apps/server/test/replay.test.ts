// GET /v1/bets/:bet_id/replay (API-CONTRACT §2.14, SCHEMAS §4.1): the slow-mo replay after a bet.
// The fixtures write what the judge pipeline writes (attempt row + evidence, attempt_frames,
// ruling.issued / appeal.result on the event log, bets.state) straight to Postgres.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { attemptFrames, attempts, bets } from '@youre-on/db';
import type { AppealResult } from '@youre-on/shared/appeal';
import type { CameraEvidence } from '@youre-on/shared/evidence';
import { judgeFrameTimesMs } from '@youre-on/shared/judge/frames';
import { ReplayResponse, type ReplayFoulInput } from '@youre-on/shared/replay';
import { GEMINI_SETTLEMENT_MODEL, type Ruling } from '@youre-on/shared/ruling';
import { emitBetEvent } from '../src/realtime/events';
import {
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

const KEY = 'stage-key-for-replay-tests';
const ORIGIN = 'http://localhost:5173';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const iso = () => new Date().toISOString();

describeDb('GET /v1/bets/:bet_id/replay', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startTestServer({ env: { STAGE_KEY: KEY } });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  const signed = (u: SignedUp, path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const get = async (token: string | null, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(ctx.base + path, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    });
    const text = await res.text();
    return {
      res,
      status: res.status,
      json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
    };
  };
  async function room(owner: SignedUp, ...members: SignedUp[]) {
    const r = await signed(owner, '/v1/rooms', { name: 'Replay room', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members)
      expect((await signed(m, '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    return r.json!.room_id as string;
  }
  const stageToken = async (roomId: string) =>
    (await postJson(ctx.base, '/v1/stage/session', { stage_key: KEY, room_id: roomId })).json!
      .token as string;

  /** A bet between A and B in a fresh room, with a 12-frame + crop attempt `n` uploaded. */
  async function setup(n = 1) {
    const A = await signUp(ctx.base, 'Logan');
    const B = await signUp(ctx.base, 'Jake');
    const roomId = await room(A, B);
    const bet = await signed(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = (bet.json!.bet_id ?? bet.json!.bet?.bet_id) as string;
    const db = ctx.deps.db;
    const times = judgeFrameTimesMs(4000);
    const jpeg = (i: number) => Buffer.from([0xff, 0xd8, 0xff, i, n, 2, 3, 0xff, 0xd9]);
    const imgs = [...times, times.at(-1)!].map((t, i) => ({ t, bytes: jpeg(i), crop: i === 12 }));
    const evidence: CameraEvidence = {
      schema_version: 1,
      kind: 'camera',
      bet_id: betId,
      attempt_no: n,
      clip_sha256: sha(`clip${n}`),
      clip_bytes: 1_000_000,
      mime: 'video/mp4',
      duration_ms: 4000,
      recorded_by: 'A',
      recorded_at: iso(),
      frames: imgs.map((f, i) => ({
        index: i,
        t_ms: f.t,
        sha256: sha(f.bytes),
        ...(f.crop ? { landing_crop: true as const } : {}),
      })),
    };
    const [att] = await db
      .insert(attempts)
      .values({
        bet_id: betId,
        attempt_no: n,
        recorded_by_user_id: A.session.user.user_id,
        max_ms: 15_000,
        go_at: new Date(),
        status: 'uploaded',
        duration_ms: 4000,
        evidence_canonical: JSON.stringify(evidence),
        frame_ts_ms: imgs.map((f) => f.t),
        frame_hashes: imgs.map((f) => sha(f.bytes)),
      })
      .returning({ id: attempts.id });
    await db.insert(attemptFrames).values(
      imgs.map((f, i) => ({
        attempt_id: att!.id,
        idx: i,
        t_ms: f.t,
        sha256: sha(f.bytes),
        bytes: f.bytes,
      })),
    );
    return { A, B, roomId, betId, evidence, attemptId: att!.id };
  }

  const rulingHash = (betId: string) => sha(`ruling:${betId}`);
  function ruling(betId: string, ev: CameraEvidence, over: Partial<Ruling> = {}): Ruling {
    return {
      schema_version: 1,
      ruling_id: randomUUID(),
      bet_id: betId,
      stage: 'attempt',
      attempt_no: ev.attempt_no,
      outcome: 'B_WINS',
      claim_result: 'MET',
      confidence: 0.93,
      reason: 'Two full rotations; it lands upright in frame 12 and stays there.',
      cited_frames: [12, 9],
      frame_hashes: ev.frames.map((f) => f.sha256),
      model: 'anthropic/claude-sonnet-5-5',
      evidence_hash: ev.clip_sha256,
      terms_hash: sha('terms'),
      created_at: iso(),
      redo_reason: null,
      void_reason: null,
      ...over,
    } as Ruling;
  }
  const rule = (betId: string, r: Ruling) =>
    emitBetEvent(ctx.deps, {
      bet_id: betId,
      type: 'ruling.issued',
      payload: { ruling: r, ruling_hash: rulingHash(betId) },
    });
  const setState = (betId: string, state: 'RULED' | 'PAID' | 'VOIDED') =>
    ctx.deps.db
      .update(bets)
      .set({
        state,
        terms_hash: sha('terms'),
        stake_a: 5_000_000n,
        stake_b: 5_000_000n,
        evidence_source: 'camera',
      })
      .where(eq(bets.id, betId));
  const replayOf = (token: string, betId: string, headers: Record<string, string> = {}) =>
    get(token, `/v1/bets/${betId}/replay`, headers);

  it('before a ruling: not_ruled; after a REDO: not_ruled', async () => {
    const { A, betId, evidence } = await setup();
    const r0 = await replayOf(A.session.token, betId);
    expect(r0.status).toBe(200);
    expect(r0.json).toEqual({ replay: null, why: 'not_ruled', final: false });
    await rule(
      betId,
      ruling(betId, evidence, {
        outcome: 'REDO',
        claim_result: 'UNCLEAR',
        confidence: 0.41,
        redo_reason: 'unclear',
      }),
    );
    expect((await replayOf(A.session.token, betId)).json.why).toBe('not_ruled');
  });

  it('a decisive ruling: the landing frames, held on the cited crop, each served by the frame route to A, B and the stage', async () => {
    const { A, B, roomId, betId, evidence } = await setup();
    await rule(betId, ruling(betId, evidence));
    await setState(betId, 'RULED');
    const r = await replayOf(B.session.token, betId);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = ReplayResponse.parse(r.json);
    expect(body.why).toBe('ready');
    expect(body.final).toBe(false);
    const m = body.replay!;
    expect(m).toMatchObject({
      kind: 'win',
      winner: 'B',
      attempt_no: 1,
      hold_source: 'judge_cited',
      ruling_hash: rulingHash(betId),
      foul: null,
      clip: null,
    });
    expect(m.frames.map((f) => f.idx)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(m.frames.at(-1)!.landing_crop).toBe(true);
    for (const f of m.frames) expect(f.t_ms).toBe(evidence.frames[f.idx!]!.t_ms);
    const stage = await stageToken(roomId);
    for (const token of [A.session.token, B.session.token, stage])
      for (const f of m.frames) expect((await get(token, f.path)).status, f.path).toBe(200);
    // the stage reads it too (its room), with CORS for the stage origin
    const s = await replayOf(stage, betId, { Origin: ORIGIN });
    expect(s.status).toBe(200);
    expect(s.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    // final once PAID
    await setState(betId, 'PAID');
    expect((await replayOf(A.session.token, betId)).json.final).toBe(true);
  });

  it('readers: an outsider and another room’s stage get 404; no bearer 401; a bad id 422', async () => {
    const { A, betId, evidence } = await setup();
    await rule(betId, ruling(betId, evidence));
    const C = await signUp(ctx.base, 'Mallory');
    expect((await replayOf(C.session.token, betId)).status).toBe(404);
    const other = await stageToken(await room(C));
    expect((await replayOf(other, betId)).status).toBe(404);
    // nor can they read the frames the replay points at
    const party = ReplayResponse.parse((await replayOf(A.session.token, betId)).json);
    expect(party.replay!.frames.length).toBeGreaterThan(0);
    for (const f of party.replay!.frames) {
      expect((await get(C.session.token, f.path)).status, f.path).toBe(404);
      expect((await get(other, f.path)).status, f.path).toBe(404);
      expect((await get(null, f.path)).status, f.path).toBe(401);
    }
    expect((await replayOf(C.session.token, randomUUID())).status).toBe(404);
    expect((await get(null, `/v1/bets/${betId}/replay`)).status).toBe(401);
    expect((await replayOf(C.session.token, 'not-a-uuid')).status).toBe(422);
  });

  it('VOID: no_winner; a Gemini settlement: no_frames; a purged attempt: purged', async () => {
    const v = await setup();
    await rule(v.betId, ruling(v.betId, v.evidence, { outcome: 'VOID', void_reason: 'max_redos' }));
    await setState(v.betId, 'VOIDED');
    expect((await replayOf(v.A.session.token, v.betId)).json).toEqual({
      replay: null,
      why: 'no_winner',
      final: true,
    });

    const g = await setup();
    await rule(
      g.betId,
      ruling(g.betId, g.evidence, {
        stage: 'settlement',
        model: GEMINI_SETTLEMENT_MODEL,
        frame_hashes: [],
        cited_frames: [],
      }),
    );
    expect((await replayOf(g.A.session.token, g.betId)).json.why).toBe('no_frames');

    const p = await setup();
    await rule(p.betId, ruling(p.betId, p.evidence));
    await ctx.deps.db
      .update(attempts)
      .set({ purged_at: new Date() })
      .where(eq(attempts.id, p.attemptId));
    expect((await replayOf(p.A.session.token, p.betId)).json.why).toBe('purged');
  });

  it('an appeal that flipped the result: the final winner, held on the last frame', async () => {
    const { A, betId, evidence } = await setup();
    const r = ruling(betId, evidence);
    await rule(betId, r);
    const vote = (seat: number, outcome: 'A_WINS' | 'B_WINS') => ({
      schema_version: 1 as const,
      appeal_id: '00000000-0000-4000-8000-000000000a01',
      bet_id: betId,
      seat,
      provider: (['anthropic', 'openai', 'google'] as const)[seat]!,
      model: 'm/x',
      status: 'ok' as const,
      outcome,
      confidence: 0.9,
      reason: 'It tips over after the bounce.',
      counted_as: outcome,
      latency_ms: 1000,
      created_at: iso(),
    });
    const result: AppealResult = {
      schema_version: 1,
      appeal_id: '00000000-0000-4000-8000-000000000a01',
      bet_id: betId,
      appellant: 'A',
      original_outcome: 'B_WINS',
      original_ruling_hash: rulingHash(betId),
      votes: [vote(0, 'A_WINS'), vote(1, 'A_WINS'), vote(2, 'B_WINS')],
      tally: { A_WINS: 2, B_WINS: 1, ABSTAIN: 0 },
      final_outcome: 'A_WINS',
      decided_by: 'majority',
      flipped: true,
      evidence_hash: evidence.clip_sha256,
      frame_hashes: r.frame_hashes,
      terms_hash: r.terms_hash,
      created_at: iso(),
    };
    await emitBetEvent(ctx.deps, {
      bet_id: betId,
      type: 'appeal.result',
      payload: { result, ruling_hash: rulingHash(betId) },
    });
    const m = ReplayResponse.parse((await replayOf(A.session.token, betId)).json).replay!;
    expect(m.winner).toBe('A');
    expect(m.hold_source).toBe('last_frame');
    expect(m.reason).toBeNull(); // the judge argued for B
  });

  it('a confirmed foul from deps.replayFouls beats the win; a failing source falls back to the win', async () => {
    const { A, betId, evidence } = await setup();
    await rule(betId, ruling(betId, evidence));
    const foul: ReplayFoulInput = {
      moment_ms: 1500,
      foul: { label: 'Toe 17 cm over', measure_cm: 17, detector: 'sam3/fal@1' },
      frames: [],
      clip: null,
    };
    const asked: Array<[string, number]> = [];
    ctx.deps.replayFouls = {
      foulFor: async (bet, n) => {
        asked.push([bet, n]);
        return bet === betId ? foul : null;
      },
    };
    try {
      const m = ReplayResponse.parse((await replayOf(A.session.token, betId)).json).replay!;
      expect(asked).toEqual([[betId, 1]]);
      expect(m).toMatchObject({
        kind: 'foul',
        hold_source: 'detector',
        moment_ms: 1500,
        foul: foul.foul,
        reason: null,
      });
      expect(m.frames.length).toBeGreaterThan(0);
      ctx.deps.replayFouls = {
        foulFor: () => Promise.reject(new Error('tracking down')),
      };
      expect((await replayOf(A.session.token, betId)).json.replay.kind).toBe('win');
    } finally {
      delete ctx.deps.replayFouls;
    }
  });

  it('CORS preflight from the stage origin', async () => {
    const { betId } = await setup();
    const pre = await fetch(`${ctx.base}/v1/bets/${betId}/replay`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });
});
