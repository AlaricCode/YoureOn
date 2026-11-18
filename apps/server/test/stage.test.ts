/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed on purpose */
// Stage routes (API-CONTRACT §1.3 stage auth, §2.13, §2.14, §2.17): POST /v1/stage/session,
// stage.market fan-out over /v1/ws, GET /v1/markets/btc5m/*, GET /v1/bets/:bet_id, and CORS for
// the stage origin. The Gemini relay runs on a fake fetch with recorded responses.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { attemptFrames, attempts, createDb } from '@youre-on/db';
import { WsStageMarket } from '@youre-on/shared/api';
import { buildApp } from '../src/app';
import { createGeminiClient } from '../src/markets/gemini';
import { MarketService } from '../src/markets/service';
import { createDeps, startServer, type RunningServer } from '../src/server';
import { routeModules } from '../src/routes';
import { silentLogger } from '../src/log';
import { stageKeyMatches } from '../src/stage/routes';
import { stageOrigins } from '../src/stage/cors';
import {
  connectWs,
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  testEnv,
  type SignedUp,
  type WsClient,
} from './helpers';
import {
  EVENTS_PATH,
  eventPath,
  fakeGemini,
  GEMINI_FIXTURE as F,
  T0237,
  TICKER_PATH,
} from './gemini-fake';

const KEY = 'stage-key-for-tests-only';
const ORIGIN = 'http://localhost:5173';

function fakeMarkets(clock: { t: number }) {
  const g = fakeGemini({
    [EVENTS_PATH]: F.events_0237,
    [eventPath('BTC05M2611180240')]: F.event_0240_active,
    [TICKER_PATH]: F.btcusd,
  });
  return new MarketService({
    client: createGeminiClient({ fetch: g.fetch }),
    now: () => clock.t,
    log: silentLogger,
    pollMs: 60_000, // tests drive refresh() by hand
  });
}

