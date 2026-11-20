// stageRoomsCache (stage/routes.ts): which rooms get the Gemini relay's `stage.market` snapshots.
// Pure: a stand-in for the one database query, answered by the test, so a refresh can be held in
// flight while a stage session opens.
import { describe, expect, it } from 'vitest';
import type { Db } from '@youre-on/db';
import { STAGE_ROOMS_TTL_MS, stageRoomsCache } from '../src/stage/routes';

type Rows = Array<{ room_id: string | null }>;

/** Each query waits until the test answers it, in order. */
function heldDb() {
  const waiting: Array<(rows: Rows) => void> = [];
  const db = {
    selectDistinct: () => ({
      from: () => ({ where: () => new Promise<Rows>((resolve) => waiting.push(resolve)) }),
    }),
  } as unknown as Db;
  return { db, answer: (rows: Rows) => waiting.shift()!(rows) };
}

describe('stageRoomsCache', () => {
  it('keeps a room whose stage session opens while the room list is refreshing', async () => {
    let t = 1_000_000;
    const q = heldDb();
    const cache = stageRoomsCache(q.db, () => t);
    const first = cache.list(); // cold cache: the query is in flight
    cache.add('room-new'); // a session opens meanwhile; the query's answer predates it
    q.answer([{ room_id: 'room-old' }]);
    expect((await first).sort()).toEqual(['room-new', 'room-old']);
    expect((await cache.list()).sort()).toEqual(['room-new', 'room-old']); // until the next refresh
    t += STAGE_ROOMS_TTL_MS + 1;
    const next = cache.list();
    q.answer([{ room_id: 'room-old' }, { room_id: 'room-new' }]);
    expect((await next).sort()).toEqual(['room-new', 'room-old']);
  });

  it('drops a room added before a refresh once that refresh no longer lists it', async () => {
    let t = 1_000_000;
    const q = heldDb();
    const cache = stageRoomsCache(q.db, () => t);
    const warm = cache.list();
    q.answer([]);
    expect(await warm).toEqual([]);
    cache.add('room-a');
    expect(await cache.list()).toEqual(['room-a']); // fanned out at once, before any refresh
    t += STAGE_ROOMS_TTL_MS + 1;
    const next = cache.list();
    q.answer([]); // its session expired or was revoked before this refresh
    expect(await next).toEqual([]);
  });
});
