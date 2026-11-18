/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// Rooms + challenge API (TASKS D0-J4; API-CONTRACT §2.3, §2.5, §3). DB-backed suites skip
// without DATABASE_URL; the pure helpers below run everywhere.
import { randomUUID } from 'node:crypto';
import { getBase58Decoder } from '@solana/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  betEvents,
  bets,
  outbox,
  roomMembers as roomMembersTable,
  rooms,
  users,
  voiceSessions,
} from '@youre-on/db';
import {
  BetSnapshot,
  CreateBetResponse,
  JoinRoomResponse,
  parseRoomCode,
  RoomPresenceResponse,
  WsRoomPresence,
} from '@youre-on/shared/api';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { asciiFold, declinedCue, eventLine, EVENT_LINE_MAX } from '../src/bets/cues';
import { maxStakeUsd } from '../src/bets/routes';
import { chainAckOf } from '../src/bets/snapshot';
import { PresenceTracker } from '../src/rooms/service';
import {
  connectWs,
  describeDb,
  newKey,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  testEnv,
  type Ctx,
  type SignedUp,
  type TestKey,
  type WsClient,
} from './helpers';

// Conversation ids are UNIQUE in voice_sessions: fresh per run so reruns on one DB pass.
const RUN = randomUUID().slice(0, 8);
const CONV_TEST_1 = `conv_${RUN}_1`;
const CONV_TEST_OWNED = `conv_${RUN}_owned`;
const CONV_TEST_PREMINTED = `conv_${RUN}_preminted`;

// ---- pure helpers ----------------------------------------------------------------------

describe('room codes', () => {
  it('parses typed codes (trimmed, upper-cased) and exact youreon:// QR payloads', () => {
    expect(parseRoomCode('UBC26X')).toBe('UBC26X');
    expect(parseRoomCode('  ubc26x ')).toBe('UBC26X');
    expect(parseRoomCode('youreon://room/UBC26X')).toBe('UBC26X');
    expect(parseRoomCode('youreon://room/ubc26x')).toBeNull(); // QR payloads are exact
    expect(parseRoomCode('UBC26O')).toBeNull(); // no O
    expect(parseRoomCode('UBC261')).toBeNull(); // no 1
    expect(parseRoomCode('UBC26XX')).toBeNull();
    expect(parseRoomCode('https://evil/room/UBC26X')).toBeNull();
  });
});

