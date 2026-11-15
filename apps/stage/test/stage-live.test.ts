// The stage client against the real server WebSocket hub (API-CONTRACT §1.3 stage auth, §3.1).
// DB-backed: skipped without DATABASE_URL. The stage token is inserted directly because
// POST /v1/stage/session is not built yet (server stream, PENDING).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiSessions, createDb, rooms, runMigrations, type DbHandle } from '@youre-on/db';
import {
  createDeps,
  loadEnv,
  routeModules,
  startServer,
  type RunningServer,
} from '@youre-on/server';
import { StageConnection, type WsLike } from '../src/connection';
import { applyFrame, initialTicker, type TickerState } from '../src/ticker';

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

d('stage client <-> server /v1/ws (DB)', () => {
  let db: DbHandle;
  let server: RunningServer;
  let wsUrl: string;

  beforeAll(async () => {
    await runMigrations(DB_URL!);
    db = createDb({ url: DB_URL!, max: 2 });
    const { deps } = createDeps({
      env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: DB_URL }),
      dbHandle: db,
      rateLimit: false,
    });
    server = await startServer(deps, {
      port: 0,
      hostname: '127.0.0.1',
      modules: routeModules,
      onClose: () => db.close(),
    });
    wsUrl = `ws://127.0.0.1:${server.port}/v1/ws`;
  });
  afterAll(async () => {
    await server?.close();
  });

  async function stageToken(roomId: string | null) {
    const token = `yo_s_${randomBytes(32).toString('base64url')}`;
    await db.db.insert(apiSessions).values({
      token_sha256: createHash('sha256').update(token).digest('hex'),
      scopes: ['stage'],
      room_id: roomId,
    });
    return token;
  }
  async function newRoom() {
    const code = Array.from(randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(
      '',
    );
    const [r] = await db.db
      .insert(rooms)
      .values({ code, name: 'stage test' })
      .returning({ id: rooms.id });
    return r!.id;
  }
  function connect(token: string, roomId: string) {
    let state: TickerState = initialTicker;
    const conn = new StageConnection({
      wsUrl,
      token,
      roomId,
      onAction: (a) => (state = applyFrame(state, a)),
      makeSocket: (u) => new WebSocket(u) as unknown as WsLike,
    });
    conn.start();
    return { conn, get: () => state };
  }

  it('a stage token for the room: welcome, then stage.* frames for that room reach the ticker', async () => {
    const roomId = await newRoom();
    const c = connect(await stageToken(roomId), roomId);
    await expect.poll(() => c.get().status, { timeout: 3000 }).toBe('open');
    expect(c.get().clockOffsetMs).not.toBeNull();
    const betId = randomUUID();
    // subscribe_room is processed after hello; retry the publish until the room channel has us
    await expect
      .poll(
        () => {
          server.deps.hub.publishToRoom(roomId, { op: 'stage.cue', bet_id: betId, kind: 'gavel' });
          return c.get().lastCue;
        },
        { timeout: 3000 },
      )
      .toEqual({ bet_id: betId, kind: 'gavel' });
    c.conn.stop();
  });

  it('another room -> 4403, final (no reconnect); a bad token -> 4401, final', async () => {
    const mine = await newRoom();
    const other = await newRoom();
    const c = connect(await stageToken(mine), other);
    await expect.poll(() => c.get().closeCode, { timeout: 3000 }).toBe(4403);
    expect(c.get().errors.at(-1)).toBe('not allowed in this room (4403)');
    const bad = connect(`yo_s_${randomBytes(32).toString('base64url')}`, mine);
    await expect.poll(() => bad.get().closeCode, { timeout: 3000 }).toBe(4401);
    await new Promise((r) => setTimeout(r, 400)); // past the first 250 ms backoff step
    expect(bad.get().status).toBe('closed');
  });
});
