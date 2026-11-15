// WebSocket hub protocol over a real socket, with stubbed access (no DB): hello/welcome,
// per-bet rooms with replay + live, dedupe, reconnect with after_seq, user/room channels,
// 4401/4403 closes, and the ping/pong heartbeat (API-CONTRACT §3).
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WS_CLOSE, WS_HEARTBEAT_MS, WS_MAX_BUFFERED_BYTES } from '@youre-on/shared/api';
import type { AuthContext } from '../src/context';
import { HUB_CLOSE, RealtimeHub, type BetEnvelope, type HubAccess } from '../src/realtime/hub';
import { createDeps, startServer, type RunningServer } from '../src/server';
import { routeModules } from '../src/routes';
import { connectWs, testEnv } from './helpers';

const USER_A = randomUUID();
const ROOM = randomUUID();
const BET = randomUUID();
const OTHER_BET = randomUUID();
const FAIL_BET = randomUUID();
const TOKEN_A = 'yo_s_' + 'a'.repeat(43);
const TOKEN_STAGE = 'yo_s_' + 's'.repeat(43);

const authA: AuthContext = {
  session_id: randomUUID(),
  scopes: ['app'],
  user_id: USER_A,
  device_id: randomUUID(),
  device_pubkey: null,
  room_id: null,
  expires_at: new Date(Date.now() + 3600_000),
};

const authStage: AuthContext = {
  session_id: randomUUID(),
  scopes: ['stage'],
  user_id: null,
  device_id: null,
  device_pubkey: null,
  room_id: ROOM,
  expires_at: new Date(Date.now() + 3600_000),
};

const env = (seq: number, type = 'bet.state', bet_id = BET): BetEnvelope => ({
  v: 1,
  type,
  bet_id,
  seq,
  ts: new Date().toISOString(),
  source: 'server',
  payload: { n: seq },
});

let log: BetEnvelope[] = [];
let replayDelay = 0;

const access: HubAccess = {
  async resolveToken(t) {
    return t === TOKEN_A ? authA : t === TOKEN_STAGE ? authStage : null;
  },
  async canSeeBet(_a, betId) {
    return betId === BET || betId === FAIL_BET;
  },
  async canSeeRoom(_a, roomId) {
    return roomId === ROOM;
  },
  async replay(betId, after) {
    if (betId === FAIL_BET) throw new Error('db down');
    if (replayDelay) await new Promise((r) => setTimeout(r, replayDelay));
    const events = log.filter((e) => e.bet_id === betId && e.seq > after);
    return { events, last_seq: Math.max(0, ...log.map((e) => e.seq)) };
  },
};

let running: RunningServer | null = null;
let hub: RealtimeHub;

async function start(opts: { heartbeatMs?: number; helloTimeoutMs?: number } = {}) {
  const { deps } = createDeps({
    env: testEnv({ DATABASE_URL: 'postgres://unused@127.0.0.1:1/none' }),
    rateLimit: false,
  });
  hub = new RealtimeHub({
    access,
    heartbeatMs: opts.heartbeatMs ?? 60_000,
    helloTimeoutMs: opts.helloTimeoutMs ?? 2_000,
  });
  deps.hub = hub;
  running = await startServer(deps, { port: 0, hostname: '127.0.0.1', modules: routeModules });
  return `ws://127.0.0.1:${running.port}/v1/ws`;
}

afterEach(async () => {
  log = [];
  replayDelay = 0;
  await running?.close();
  running = null;
});

