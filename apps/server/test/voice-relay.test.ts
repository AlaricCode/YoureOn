/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// A's phone relays (API-CONTRACT §2.6): POST /v1/bets/:id/voice/lines -> judge.line / party.line
// (the stage's live transcript, B's captions) and POST /v1/bets/:id/cues -> stage.cue (the stage
// plays the clip). Pure helpers first, then over HTTP + WS + Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { betEvents } from '@youre-on/db';
import { VoiceLine, VoiceLinesResponse } from '@youre-on/shared/judge/voice';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { LineDedupe, linePayload, MAX_LINES_PER_BET, normalizeLine } from '../src/voice/relay';
import {
  connectWs,
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
  type WsClient,
} from './helpers';

const AT = '2026-11-21T18:00:00.000Z';
const uuid = () => randomUUID();
const judge = (text: string, o: Partial<VoiceLine> = {}): VoiceLine => ({
  utterance_id: uuid(),
  role: 'judge',
  text,
  final: true,
  at: AT,
  ...o,
});
const party = (text: string, o: Partial<VoiceLine> = {}): VoiceLine => ({
  utterance_id: uuid(),
  role: 'party',
  party: 'A',
  text,
  final: true,
  at: AT,
  ...o,
});

describe('relay helpers', () => {
  it('VoiceLine: party is required for party lines and refused on judge lines', () => {
    expect(VoiceLine.safeParse(judge('Order.')).success).toBe(true);
    expect(VoiceLine.safeParse(party('Deal.')).success).toBe(true);
    expect(VoiceLine.safeParse({ ...party('Deal.'), party: undefined }).success).toBe(false);
    expect(VoiceLine.safeParse({ ...judge('Order.'), party: 'A' }).success).toBe(false);
    expect(VoiceLine.safeParse({ ...judge('x'), utterance_id: 'not-a-uuid' }).success).toBe(false);
  });

  it('linePayload: finals only, normalized, judge cut to 400, [EVENT] party lines dropped', () => {
    expect(normalizeLine('  so   it is\na deal ')).toBe('so it is a deal');
    const j = judge('  Bold.\n\nFive dollars   each. ');
    expect(linePayload(j)).toEqual({
      type: 'judge.line',
      payload: { utterance_id: j.utterance_id, text: 'Bold. Five dollars each.', final: true },
    });
    const p = party('Deal.', { party: 'B' });
    expect(linePayload(p)).toEqual({
      type: 'party.line',
      payload: { party: 'B', utterance_id: p.utterance_id, text: 'Deal.', final: true },
    });
    expect(linePayload(judge('Bo', { final: false }))).toBeNull();
    expect(linePayload(judge('   '))).toBeNull();
    expect(linePayload(party('[EVENT] LOCKED pot=$10 :: Announce it.'))).toBeNull();
    // A judge line may quote the event name; only a party line is the injected text.
    expect(linePayload(judge('[EVENT] noted.'))).not.toBeNull();
    const long = linePayload(judge('x'.repeat(600)))!;
    expect(long.payload.text).toHaveLength(400);
    expect(long.payload.text.endsWith('…')).toBe(true);
  });

  it('LineDedupe: first sighting only, bounded, forget lets a key through again', () => {
    const d = new LineDedupe(2);
    expect([d.first('a'), d.first('a'), d.first('b')]).toEqual([true, false, true]);
    d.first('c'); // evicts the oldest ('a')
    expect(d.first('a')).toBe(true);
    d.forget('c');
    expect(d.first('c')).toBe(true);
  });
});

const STAGE_KEY = 'stage-key-for-voice-relay';

