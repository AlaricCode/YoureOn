/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// The shared lobby (API-CONTRACT §2.3a) over HTTP + Postgres: POST /v1/rooms/lobby get-or-create
// (one lobby under concurrent first joins, its expiry pushed out by every join, a new one once it
// has run out, a user's room named "Lobby" never mistaken for it), the "around" member list,
// lobby face matching limited to members online or seen within LOBBY_RECENT_MS (non-lobby rooms
// unchanged), a lobby face challenge reaching B as bet.invited, the stage's room_code LOBBY alias,
// and LOBBY_ENABLED=false. The lobby is a global singleton, so this suite runs on a database of
// its own (`<db>_lobby`) and closes any lobby a previous run left before each test.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { roomMembers, rooms, users } from '@youre-on/db';
import {
  isLobbySummary,
  JoinRoomResponse,
  LOBBY_PATH,
  LOBBY_RECENT_MS,
  LOBBY_ROOM_KIND,
} from '@youre-on/shared/api';
import { embeddingToBytes, FACE_CONSENT_V1_SHA256, FACE_MODEL_W600K } from '@youre-on/shared/face';
import { ROOM_TTL_MS } from '../src/rooms/service';
import {
  connectWs,
  DB_URL,
  describeDb,
  ownDatabase,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
  type WsClient,
} from './helpers';

const DIM = 512;
const STAGE_KEY = 'lobby-test-stage-key';

const basis = (i: number) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};
/** A unit vector with cosine `c` against basis(i), the rest on axis 500. */
const probeAt = (i: number, c = 0.8) => {
  const v = new Float32Array(DIM);
  v[i] = c;
  v[500] = Math.sqrt(1 - c * c);
  return v;
};
const sealed = (v: Float32Array) => ({
  alg: 'plain-v0' as const,
  epk_b64: null,
  nonce_b64: null,
  ct_b64: Buffer.from(embeddingToBytes(v)).toString('base64'),
});

