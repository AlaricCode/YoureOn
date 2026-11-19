/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// "Call it off" (API-CONTRACT §2.9a, src/judge/call-off.ts): a mutual stop of a locked bet, and
// the operator's demo void. The request lives in bet_events; both agreeing issues a VOID
// 'safety_stop' ruling (model rule/called-off@1) through the ruling machinery: the rulings row on
// the bet's attempt (a new one from LOCKED / after a REDO), bet -> JUDGING, ruling.issued, the
// VOIDED cue, deps.onRuling (resolve), and the keeper's resolve-due as its backstop. Never once
// a ruling is in flight or out. DB-backed: skips without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { attempts, betEvents, bets, rulings } from '@youre-on/db';
import { requestSigningString } from '@youre-on/shared/api';
import { CALL_OFF_TTL_MS, CALLED_OFF_REASON, CallOffRecord } from '@youre-on/shared/call-off';
import { ESCROW_ID, USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import { poseSha256, type PoseSeries } from '@youre-on/shared/dance/pose';
import { getRoutine, routineSha256 } from '@youre-on/shared/dance/routine';
import { scoreRound } from '@youre-on/shared/dance/score';
import { danceTermsText } from '@youre-on/shared/dance/terms';
import { hashJcs } from '@youre-on/shared/jcs';
import { sha256Hex } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { CALLED_OFF_MODEL, Ruling } from '@youre-on/shared/ruling';
import { computeTermsHash, type Terms } from '@youre-on/shared/terms';
import { calledOffCue } from '../src/judge/call-off';
import { isCalledOffBet } from '../src/judge/dance-bet';
import { createJudgeRoutes } from '../src/judge/routes';
import { loadFinalTerms } from '../src/judge/terms';
import { resolveDue, RESOLVE_GRACE_MS } from '../src/payout/resolve-due';
import { appendBetEvent } from '../src/realtime/events';
import { routeModules } from '../src/routes';
import {
  b64url,
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

const ROUTINE = getRoutine('wave-pop')!;
const ADMIN = 'call-off-admin-token';

function series(): PoseSeries {
  const first = ROUTINE.frames[0]!.k;
  return {
    schema_version: 1,
    w: ROUTINE.w,
    h: ROUTINE.h,
    fps_cap: 15,
    sync_offset_ms: 0,
    frames: ROUTINE.frames.map((f) => ({ t: f.t, n: 2, a: [...f.k], b: [...first] })),
  };
}

const jpeg = (i: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64), i & 0xff, 0xff, 0xd9]);

describe('calledOffCue', () => {
  it('is a VOIDED line naming the call-off (players) or the operator', () => {
    expect(calledOffCue('A').text).toMatch(
      /^\[EVENT\] VOIDED reason=safety_stop why=called_off :: Say both players called it off/,
    );
    expect(calledOffCue('operator').text).toContain('why=operator');
    expect(calledOffCue('B').speak).toBe(true);
  });
});

