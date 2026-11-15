// The WS hub against Postgres (skips without DATABASE_URL): session-token hello, party-only
// bet subscriptions, stage-scope room fan-out, gapless seq from bet_events, replay on reconnect.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apiSessions, betEvents, bets, roomMembers, rooms } from '@youre-on/db';
import { WS_CLOSE } from '@youre-on/shared/api';
import { sha256Hex } from '../src/crypto';
import { emitBetEvent } from '../src/realtime/events';
import { connectWs, describeDb, signUp, startTestServer, type Ctx, type SignedUp } from './helpers';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const roomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
};

describeDb('realtime over Postgres', () => {
  let ctx: Ctx;
  let A: SignedUp, B: SignedUp, C: SignedUp;
  let roomId: string, betId: string, stageToken: string;

  beforeAll(async () => {
    ctx = await startTestServer();
    [A, B, C] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Stranger'),
    ]);
    const db = ctx.deps.db;
    const [room] = await db
      .insert(rooms)
      .values({ code: roomCode(), created_by: A.session.user.user_id })
      .returning();
    roomId = room!.id;
    await db.insert(roomMembers).values([
      { room_id: roomId, user_id: A.session.user.user_id, joined_via: 'code' },
      { room_id: roomId, user_id: B.session.user.user_id, joined_via: 'code' },
    ]);
    const [bet] = await db
      .insert(bets)
      .values({
        room_id: roomId,
        party_a_id: A.session.user.user_id,
        party_b_id: B.session.user.user_id,
        challenge_method: 'list',
        mint: MINT,
      })
      .returning();
    betId = bet!.id;
    stageToken = 'yo_s_' + randomBytes(32).toString('base64url');
    await db
      .insert(apiSessions)
      .values({ token_sha256: sha256Hex(stageToken), scopes: ['stage'], room_id: roomId });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  it('emitBetEvent assigns gapless seq, persists the envelope, and fans out to the party live', async () => {
    const e1 = await emitBetEvent(ctx.deps, {
      bet_id: betId,
      type: 'bet.invited',
      payload: { challenger: A.session.user, room_id: roomId },
    });
    expect(e1).toMatchObject({ v: 1, seq: 1, source: 'server', type: 'bet.invited' });

    const b = await connectWs(ctx.wsUrl);
    b.send({
      op: 'hello',
      token: B.session.token,
      device_id: B.session.device_id,
      subs: [{ bet_id: betId, after_seq: 0 }],
    });
    expect(await b.next((f) => f.op === 'welcome')).toMatchObject({ user_channel: true });
    expect(await b.next((f) => f.seq === 1)).toEqual(e1);
    expect(await b.next((f) => f.op === 'subscribed')).toMatchObject({
      bet_id: betId,
      last_seq: 1,
      replayed: 1,
    });

    const e2 = await emitBetEvent(ctx.deps, {
      bet_id: betId,
      type: 'bet.state',
      payload: {
        state: 'DRAFTING',
        prev: null,
        onchain_status: null,
        chain_ack: 'none',
        pending_tx: null,
        reason: null,
      },
    });
    expect(e2.seq).toBe(2);
    expect(await b.next((f) => f.seq === 2)).toEqual(e2);

    const rows = await ctx.deps.db.select().from(betEvents).where(eq(betEvents.bet_id, betId));
    expect(rows.map((r) => [r.seq, r.type, r.source])).toEqual([
      [1, 'bet.invited', 'server'],
      [2, 'bet.state', 'server'],
    ]);
    const [bet] = await ctx.deps.db
      .select({ last_seq: bets.last_seq })
      .from(bets)
      .where(eq(bets.id, betId));
    expect(bet!.last_seq).toBe(2);
    b.close();

    // Reconnect with after_seq = 1: only seq 2 is replayed.
    const b2 = await connectWs(ctx.wsUrl);
    b2.send({ op: 'hello', token: B.session.token, subs: [{ bet_id: betId, after_seq: 1 }] });
    expect((await b2.next((f) => typeof f.seq === 'number')).seq).toBe(2);
    expect(await b2.next((f) => f.op === 'subscribed')).toMatchObject({ last_seq: 2, replayed: 1 });
    b2.close();
  });

  it('a non-party is closed with 4403; a stage token of the room may subscribe', async () => {
    const c = await connectWs(ctx.wsUrl);
    c.send({ op: 'hello', token: C.session.token, subs: [] });
    await c.next((f) => f.op === 'welcome');
    c.send({ op: 'subscribe', bet_id: betId, after_seq: 0 });
    expect((await c.closed).code).toBe(WS_CLOSE.FORBIDDEN);

    const stage = await connectWs(ctx.wsUrl);
    stage.send({ op: 'hello', token: stageToken, subs: [{ bet_id: betId, after_seq: 0 }] });
    expect(await stage.next((f) => f.op === 'welcome')).toMatchObject({ user_channel: false });
    await stage.next((f) => f.op === 'subscribed');
    stage.send({ op: 'subscribe_room', room_id: roomId });
    await new Promise((r) => setTimeout(r, 50));
    ctx.deps.hub.publishToRoom(roomId, { op: 'stage.cue', bet_id: betId, kind: 'gavel' });
    expect(await stage.next((f) => f.op === 'stage.cue')).toMatchObject({ kind: 'gavel' });
    stage.close();
  });

  it('room members may subscribe_room; non-members get 4403; a revoked session token gets 4401', async () => {
    const a = await connectWs(ctx.wsUrl);
    a.send({ op: 'hello', token: A.session.token, subs: [] });
    await a.next((f) => f.op === 'welcome');
    a.send({ op: 'subscribe_room', room_id: roomId });
    await new Promise((r) => setTimeout(r, 50));
    ctx.deps.hub.publishToRoom(roomId, { op: 'room.presence', room_id: roomId, members: [] });
    await a.next((f) => f.op === 'room.presence');
    a.close();

    const c = await connectWs(ctx.wsUrl);
    c.send({ op: 'hello', token: C.session.token, subs: [] });
    await c.next((f) => f.op === 'welcome');
    c.send({ op: 'subscribe_room', room_id: roomId });
    expect((await c.closed).code).toBe(WS_CLOSE.FORBIDDEN);

    await fetch(ctx.base + '/v1/auth/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${C.session.token}` },
    });
    const revoked = await connectWs(ctx.wsUrl);
    revoked.send({ op: 'hello', token: C.session.token, subs: [] });
    expect((await revoked.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it("emitBetEvent reaches a stage session of the bet's room via subscribe_room alone", async () => {
    const stage = await connectWs(ctx.wsUrl);
    stage.send({ op: 'hello', token: stageToken, subs: [] });
    await stage.next((f) => f.op === 'welcome');
    stage.send({ op: 'subscribe_room', room_id: roomId });
    await new Promise((r) => setTimeout(r, 50));
    const e = await emitBetEvent(ctx.deps, {
      bet_id: betId,
      type: 'terms.declined',
      payload: { party: 'B' },
    });
    expect(await stage.next((f) => f.seq === e.seq)).toEqual(e);
    stage.close();
  });
});