describe('[EVENT] lines (§4.5)', () => {
  it('DECLINED matches the §4.5 example', () => {
    expect(declinedCue('Jake')).toEqual({
      cue: 'DECLINED',
      text: '[EVENT] DECLINED name=Jake :: Say Jake passed. Nothing moved.',
      speak: true,
    });
  });
  it('is ASCII, quotes values with spaces, and stays within 300 chars', () => {
    expect(asciiFold('Zoë')).toBe('Zoe');
    expect(asciiFold('Zoë')).toBe('Zoe');
    expect(asciiFold('a\nb‮c')).toBe('a b?c');
    expect(eventLine('DECLINED', { name: 'Mary Jane' }, 'x')).toBe(
      '[EVENT] DECLINED name="Mary Jane" :: x',
    );
    expect(eventLine('DECLINED', { said: 'a "b"' }, 'x')).toBe(
      `[EVENT] DECLINED said="a 'b'" :: x`,
    );
    const long = eventLine('DECLINED', { name: 'x' }, 'y'.repeat(400));
    expect(long.length).toBe(EVENT_LINE_MAX);
    expect(/^[\x20-\x7e]*$/.test(declinedCue('张伟 Zoë').text)).toBe(true);
  });
  it('truncation shortens the instruction and never cuts a quoted value open', () => {
    const said = 'word '.repeat(40).trim(); // 199 chars, quoted
    const line = eventLine('DECLINED', { name: 'Mary Jane', said }, 'z'.repeat(400));
    expect(line.length).toBe(EVENT_LINE_MAX);
    expect(line).toContain(`said="${said}" :: `);
    expect(line.endsWith('...')).toBe(true);
    expect((line.match(/"/g) ?? []).length % 2).toBe(0);
  });
  it('max_stake_usd is the whole-dollar string the agent expects', () => {
    expect(maxStakeUsd(testEnv())).toBe('20');
    expect(maxStakeUsd(testEnv({ MAX_STAKE_MICRO: '5000000' }))).toBe('5');
    expect(maxStakeUsd(testEnv({ MAX_STAKE_MICRO: '2500000' }))).toBe('2.50');
  });
});

describe('chainAckOf (DATA-MODEL §8.4, SCHEMAS §9.2)', () => {
  it("is 'rpc' while onchain_pending is set, even when an older status is stream-confirmed", () => {
    expect(chainAckOf({ onchain_status: 'none', onchain_pending: null })).toBe('none');
    expect(chainAckOf({ onchain_status: 'none', onchain_pending: 'locked' })).toBe('rpc');
    expect(chainAckOf({ onchain_status: 'locked', onchain_pending: null })).toBe('stream');
    // RULED entered on our own RPC confirm: Streams has only echoed the lock so far.
    expect(chainAckOf({ onchain_status: 'locked', onchain_pending: 'resolved' })).toBe('rpc');
  });
});

describe('PresenceTracker (§2.3: online = a live WS within 30 s)', () => {
  it('stays online through the grace period after the last socket closes', () => {
    let t = 1_000_000;
    let online = false;
    let listener: ((u: string, o: boolean) => void) | null = null;
    const chain = { set: () => chain, where: () => chain, returning: async () => [] };
    const tracker = new PresenceTracker(
      {
        db: { update: () => chain } as any,
        hub: {
          onPresence: (l: any) => ((listener = l), () => (listener = null)),
          isUserOnline: () => online,
        } as any,
        log: { warn() {}, info() {}, error() {}, debug() {} } as any,
        now: () => t,
      },
      30_000,
    );
    const u = '00000000-0000-4000-8000-000000000001';
    expect(tracker.isOnline(u)).toBe(false);
    online = true;
    listener!(u, true);
    expect(tracker.isOnline(u)).toBe(true);
    online = false;
    listener!(u, false);
    t += 29_000;
    expect(tracker.isOnline(u)).toBe(true);
    t += 2_000;
    expect(tracker.isOnline(u)).toBe(false);
    tracker.stop();
    expect(listener).toBeNull();
  });
});

// ---- API over Postgres -----------------------------------------------------------------

describeDb('rooms and challenge API over Postgres', () => {
  let ctx: Ctx;
  const sockets: WsClient[] = [];

  beforeAll(async () => {
    ctx = await startTestServer();
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await ctx?.server.close();
  });

  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, method, path, raw));
  };
  const post = (u: SignedUp, path: string, body?: unknown) => signed(u, 'POST', path, body);
  const get = async (u: SignedUp, path: string) => {
    const res = await fetch(ctx.base + path, {
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const uid = (u: SignedUp) => u.session.user.user_id;

  async function ws(u: SignedUp): Promise<WsClient> {
    const s = await connectWs(ctx.wsUrl);
    sockets.push(s);
    s.send({ op: 'hello', token: u.session.token, device_id: u.session.device_id });
    await s.next((f) => f.op === 'welcome');
    return s;
  }
  /** The hub handles a socket's frames in order: an error reply proves earlier ones ran. */
  async function sync(s: WsClient) {
    s.send({ op: 'sync-probe' });
    await s.next((f) => f.op === 'error' && f.code === 'VALIDATION_FAILED');
  }

  async function newRoom(owner: SignedUp, ...members: SignedUp[]) {
    const r = await post(owner, '/v1/rooms', { name: 'Test room', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members) {
      const j = await post(m, '/v1/rooms/join', { code: r.json!.code });
      expect(j.status).toBe(200);
    }
    return r.json as { room_id: string; code: string; qr_payload: string; expires_at: string };
  }

  async function challenge(a: SignedUp, b: SignedUp, roomId: string, extra: object = {}) {
    return post(a, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(b),
      challenge_method: 'list',
      ...extra,
    });
  }

  // ---- §2.3 rooms ----

  it('POST /v1/rooms creates a room, joins the creator, returns code + youreon:// QR payload', async () => {
    const A = await signUp(ctx.base, 'Logan');
    const r = await post(A, '/v1/rooms', { name: 'Hack night', kind: 'session' });
    expect(r.status).toBe(201);
    expect(r.json!.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(r.json!.qr_payload).toBe(`youreon://room/${r.json!.code}`);
    const ttl = Date.parse(r.json!.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(11.9 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(12 * 3600_000);
    const p = await get(A, `/v1/rooms/${r.json!.room_id}/presence`);
    expect(p.status).toBe(200);
    const members = RoomPresenceResponse.parse(p.json).members;
    expect(members.map((m) => m.user.user_id)).toEqual([uid(A)]);
    expect(members[0]).toMatchObject({ face_enrolled: false, online: false });
  });

  it('join by typed code or QR payload; unknown -> 404, malformed -> 422, closed -> 410 ROOM_EXPIRED', async () => {
    const [A, B, C] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Mia'),
    ]);
    const room = await newRoom(A);
    const jb = await post(B, '/v1/rooms/join', { code: room.code.toLowerCase() });
    expect(jb.status).toBe(200);
    const parsed = JoinRoomResponse.parse(jb.json);
    expect(parsed.room).toMatchObject({ room_id: room.room_id, code: room.code, kind: 'session' });
    expect(parsed.members.map((m) => m.user.user_id)).toEqual([uid(A), uid(B)]);

    const jc = await post(C, '/v1/rooms/join', { qr_payload: room.qr_payload });
    expect(jc.status).toBe(200);
    expect(jc.json!.members).toHaveLength(3);

    expect((await post(C, '/v1/rooms/join', { code: 'ZZZZZZ' })).json!.error.code).toBe(
      'NOT_FOUND',
    );
    const bad = await post(C, '/v1/rooms/join', { qr_payload: `https://x/${room.code}` });
    expect(bad.status).toBe(422);
    expect(bad.json!.error.code).toBe('VALIDATION_FAILED');
    expect((await post(C, '/v1/rooms/join', { code: 'O0I1!!' })).status).toBe(422);
    expect(
      (await post(C, '/v1/rooms/join', { code: room.code, qr_payload: room.qr_payload })).status,
    ).toBe(422);

    await ctx.deps.db
      .update(rooms)
      .set({ closed_at: new Date() })
      .where(eq(rooms.id, room.room_id));
    const gone = await post(C, '/v1/rooms/join', { code: room.code });
    expect(gone.status).toBe(410);
    expect(gone.json!.error.code).toBe('ROOM_EXPIRED');
  });

  it('leave -> 204 (idempotent); a re-join clears left_at; non-members get NOT_IN_ROOM', async () => {
    const [A, B, C] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Stranger'),
    ]);
    const room = await newRoom(A, B);
    const leave = `/v1/rooms/${room.room_id}/leave`;
    expect((await post(B, leave)).status).toBe(204);
    expect((await post(B, leave)).status).toBe(204);
    const p = RoomPresenceResponse.parse((await get(A, `/v1/rooms/${room.room_id}/presence`)).json);
    expect(p.members.map((m) => m.user.user_id)).toEqual([uid(A)]);
    // B left: B can no longer read presence; C never joined.
    expect((await get(B, `/v1/rooms/${room.room_id}/presence`)).json!.error.code).toBe(
      'NOT_IN_ROOM',
    );
    const cp = await get(C, `/v1/rooms/${room.room_id}/presence`);
    expect(cp.status).toBe(403);
    expect(cp.json!.error.code).toBe('NOT_IN_ROOM');
    expect((await post(C, leave)).json!.error.code).toBe('NOT_IN_ROOM');
    expect((await get(C, `/v1/rooms/not-a-uuid/presence`)).status).toBe(404);

    expect((await post(B, '/v1/rooms/join', { code: room.code })).status).toBe(200);
    const again = RoomPresenceResponse.parse(
      (await get(B, `/v1/rooms/${room.room_id}/presence`)).json,
    );
    expect(again.members.map((m) => m.user.user_id).sort()).toEqual([uid(A), uid(B)].sort());
  });

  it('a member who leaves stops receiving room.presence on their open socket', async () => {
    const [A, B, C] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Priya'),
    ]);
    const room = await newRoom(A, B);
    const a = await ws(A);
    const b = await ws(B);
    a.send({ op: 'subscribe_room', room_id: room.room_id });
    b.send({ op: 'subscribe_room', room_id: room.room_id });
    await Promise.all([sync(a), sync(b)]);

    expect((await post(B, `/v1/rooms/${room.room_id}/leave`)).status).toBe(204);
    await a.next((f) => f.op === 'room.presence' && f.members.length === 1);
    const bSeen = b.frames.length;

    // C joins: A gets the new member list, B (left, socket still open) gets nothing.
    expect((await post(C, '/v1/rooms/join', { code: room.code })).status).toBe(200);
    await a.next(
      (f) => f.op === 'room.presence' && f.members.some((m: any) => m.user.user_id === uid(C)),
    );
    await sync(b);
    expect(b.frames.slice(bSeen).filter((f) => f.op === 'room.presence')).toEqual([]);
  });

  it('room.presence frames: pushed on join, leave, and when a member comes online', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A);
    const a = await ws(A);
    a.send({ op: 'subscribe_room', room_id: room.room_id });
    await sync(a);

    expect((await post(B, '/v1/rooms/join', { code: room.code })).status).toBe(200);
    const onJoin = WsRoomPresence.parse(
      await a.next((f) => f.op === 'room.presence' && f.members.length === 2),
    );
    expect(onJoin.room_id).toBe(room.room_id);
    const bOnJoin = onJoin.members.find((m) => m.user.user_id === uid(B))!;
    const aOnJoin = onJoin.members.find((m) => m.user.user_id === uid(A))!;
    expect(aOnJoin.online).toBe(true); // A's socket is live
    expect(bOnJoin.online).toBe(false);

    await ws(B); // B comes online -> a frame with B online
    await a.next(
      (f) =>
        f.op === 'room.presence' &&
        f.members.some((m: any) => m.user.user_id === uid(B) && m.online === true),
    );
    const p = RoomPresenceResponse.parse((await get(A, `/v1/rooms/${room.room_id}/presence`)).json);
    expect(p.members.find((m) => m.user.user_id === uid(B))!.online).toBe(true);

    expect((await post(B, `/v1/rooms/${room.room_id}/leave`)).status).toBe(204);
    await a.next((f) => f.op === 'room.presence' && f.members.length === 1);
  });

  it('room.presence: a member goes offline once the grace after their last socket ends', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    // A second tracker on the same hub with a short grace (the app's own one uses 30 s).
    const fast = new PresenceTracker(ctx.deps, 150);
    try {
      const a = await ws(A);
      a.send({ op: 'subscribe_room', room_id: room.room_id });
      await sync(a);
      const b = await ws(B);
      await a.next(
        (f) =>
          f.op === 'room.presence' &&
          f.members.some((m: any) => m.user.user_id === uid(B) && m.online === true),
      );
      const [before] = await ctx.deps.db
        .select({ t: roomMembersTable.last_seen_at })
        .from(roomMembersTable)
        .where(
          and(eq(roomMembersTable.room_id, room.room_id), eq(roomMembersTable.user_id, uid(B))),
        );
      b.close();
      // Presence broadcasts are async and unordered across trackers: a frame computed before
      // B connected (B offline, older last_seen_at) can still arrive after B's online frame.
      // Only accept an offline frame computed after `before`.
      const off = WsRoomPresence.parse(
        await a.next(
          (f) =>
            f.op === 'room.presence' &&
            f.members.some(
              (m: any) =>
                m.user.user_id === uid(B) &&
                m.online === false &&
                Date.parse(m.last_seen_at) >= before!.t.getTime(),
            ),
        ),
      );
      const bOff = off.members.find((m) => m.user.user_id === uid(B))!;
      expect(Date.parse(bOff.last_seen_at)).toBeGreaterThanOrEqual(before!.t.getTime());
      expect(off.members.find((m) => m.user.user_id === uid(A))!.online).toBe(true);
    } finally {
      fast.stop();
    }
  });

  // ---- §2.5 challenge (DoD) ----

  it('DoD: a non-member gets NOT_IN_ROOM (caller or opponent)', async () => {
    const [A, B, C] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Outsider'),
    ]);
    const room = await newRoom(A, B);
    const byOutsider = await challenge(C, B, room.room_id);
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.json!.error).toMatchObject({ code: 'NOT_IN_ROOM', details: { party: 'A' } });
    const ofOutsider = await challenge(A, C, room.room_id);
    expect(ofOutsider.status).toBe(403);
    expect(ofOutsider.json!.error).toMatchObject({ code: 'NOT_IN_ROOM', details: { party: 'B' } });
    // Someone who left is no longer challengeable.
    await post(B, `/v1/rooms/${room.room_id}/leave`);
    expect((await challenge(A, B, room.room_id)).json!.error.code).toBe('NOT_IN_ROOM');
    const n = await ctx.deps.db.select().from(bets).where(eq(bets.room_id, room.room_id));
    expect(n).toHaveLength(0);
  });

  it('DoD: a self-challenge gets VALIDATION_FAILED', async () => {
    const A = await signUp(ctx.base, 'Logan');
    const room = await newRoom(A);
    const r = await challenge(A, A, room.room_id);
    expect(r.status).toBe(422);
    expect(r.json!.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'self_challenge' },
    });
  });

  it("challenge_method 'face' without a valid match_ticket -> VALIDATION_FAILED (ticket check is D4-M1)", async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    for (const extra of [{}, { match_ticket: 'mt_forged' }]) {
      const r = await challenge(A, B, room.room_id, { challenge_method: 'face', ...extra });
      expect(r.status).toBe(422);
      expect(r.json!.error.details.reason).toBe('match_ticket_invalid');
    }
  });

  it('AGE_REQUIRED when either party is not attested 18+', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    await ctx.deps.db
      .update(users)
      .set({ age_attested_18plus: false })
      .where(eq(users.id, uid(B)));
    const r = await challenge(A, B, room.room_id);
    expect(r.status).toBe(403);
    expect(r.json!.error).toMatchObject({ code: 'AGE_REQUIRED', details: { party: 'B' } });
  });

  it("DoD: B's socket receives bet.invited (seq 1) then bet.state DRAFTING (seq 2); effects are persisted", async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    const b = await ws(B);

    const r = await challenge(A, B, room.room_id, { voice_conversation_id: CONV_TEST_1 });
    expect(r.status).toBe(201);
    const body = CreateBetResponse.parse(r.json);
    const betId = body.bet.bet_id;
    expect(betId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.bet).toMatchObject({
      state: 'DRAFTING',
      prev_state: null,
      onchain_status: null,
      chain_ack: 'none',
      my_party: 'A',
      room_id: room.room_id,
      last_seq: 2,
      party_a: { user_id: uid(A), display_name: 'Logan' },
      party_b: { user_id: uid(B), display_name: 'Jake' },
    });
    expect(body.voice.dynamic_variables).toEqual({
      bet_id: betId,
      party_a_name: 'Logan',
      party_b_name: 'Jake',
      max_stake_usd: '20',
    });

    // B's user channel: bet.invited (seq 1), a valid SCHEMAS RealtimeEvent.
    const invited = await b.next((f) => f.type === 'bet.invited');
    const pi = parseRealtimeEvent(invited);
    expect(pi.ok).toBe(true);
    expect(invited).toMatchObject({
      v: 1,
      bet_id: betId,
      seq: 1,
      source: 'server',
      payload: { challenger: { user_id: uid(A) }, room_id: room.room_id },
    });
    // B opens the invite card and subscribes from where it is: bet.state DRAFTING (seq 2).
    b.send({ op: 'subscribe', bet_id: betId, after_seq: 1 });
    const drafting = await b.next((f) => f.type === 'bet.state');
    expect(parseRealtimeEvent(drafting).ok).toBe(true);
    expect(drafting).toMatchObject({
      seq: 2,
      payload: { state: 'DRAFTING', prev: null, chain_ack: 'none', pending_tx: null },
    });
    expect(await b.next((f) => f.op === 'subscribed')).toMatchObject({ last_seq: 2, replayed: 1 });
    const order = b.frames.filter((f) => f.bet_id === betId && f.seq).map((f) => f.type);
    expect(order).toEqual(['bet.invited', 'bet.state']);

    // A fresh subscriber from 0 replays both, in order.
    const a = await ws(A);
    a.send({ op: 'subscribe', bet_id: betId, after_seq: 0 });
    await a.next((f) => f.op === 'subscribed');
    expect(a.frames.filter((f) => f.bet_id === betId && f.seq).map((f) => f.seq)).toEqual([1, 2]);

    const db = ctx.deps.db;
    const ev = await db
      .select()
      .from(betEvents)
      .where(eq(betEvents.bet_id, betId))
      .orderBy(asc(betEvents.seq));
    expect(ev.map((e) => [e.seq, e.type])).toEqual([
      [1, 'bet.invited'],
      [2, 'bet.state'],
    ]);
    const [push] = await db.select().from(outbox).where(eq(outbox.bet_id, betId));
    expect(push).toMatchObject({
      recipient_user_id: uid(B),
      kind: 'challenge_received',
      status: 'pending',
      dedupe_key: `${betId}:challenge_received:${betId}:${uid(B)}`,
    });
    expect(push!.payload).toMatchObject({ challenger: { display_name: 'Logan' } });
    const [vs] = await db
      .select()
      .from(voiceSessions)
      .where(eq(voiceSessions.el_conversation_id, CONV_TEST_1));
    expect(vs).toMatchObject({
      bet_id: betId,
      user_id: uid(A),
      device_id: A.session.device_id,
      purpose: 'terms',
      status: 'active',
    });
    const [row] = await db.select().from(bets).where(eq(bets.id, betId));
    expect(row).toMatchObject({
      challenge_method: 'list',
      lock_mode: 'atomic',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      onchain_status: 'none',
    });
  });

  it('DoD: a second pre-lock bet for the same pair gets 409 pair_busy (either direction, even concurrently)', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    const results = await Promise.all([
      challenge(A, B, room.room_id),
      challenge(A, B, room.room_id),
      challenge(B, A, room.room_id),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.json!.error).toMatchObject({
        code: 'INVALID_STATE',
        details: { reason: 'pair_busy', state: 'DRAFTING' },
      });
    }
    const rows = await ctx.deps.db.select().from(bets).where(eq(bets.room_id, room.room_id));
    expect(rows).toHaveLength(1);
  });

  it('accept: B only, emits bet.invite_answered once, state unchanged', async () => {
    const [A, B, C] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Mia'),
    ]);
    const room = await newRoom(A, B, C);
    const betId = (await challenge(A, B, room.room_id)).json!.bet.bet_id as string;
    const accept = `/v1/bets/${betId}/invite/accept`;
    const byA = await post(A, accept);
    expect(byA.status).toBe(403);
    expect(byA.json!.error.code).toBe('NOT_A_PARTY');
    expect((await post(C, accept)).json!.error.code).toBe('NOT_A_PARTY');
    expect(
      (await post(B, `/v1/bets/00000000-0000-4000-8000-00000000dead/invite/accept`)).status,
    ).toBe(404);

    const a = await ws(A);
    a.send({ op: 'subscribe', bet_id: betId, after_seq: 2 });
    await a.next((f) => f.op === 'subscribed');

    const ok = await post(B, accept);
    expect(ok.status).toBe(200);
    const snap = BetSnapshot.parse(ok.json!.bet);
    expect(snap).toMatchObject({ state: 'DRAFTING', my_party: 'B', last_seq: 3 });
    expect(await a.next((f) => f.type === 'bet.invite_answered')).toMatchObject({
      seq: 3,
      payload: { party: 'B', answer: 'accepted' },
    });
    const again = await post(B, accept);
    expect(again.status).toBe(200);
    expect(again.json!.bet.last_seq).toBe(3); // idem (bet_id, 'B'): no second event
  });

  it("DoD: B's decline -> CANCELLED (declined), terms.declined + judge.cue DECLINED; the pair is free again", async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    const betId = (await challenge(A, B, room.room_id)).json!.bet.bet_id as string;
    const decline = `/v1/bets/${betId}/invite/decline`;

    const a = await ws(A);
    a.send({ op: 'subscribe', bet_id: betId, after_seq: 2 });
    await a.next((f) => f.op === 'subscribed');

    expect((await post(A, decline)).json!.error.code).toBe('NOT_A_PARTY');
    const r = await post(B, decline);
    expect(r.status).toBe(200);
    const snap = BetSnapshot.parse(r.json!.bet);
    expect(snap).toMatchObject({
      state: 'CANCELLED',
      prev_state: 'DRAFTING',
      end_reason: 'declined',
      my_party: 'B',
      last_seq: 6,
    });

    const state = await a.next((f) => f.type === 'bet.state');
    expect(parseRealtimeEvent(state).ok).toBe(true);
    expect(state.payload).toMatchObject({
      state: 'CANCELLED',
      prev: 'DRAFTING',
      reason: 'declined',
    });
    const cue = await a.next((f) => f.type === 'judge.cue');
    expect(cue.payload).toEqual({
      cue: 'DECLINED',
      text: '[EVENT] DECLINED name=Jake :: Say Jake passed. Nothing moved.',
      speak: true,
    });
    const seqs = a.frames.filter((f) => f.bet_id === betId && f.seq).map((f) => [f.seq, f.type]);
    expect(seqs).toEqual([
      [3, 'bet.invite_answered'],
      [4, 'terms.declined'],
      [5, 'bet.state'],
      [6, 'judge.cue'],
    ]);
    const [row] = await ctx.deps.db.select().from(bets).where(eq(bets.id, betId));
    expect(row).toMatchObject({ state: 'CANCELLED', end_reason: 'declined' });

    // Repeat decline: same answer, no new events. Accept after decline: refused.
    const again = await post(B, decline);
    expect(again.status).toBe(200);
    expect(again.json!.bet.last_seq).toBe(6);
    expect((await post(B, `/v1/bets/${betId}/invite/accept`)).json!.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'already_declined' },
    });
    // The pair is no longer busy.
    expect((await challenge(A, B, room.room_id)).status).toBe(201);
  });

  it('accept -> decline -> accept: the later accept is refused (already_declined), never a 200 on a CANCELLED bet', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    const betId = (await challenge(A, B, room.room_id)).json!.bet.bet_id as string;
    expect((await post(B, `/v1/bets/${betId}/invite/accept`)).status).toBe(200);
    const d = await post(B, `/v1/bets/${betId}/invite/decline`);
    expect(d.status).toBe(200);
    expect(d.json!.bet).toMatchObject({ state: 'CANCELLED', end_reason: 'declined', last_seq: 7 });
    for (let i = 0; i < 3; i++) {
      const again = await post(B, `/v1/bets/${betId}/invite/accept`);
      expect(again.status).toBe(409);
      expect(again.json!.error).toMatchObject({
        code: 'INVALID_STATE',
        details: { reason: 'already_declined', state: 'CANCELLED' },
      });
    }
    // A repeat decline is still a no-op 200.
    expect((await post(B, `/v1/bets/${betId}/invite/decline`)).json!.bet.last_seq).toBe(7);
  });

  it('B may decline from TERMS_PROPOSED too (§2.5)', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    const betId = (await challenge(A, B, room.room_id)).json!.bet.bet_id as string;
    await ctx.deps.db.update(bets).set({ state: 'TERMS_PROPOSED' }).where(eq(bets.id, betId));
    const r = await post(B, `/v1/bets/${betId}/invite/decline`);
    expect(r.status).toBe(200);
    expect(r.json!.bet).toMatchObject({
      state: 'CANCELLED',
      prev_state: 'TERMS_PROPOSED',
      end_reason: 'declined',
    });
  });

  it('a bet CANCELLED for another reason is not "already declined" by B', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    const betId = (await challenge(A, B, room.room_id)).json!.bet.bet_id as string;
    // e.g. the guardrail refused the terms (SCHEMAS §3) — not B's invite decline.
    await ctx.deps.db
      .update(bets)
      .set({ state: 'CANCELLED', end_reason: 'refused', refusal_category: 'other' })
      .where(eq(bets.id, betId));
    const r = await post(B, `/v1/bets/${betId}/invite/decline`);
    expect(r.status).toBe(409);
    expect(r.json!.error).toMatchObject({ code: 'INVALID_STATE', details: { state: 'CANCELLED' } });
  });

  it('decline is refused once the terms are frozen (AWAITING_AUTHORIZATIONS: use lock/decline)', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    const betId = (await challenge(A, B, room.room_id)).json!.bet.bet_id as string;
    await ctx.deps.db
      .update(bets)
      .set({
        state: 'AWAITING_AUTHORIZATIONS',
        terms_hash: '05860f0a9c9034685ddbed902667f8453258056a21de30138b430ba3903f998f',
        stake_a: 5_000_000n,
        stake_b: 5_000_000n,
        evidence_source: 'camera',
      })
      .where(eq(bets.id, betId));
    const r = await post(B, `/v1/bets/${betId}/invite/decline`);
    expect(r.status).toBe(409);
    expect(r.json!.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { state: 'AWAITING_AUTHORIZATIONS', reason: 'use_lock_decline' },
    });
  });

  it('caps pre-lock bets at 3 per user (§1.7) with 429 RATE_LIMITED', async () => {
    const A = await signUp(ctx.base, 'Logan');
    const others = await Promise.all([1, 2, 3, 4].map((i) => signUp(ctx.base, `P${i}`)));
    const room = await newRoom(A, ...others);
    for (const o of others.slice(0, 3))
      expect((await challenge(A, o, room.room_id)).status).toBe(201);
    const r = await challenge(A, others[3]!, room.room_id);
    expect(r.status).toBe(429);
    expect(r.json!.error.details).toMatchObject({ reason: 'too_many_open_bets' });
    expect(r.res.headers.get('Retry-After')).toBe('60');
  });

  it("voice binding refuses another user's (or an already bound) conversation", async () => {
    const [A, B, C] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Mia'),
    ]);
    const room = await newRoom(A, B, C);
    expect(
      (await challenge(A, B, room.room_id, { voice_conversation_id: CONV_TEST_OWNED })).status,
    ).toBe(201);
    // C tries to bind A's conversation to C's own challenge.
    const stolen = await challenge(C, B, room.room_id, { voice_conversation_id: CONV_TEST_OWNED });
    expect(stolen.status).toBe(422);
    expect(stolen.json!.error.details.reason).toBe('voice_session_unavailable');
    // A reuses it for a second bet: already bound.
    const reused = await challenge(A, C, room.room_id, { voice_conversation_id: CONV_TEST_OWNED });
    expect(reused.status).toBe(422);
    // Nothing was written for the refused challenges (one transaction).
    const rows = await ctx.deps.db
      .select()
      .from(bets)
      .where(and(eq(bets.room_id, room.room_id), eq(bets.party_b_id, uid(B))));
    expect(rows).toHaveLength(1);
    // A pre-minted (unbound) session of A is bound in place.
    await ctx.deps.db.insert(voiceSessions).values({
      user_id: uid(A),
      purpose: 'terms',
      el_agent_id: 'agent_test',
      el_conversation_id: CONV_TEST_PREMINTED,
    });
    const fresh = await challenge(A, C, room.room_id, {
      voice_conversation_id: CONV_TEST_PREMINTED,
    });
    expect(fresh.status).toBe(201);
    const [vs] = await ctx.deps.db
      .select()
      .from(voiceSessions)
      .where(eq(voiceSessions.el_conversation_id, CONV_TEST_PREMINTED));
    expect(vs).toMatchObject({ bet_id: fresh.json!.bet.bet_id, el_agent_id: 'agent_test' });
  });

  it('two concurrent challenges (disjoint pairs) with the same new conversation id: 201 + 422, never a 500', async () => {
    const [A, B, C, D] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Mia'),
      signUp(ctx.base, 'Sam'),
    ]);
    const room = await newRoom(A, B, C, D);
    // Disjoint pairs take disjoint advisory locks, so both inserts really race.
    const conv = `conv_${RUN}_race`;
    const rs = await Promise.all([
      challenge(A, B, room.room_id, { voice_conversation_id: conv }),
      challenge(C, D, room.room_id, { voice_conversation_id: conv }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 422]);
    const loser = rs.find((r) => r.status === 422)!;
    expect(loser.json!.error.details.reason).toBe('voice_session_unavailable');
    const vs = await ctx.deps.db
      .select()
      .from(voiceSessions)
      .where(eq(voiceSessions.el_conversation_id, conv));
    expect(vs).toHaveLength(1);
    expect(vs[0]!.bet_id).toBe(rs.find((r) => r.status === 201)!.json!.bet.bet_id);
  });

  it('an expired room refuses challenges with ROOM_EXPIRED', async () => {
    const [A, B] = await Promise.all([signUp(ctx.base, 'Logan'), signUp(ctx.base, 'Jake')]);
    const room = await newRoom(A, B);
    await ctx.deps.db
      .update(rooms)
      .set({ closed_at: new Date() })
      .where(eq(rooms.id, room.room_id));
    const r = await challenge(A, B, room.room_id);
    expect(r.status).toBe(410);
    expect(r.json!.error.code).toBe('ROOM_EXPIRED');
  });
});