describeDb('call it off (DB)', () => {
  let ctx: Ctx;
  const termsByBet = new Map<string, Terms>();
  const judge = createJudgeRoutes({
    loadTerms: async (db, bet) => termsByBet.get(bet.id) ?? loadFinalTerms(db, bet),
  });
  const modules = routeModules.map((m) => (m.name === 'judge' ? judge : m));
  const ruled: { betId: string; ruling: Ruling }[] = [];
  let A: SignedUp;
  let B: SignedUp;
  let C: SignedUp;
  let roomId: string;
  const uid = (u: SignedUp) => u.session.user.user_id;

  const post = (u: SignedUp, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(ctx.base + path, {
      method: 'POST',
      headers: signedHeaders(u, 'POST', path, raw),
      body: raw || undefined,
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
    });
  };
  const callOff = (u: SignedUp, betId: string, agree: boolean) =>
    post(u, `/v1/bets/${betId}/call-off`, { agree });

  beforeAll(async () => {
    ctx = await startTestServer({
      modules,
      env: { DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: ADMIN },
    });
    ctx.deps.onRuling = (betId, ruling) => {
      ruled.push({ betId, ruling });
    };
    A = await signUp(ctx.base, 'Logan');
    B = await signUp(ctx.base, 'Jake');
    C = await signUp(ctx.base, 'Mallory');
    const r = await post(A, '/v1/rooms', { name: 'Call off', kind: 'session' });
    roomId = r.json!.room_id;
    expect((await post(B, '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
  });
  afterAll(async () => {
    await judge.idle();
    await ctx?.server.close();
  });

  /** A dance off A vs B, frozen + LOCKED in the DB (no chain: resolve is the onRuling spy). */
  async function lockedDance(): Promise<string> {
    const created = await post(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(B),
      challenge_method: 'list',
    });
    expect(created.status).toBe(201);
    const betId: string = created.json!.bet.bet_id;
    const now = new Date();
    const deadline = new Date(Math.ceil(now.getTime() / 1000) * 1000 + 3600_000);
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

  async function uploadDance(u: SignedUp, betId: string, attemptNo: number) {
    const s = series();
    const local = scoreRound(ROUTINE, s);
    const frames = [0, 1, 2, 3].map((i) => jpeg(i));
    const upload = {
      routine_id: ROUTINE.id,
      routine_sha256: routineSha256(ROUTINE),
      series: s,
      pose_sha256: poseSha256(s),
      client_scores: { a: local.a.score_x10, b: local.b.score_x10 },
      clip_sha256: null,
      frames: frames.map((f, i) => ({
        index: i,
        t_ms: 1000 + i * 3000,
        sha256: sha256Hex(f),
        width: 288,
        height: 512,
        bytes: f.length,
      })),
    };
    const form = new FormData();
    form.append('upload', new Blob([JSON.stringify(upload)], { type: 'application/json' }));
    frames.forEach((f, i) =>
      form.append(
        'frame',
        new Blob([f as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
        `${i}.jpg`,
      ),
    );
    const req = new Request('http://x/', { method: 'POST', body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    const path = `/v1/bets/${betId}/attempts/${attemptNo}/dance`;
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
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
  const events = async (id: string) =>
    (
      await ctx.deps.db
        .select()
        .from(betEvents)
        .where(eq(betEvents.bet_id, id))
        .orderBy(asc(betEvents.seq))
    ).map((e) => e.envelope as any);
  const rulingRows = async (id: string) =>
    ctx.deps.db.select().from(rulings).where(eq(rulings.bet_id, id));
  const attemptRows = async (id: string) =>
    ctx.deps.db
      .select()
      .from(attempts)
      .where(eq(attempts.bet_id, id))
      .orderBy(asc(attempts.attempt_no));

  /** The call-off ruling is a valid SCHEMAS Ruling and commits to its CallOffRecord. */
  async function expectCalledOff(betId: string, attemptNo: number) {
    const rows = await rulingRows(betId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      stage: 'attempt',
      outcome: 'VOID',
      void_reason: 'safety_stop',
      model: CALLED_OFF_MODEL,
      reason: CALLED_OFF_REASON,
      frame_hashes: [],
    });
    const ruling = Ruling.parse(JSON.parse(row.record_canonical));
    expect(hashJcs(ruling)).toBe(row.ruling_hash);
    const record = CallOffRecord.parse(JSON.parse(row.evidence_canonical!));
    expect(hashJcs(record)).toBe(ruling.evidence_hash);
    expect(record).toMatchObject({ bet_id: betId, attempt_no: attemptNo });
    expect(ruling.attempt_no).toBe(attemptNo);
    const att = (await attemptRows(betId)).find((a) => a.attempt_no === attemptNo)!;
    expect(att.id).toBe(row.attempt_id);
    expect(att.status).toBe('ruled');
    // the payout stream got it (resolve(Refund)), exactly once
    expect(ruled.filter((r) => r.betId === betId).map((r) => r.ruling.ruling_id)).toEqual([
      ruling.ruling_id,
    ]);
    return { ruling, record, row };
  }

  it('LOCKED: A asks, B agrees -> one VOID ruling through the normal machinery', async () => {
    const betId = await lockedDance();
    const ask = await callOff(A, betId, true);
    expect(ask.status).toBe(200);
    expect(ask.json).toMatchObject({ status: 'requested', ruling_hash: null });
    const expires = Date.parse(ask.json!.expires_at);
    expect(expires - Date.now()).toBeGreaterThan(CALL_OFF_TTL_MS - 5_000);
    // asking again is the same open request (a double tap, a retry)
    const again = await callOff(A, betId, true);
    expect(again.json).toMatchObject({ status: 'requested', expires_at: ask.json!.expires_at });
    expect((await betRow(betId)).state).toBe('LOCKED');
    expect(ruled.some((r) => r.betId === betId)).toBe(false);

    const agree = await callOff(B, betId, true);
    expect(agree.status).toBe(200);
    expect(agree.json).toMatchObject({ status: 'agreed', expires_at: null });
    expect((await betRow(betId)).state).toBe('JUDGING');
    const { ruling, record, row } = await expectCalledOff(betId, 1);
    expect(agree.json!.ruling_hash).toBe(row.ruling_hash);
    expect(record).toMatchObject({ requested_by: 'A', agreed_by: 'B' });

    // the attempt that never recorded: no device, so POST …/attempts can't replay it
    const att = (await attemptRows(betId))[0]!;
    expect(att.recorded_by_device_id).toBeNull();
    const start = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' });
    expect(start.status).toBe(409);
    expect(start.json!.error).toMatchObject({ code: 'INVALID_STATE' });

    // the log: the request, then one commit of JUDGING + agreed + ruling.issued + the VOIDED cue
    const log = await events(betId);
    for (const e of log) expect(parseRealtimeEvent(e).ok).toBe(true);
    const tail = log.slice(-4).map((e) => e.type);
    expect(tail).toEqual(['bet.state', 'bet.call_off', 'ruling.issued', 'judge.cue']);
    const calls = log.filter((e) => e.type === 'bet.call_off').map((e) => e.payload);
    expect(calls).toEqual([
      { status: 'requested', by: 'A', expires_at: ask.json!.expires_at },
      { status: 'agreed', by: 'B', expires_at: null },
    ]);
    expect(log.at(-4).payload).toMatchObject({ state: 'JUDGING', prev: 'LOCKED' });
    expect(log.at(-2).payload.ruling).toEqual(ruling);
    expect(log.at(-1).payload).toMatchObject({ cue: 'VOIDED' });

    // idempotent afterwards, for both; and never a second ruling
    expect((await callOff(B, betId, true)).json).toMatchObject({
      status: 'agreed',
      ruling_hash: row.ruling_hash,
    });
    expect((await callOff(A, betId, false)).json).toMatchObject({ status: 'agreed' });
    expect(await rulingRows(betId)).toHaveLength(1);
    // the appeal routes refuse a called-off bet (both agreed to the refund)
    expect(await isCalledOffBet(ctx.deps.db, betId)).toBe(true);
  });

  it('decline, withdraw, nothing open, and a lapsed request', async () => {
    const betId = await lockedDance();
    expect((await callOff(B, betId, false)).json).toMatchObject({ status: 'none' });
    expect((await callOff(A, betId, true)).json!.status).toBe('requested');
    // B keeps playing
    expect((await callOff(B, betId, false)).json).toMatchObject({ status: 'cleared' });
    // now B asks, and withdraws it
    expect((await callOff(B, betId, true)).json!.status).toBe('requested');
    expect((await callOff(B, betId, false)).json).toMatchObject({ status: 'cleared' }); // withdrawn
    // a request past its 60 s is not open: B's agree opens B's own request instead
    await ctx.deps.db.transaction((tx) =>
      appendBetEvent(tx, {
        bet_id: betId,
        type: 'bet.call_off',
        payload: {
          status: 'requested',
          by: 'A',
          expires_at: new Date(Date.now() - 1_000).toISOString(),
        },
      }),
    );
    const late = await callOff(B, betId, true);
    expect(late.json).toMatchObject({ status: 'requested' });
    expect((await betRow(betId)).state).toBe('LOCKED');
    expect(await rulingRows(betId)).toHaveLength(0);
    const calls = (await events(betId)).filter((e) => e.type === 'bet.call_off');
    expect(calls.map((e) => `${e.payload.status}:${e.payload.by}`)).toEqual([
      'requested:A',
      'cleared:B',
      'requested:B',
      'cleared:B',
      'requested:A',
      'requested:B',
    ]);
    // and A agreeing to B's open request completes it
    expect((await callOff(A, betId, true)).json!.status).toBe('agreed');
    const { record } = await expectCalledOff(betId, 1);
    expect(record).toMatchObject({ requested_by: 'B', agreed_by: 'A' });
  });

  it('ATTEMPT (still recording): the VOID rules the open attempt; the upload is then refused', async () => {
    const betId = await lockedDance();
    const start = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' });
    expect(start.status).toBe(201);
    expect((await betRow(betId)).state).toBe('ATTEMPT');
    expect((await callOff(B, betId, true)).json!.status).toBe('requested');
    expect((await callOff(A, betId, true)).json!.status).toBe('agreed');
    await expectCalledOff(betId, 1);
    expect(await attemptRows(betId)).toHaveLength(1);
    const late = await uploadDance(A, betId, 1);
    expect(late.status).toBeGreaterThanOrEqual(400);
    await judge.idle();
    expect(await rulingRows(betId)).toHaveLength(1);
  });

  it('never once a ruling is in flight or out (no escape from a decisive ruling)', async () => {
    const betId = await lockedDance();
    expect(
      (await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' })).status,
    ).toBe(201);
    // B asks while A records; then A uploads: the round is being judged
    expect((await callOff(B, betId, true)).json!.status).toBe('requested');
    expect((await uploadDance(A, betId, 1)).status).toBe(202);
    const inFlight = await callOff(A, betId, true);
    expect(inFlight.status).toBe(409);
    expect(inFlight.json!.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { state: 'JUDGING' },
    });
    await judge.idle();
    // decisive (A danced, B stood still): still no way out
    expect((await rulingRows(betId)).map((r) => r.outcome)).toEqual(['A_WINS']);
    const after = await callOff(B, betId, true);
    expect(after.status).toBe(409);
    expect(after.json!.error.details.reason).toBe('ruling_in_flight');
    await ctx.deps.db.update(bets).set({ state: 'RULED' }).where(eq(bets.id, betId));
    const ruled409 = await callOff(B, betId, true);
    expect(ruled409.status).toBe(409);
    expect(ruled409.json!.error.details).toMatchObject({ state: 'RULED', reason: 'too_late' });
    // the operator can't either
    const op = await postJson(
      ctx.base,
      `/v1/demo/bets/${betId}/void`,
      {},
      { 'X-YO-Demo-Key': ADMIN },
    );
    expect(op.status).toBe(409);
    expect((await rulingRows(betId)).map((r) => r.outcome)).toEqual(['A_WINS']);
  });

  it('JUDGING right after a REDO: the VOID takes the next attempt number', async () => {
    const betId = await lockedDance();
    // a REDO'd attempt 1, as the camera judge leaves it (the REDO never goes onchain)
    await ctx.deps.db.insert(attempts).values({
      bet_id: betId,
      attempt_no: 1,
      recorded_by_user_id: uid(B),
      recorded_by_device_id: B.session.device_id,
      recorder: 'self',
      status: 'redo',
      max_ms: 6000,
      go_at: new Date(),
    });
    await ctx.deps.db
      .update(bets)
      .set({ state: 'JUDGING', redo_count: 1 })
      .where(eq(bets.id, betId));
    expect((await callOff(A, betId, true)).json!.status).toBe('requested');
    expect((await callOff(B, betId, true)).json!.status).toBe('agreed');
    await expectCalledOff(betId, 2);
    expect((await attemptRows(betId)).map((a) => `${a.attempt_no}:${a.status}`)).toEqual([
      '1:redo',
      '2:ruled',
    ]);
    // no bet.state event: it was JUDGING already
    const tail = (await events(betId)).slice(-3).map((e) => e.type);
    expect(tail).toEqual(['bet.call_off', 'ruling.issued', 'judge.cue']);
  });

  it('only the parties; a stranger spends nothing and learns nothing', async () => {
    const betId = await lockedDance();
    const r = await callOff(C, betId, true);
    expect(r.status).toBe(403);
    expect(r.json!.error.code).toBe('NOT_A_PARTY');
    expect((await post(A, `/v1/bets/${randomUUID()}/call-off`, { agree: true })).status).toBe(404);
    expect((await post(A, `/v1/bets/${betId}/call-off`, { agree: 'yes' })).status).toBe(422);
    expect((await events(betId)).some((e) => e.type === 'bet.call_off')).toBe(false);
    expect(await isCalledOffBet(ctx.deps.db, betId)).toBe(false);
  });

  it('the operator void (demo key) does the same VOID at once; resolve-due is its backstop', async () => {
    const betId = await lockedDance();
    const path = `/v1/demo/bets/${betId}/void`;
    expect((await postJson(ctx.base, path, {})).status).toBe(404);
    expect((await postJson(ctx.base, path, {}, { 'X-YO-Demo-Key': 'wrong' })).status).toBe(404);
    const r = await postJson(ctx.base, path, {}, { 'X-YO-Demo-Key': ADMIN });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'agreed' });
    const rows = await rulingRows(betId);
    expect(rows).toHaveLength(1);
    const record = CallOffRecord.parse(JSON.parse(rows[0]!.evidence_canonical!));
    expect(record).toMatchObject({ requested_by: 'operator', agreed_by: 'operator' });
    expect(Ruling.parse(JSON.parse(rows[0]!.record_canonical)).reason).toMatch(/^Called off\./);
    // idempotent
    const again = await postJson(ctx.base, path, {}, { 'X-YO-Demo-Key': ADMIN });
    expect(again.json).toMatchObject({ status: 'agreed', ruling_hash: rows[0]!.ruling_hash });
    expect(await rulingRows(betId)).toHaveLength(1);

    // if the in-process resolve failed, the keeper's resolve-due sends it again (dated first in
    // its oldest-first batch, past other suites' JUDGING bets in a shared database)
    await ctx.deps.db
      .update(rulings)
      .set({ created_at: new Date('2001-01-01T00:00:00Z') })
      .where(eq(rulings.bet_id, betId));
    const resent: string[] = [];
    const n = await resolveDue(
      {
        db: ctx.deps.db,
        log: ctx.deps.log,
        onRuling: async (id, ruling) => {
          if (id === betId) resent.push(ruling.model);
        },
      },
      Date.now() + RESOLVE_GRACE_MS + 1_000,
    );
    expect(n).toBeGreaterThanOrEqual(1);
    expect(resent).toEqual([CALLED_OFF_MODEL]);
  });
});
