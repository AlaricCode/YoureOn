/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// Judge pipeline, Beat 4 (API-CONTRACT §2.9, §2.15, §7.1; SCHEMAS §5). The LLM is the offline
// MockLlm with scripted verdicts; no network. DB-backed suites skip without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { attemptFrames, attempts, betEvents, bets, devices, rulings } from '@youre-on/db';
import { requestSigningString } from '@youre-on/shared/api';
import { ESCROW_ID, USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import { hashJcs } from '@youre-on/shared/jcs';
import { sha256Hex } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { Ruling } from '@youre-on/shared/ruling';
import { computeTermsHash, type Terms } from '@youre-on/shared/terms';
import { issueAppSession } from '../src/auth/sessions';
import { MockLlm, type MockReply } from '../src/providers/mock/llm';
import type { ChatRequest } from '../src/providers/types';
import { routeModules } from '../src/routes';
import { compareChecks, isBottleFlip } from '../src/judge/checks';
import { rulingCue } from '../src/judge/cues';
import { JUDGE_TIMEOUT_MS } from '../src/judge/prompt';
import { buildRuling, cachedVerdict, CACHED_RULING_MODEL, type Judged } from '../src/judge/ruling';
import { createJudgeRoutes, MAX_FRAME_BYTES } from '../src/judge/routes';
import {
  b64url,
  connectWs,
  describeDb,
  newKey,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
  type WsClient,
} from './helpers';

const H = (s: string) => sha256Hex(s);
const FRAME_HASHES = Array.from({ length: 8 }, (_, k) => H(`frame ${k}`));

const ctxBase = {
  ruling_id: randomUUID(),
  bet_id: randomUUID(),
  attempt_no: 1,
  yes_party: 'B' as const,
  terms_hash: H('terms'),
  evidence_hash: H('clip'),
  frame_hashes: FRAME_HASHES,
  created_at: '2026-11-21T18:07:04.512Z',
};
const verdict = (over: Partial<Extract<Judged, { kind: 'verdict' }>['verdict']> = {}) => ({
  claim_result: 'MET' as const,
  confidence: 0.93,
  reason: 'Lands upright on its base in frame 7.',
  cited_frames: [5, 6, 7],
  contested: false,
  ...over,
});

// ---- pure ------------------------------------------------------------------------------

describe('buildRuling (SCHEMAS §5.1)', () => {
  const v = (over = {}, disagreement: string | null = null): Judged => ({
    kind: 'verdict',
    model: 'anthropic/claude-sonnet-5-5',
    verdict: verdict(over),
    disagreement,
  });

  it('maps MET through yes_party and commits to the frame hashes', () => {
    const r = buildRuling(ctxBase, v());
    expect(r).toMatchObject({ outcome: 'B_WINS', redo_reason: null, void_reason: null });
    expect(r.frame_hashes).toEqual(FRAME_HASHES);
    expect(Ruling.safeParse(r).success).toBe(true);
    expect(buildRuling({ ...ctxBase, yes_party: 'A' }, v()).outcome).toBe('A_WINS');
    expect(buildRuling(ctxBase, v({ claim_result: 'NOT_MET' })).outcome).toBe('A_WINS');
  });
  it('rounds confidence first, then applies REDO_BELOW', () => {
    expect(buildRuling(ctxBase, v({ confidence: 0.796 })).outcome).toBe('B_WINS');
    const low = buildRuling(ctxBase, v({ confidence: 0.75 }));
    expect(low).toMatchObject({ outcome: 'REDO', redo_reason: 'low_confidence', confidence: 0.75 });
    expect(buildRuling(ctxBase, v({ claim_result: 'UNCLEAR' })).redo_reason).toBe('unclear');
    expect(buildRuling(ctxBase, v({ confidence: 0.5, contested: true })).redo_reason).toBe(
      'contested',
    );
  });
  it('a disagreeing deterministic check turns a decisive verdict into REDO', () => {
    const r = buildRuling(ctxBase, v({}, 'checks miss upright at rest'));
    expect(r).toMatchObject({ outcome: 'REDO', redo_reason: 'unclear', claim_result: 'MET' });
    expect(r.reason).toMatch(/^Checks disagree/);
  });
  it('a model failure is REDO unclear; past MAX_REDOS any REDO is VOID max_redos', () => {
    const fail: Judged = { kind: 'failure', model: 'anthropic/x', status: 'timeout', message: 't' };
    expect(buildRuling(ctxBase, fail)).toMatchObject({ outcome: 'REDO', redo_reason: 'unclear' });
    expect(buildRuling({ ...ctxBase, attempt_no: 2 }, fail).outcome).toBe('REDO');
    expect(buildRuling({ ...ctxBase, attempt_no: 3 }, fail)).toMatchObject({
      outcome: 'VOID',
      void_reason: 'max_redos',
      redo_reason: null,
    });
    // a decisive 3rd attempt still wins
    expect(buildRuling({ ...ctxBase, attempt_no: 3 }, v()).outcome).toBe('B_WINS');
  });
  it('cleans citations and the spoken reason', () => {
    const r = buildRuling(ctxBase, v({ cited_frames: [7, 7, 99, 1, -1], reason: '  a\n\nb  ' }));
    expect(r.cited_frames).toEqual([7, 1]);
    expect(r.reason).toBe('a b');
  });
});

describe('bottle checks', () => {
  const ok = { cap_tape_visible: true, bottle_upright_at_rest: true };
  it('applies to bottle-flip terms only', () => {
    expect(isBottleFlip({ claim: 'Jake can land a bottle flip.', success_criteria: ['x'] })).toBe(
      true,
    );
    expect(isBottleFlip({ claim: 'Jake sinks a free throw.', success_criteria: ['x'] })).toBe(
      false,
    );
  });
  it('MET needs both checks; NOT_MET contradicts a confirmed landing', () => {
    expect(compareChecks('MET', ok, true)).toEqual({ agree: true });
    expect(compareChecks('MET', { ...ok, bottle_upright_at_rest: false }, true).agree).toBe(false);
    expect(compareChecks('MET', { ...ok, cap_tape_visible: null }, true).agree).toBe(false);
    expect(compareChecks('NOT_MET', ok, true).agree).toBe(false);
    expect(compareChecks('NOT_MET', { ...ok, bottle_upright_at_rest: false }, true).agree).toBe(
      true,
    );
    expect(compareChecks('MET', { ...ok, cap_tape_visible: false }, false).agree).toBe(true);
  });
});

describe('cues (§4.5)', () => {
  it('RULING / REDO / VOIDED lines', () => {
    const names = { A: 'Logan', B: 'Jake' };
    const won = buildRuling(ctxBase, {
      kind: 'verdict',
      model: 'm',
      verdict: verdict(),
      disagreement: null,
    });
    expect(rulingCue(won, names, 10).text).toBe(
      '[EVENT] RULING outcome=B_WINS winner=Jake conf=0.93 frames=5,6,7 reason="Lands upright on its base in frame 7." gg_secs=10 :: Deliver the ruling in two short sentences using the reason, then tell Logan he can tap GG.',
    );
    const fail: Judged = { kind: 'failure', model: 'm', status: 'error', message: '' };
    expect(rulingCue(buildRuling(ctxBase, fail), names, 10).text).toBe(
      '[EVENT] REDO attempt=2 max=3 why=unclear :: Say "Run it back" and call request_attempt with attempt_no 2.',
    );
    const vd = rulingCue(buildRuling({ ...ctxBase, attempt_no: 3 }, fail), names, 10);
    expect(vd.cue).toBe('VOIDED');
    expect(vd.text).toMatch(/^\[EVENT\] VOIDED reason=max_redos attempts=3 :: /);
  });
  it('the cached verdict cites the last frames', () => {
    expect(cachedVerdict(12).cited_frames).toEqual([9, 10, 11]);
  });
});

// ---- HTTP + DB -------------------------------------------------------------------------

describeDb('judge pipeline (DB)', () => {
  let ctx: Ctx;
  const termsByBet = new Map<string, Terms>();
  const judge = createJudgeRoutes({
    loadTerms: async (_db, bet) => termsByBet.get(bet.id) ?? null,
  });
  const modules = routeModules.map((m) => (m.name === 'judge' ? judge : m));
  let llm: MockLlm;
  let replies: MockReply[] = [];
  const ruled: { betId: string; ruling: Ruling }[] = [];
  const sockets: WsClient[] = [];

  let A: SignedUp; // A's voice phone
  let B: SignedUp;
  let C: SignedUp; // not in the bet
  let CAM: SignedUp; // A's second device, the judge cam
  let roomId: string;

  const uid = (u: SignedUp) => u.session.user.user_id;
  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(ctx.base + path, {
      method,
      headers: signedHeaders(u, method, path, raw),
      body: raw || undefined,
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
    });
  };
  const post = (u: SignedUp, path: string, body?: unknown) => signed(u, 'POST', path, body);

  beforeAll(async () => {
    ctx = await startTestServer({ modules });
    llm = new MockLlm(() => replies.shift() ?? { fail: 'error', message: 'no scripted reply' });
    ctx.deps.providers.llm = llm;
    ctx.deps.onRuling = (betId, ruling) => {
      ruled.push({ betId, ruling });
    };

    A = await signUp(ctx.base, 'Logan');
    B = await signUp(ctx.base, 'Jake');
    C = await signUp(ctx.base, 'Carol');
    const r = await post(A, '/v1/rooms', { name: 'Judge room', kind: 'session' });
    expect(r.status).toBe(201);
    roomId = r.json!.room_id;
    for (const m of [B, C]) {
      expect((await post(m, '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    }
    // The judge-cam iPhone: a second device of A (API-CONTRACT §2.9 "Judge-cam identity").
    const camKey = newKey();
    const [dev] = await ctx.deps.db
      .insert(devices)
      .values({ user_id: uid(A), device_pubkey: camKey.pubkey })
      .returning({ id: devices.id });
    const s = await issueAppSession(ctx.deps.db, {
      user_id: uid(A),
      device_id: dev!.id,
      now: Date.now(),
    });
    CAM = {
      device: camKey,
      wallet: A.wallet,
      session: { ...A.session, token: s.token, session_id: s.session_id, device_id: dev!.id },
    };
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await judge.idle();
    await ctx?.server.close();
  });

  /** A bet A→B in the room, frozen + LOCKED directly in the DB (the lock stream's job). */
  async function lockedBet(): Promise<string> {
    const created = await post(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(B),
      challenge_method: 'list',
    });
    expect(created.status).toBe(201);
    const betId: string = created.json!.bet.bet_id;
    const now = new Date();
    const deadline = new Date(Math.ceil(now.getTime() / 1000) * 1000 + 3600_000);
    const { terms, terms_hash } = computeTermsHash({
      schema_version: 1,
      bet_id: betId,
      escrow: { cluster: 'devnet', program_id: ESCROW_ID, mint: USDC_MINT_DEVNET },
      party_a: { pubkey: A.wallet.pubkey, display_name: 'Logan' },
      party_b: { pubkey: B.wallet.pubkey, display_name: 'Jake' },
      type: 'skill',
      claim: 'Jake lands a bottle flip upright on its base.',
      performer: 'B',
      yes_party: 'B',
      attempts: { count: 1, rule: 'single' },
      success_criteria: [
        'The bottle rotates at least once in the air.',
        'The bottle comes to rest standing upright on its base.',
      ],
      failure_criteria: ['The bottle ends on its side, upside down, or off the table.'],
      edge_cases: [
        {
          question: 'Does landing on the cap count?',
          answer: 'No. Only the base.',
          asked_by: 'judge',
        },
      ],
      evidence_source: 'camera',
      market: null,
      stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
      deadline: deadline.toISOString(),
      created_at: now.toISOString(),
    });
    termsByBet.set(betId, terms);
    await ctx.deps.db
      .update(bets)
      .set({
        state: 'LOCKED',
        terms_hash,
        stake_a: 5_000_000n,
        stake_b: 5_000_000n,
        evidence_source: 'camera',
        party_a_wallet: A.wallet.pubkey,
        party_b_wallet: B.wallet.pubkey,
        a_authorized_at: now,
        b_authorized_at: now,
        a_authorization_method: 'faceid_hold',
        b_authorization_method: 'faceid_hold',
        onchain_status: 'locked',
        locked_at: now,
      })
      .where(eq(bets.id, betId));
    return betId;
  }

  async function bindCam() {
    const r = await signed(CAM, 'PATCH', '/v1/devices/current', {
      role: 'judge_cam',
      room_id: roomId,
    });
    expect(r.status).toBe(204);
  }

  function jpeg(i: number): Uint8Array {
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64), i & 0xff, 0xff, 0xd9]);
  }

  /** Signed multipart upload of `n` frames; `tamper` corrupts one frame after hashing. */
  async function uploadFrames(
    u: SignedUp,
    betId: string,
    attemptNo: number,
    o: { n?: number; tamper?: number; clipHash?: string; frames?: Uint8Array[] } = {},
  ) {
    const frames = o.frames ?? Array.from({ length: o.n ?? 8 }, (_, i) => jpeg(i));
    const evidence = {
      schema_version: 1,
      kind: 'camera',
      bet_id: betId,
      attempt_no: attemptNo,
      clip_sha256: o.clipHash ?? H(`clip ${betId} ${attemptNo}`),
      clip_bytes: 5_500_000,
      mime: 'video/quicktime',
      duration_ms: 4200,
      recorded_by: 'A',
      recorded_at: new Date().toISOString(),
      frames: frames.map((f, i) => ({ index: i, t_ms: 2000 + i * 250, sha256: sha256Hex(f) })),
    };
    const form = new FormData();
    form.append('evidence', new Blob([JSON.stringify(evidence)], { type: 'application/json' }));
    frames.forEach((f, i) => {
      const bytes = i === o.tamper ? jpeg(99) : f;
      form.append(
        'frame',
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
        `${i}.jpg`,
      );
    });
    const req = new Request('http://x/', { method: 'POST', body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    const path = `/v1/bets/${betId}/attempts/${attemptNo}/frames`;
    const ts = String(Date.now());
    const idem = randomUUID();
    const sig = u.device.sign(
      requestSigningString({
        method: 'POST',
        path_and_query: path,
        timestamp_ms: ts,
        idempotency_key: idem,
        session_id: u.session.session_id,
        body_sha256_hex: sha256Hex(body),
      }),
    );
    const res = await fetch(ctx.base + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.session.token}`,
        'X-YO-Device': u.session.device_id,
        'X-YO-Timestamp': ts,
        'Idempotency-Key': idem,
        'X-YO-Signature': b64url(sig),
        'Content-Type': req.headers.get('content-type')!,
      },
      body,
    });
    const text = await res.text();
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, any>) : null,
      frames,
      evidence,
    };
  }

  const met = (over: Record<string, unknown> = {}): MockReply => ({
    value: {
      claim_result: 'met',
      confidence: 0.93,
      reason: 'Full turn, lands on its base in frame 7 and stays put.',
      cited_frames: [5, 6, 7],
      contested: false,
      checks: { cap_tape_visible: true, bottle_upright_at_rest: true },
      ...over,
    },
  });
  const unclear: MockReply = {
    value: {
      claim_result: 'UNCLEAR',
      confidence: 0.4,
      reason: 'The landing is out of frame.',
      cited_frames: [],
      contested: false,
      checks: { cap_tape_visible: null, bottle_upright_at_rest: null },
    },
  };

  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
  const events = async (id: string) =>
    ctx.deps.db
      .select()
      .from(betEvents)
      .where(eq(betEvents.bet_id, id))
      .orderBy(asc(betEvents.seq));
  const rulingRows = async (id: string) =>
    ctx.deps.db
      .select()
      .from(rulings)
      .where(eq(rulings.bet_id, id))
      .orderBy(asc(rulings.created_at));

  // ---- PATCH /v1/devices/current ----

  it('binds a judge_cam to a room the user is in; refuses outsiders and a missing room', async () => {
    const missing = await signed(CAM, 'PATCH', '/v1/devices/current', { role: 'judge_cam' });
    expect(missing.status).toBe(422);
    const other = await post(C, '/v1/rooms', { name: 'Other', kind: 'session' });
    const notIn = await signed(CAM, 'PATCH', '/v1/devices/current', {
      role: 'judge_cam',
      room_id: other.json!.room_id,
    });
    expect(notIn.json!.error.code).toBe('NOT_IN_ROOM');
    await bindCam();
    const [d] = await ctx.deps.db
      .select()
      .from(devices)
      .where(eq(devices.id, CAM.session.device_id));
    expect(d).toMatchObject({ role: 'judge_cam', judge_room_id: roomId });
  });

  // ---- POST /v1/bets/:id/attempts ----

  it('state guard: an attempt on a bet that is not LOCKED is 409 INVALID_STATE', async () => {
    const created = await post(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(C),
      challenge_method: 'list',
    });
    const betId = created.json!.bet.bet_id;
    const r = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'judge_cam' });
    expect(r.status).toBe(409);
    expect(r.json!.error).toMatchObject({ code: 'INVALID_STATE', details: { state: 'DRAFTING' } });
    expect((await betRow(betId)).state).toBe('DRAFTING');
  });

  it('state guard: LOCKED only; a second start of attempt 1 replays, attempt 2 is refused', async () => {
    await bindCam();
    const betId = await lockedBet();
    expect((await post(C, `/v1/bets/${betId}/attempts`, { attempt_no: 1 })).json!.error.code).toBe(
      'NOT_A_PARTY',
    );
    expect((await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 2 })).status).toBe(422);
    const first = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 });
    expect(first.status).toBe(201);
    const again = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 });
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
    const two = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 2 });
    expect(two.status).toBe(409);
    expect(two.json!.error).toMatchObject({ code: 'INVALID_STATE', details: { state: 'ATTEMPT' } });
  });

  it('no judge cam in the room -> 409 no_judge_cam', async () => {
    const betId = await lockedBet();
    await ctx.deps.db
      .update(devices)
      .set({ role: 'phone', judge_room_id: null })
      .where(eq(devices.id, CAM.session.device_id));
    const r = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 });
    expect(r.json!.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'no_judge_cam' },
    });
    await bindCam();
  });

  // ---- happy path ----

  it('LOCKED -> ATTEMPT -> JUDGING -> ruling.issued + judge.cue, then onRuling', async () => {
    await bindCam();
    const betId = await lockedBet();
    const ws = await connectWs(ctx.wsUrl);
    sockets.push(ws);
    ws.send({ op: 'hello', token: A.session.token, device_id: A.session.device_id });
    await ws.next((f) => f.op === 'welcome');
    ws.send({ op: 'subscribe', bet_id: betId, after_seq: 0 });
    await ws.next((f) => f.op === 'subscribed');

    const start = await post(A, `/v1/bets/${betId}/attempts`, {
      attempt_no: 1,
      recorder: 'judge_cam',
    });
    expect(start.status).toBe(201);
    expect(start.json).toMatchObject({
      attempt_no: 1,
      performer: 'B',
      recorder_device_id: CAM.session.device_id,
      max_ms: 6000,
    });
    expect((await betRow(betId)).state).toBe('ATTEMPT');
    const started = await ws.next((f) => f.type === 'attempt.started');
    expect(parseRealtimeEvent(started).ok).toBe(true);

    replies = [met()];
    const calls0 = llm.calls.length;
    const up = await uploadFrames(CAM, betId, 1, { n: 8 });
    expect(up.status).toBe(202);
    const hashes = up.frames.map((f) => sha256Hex(f));
    expect(up.json).toEqual({ judging: true, frame_hashes: hashes, clip_upload: null });

    const issued = await ws.next((f) => f.type === 'ruling.issued', 5000);
    const cue = await ws.next((f) => f.type === 'judge.cue' && f.payload.cue === 'RULING', 5000);
    await judge.idle();
    expect(parseRealtimeEvent(issued).ok).toBe(true);
    expect(parseRealtimeEvent(cue).ok).toBe(true);
    expect(cue.payload.text).toMatch(/^\[EVENT\] RULING outcome=B_WINS winner=Jake conf=0.93/);

    // one vision call: the configured model, 8 inline frames, the 10 s deadline
    expect(llm.calls.length - calls0).toBe(1);
    const call = llm.calls.at(-1)! as ChatRequest<unknown>;
    expect(call.model).toBe('claude-sonnet-5-5');
    expect(call.timeoutMs).toBe(JUDGE_TIMEOUT_MS);
    expect(call.parts.filter((p) => p.kind === 'image')).toHaveLength(8);

    const ruling = Ruling.parse(issued.payload.ruling);
    expect(ruling).toMatchObject({
      outcome: 'B_WINS',
      claim_result: 'MET',
      attempt_no: 1,
      frame_hashes: hashes,
      evidence_hash: up.evidence.clip_sha256,
      terms_hash: (await betRow(betId)).terms_hash,
      model: 'anthropic/mock/claude-sonnet-5-5',
    });
    expect(issued.payload.ruling_hash).toBe(hashJcs(ruling));

    const [row] = await rulingRows(betId);
    expect(row).toMatchObject({
      outcome: 'B_WINS',
      ruling_hash: hashJcs(ruling),
      stage: 'attempt',
    });
    expect(sha256Hex(row!.record_canonical)).toBe(row!.ruling_hash);
    const [att] = await ctx.deps.db.select().from(attempts).where(eq(attempts.bet_id, betId));
    expect(att).toMatchObject({ status: 'ruled', frame_hashes: hashes });
    const stored = await ctx.deps.db
      .select()
      .from(attemptFrames)
      .where(eq(attemptFrames.attempt_id, att!.id))
      .orderBy(asc(attemptFrames.idx));
    expect(stored.map((f) => f.sha256)).toEqual(hashes);

    expect((await betRow(betId)).state).toBe('JUDGING'); // RULED comes with resolve (payout)
    expect(ruled.filter((x) => x.betId === betId).map((x) => x.ruling.ruling_id)).toEqual([
      ruling.ruling_id,
    ]);
    const types = (await events(betId)).map((e) => e.type);
    expect(types.slice(-7)).toEqual([
      'bet.state',
      'attempt.started',
      'judge.cue',
      'bet.state',
      'attempt.evidence',
      'ruling.issued',
      'judge.cue',
    ]);

    // the same upload replays the 202; a different clip is refused
    const replay = await uploadFrames(CAM, betId, 1, {
      frames: up.frames,
      clipHash: up.evidence.clip_sha256,
    });
    expect(replay).toMatchObject({ status: 202, json: { frame_hashes: hashes } });
    expect(
      (await uploadFrames(CAM, betId, 1, { clipHash: H('another clip') })).json!.error.code,
    ).toBe('ATTEMPT_NOT_OPEN');
  });

  // ---- auth + validation ----

  it('only the room judge_cam device may upload; hash mismatch and size caps are rejected', async () => {
    await bindCam();
    const betId = await lockedBet();
    expect((await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 })).status).toBe(201);
    for (const u of [A, B, C]) {
      const r = await uploadFrames(u, betId, 1);
      expect(r.status).toBe(403);
      expect(r.json!.error.code).toBe('NOT_A_PARTY');
    }
    const mismatch = await uploadFrames(CAM, betId, 1, { tamper: 3 });
    expect(mismatch.status).toBe(422);
    expect(mismatch.json!.error).toMatchObject({
      code: 'FRAME_HASH_MISMATCH',
      details: { index: 3 },
    });
    expect((await uploadFrames(CAM, betId, 1, { n: 7 })).status).toBe(422);
    expect((await uploadFrames(CAM, betId, 1, { n: 13 })).status).toBe(422);
    const big = new Uint8Array(MAX_FRAME_BYTES + 1).fill(7);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    const frames = Array.from({ length: 8 }, (_, i) => (i === 0 ? big : jpeg(i)));
    expect((await uploadFrames(CAM, betId, 1, { frames })).status).toBe(413);
    expect((await betRow(betId)).state).toBe('ATTEMPT'); // nothing was accepted

    // a camera that is no longer the room's judge cam loses upload rights
    await signed(CAM, 'PATCH', '/v1/devices/current', { role: 'phone' });
    expect((await uploadFrames(CAM, betId, 1)).status).toBe(403);
    await bindCam();
    replies = [met()];
    expect((await uploadFrames(CAM, betId, 1)).status).toBe(202);
    await judge.idle();
  });

  // ---- REDO and MAX_REDOS ----

  it('a disagreeing deterministic check -> REDO; the next attempt opens', async () => {
    await bindCam();
    const betId = await lockedBet();
    expect((await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 })).status).toBe(201);
    replies = [met({ checks: { cap_tape_visible: true, bottle_upright_at_rest: false } })];
    expect((await uploadFrames(CAM, betId, 1)).status).toBe(202);
    await judge.idle();
    const [r] = await rulingRows(betId);
    expect(r).toMatchObject({ outcome: 'REDO', redo_reason: 'unclear', claim_result: 'MET' });
    const bet = await betRow(betId);
    expect(bet).toMatchObject({ state: 'JUDGING', redo_count: 1 });
    const cue = (await events(betId)).at(-1)!;
    expect((cue.envelope as any).payload.text).toMatch(/^\[EVENT\] REDO attempt=2 max=3/);
    expect(ruled.find((x) => x.betId === betId)?.ruling.outcome).toBe('REDO');

    expect((await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 })).status).toBe(422);
    expect((await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 2 })).status).toBe(201);
    replies = [met()];
    expect((await uploadFrames(CAM, betId, 2)).status).toBe(202);
    await judge.idle();
    expect((await rulingRows(betId)).map((x) => x.outcome)).toEqual(['REDO', 'B_WINS']);
  });

  it('MAX_REDOS: the 3rd non-decisive recording is VOID max_redos (refund), and nothing follows', async () => {
    await bindCam();
    const betId = await lockedBet();
    for (let n = 1; n <= 3; n++) {
      expect((await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: n })).status).toBe(201);
      replies = [n === 2 ? { fail: 'timeout' } : unclear];
      expect((await uploadFrames(CAM, betId, n)).status).toBe(202);
      await judge.idle();
    }
    const rows = await rulingRows(betId);
    expect(rows.map((r) => [r.outcome, r.redo_reason, r.void_reason])).toEqual([
      ['REDO', 'unclear', null],
      ['REDO', 'unclear', null],
      ['VOID', null, 'max_redos'],
    ]);
    expect((await betRow(betId)).redo_count).toBe(2);
    const last = ruled.filter((x) => x.betId === betId).at(-1)!.ruling;
    expect(last).toMatchObject({ outcome: 'VOID', void_reason: 'max_redos', attempt_no: 3 });
    const cue = (await events(betId)).at(-1)!;
    expect((cue.envelope as any).payload.cue).toBe('VOIDED');
    expect((await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 4 })).status).toBe(409);
  });

  // ---- CACHED_RULING ----

  it('CACHED_RULING rules without calling the LLM, committing to the uploaded frames', async () => {
    await bindCam();
    const betId = await lockedBet();
    ctx.deps.env.CACHED_RULING = true;
    try {
      const calls0 = llm.calls.length;
      expect((await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 })).status).toBe(201);
      const up = await uploadFrames(CAM, betId, 1, { n: 12 });
      expect(up.status).toBe(202);
      await judge.idle();
      expect(llm.calls.length).toBe(calls0);
      const [r] = await rulingRows(betId);
      expect(r).toMatchObject({
        outcome: 'B_WINS',
        model: CACHED_RULING_MODEL,
        cited_frames: [9, 10, 11],
      });
      expect(r!.frame_hashes).toEqual(up.frames.map((f) => sha256Hex(f)));
    } finally {
      ctx.deps.env.CACHED_RULING = false;
    }
  });

  it('attempt rows are unique per (bet, attempt_no)', async () => {
    const rows = await ctx.deps.db
      .select({ bet: attempts.bet_id, n: attempts.attempt_no })
      .from(attempts)
      .where(and(eq(attempts.attempt_no, 1)));
    const keys = rows.map((r) => `${r.bet}:${r.n}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