describeDb('the shared lobby over Postgres', () => {
  let ctx: Ctx;
  let dbUrl: string;
  let clock = Date.now();
  const sockets: WsClient[] = [];

  beforeAll(async () => {
    dbUrl = await ownDatabase(DB_URL!, 'lobby');
    ctx = await startTestServer({
      now: () => clock,
      env: { DATABASE_URL: dbUrl, STAGE_KEY },
    });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await ctx?.server.close();
  });
  beforeEach(async () => {
    await ctx.deps.db
      .update(rooms)
      .set({ closed_at: new Date(clock) })
      .where(and(eq(rooms.kind, LOBBY_ROOM_KIND), isNull(rooms.closed_at)));
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
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
    });
  };
  const lobby = async (u: SignedUp) => {
    const r = await call(u, 'POST', LOBBY_PATH, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return JoinRoomResponse.parse(r.json);
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
    }).then((r) => expect(r.status, JSON.stringify(r.json)).toBe(201));
  const match = (u: SignedUp, roomId: string, v: Float32Array) =>
    call(u, 'POST', `/v1/rooms/${roomId}/face-match`, {
      probe: sealed(v),
      model: FACE_MODEL_W600K,
      capture: { captured_at: new Date(clock).toISOString(), eye_distance_px: 90, yaw_deg: 2 },
    });
  const matchedId = async (u: SignedUp, roomId: string, v: Float32Array) => {
    const r = await match(u, roomId, v);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return (r.json!.match?.user.user_id as string | undefined) ?? null;
  };
  async function online(u: SignedUp): Promise<WsClient> {
    const s = await connectWs(ctx.wsUrl);
    sockets.push(s);
    s.send({ op: 'hello', token: u.session.token, device_id: u.session.device_id });
    await s.next((f) => f.op === 'welcome');
    return s;
  }
  const settle = () => new Promise((r) => setTimeout(r, 150)); // presence touches are async
  const liveLobbies = () =>
    ctx.deps.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.kind, LOBBY_ROOM_KIND), isNull(rooms.closed_at)));

  it('creates the lobby on first join and puts everyone in that one room', async () => {
    const a = await signUp(ctx.base, 'Ada');
    const b = await signUp(ctx.base, 'Bo');
    const ra = await lobby(a);
    expect(isLobbySummary(ra.room)).toBe(true);
    expect(ra.room).toMatchObject({
      kind: 'nearby',
      name: 'Lobby',
      created_by: null,
      is_demo: false,
    });
    expect(ra.room.expires_at).toBe(new Date(clock + ROOM_TTL_MS).toISOString());
    const rb = await lobby(b);
    expect(rb.room.room_id).toBe(ra.room.room_id);
    expect(rb.members.map((m) => m.user.user_id).sort()).toEqual([uid(a), uid(b)].sort());
    const [m] = await ctx.deps.db
      .select({ via: roomMembers.joined_via })
      .from(roomMembers)
      .where(and(eq(roomMembers.room_id, ra.room.room_id), eq(roomMembers.user_id, uid(b))));
    expect(m!.via).toBe('nearby');
    // Idempotent, and the code still works like any room's.
    expect((await lobby(b)).room.room_id).toBe(ra.room.room_id);
    const c = await signUp(ctx.base, 'Cy');
    const byCode = await call(c, 'POST', '/v1/rooms/join', { code: ra.room.code });
    expect(byCode.status).toBe(200);
    expect(byCode.json!.room.room_id).toBe(ra.room.room_id);
  });

  it('concurrent first joins make exactly one lobby', async () => {
    const people = await Promise.all(
      Array.from({ length: 8 }, (_, i) => signUp(ctx.base, `P${i}`)),
    );
    const out = await Promise.all(people.map(lobby));
    expect(new Set(out.map((r) => r.room.room_id)).size).toBe(1);
    expect(await liveLobbies()).toHaveLength(1);
  });

  it('a user room named "Lobby" is never the lobby; an empty body is fine', async () => {
    const a = await signUp(ctx.base, 'Eve');
    const mine = await call(a, 'POST', '/v1/rooms', { name: 'Lobby', kind: 'session' });
    expect(mine.status).toBe(201);
    const raw = await postJson(
      ctx.base,
      LOBBY_PATH,
      '',
      signedHeaders(a, 'POST', LOBBY_PATH, '', { ts: clock }),
    );
    expect(raw.status).toBe(200);
    expect((raw.json as any).room.room_id).not.toBe(mine.json!.room_id);
    expect((raw.json as any).room.kind).toBe('nearby');
  });

  it('every join pushes the expiry out; a lobby that ran out is replaced', async () => {
    const a = await signUp(ctx.base, 'Fay');
    const first = await lobby(a);
    clock += 11 * 60 * 60_000;
    const later = await lobby(a);
    expect(later.room.room_id).toBe(first.room.room_id);
    expect(later.room.expires_at).toBe(new Date(clock + ROOM_TTL_MS).toISOString());
    clock += ROOM_TTL_MS + 60_000; // nobody joined for 12 h: it expired
    const b = await signUp(ctx.base, 'Gus');
    const next = await lobby(b);
    expect(next.room.room_id).not.toBe(first.room.room_id);
    expect(next.members.map((m) => m.user.user_id)).toEqual([uid(b)]);
  });

  it('lists and face-matches only members who are around; other rooms are unchanged', async () => {
    const scanner = await signUp(ctx.base, 'Hal');
    const stale = await signUp(ctx.base, 'Ivy'); // joined, then left the app
    const steady = await signUp(ctx.base, 'Jo'); // the app open the whole time (one long socket)
    await enroll(stale, basis(10));
    await enroll(steady, basis(11));
    // A private room with the same two people: today's rules (no recency filter). Joined first,
    // since going into a private room leaves the lobby; the lobby join after it doesn't leave it.
    const priv = await call(scanner, 'POST', '/v1/rooms', { name: 'Private', kind: 'session' });
    for (const u of [stale, steady])
      expect((await call(u, 'POST', '/v1/rooms/join', { code: priv.json!.code })).status).toBe(200);
    const room = (await lobby(scanner)).room.room_id;
    await lobby(stale);
    await lobby(steady);
    await online(steady);
    await settle();

    expect(await matchedId(scanner, room, probeAt(10))).toBe(uid(stale));
    expect(await matchedId(scanner, room, probeAt(11))).toBe(uid(steady));

    clock += LOBBY_RECENT_MS + 60_000;
    // Ivy hasn't been seen for 16 min: not a lobby candidate. Jo has a live socket.
    expect(await matchedId(scanner, room, probeAt(10))).toBeNull();
    expect(await matchedId(scanner, room, probeAt(11))).toBe(uid(steady));
    expect(await matchedId(scanner, priv.json!.room_id, probeAt(10))).toBe(uid(stale));

    const listed = (await lobby(scanner)).members.map((m) => m.user.user_id);
    expect(listed).toContain(uid(steady));
    expect(listed).toContain(uid(scanner));
    expect(listed).not.toContain(uid(stale));
    const presence = await fetch(`${ctx.base}/v1/rooms/${room}/presence`, {
      headers: { Authorization: `Bearer ${scanner.session.token}` },
    }).then((r) => r.json() as Promise<any>);
    expect(presence.members.map((m: any) => m.user.user_id)).not.toContain(uid(stale));

    // Opening the app again (the lobby join on launch) makes Ivy findable again.
    await lobby(stale);
    expect(await matchedId(scanner, room, probeAt(10))).toBe(uid(stale));
  });

  it('a lobby face scan sends the challenge to their phone as bet.invited', async () => {
    const a = await signUp(ctx.base, 'Kai');
    const b = await signUp(ctx.base, 'Lu');
    await enroll(b, basis(20));
    const room = (await lobby(a)).room.room_id;
    await lobby(b);
    const bs = await online(b);
    const r = await match(a, room, probeAt(20));
    expect(r.json!.match.user.user_id).toBe(uid(b));
    const ok = await call(a, 'POST', '/v1/bets', {
      room_id: room,
      opponent_user_id: uid(b),
      challenge_method: 'face',
      match_ticket: r.json!.match.match_ticket,
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const invited = await bs.next((f) => f.type === 'bet.invited');
    expect(invited).toMatchObject({
      bet_id: ok.json!.bet.bet_id,
      payload: { challenger: { user_id: uid(a), display_name: 'Kai' }, room_id: room },
    });
  });

  it('scans with nobody online at all (presence empty) still answer, online-first order or not', async () => {
    const a = await signUp(ctx.base, 'Ola');
    const b = await signUp(ctx.base, 'Pip');
    await enroll(b, basis(30));
    const room = (await lobby(a)).room.room_id;
    await lobby(b);
    for (const s of sockets.splice(0)) s.close(); // no live sockets anywhere
    await settle();
    clock += 60_000; // past the presence grace: the tracker reports nobody online
    expect(await matchedId(a, room, probeAt(30))).toBe(uid(b));
    expect(await matchedId(a, room, probeAt(31))).toBeNull();
  });

  it('going into a private room leaves the lobby: not listed, matched or challengeable there', async () => {
    const a = await signUp(ctx.base, 'Quin');
    const b = await signUp(ctx.base, 'Rae'); // killed in the lobby, cold-started from a room link
    const c = await signUp(ctx.base, 'Sol'); // made a room of their own
    await enroll(b, basis(40));
    await enroll(c, basis(41));
    const room = (await lobby(a)).room.room_id;
    await lobby(b);
    await lobby(c);
    await online(b);
    await settle();
    expect(await matchedId(a, room, probeAt(40))).toBe(uid(b));

    const priv = await call(a, 'POST', '/v1/rooms', { name: 'Table 4', kind: 'session' });
    expect(priv.status).toBe(201);
    // a made the room, so a left the lobby too; back in for the scans below.
    expect((await lobby(a)).room.room_id).toBe(room);
    expect((await call(b, 'POST', '/v1/rooms/join', { code: priv.json!.code })).status).toBe(200);
    expect((await call(c, 'POST', '/v1/rooms', { name: 'Mine', kind: 'session' })).status).toBe(
      201,
    );
    await settle();

    expect(await matchedId(a, room, probeAt(40))).toBeNull();
    expect(await matchedId(a, room, probeAt(41))).toBeNull();
    const listed = (await lobby(a)).members.map((m) => m.user.user_id);
    expect(listed).not.toContain(uid(b));
    expect(listed).not.toContain(uid(c));
    const bet = await call(a, 'POST', '/v1/bets', {
      room_id: room,
      opponent_user_id: uid(b),
      challenge_method: 'list',
    });
    expect(bet.status).toBe(403);
    expect(bet.json!.error.code).toBe('NOT_IN_ROOM');
    // Still in the private room, where a finds b as before.
    expect(await matchedId(a, priv.json!.room_id, probeAt(40))).toBe(uid(b));
    // The next lobby join brings b back.
    await lobby(b);
    expect(await matchedId(a, room, probeAt(40))).toBe(uid(b));
  });

  it('DEMO_MODE: no lobby bet between a demo player and a stranger; no stage on the lobby', async () => {
    const demo = await startTestServer({
      now: () => clock,
      env: { DATABASE_URL: dbUrl, STAGE_KEY, DEMO_MODE: 'true' },
    });
    try {
      const sign = (u: SignedUp, path: string, body: unknown) => {
        const raw = JSON.stringify(body);
        return postJson(demo.base, path, raw, signedHeaders(u, 'POST', path, raw, { ts: clock }));
      };
      const join = async (u: SignedUp) => {
        const r = await sign(u, LOBBY_PATH, {});
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        return (r.json as any).room.room_id as string;
      };
      const bet = (a: SignedUp, b: SignedUp, roomId: string) =>
        sign(a, '/v1/bets', {
          room_id: roomId,
          opponent_user_id: uid(b),
          challenge_method: 'list',
        });
      const demoA = await signUp(demo.base, 'Demo A');
      const demoB = await signUp(demo.base, 'Demo B');
      await ctx.deps.db
        .update(users)
        .set({ is_demo: true })
        .where(inArray(users.id, [uid(demoA), uid(demoB)]));
      const x = await signUp(demo.base, 'Stranger');
      const y = await signUp(demo.base, 'Friend');
      const room = await join(demoA);
      for (const u of [demoB, x, y]) expect(await join(u)).toBe(room);

      const s = await postJson(demo.base, '/v1/stage/session', {
        stage_key: STAGE_KEY,
        room_code: 'LOBBY',
      });
      expect(s.status).toBe(403);
      expect((s.json as any).error).toMatchObject({
        code: 'NOT_IN_ROOM',
        details: { reason: 'demo_room' },
      });

      const toDemo = await bet(x, demoB, room);
      expect(toDemo.status).toBe(403);
      expect((toDemo.json as any).error).toMatchObject({
        code: 'NOT_IN_ROOM',
        details: { reason: 'demo_room', party: 'A' },
      });
      const fromDemo = await bet(demoA, y, room);
      expect(fromDemo.status).toBe(403);
      expect((fromDemo.json as any).error.details).toMatchObject({ party: 'B' });
      // Strangers bet with each other, and the demo players with each other.
      expect((await bet(x, y, room)).status).toBe(201);
      expect((await bet(demoA, demoB, room)).status).toBe(201);
    } finally {
      await demo.server.close();
    }
  });

  it('the stage opens the lobby with room_code LOBBY (any case), creating it if needed', async () => {
    const s = await postJson(ctx.base, '/v1/stage/session', {
      stage_key: STAGE_KEY,
      room_code: ' lobby ',
    });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    const roomId = (s.json as any).room_id as string;
    const a = await signUp(ctx.base, 'Mo');
    expect((await lobby(a)).room.room_id).toBe(roomId);
    const again = await postJson(ctx.base, '/v1/stage/session', {
      stage_key: STAGE_KEY,
      room_code: 'LOBBY',
    });
    expect((again.json as any).room_id).toBe(roomId);
    // Not a code, not the alias: still refused.
    const bad = await postJson(ctx.base, '/v1/stage/session', {
      stage_key: STAGE_KEY,
      room_code: 'LOBBYX',
    });
    expect(bad.status).toBe(422);
  });

  it('LOBBY_ENABLED=false: the route and the stage alias answer 404', async () => {
    const off = await startTestServer({
      now: () => clock,
      env: { DATABASE_URL: dbUrl, STAGE_KEY, LOBBY_ENABLED: 'false' },
    });
    try {
      const a = await signUp(off.base, 'Nia');
      const r = await postJson(off.base, LOBBY_PATH, '{}', {
        ...signedHeaders(a, 'POST', LOBBY_PATH, '{}', { ts: clock }),
      });
      expect(r.status).toBe(404);
      const s = await postJson(off.base, '/v1/stage/session', {
        stage_key: STAGE_KEY,
        room_code: 'LOBBY',
      });
      expect(s.status).toBe(404);
    } finally {
      await off.server.close();
    }
  });
});
