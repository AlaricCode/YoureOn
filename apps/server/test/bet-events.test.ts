/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// GET /v1/bets/:bet_id/events?after=<seq>&limit=200 (API-CONTRACT §2.14, §3.3 REST resync) over
// Postgres: who may read it (the same sessions as GET /v1/bets/:bet_id and WS subscribe), after /
// limit paging and last_seq, and parity with the socket replay (the same envelopes, verbatim).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { betEvents, bets } from '@youre-on/db';
import { BET_EVENTS_LIMIT, betEventsPath } from '@youre-on/shared/api';
import { BetEventsResponse } from '@youre-on/shared/realtime';
import { emitBetEvent } from '../src/realtime/events';
import { parseBetEventsQuery } from '../src/realtime/resync';
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

const KEY = 'stage-key-for-bet-events-tests';
const ORIGIN = 'http://localhost:5173';

describe('parseBetEventsQuery', () => {
  it('after defaults to 0 and limit to the contract 200; both are plain integers in range', () => {
    expect(parseBetEventsQuery({})).toEqual({ after: 0, limit: BET_EVENTS_LIMIT });
    expect(parseBetEventsQuery({ after: '17', limit: '50' })).toEqual({ after: 17, limit: 50 });
    expect(parseBetEventsQuery({ after: '2147483647', limit: '200' })).toEqual({
      after: 2_147_483_647,
      limit: 200,
    });
    for (const bad of [
      { after: '-1' },
      { after: '1.5' },
      { after: 'abc' },
      { after: '' },
      { after: '2147483648' },
      { limit: '0' },
      { limit: '201' },
      { limit: '1e2' },
      { limit: '' },
    ]) {
      expect(() => parseBetEventsQuery(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });
});

describeDb('GET /v1/bets/:bet_id/events over Postgres', () => {
  let ctx: Ctx;
  const sockets: WsClient[] = [];

  beforeAll(async () => {
    ctx = await startTestServer({ env: { STAGE_KEY: KEY } });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await ctx?.server.close();
  });

  const signed = (u: SignedUp, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const get = async (token: string | null, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(ctx.base + path, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    });
    const text = await res.text();
    return { res, status: res.status, json: text ? (JSON.parse(text) as any) : null };
  };
  const uid = (u: SignedUp) => u.session.user.user_id;

  async function room(owner: SignedUp, ...members: SignedUp[]) {
    const r = await signed(owner, '/v1/rooms', { name: 'Events room', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members)
      expect((await signed(m, '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    return r.json!.room_id as string;
  }
  async function stageToken(roomId: string) {
    const r = await postJson(ctx.base, '/v1/stage/session', { stage_key: KEY, room_id: roomId });
    expect(r.status).toBe(201);
    return r.json!.token as string;
  }

  /** A challenges B (seq 1 bet.invited, 2 bet.state), B accepts (3), then `lines` party.lines. */
  async function betWithLog(A: SignedUp, B: SignedUp, roomId: string, lines = 0) {
    const r = await signed(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(B),
      challenge_method: 'list',
    });
    expect(r.status).toBe(201);
    const betId = r.json!.bet.bet_id as string;
    expect((await signed(B, `/v1/bets/${betId}/invite/accept`)).status).toBe(200);
    for (let i = 0; i < lines; i++)
      await emitBetEvent(ctx.deps, {
        bet_id: betId,
        type: 'party.line',
        payload: {
          party: i % 2 ? 'B' : 'A',
          utterance_id: randomUUID(),
          text: `line ${i}`,
          final: true,
        },
      });
    const [row] = await ctx.deps.db
      .select({ last_seq: bets.last_seq })
      .from(bets)
      .where(eq(bets.id, betId));
    return { betId, lastSeq: row!.last_seq };
  }

  /** What the socket replays for `token` from after_seq, up to its `subscribed` frame. */
  async function wsReplay(token: string, betId: string, afterSeq: number) {
    const s = await connectWs(ctx.wsUrl);
    sockets.push(s);
    s.send({ op: 'hello', token, subs: [{ bet_id: betId, after_seq: afterSeq }] });
    await s.next((f) => f.op === 'welcome');
    const sub = await s.next((f) => f.op === 'subscribed' && f.bet_id === betId);
    const events = s.frames.filter((f) => !('op' in f) && f.bet_id === betId);
    s.close();
    return { events, last_seq: sub.last_seq as number, replayed: sub.replayed as number };
  }

  it('parties and stage sessions of the room read it; a non-party room member, a stranger and another room get 404', async () => {
    const [A, B, C, D] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Mia'),
      signUp(ctx.base, 'Stranger'),
    ]);
    const roomId = await room(A, B, C); // C is in the room but not in the bet
    const { betId, lastSeq } = await betWithLog(A, B, roomId);
    const path = betEventsPath(betId, 0);

    for (const u of [A, B]) {
      const r = await get(u.session.token, path);
      expect(r.status).toBe(200);
      expect(r.json.last_seq).toBe(lastSeq);
      expect(r.json.events.map((e: any) => e.type)).toEqual([
        'bet.invited',
        'bet.state',
        'bet.invite_answered',
      ]);
    }
    const stage = await stageToken(roomId);
    const s = await get(stage, path, { Origin: ORIGIN });
    expect(s.status).toBe(200);
    expect(s.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(s.json.events).toHaveLength(3);

    // Not a party: the same 404 as an unknown bet (and as GET /v1/bets/:bet_id), never a 403
    // that would confirm the id exists.
    for (const token of [C.session.token, D.session.token, await stageToken(await room(D))]) {
      const r = await get(token, path);
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe('NOT_FOUND');
      expect((await get(token, `/v1/bets/${betId}`)).status).toBe(404);
    }
    const unknown = await get(A.session.token, betEventsPath(randomUUID(), 0));
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('NOT_FOUND');
    expect((await get(A.session.token, '/v1/bets/not-a-uuid/events')).status).toBe(422);

    // No bearer / a revoked one: 401.
    const anon = await get(null, path);
    expect(anon.status).toBe(401);
    expect(anon.json.error.code).toBe('AUTH_REQUIRED');
    await fetch(ctx.base + '/v1/auth/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${D.session.token}` },
    });
    expect((await get(D.session.token, path)).status).toBe(401);

    // The socket agrees on who may see the bet: C's subscribe is refused (4403).
    const c = await connectWs(ctx.wsUrl);
    sockets.push(c);
    c.send({ op: 'hello', token: C.session.token, subs: [{ bet_id: betId, after_seq: 0 }] });
    expect((await c.closed).code).toBe(4403);
  });

  it('after / limit page through the log in seq order; last_seq is the bet head', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const { betId, lastSeq } = await betWithLog(A, B, await room(A, B), 5);
    expect(lastSeq).toBe(8);
    const token = A.session.token;

    const all = await get(token, `/v1/bets/${betId}/events`); // after=0, limit=200 by default
    expect(all.status).toBe(200);
    const full = BetEventsResponse.parse(all.json);
    expect(full.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(full.last_seq).toBe(8);
    expect(full.events.every((e) => e.bet_id === betId && e.v === 1)).toBe(true);

    // Pages of 3: the client asks again with after = the last seq it got, until last_seq.
    const pages: number[][] = [];
    let after = 0;
    for (;;) {
      const r = await get(token, betEventsPath(betId, after, 3));
      expect(r.status).toBe(200);
      const p = BetEventsResponse.parse(r.json);
      expect(p.last_seq).toBe(8);
      if (p.events.length === 0) break;
      pages.push(p.events.map((e) => e.seq));
      after = p.events.at(-1)!.seq;
    }
    expect(pages).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8],
    ]);
    // The pages together are the whole log, envelope for envelope.
    const joined: unknown[] = [];
    for (const from of [0, 3, 6])
      joined.push(...(await get(token, betEventsPath(betId, from, 3))).json.events);
    expect(joined).toEqual(all.json.events);

    expect(
      (await get(token, betEventsPath(betId, 2, 1))).json.events.map((e: any) => e.seq),
    ).toEqual([3]);
    // At or past the head: nothing, and the head says so.
    for (const from of [8, 50]) {
      const r = await get(token, betEventsPath(betId, from));
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ events: [], last_seq: 8 });
    }
    // A new event moves the head.
    const e9 = await emitBetEvent(ctx.deps, {
      bet_id: betId,
      type: 'terms.declined',
      payload: { party: 'B' },
    });
    expect((await get(token, betEventsPath(betId, 8))).json).toEqual({ events: [e9], last_seq: 9 });

    for (const q of ['after=-1', 'after=x', 'limit=0', 'limit=201', 'limit=2.5']) {
      const r = await get(token, `/v1/bets/${betId}/events?${q}`);
      expect(r.status, q).toBe(422);
      expect(r.json.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('returns exactly what the socket replays to the same session, after any seq (no fork of its rules)', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const roomId = await room(A, B);
    const { betId, lastSeq } = await betWithLog(A, B, roomId, 4);
    const stage = await stageToken(roomId);

    for (const token of [A.session.token, B.session.token, stage]) {
      for (const after of [0, 2, lastSeq - 1, lastSeq]) {
        const ws = await wsReplay(token, betId, after);
        const rest = await get(token, betEventsPath(betId, after));
        expect(rest.status).toBe(200);
        // Same envelopes, same order, byte for byte (no per-recipient filtering or redaction
        // on either path), and the same head.
        expect(rest.json.events).toEqual(ws.events);
        expect(rest.json.events).toHaveLength(ws.replayed);
        expect(rest.json.last_seq).toBe(ws.last_seq);
        expect(JSON.stringify(rest.json.events)).toBe(JSON.stringify(ws.events));
      }
    }
    // And both are the stored rows.
    const rows = await ctx.deps.db
      .select({ envelope: betEvents.envelope })
      .from(betEvents)
      .where(eq(betEvents.bet_id, betId))
      .orderBy(betEvents.seq);
    expect((await get(A.session.token, betEventsPath(betId, 0))).json.events).toEqual(
      rows.map((r) => r.envelope),
    );
  });

  it('a stored envelope that fails the shared RealtimeEvent schema is left out (clients drop it anyway)', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const { betId } = await betWithLog(A, B, await room(A, B));
    // seq 4: a type no client knows, written the way appendBetEvent would.
    await ctx.deps.db.transaction(async (tx) => {
      const [r] = await tx
        .update(bets)
        .set({ last_seq: sql`${bets.last_seq} + 1` })
        .where(eq(bets.id, betId))
        .returning({ seq: bets.last_seq });
      const envelope = {
        v: 1,
        type: 'future.thing',
        bet_id: betId,
        seq: r!.seq,
        ts: new Date().toISOString(),
        source: 'server',
        payload: {},
      };
      await tx.insert(betEvents).values({
        bet_id: betId,
        seq: r!.seq,
        type: envelope.type,
        source: 'server',
        envelope,
      });
    });
    const e5 = await emitBetEvent(ctx.deps, {
      bet_id: betId,
      type: 'terms.declined',
      payload: { party: 'B' },
    });
    const r = await get(A.session.token, betEventsPath(betId, 2));
    expect(r.status).toBe(200);
    expect(BetEventsResponse.parse(r.json).events.map((e) => e.seq)).toEqual([3, 5]);
    expect(r.json.events.at(-1)).toEqual(e5);
    expect(r.json.last_seq).toBe(5);
  });
});