describe('WS hub', () => {
  it('hello -> welcome, subscribe -> replay + subscribed, then live events in order without duplicates', async () => {
    const url = await start();
    log = [env(1, 'bet.invited'), env(2)];
    const c = await connectWs(url);
    c.send({
      op: 'hello',
      token: TOKEN_A,
      device_id: authA.device_id,
      app_version: '0.1.0',
      subs: [],
    });
    const welcome = await c.next((f) => f.op === 'welcome');
    expect(welcome).toMatchObject({ heartbeat_ms: 60_000, user_channel: true });
    expect(new Date(welcome.server_time).toISOString()).toBe(welcome.server_time);

    c.send({ op: 'subscribe', bet_id: BET, after_seq: 0 });
    expect((await c.next((f) => f.seq === 1)).type).toBe('bet.invited');
    expect((await c.next((f) => f.seq === 2)).type).toBe('bet.state');
    expect(await c.next((f) => f.op === 'subscribed')).toEqual({
      op: 'subscribed',
      bet_id: BET,
      last_seq: 2,
      replayed: 2,
    });

    hub.publishBetEvent(env(3));
    hub.publishBetEvent(env(3)); // duplicate: dropped
    hub.publishBetEvent(env(2)); // stale: dropped
    hub.publishBetEvent(env(4));
    expect((await c.next((f) => f.seq === 4)).payload).toEqual({ n: 4 });
    const seqs = c.frames.filter((f) => !('op' in f)).map((f) => f.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    c.close();
  });

  it('reconnect: hello.subs[].after_seq replays only the gap', async () => {
    const url = await start();
    log = [env(1), env(2), env(3)];
    const c = await connectWs(url);
    c.send({ op: 'hello', token: TOKEN_A, subs: [{ bet_id: BET, after_seq: 2 }] });
    await c.next((f) => f.op === 'welcome');
    expect((await c.next((f) => f.seq !== undefined)).seq).toBe(3);
    expect(await c.next((f) => f.op === 'subscribed')).toMatchObject({ last_seq: 3, replayed: 1 });
    c.close();
  });

  it('events published during the replay are buffered and delivered once, after it', async () => {
    const url = await start();
    log = [env(1)];
    replayDelay = 150;
    const c = await connectWs(url);
    c.send({ op: 'hello', token: TOKEN_A, subs: [] });
    await c.next((f) => f.op === 'welcome');
    c.send({ op: 'subscribe', bet_id: BET, after_seq: 0 });
    await new Promise((r) => setTimeout(r, 50));
    hub.publishBetEvent(env(2)); // arrives mid-replay
    await c.next((f) => f.seq === 2);
    const order = c.frames.filter((f) => f.op !== 'welcome').map((f) => f.op ?? f.seq);
    expect(order).toEqual([1, 'subscribed', 2]);
    c.close();
  });

  it('user channel and room channel round trips', async () => {
    const url = await start();
    const c = await connectWs(url);
    c.send({ op: 'hello', token: TOKEN_A, subs: [] });
    await c.next((f) => f.op === 'welcome');
    expect(hub.isUserOnline(USER_A)).toBe(true);

    hub.publishToUser(USER_A, env(1, 'bet.invited', OTHER_BET));
    expect(await c.next((f) => f.type === 'bet.invited')).toMatchObject({
      bet_id: OTHER_BET,
      seq: 1,
    });

    c.send({ op: 'subscribe_room', room_id: ROOM });
    await new Promise((r) => setTimeout(r, 50));
    hub.publishToRoom(ROOM, { op: 'room.presence', room_id: ROOM, members: [] });
    expect(await c.next((f) => f.op === 'room.presence')).toEqual({
      op: 'room.presence',
      room_id: ROOM,
      members: [],
    });

    c.send({ op: 'bogus' });
    expect(await c.next((f) => f.op === 'error')).toMatchObject({ code: 'VALIDATION_FAILED' });
    c.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.isUserOnline(USER_A)).toBe(false);
  });

  it('closes 4401 for a bad token, a non-hello first frame, or no hello in time', async () => {
    const url = await start({ helloTimeoutMs: 200 });
    const bad = await connectWs(url);
    bad.send({ op: 'hello', token: 'yo_s_nope' });
    expect((await bad.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);

    const early = await connectWs(url);
    early.send({ op: 'subscribe', bet_id: BET, after_seq: 0 });
    expect((await early.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);

    const silent = await connectWs(url);
    expect((await silent.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('closes 4403 on a subscribe to a bet or room the caller may not see', async () => {
    const url = await start();
    const c = await connectWs(url);
    c.send({ op: 'hello', token: TOKEN_A, subs: [] });
    await c.next((f) => f.op === 'welcome');
    c.send({ op: 'subscribe', bet_id: OTHER_BET, after_seq: 0 });
    expect((await c.closed).code).toBe(WS_CLOSE.FORBIDDEN);

    const r = await connectWs(url);
    r.send({ op: 'hello', token: TOKEN_A, subs: [] });
    await r.next((f) => f.op === 'welcome');
    r.send({ op: 'subscribe_room', room_id: randomUUID() });
    expect((await r.closed).code).toBe(WS_CLOSE.FORBIDDEN);
  });

  it('pings every heartbeat, keeps a socket that pongs, drops one after 2 missed pongs', async () => {
    const url = await start({ heartbeatMs: 100 });
    const good = await connectWs(url);
    good.ws.on('message', (d) => {
      const f = JSON.parse(String(d));
      if (f.op === 'ping') good.send({ op: 'pong', t: f.t });
    });
    good.send({ op: 'hello', token: TOKEN_A, subs: [] });
    const lazy = await connectWs(url);
    lazy.send({ op: 'hello', token: TOKEN_A, subs: [] });

    const ping = await lazy.next((f) => f.op === 'ping');
    expect(typeof ping.t).toBe('number');
    expect(new Date(ping.server_time).toISOString()).toBe(ping.server_time);
    expect((await lazy.closed).code).toBe(HUB_CLOSE.HEARTBEAT_TIMEOUT);

    await new Promise((r) => setTimeout(r, 150));
    expect(good.ws.readyState).toBe(good.ws.OPEN);
    expect(good.frames.filter((f) => f.op === 'ping').length).toBeGreaterThanOrEqual(3);
    good.close();
  });

  it('defaults to the spec heartbeat (20 s)', () => {
    expect(new RealtimeHub({ access }).heartbeatMs).toBe(WS_HEARTBEAT_MS);
    expect(WS_HEARTBEAT_MS).toBe(20_000);
  });

  it('a failed replay sends error, never `subscribed`, and drops the subscription', async () => {
    const url = await start();
    const c = await connectWs(url);
    c.send({ op: 'hello', token: TOKEN_A, subs: [{ bet_id: FAIL_BET, after_seq: 0 }] });
    await c.next((f) => f.op === 'welcome');
    expect(await c.next((f) => f.op === 'error')).toMatchObject({ code: 'INTERNAL' });
    hub.publishBetEvent(env(1, 'bet.state', FAIL_BET));
    c.send({ op: 'pong', t: 0 }); // round trip so any stray frame would have arrived
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames.some((f) => f.op === 'subscribed')).toBe(false);
    expect(c.frames.some((f) => f.bet_id === FAIL_BET && f.seq !== undefined)).toBe(false);
    expect(c.ws.readyState).toBe(c.ws.OPEN);
    c.close();
  });

  it('stage scope on subscribe_room receives every bet of its room (publishBetEvent roomId)', async () => {
    const url = await start();
    const stage = await connectWs(url);
    stage.send({ op: 'hello', token: TOKEN_STAGE });
    expect(await stage.next((f) => f.op === 'welcome')).toMatchObject({ user_channel: false });
    stage.send({ op: 'subscribe_room', room_id: ROOM });
    const member = await connectWs(url); // a phone room member: presence only, no bet events
    member.send({ op: 'hello', token: TOKEN_A, subs: [] });
    await member.next((f) => f.op === 'welcome');
    member.send({ op: 'subscribe_room', room_id: ROOM });
    await new Promise((r) => setTimeout(r, 50));

    hub.publishBetEvent(env(1, 'bet.invited', OTHER_BET)); // no room id: bet channel only
    hub.publishBetEvent(env(2, 'bet.state', OTHER_BET), ROOM);
    hub.publishBetEvent(env(2, 'bet.state', OTHER_BET), ROOM); // duplicate: dropped
    hub.publishBetEvent(env(3, 'bet.state', OTHER_BET), randomUUID()); // another room
    expect((await stage.next((f) => f.bet_id === OTHER_BET)).seq).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(stage.frames.filter((f) => f.bet_id === OTHER_BET).map((f) => f.seq)).toEqual([2]);
    expect(member.frames.some((f) => f.bet_id === OTHER_BET)).toBe(false);
    stage.close();
    member.close();
  });

  it("closeSession closes that session's sockets with 4401 and leaves others open", async () => {
    const url = await start();
    const a = await connectWs(url);
    a.send({ op: 'hello', token: TOKEN_A, subs: [] });
    await a.next((f) => f.op === 'welcome');
    const stage = await connectWs(url);
    stage.send({ op: 'hello', token: TOKEN_STAGE });
    await stage.next((f) => f.op === 'welcome');
    hub.closeSession(authA.session_id);
    expect((await a.closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
    expect(hub.isUserOnline(USER_A)).toBe(false);
    expect(stage.ws.readyState).toBe(stage.ws.OPEN);
    stage.close();
  });
});

describe('WS hub backpressure', () => {
  it('closes a socket whose send buffer exceeds 1 MB with 4413', async () => {
    const h = new RealtimeHub({ access });
    let closedWith: number | undefined;
    const sent: string[] = [];
    const fakeWs = {
      readyState: 1,
      raw: { bufferedAmount: WS_MAX_BUFFERED_BYTES + 1 },
      send: (d: string) => sent.push(d),
      close: (code?: number) => {
        closedWith = code;
      },
    };
    const ev = h.events();
    const ws = fakeWs as unknown as Parameters<NonNullable<typeof ev.onOpen>>[1];
    ev.onOpen?.(new Event('open'), ws);
    ev.onMessage?.(
      new MessageEvent('message', { data: JSON.stringify({ op: 'hello', token: TOKEN_A }) }),
      ws,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(closedWith).toBe(HUB_CLOSE.BACKPRESSURE);
    expect(sent).toEqual([]); // the welcome was not queued onto a full buffer
    expect(h.connectionCount).toBe(0);
  });
});
