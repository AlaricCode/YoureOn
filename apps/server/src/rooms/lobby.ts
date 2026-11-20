// The shared lobby: one live room every phone joins on launch, so a face scan reaches whoever has
// the app open without anyone typing a code. It is an ordinary rooms row (bets, the stage and
// face scoping all key on room_id), told apart without a migration by isLobbyRoom (kind
// 'nearby', name 'Lobby', created_by null, not a demo room).
// Spec: docs/planning/API-CONTRACT.md §2.3a.
//
// Get-or-create: the newest live lobby wins. Every lobby join pushes its expires_at out to
// now + ROOM_TTL_MS (capped by the rooms_expiry CHECK, created_at + 14 days) so it never
// expires mid-demo; when there is none (first use, or the old one closed or ran out), one is
// created under a transaction-scoped advisory lock, so concurrent first joins make exactly one.
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { roomMembers, rooms, type Db } from '@youre-on/db';
import { LOBBY_ROOM_KIND, LOBBY_ROOM_NAME } from '@youre-on/shared/api';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import { generateRoomCode, isUniqueViolation, ROOM_TTL_MS, type RoomRow } from './service';

/** The rooms_expiry CHECK: expires_at <= created_at + 14 days. */
const ROOM_MAX_LIFETIME = sql`interval '14 days'`;
const lobbyLock = sql`hashtextextended('yo:rooms:lobby', 0)`;

/** isLobbyRoom (rooms/service.ts) as SQL: any lobby, live or not. */
const isLobbyWhere = () =>
  and(
    eq(rooms.kind, LOBBY_ROOM_KIND),
    eq(rooms.name, LOBBY_ROOM_NAME),
    isNull(rooms.created_by),
    eq(rooms.is_demo, false),
  );

const lobbyWhere = (nowMs: number) =>
  and(isLobbyWhere(), isNull(rooms.closed_at), gt(rooms.expires_at, new Date(nowMs)));

/** 404 unless LOBBY_ENABLED (default true). */
export function assertLobbyEnabled(env: AppDeps['env']): void {
  if (!env.LOBBY_ENABLED) throw new HttpError('NOT_FOUND', 'There is no lobby on this server.');
}

/** The newest live lobby, its expiry pushed out to now + ROOM_TTL_MS; null when there is none. */
async function extendLiveLobby(db: Pick<Db, 'update'>, nowMs: number): Promise<RoomRow | null> {
  const until = new Date(nowMs + ROOM_TTL_MS).toISOString();
  // One statement: picks the newest live lobby and extends it (monotonic: never shortens).
  const [r] = await db
    .update(rooms)
    .set({
      expires_at: sql`GREATEST(${rooms.expires_at}, LEAST(${until}::timestamptz, ${rooms.created_at} + ${ROOM_MAX_LIFETIME}))`,
    })
    .where(
      eq(
        rooms.id,
        sql`(SELECT id FROM rooms WHERE ${lobbyWhere(nowMs)} ORDER BY created_at DESC, id DESC LIMIT 1)`,
      ),
    )
    .returning();
  return r ?? null;
}

/** The live lobby (extended), created on first use. */
export async function getOrCreateLobby(deps: Pick<AppDeps, 'db' | 'now'>): Promise<RoomRow> {
  const now = deps.now();
  const live = await extendLiveLobby(deps.db, now);
  if (live) return live;
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lobbyLock})`);
    const again = await extendLiveLobby(tx, now); // another join made it while we waited
    if (again) return again;
    for (let i = 0; i < 8; i++) {
      try {
        // A savepoint, so a code collision with a user's room doesn't abort the transaction.
        return await tx.transaction(async (sp) => {
          const [r] = await sp
            .insert(rooms)
            .values({
              code: generateRoomCode(),
              name: LOBBY_ROOM_NAME,
              kind: LOBBY_ROOM_KIND,
              join_method: 'nearby',
              created_by: null,
              is_demo: false,
              created_at: new Date(now),
              expires_at: new Date(now + ROOM_TTL_MS),
            })
            .returning();
          return r!;
        });
      } catch (err) {
        if (!isUniqueViolation(err, 'rooms_code_uq')) throw err;
      }
    }
    throw new HttpError('INTERNAL', 'Could not open the lobby. Try again.');
  });
}

/**
 * Ends `userId`'s lobby membership(s), for a phone that goes into a private room (POST /v1/rooms,
 * POST /v1/rooms/join): an explicit room choice means it is no longer listed, face-matched or
 * challengeable in the lobby, even when the app never left the lobby itself (killed while in it,
 * then cold-started from a room link). The next lobby join brings it back. Returns the lobby
 * room ids it left, for the caller to unsubscribe and push room.presence to.
 */
export async function leaveLobbies(
  db: Pick<Db, 'update' | 'select'>,
  userId: string,
  nowMs: number,
): Promise<string[]> {
  const left = await db
    .update(roomMembers)
    .set({ left_at: new Date(nowMs) })
    .where(
      and(
        eq(roomMembers.user_id, userId),
        isNull(roomMembers.left_at),
        inArray(roomMembers.room_id, db.select({ id: rooms.id }).from(rooms).where(isLobbyWhere())),
      ),
    )
    .returning({ room_id: roomMembers.room_id });
  return left.map((r) => r.room_id);
}