describeDb('DEMO_MODE: the demo room is for the demo players (auth-01)', () => {
  let ctx: Ctx;
  const STAGE_KEY = 'test-stage-key';
  const walletA = newKey();
  const walletB = newKey();
  const seed = (k: TestKey) => getBase58Decoder().decode(k.secret);

  beforeAll(async () => {
    ctx = await startTestServer({
      env: {
        DEMO_MODE: 'true',
        STAGE_KEY,
        DEMO_A_SECRET_KEY: seed(walletA),
        DEMO_B_SECRET_KEY: seed(walletB),
      },
    });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  const post = (u: SignedUp, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const uid = (u: SignedUp) => u.session.user.user_id;
  const challenge = (a: SignedUp, b: SignedUp, roomId: string) =>
    post(a, '/v1/bets', { room_id: roomId, opponent_user_id: uid(b), challenge_method: 'list' });
  const demoRoomRefusal = { code: 'NOT_IN_ROOM', details: { reason: 'demo_room' } };

  it('a stranger with the code on the projector can neither join the demo room nor bet in it', async () => {
    // The demo accounts, signed up with the demo-a / demo-b wallets (as cp1-drive does).
    const A = await signUp(ctx.base, 'Demo A', walletA);
    const B = await signUp(ctx.base, 'Demo B', walletB);
    const X = await signUp(ctx.base, 'Mallory');
    const room = await post(A, '/v1/rooms', { name: 'Finals', kind: 'session' });
    expect(room.status).toBe(201);
    const { room_id, code } = room.json as { room_id: string; code: string };
    expect((await post(B, '/v1/rooms/join', { code })).status).toBe(200);

    const join = await post(X, '/v1/rooms/join', { code });
    expect(join.status).toBe(403);
    expect(join.json!.error).toMatchObject(demoRoomRefusal);
    expect(join.json!.members).toBeUndefined(); // and no member ids leak
    // Not a member, so no bet in the room: no projector takeover, no challenge for demo B.
    expect((await challenge(X, B, room_id)).json!.error.code).toBe('NOT_IN_ROOM');

    const ok = await challenge(A, B, room_id);
    expect(ok.status).toBe(201);
  });

  it('a room the projector shows is a demo room too, whoever created it', async () => {
    const T = await signUp(ctx.base, 'Teammate');
    const F = await signUp(ctx.base, 'Friend');
    const X = await signUp(ctx.base, 'Mallory');
    const room = await post(T, '/v1/rooms', { name: 'Rehearsal', kind: 'session' });
    const { room_id, code } = room.json as { room_id: string; code: string };
    // No stage yet: an ordinary room.
    expect((await post(F, '/v1/rooms/join', { code })).status).toBe(200);
    const st = await postJson(ctx.base, '/v1/stage/session', { stage_key: STAGE_KEY, room_id });
    expect(st.status).toBe(201);

    const join = await post(X, '/v1/rooms/join', { code });
    expect(join.status).toBe(403);
    expect(join.json!.error).toMatchObject(demoRoomRefusal);
    // Members from before the stage opened can't put a bet on it either.
    const bet = await challenge(T, F, room_id);
    expect(bet.status).toBe(403);
    expect(bet.json!.error).toMatchObject({ ...demoRoomRefusal, details: { party: 'A' } });
  });

  it('a demo-claim account (users.is_demo) is a demo player; other rooms stay open', async () => {
    const A = await signUp(ctx.base, 'Claimed demo');
    await ctx.deps.db
      .update(users)
      .set({ is_demo: true })
      .where(eq(users.id, uid(A)));
    const T = await signUp(ctx.base, 'Teammate');
    const room = await post(T, '/v1/rooms', { name: 'Hack night', kind: 'session' });
    const { room_id, code } = room.json as { room_id: string; code: string };
    const F = await signUp(ctx.base, 'Friend');
    expect((await post(F, '/v1/rooms/join', { code })).status).toBe(200);
    expect((await post(A, '/v1/rooms/join', { code })).status).toBe(200);
    expect((await challenge(T, F, room_id)).status).toBe(201);

    const demoRoom = await post(A, '/v1/rooms', { name: 'Demo', kind: 'session' });
    const join = await post(F, '/v1/rooms/join', { code: demoRoom.json!.code });
    expect(join.json!.error).toMatchObject(demoRoomRefusal);
  });
});