describe('stage session without a DB round trip', () => {
  // postgres.js connects lazily: these paths never reach the database.
  const app = (env: Record<string, string>, rateLimit = false) =>
    buildApp(
      createDeps({
        env: testEnv(env),
        dbHandle: createDb({ url: 'postgres://unused@127.0.0.1:1/none' }),
        rateLimit,
      }).deps,
      routeModules,
    );
  const post = (a: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) =>
    a.request('/v1/stage/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const ROOM = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';

  it('404 unless STAGE_KEY is configured', async () => {
    const r = await post(app({}), { stage_key: 'x', room_id: ROOM });
    expect(r.status).toBe(404);
  });

  it('wrong key -> 401 AUTH_REQUIRED; bad body -> 422', async () => {
    const a = app({ STAGE_KEY: KEY });
    const r = await post(a, { stage_key: 'nope', room_id: ROOM });
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error.code).toBe('AUTH_REQUIRED');
    const bad = await post(a, { stage_key: KEY, room_id: 'not-a-uuid' });
    expect(bad.status).toBe(422);
    // exactly one of room_id / room_code, and the code must be a room code
    for (const body of [
      { stage_key: KEY },
      { stage_key: KEY, room_id: ROOM, room_code: 'ABC234' },
      { stage_key: KEY, room_code: 'ABC10O' },
    ])
      expect((await post(a, body)).status, JSON.stringify(body)).toBe(422);
  });

  it('10/min per client IP, then 429 with Retry-After', async () => {
    const a = app({ STAGE_KEY: KEY }, true);
    const ip = { 'fly-client-ip': '203.0.113.7' };
    for (let i = 0; i < 10; i++)
      expect((await post(a, { stage_key: 'nope', room_id: ROOM }, ip)).status).toBe(401);
    const r = await post(a, { stage_key: 'nope', room_id: ROOM }, ip);
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBeTruthy();
    // another IP still has its budget
    const other = await post(
      a,
      { stage_key: 'nope', room_id: ROOM },
      { 'fly-client-ip': '203.0.113.8' },
    );
    expect(other.status).toBe(401);
  });

  it('CORS: the stage origin gets ACAO (also on errors) and a preflight answer; others do not', async () => {
    const a = app({ STAGE_KEY: KEY });
    const r = await post(a, { stage_key: 'nope', room_id: ROOM }, { Origin: ORIGIN });
    expect(r.status).toBe(401);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const pre = await a.request('/v1/stage/session', {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    const evil = await post(
      a,
      { stage_key: 'nope', room_id: ROOM },
      { Origin: 'https://evil.example' },
    );
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const mk = await a.request('/v1/markets/btc5m/current', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    expect(mk.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('STAGE_ORIGIN overrides the dev defaults; key compare is exact', () => {
    expect(stageOrigins({ STAGE_ORIGIN: 'https://a.dev/, https://b.dev' })).toEqual([
      'https://a.dev',
      'https://b.dev',
    ]);
    expect(stageOrigins({})).toContain('http://localhost:5173');
    expect(stageKeyMatches(KEY, KEY)).toBe(true);
    expect(stageKeyMatches(`${KEY} `, KEY)).toBe(false);
    expect(stageKeyMatches('', KEY)).toBe(false);
  });

  it('markets routes need a bearer', async () => {
    const r = await app({}).request('/v1/markets/btc5m/current');
    expect(r.status).toBe(401);
  });
});

describeDb('stage over Postgres', () => {
  let server: RunningServer;
  let base: string;
  let wsUrl: string;
  const clock = { t: T0237 };
  const markets = fakeMarkets(clock);
  const sockets: WsClient[] = [];

  beforeAll(async () => {
    const env = testEnv({ STAGE_KEY: KEY });
    const dbHandle = createDb({ url: env.DATABASE_URL, max: 4 });
    const { deps } = createDeps({ env, dbHandle, rateLimit: false, markets });
    server = await startServer(deps, {
      port: 0,
      hostname: '127.0.0.1',
      modules: routeModules,
      onClose: () => dbHandle.close(),
    });
    base = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/v1/ws`;
    await markets.refresh(); // startServer started the relay; this joins or repeats its first poll
    expect(markets.isStarted).toBe(true);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await server?.close();
  });

  const signed = (u: SignedUp, path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return postJson(base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const get = async (token: string, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    const text = await res.text();
    return { res, status: res.status, json: text ? (JSON.parse(text) as any) : null };
  };
  async function room(owner: SignedUp, ...members: SignedUp[]) {
    const r = await signed(owner, '/v1/rooms', { name: 'Stage room', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members)
      expect((await signed(m, '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    return r.json!.room_id as string;
  }
  const session = (roomId: string, key = KEY) =>
    postJson(base, '/v1/stage/session', { stage_key: key, room_id: roomId }, { Origin: ORIGIN });

  it('issues a stage token for an existing room; unknown room -> 404', async () => {
    const A = await signUp(base, 'Logan');
    const roomId = await room(A);
    const r = await session(roomId);
    expect(r.status).toBe(201);
    expect(r.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(r.json).toMatchObject({ room_id: roomId, scopes: ['stage'] });
    expect(r.json!.token).toMatch(/^yo_s_/);
    const ttl = Date.parse(r.json!.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(11.9 * 3600_000);
    const missing = await session('00000000-0000-4000-8000-00000000abcd');
    expect(missing.status).toBe(404);
  });

  it('room_code: the typed code (any case) or the QR payload finds the same room', async () => {
    const A = await signUp(base, 'Logan');
    const r = await signed(A, '/v1/rooms', { name: 'Stage by code', kind: 'session' });
    expect(r.status).toBe(201);
    const { room_id, code } = r.json as { room_id: string; code: string };
    for (const typed of [` ${code.toLowerCase()} `, `youreon://room/${code}`]) {
      const s = await postJson(base, '/v1/stage/session', { stage_key: KEY, room_code: typed });
      expect(s.status, typed).toBe(201);
      expect(s.json).toMatchObject({ room_id, scopes: ['stage'] });
    }
    const wrongKey = await postJson(base, '/v1/stage/session', {
      stage_key: 'nope',
      room_code: code,
    });
    expect(wrongKey.status).toBe(401);
    // a well-formed code no room holds (codes are random: a clash is a 1-in-10^9 event)
    const nobody = await postJson(base, '/v1/stage/session', {
      stage_key: KEY,
      room_code: 'ZZZZZZ',
    });
    expect(nobody.status).toBe(404);
  });

  it('the stage token opens /v1/ws for its room and receives stage.market frames', async () => {
    const A = await signUp(base, 'Logan');
    const roomId = await room(A);
    const { json } = await session(roomId);
    const s = await connectWs(wsUrl);
    sockets.push(s);
    s.send({ op: 'hello', token: json!.token, subs: [] });
    await s.next((f) => f.op === 'welcome');
    s.send({ op: 'subscribe_room', room_id: roomId });
    await new Promise((r) => setTimeout(r, 100)); // subscribe_room is handled async
    clock.t += 2_000;
    await markets.refresh();
    const f = await s.next((x) => x.op === 'stage.market');
    const parsed = WsStageMarket.parse(f);
    expect(parsed.snapshot).toMatchObject({
      eventTicker: 'BTC05M2611180240',
      strike: { value: '64389.6' },
    });
  });

  it('GET /v1/markets/btc5m/current and /quote with a stage token', async () => {
    const A = await signUp(base, 'Logan');
    const { json } = await session(await room(A));
    const token = json!.token as string;
    clock.t += 1_000;
    await markets.refresh();
    const cur = await get(token, '/v1/markets/btc5m/current', { Origin: ORIGIN });
    expect(cur.status).toBe(200);
    expect(cur.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(cur.json).toMatchObject({
      market: { eventTicker: 'BTC05M2611180240' },
      strike_known: true,
      window: { expiry: '2026-11-18T02:40:00.000Z' },
    });
    const q = await get(token, '/v1/markets/btc5m/quote?amount=5000000&a_side=YES');
    expect(q.status).toBe(200);
    expect(q.json.result).toMatchObject({ ok: true, priceAtLock: '0.63' }); // detail call: .56/.69
    expect(q.json.snapshot.eventTicker).toBe('BTC05M2611180240');
    const bad = await get(token, '/v1/markets/btc5m/quote?amount=5&a_side=UP');
    expect(bad.status).toBe(422);
    // $20 a side -> YES would put in $25.20 > MAX_STAKE
    const big = await get(token, '/v1/markets/btc5m/quote?amount=20000000&a_side=YES');
    expect(big.status).toBe(409);
    expect(big.json.error).toMatchObject({
      code: 'MARKET_UNAVAILABLE',
      details: { reason: 'STAKE_ABOVE_MAX' },
    });
  });

  it('GET /v1/bets/:bet_id: parties and stage sessions of the room; everyone else 404', async () => {
    const A = await signUp(base, 'Logan');
    const B = await signUp(base, 'Jake');
    const C = await signUp(base, 'Mallory');
    const roomId = await room(A, B);
    const bet = await signed(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = (bet.json!.bet_id ?? bet.json!.bet?.bet_id) as string;
    expect(betId).toBeTruthy();

    const stage = (await session(roomId)).json!.token as string;
    const s = await get(stage, `/v1/bets/${betId}`, { Origin: ORIGIN });
    expect(s.status).toBe(200);
    expect(s.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(s.json).toMatchObject({
      bet_id: betId,
      room_id: roomId,
      my_party: null,
      party_a: { display_name: 'Logan' },
      party_b: { display_name: 'Jake' },
      envelope: null,
    });
    const asA = await get(A.session.token, `/v1/bets/${betId}`);
    expect(asA.status).toBe(200);
    expect(asA.json.my_party).toBe('A');
    expect((await get(B.session.token, `/v1/bets/${betId}`)).json.my_party).toBe('B');
    expect((await get(C.session.token, `/v1/bets/${betId}`)).status).toBe(404);
    const otherStage = (await session(await room(C))).json!.token as string;
    expect((await get(otherStage, `/v1/bets/${betId}`)).status).toBe(404);
    expect((await get(stage, '/v1/bets/not-a-uuid')).status).toBe(422);
  });

  it('GET /v1/bets/:bet_id/attempts/:n/frames/:idx: the evidence JPEGs, same readers as the bet', async () => {
    const A = await signUp(base, 'Logan');
    const B = await signUp(base, 'Jake');
    const C = await signUp(base, 'Mallory');
    const roomId = await room(A, B);
    const bet = await signed(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    const betId = (bet.json!.bet_id ?? bet.json!.bet?.bet_id) as string;
    const db = server.deps.db;
    const [att] = await db
      .insert(attempts)
      .values({
        bet_id: betId,
        attempt_no: 2,
        recorded_by_user_id: A.session.user.user_id,
        max_ms: 15_000,
        go_at: new Date(),
      })
      .returning({ id: attempts.id });
    const jpeg = (i: number) => Buffer.from([0xff, 0xd8, 0xff, i, 1, 2, 3, 0xff, 0xd9]);
    await db.insert(attemptFrames).values(
      [0, 1].map((i) => ({
        attempt_id: att!.id,
        idx: i,
        t_ms: i * 500,
        sha256: createHash('sha256').update(jpeg(i)).digest('hex'),
        bytes: jpeg(i),
      })),
    );
    const stage = (await session(roomId)).json!.token as string;
    const path = (n: number, idx: number | string) =>
      `/v1/bets/${betId}/attempts/${n}/frames/${idx}`;
    const read = (token: string, p: string, headers: Record<string, string> = {}) =>
      fetch(base + p, { headers: { Authorization: `Bearer ${token}`, ...headers } });

    const r = await read(stage, path(2, 1), { Origin: ORIGIN });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('image/jpeg');
    expect(r.headers.get('Cache-Control')).toBe('private, max-age=86400, immutable');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(Buffer.from(await r.arrayBuffer())).toEqual(jpeg(1));
    const etag = r.headers.get('ETag')!;
    expect(etag).toBe(`"${createHash('sha256').update(jpeg(1)).digest('hex')}"`);
    expect((await read(stage, path(2, 1), { 'If-None-Match': etag })).status).toBe(304);
    expect((await read(A.session.token, path(2, 0))).status).toBe(200);
    // not a reader of the bet, no such attempt / frame, junk params: 404 (422 for a bad bet id)
    expect((await read(C.session.token, path(2, 0))).status).toBe(404);
    expect((await read(stage, path(1, 0))).status).toBe(404);
    expect((await read(stage, path(2, 5))).status).toBe(404);
    expect((await read(stage, path(2, 'x'))).status).toBe(404);
    expect((await read(stage, path(2, 99))).status).toBe(404);
    expect((await read(stage, `/v1/bets/nope/attempts/2/frames/0`)).status).toBe(422);
    expect((await fetch(base + path(2, 0))).status).toBe(401);
    // a purged attempt has no frames to show
    await db.update(attempts).set({ purged_at: new Date() }).where(eq(attempts.id, att!.id));
    expect((await read(stage, path(2, 0))).status).toBe(404);
  });
});