describeDb('voice relays: POST /v1/bets/:id/voice/lines and /cues (DB)', () => {
  let ctx: Ctx;
  const sockets: WsClient[] = [];

  beforeAll(async () => {
    ctx = await startTestServer({ env: { STAGE_KEY } });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await ctx?.server.close();
  });

  const post = (u: SignedUp, path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const ws = async () => {
    const w = await connectWs(ctx.wsUrl);
    sockets.push(w);
    return w;
  };

  /** A and B in a room with a stage, a bet between them, B's phone and the stage listening. */
  async function setup() {
    const A = await signUp(ctx.base, 'Logan');
    const B = await signUp(ctx.base, 'Jake');
    const C = await signUp(ctx.base, 'Carol');
    const room = await post(A, '/v1/rooms', { name: 'Relay', kind: 'session' });
    for (const m of [B, C])
      expect((await post(m, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const roomId = room.json!.room_id as string;
    const st = await postJson(ctx.base, '/v1/stage/session', {
      stage_key: STAGE_KEY,
      room_id: roomId,
    });
    expect(st.status).toBe(201);
    const stage = await ws();
    stage.send({ op: 'hello', token: st.json!.token, subs: [] });
    await stage.next((f) => f.op === 'welcome');
    stage.send({ op: 'subscribe_room', room_id: roomId });
    const bet = await post(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    const wsB = await ws();
    wsB.send({ op: 'hello', token: B.session.token, device_id: B.session.device_id, subs: [] });
    await wsB.next((f) => f.op === 'welcome');
    wsB.send({ op: 'subscribe', bet_id: betId, after_seq: 0 });
    await wsB.next((f) => f.op === 'subscribed' && f.bet_id === betId);
    await new Promise((r) => setTimeout(r, 50)); // subscribe_room is handled async
    return { A, B, C, betId, roomId, stage, wsB };
  }

  const lineEvents = async (betId: string) =>
    (
      await ctx.deps.db
        .select({ type: betEvents.type, envelope: betEvents.envelope })
        .from(betEvents)
        .where(eq(betEvents.bet_id, betId))
        .orderBy(asc(betEvents.seq))
    ).filter((e) => e.type === 'judge.line' || e.type === 'party.line');

  it('lines -> judge.line / party.line to B and the stage; a resent batch is not re-emitted', async () => {
    const s = await setup();
    const path = `/v1/bets/${s.betId}/voice/lines`;
    const lines = [
      judge("Order. Court is in session. Logan, Jake: what's the bet?"),
      party('Bet you can not flip that bottle.'),
      judge('Bo', { final: false }),
      party('[EVENT] AUTHORIZED party=B :: Say Jake is locked in.'),
    ];
    const r = await post(s.A, path, { lines });
    expect(r.status).toBe(202);
    expect(VoiceLinesResponse.parse(r.json)).toEqual({ accepted: 2, duplicates: 0, dropped: 2 });

    const evs = await lineEvents(s.betId);
    expect(evs.map((e) => [e.type, (e.envelope as any).payload])).toEqual([
      ['judge.line', { utterance_id: lines[0]!.utterance_id, text: lines[0]!.text, final: true }],
      [
        'party.line',
        { party: 'A', utterance_id: lines[1]!.utterance_id, text: lines[1]!.text, final: true },
      ],
    ]);
    for (const w of [s.wsB, s.stage]) {
      const j = await w.next((f) => f.type === 'judge.line' && f.bet_id === s.betId);
      expect(parseRealtimeEvent(j).ok).toBe(true);
      expect(j.payload.text).toBe(lines[0]!.text);
      const p = await w.next((f) => f.type === 'party.line' && f.bet_id === s.betId);
      expect(parseRealtimeEvent(p).ok).toBe(true);
    }

    // The same lines in a new request (new Idempotency-Key): counted as repeats, nothing emitted.
    const again = await post(s.A, path, { lines });
    expect(again.json).toEqual({ accepted: 0, duplicates: 2, dropped: 2 });
    expect(await lineEvents(s.betId)).toHaveLength(2);
    // A new utterance is accepted.
    expect((await post(s.A, path, { lines: [judge('Bold.')] })).json).toMatchObject({
      accepted: 1,
    });
  });

  it('only party A (the voice host) relays; bad bodies are 422; unknown bets 404', async () => {
    const s = await setup();
    const path = `/v1/bets/${s.betId}/voice/lines`;
    const one = { lines: [judge('Order.')] };
    for (const u of [s.B, s.C]) {
      const r = await post(u, path, one);
      expect([r.status, r.json!.error.code]).toEqual([403, 'NOT_A_PARTY']);
    }
    expect((await post(s.A, `/v1/bets/${uuid()}/voice/lines`, one)).status).toBe(404);
    expect((await post(s.A, '/v1/bets/not-a-bet/voice/lines', one)).status).toBe(404);
    for (const bad of [
      { lines: [] },
      { lines: [{ ...party('x'), party: undefined }] },
      { lines: [{ ...judge('x'), text: '' }] },
      { lines: Array.from({ length: 51 }, () => judge('x')) },
      {},
    ]) {
      const r = await post(s.A, path, bad);
      expect([r.status, r.json!.error.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    // Unsigned (bearer only): 401.
    const raw = await postJson(ctx.base, path, one, {
      Authorization: `Bearer ${s.A.session.token}`,
      'Idempotency-Key': uuid(),
    });
    expect(raw.status).toBe(401);
    expect(await lineEvents(s.betId)).toHaveLength(0);
  });

  it(`at most ${MAX_LINES_PER_BET} lines are kept per bet; the rest are dropped`, async () => {
    const s = await setup();
    const path = `/v1/bets/${s.betId}/voice/lines`;
    for (let i = 0; i < MAX_LINES_PER_BET / 50; i++)
      expect(
        (
          await post(s.A, path, {
            lines: Array.from({ length: 50 }, (_, k) => judge(`l${i}-${k}`)),
          })
        ).json,
      ).toEqual({ accepted: 50, duplicates: 0, dropped: 0 });
    const extra = [judge('one too many'), judge('two too many')];
    expect((await post(s.A, path, { lines: extra })).json).toEqual({
      accepted: 0,
      duplicates: 0,
      dropped: 2,
    });
    expect(await lineEvents(s.betId)).toHaveLength(MAX_LINES_PER_BET);
  }, 30_000);

  it('cues: A relays a stage.cue to the room; B, bad kinds and unknown bets are refused', async () => {
    const s = await setup();
    const path = `/v1/bets/${s.betId}/cues`;
    const r = await post(s.A, path, { kind: 'gavel' });
    expect([r.status, r.json]).toEqual([202, { relayed: true }]);
    expect(await s.stage.next((f) => f.op === 'stage.cue')).toEqual({
      op: 'stage.cue',
      bet_id: s.betId,
      kind: 'gavel',
    });
    for (const kind of ['drumroll', 'buzzer', 'cheer'])
      expect((await post(s.A, path, { kind })).status).toBe(202);
    expect((await post(s.A, path, { kind: 'airhorn' })).status).toBe(422);
    expect((await post(s.B, path, { kind: 'gavel' })).status).toBe(403);
    expect((await post(s.A, `/v1/bets/${uuid()}/cues`, { kind: 'gavel' })).status).toBe(404);
  });
});
