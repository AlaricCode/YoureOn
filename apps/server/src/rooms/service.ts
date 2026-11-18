// Rooms and presence (API-CONTRACT §2.3, DATA-MODEL §5.4/§5.5): room lookup and liveness,
// active membership, member lists (RoomMember[]) and the `room.presence` WS control frame.
import { randomInt } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { roomMembers, rooms, users, type Db } from '@youre-on/db';
import {
  PRESENCE_ONLINE_GRACE_MS,
  ROOM_CODE_ALPHABET,
  roomQrPayload,
  type RoomMember,
  type RoomSummary,
} from '@youre-on/shared/api';
import { Uuid } from '@youre-on/shared/primitives';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import { userRefOf } from '../bets/snapshot';

export type RoomRow = typeof rooms.$inferSelect;
type Reader = Pick<Db, 'select' | 'execute'>;

/** DATA-MODEL §5.4 default lifetime (`now() + 12 h`). */
export const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

export function generateRoomCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return s;
}

/** Postgres unique_violation, possibly wrapped by Drizzle ("Failed query", cause = pg error). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const pg = e as { code?: unknown; constraint_name?: unknown };
    if (pg.code === '23505') return constraint === undefined || pg.constraint_name === constraint;
  }
  return false;
}

export function roomSummary(r: RoomRow): RoomSummary {
  return {
    room_id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    is_demo: r.is_demo,
    qr_payload: roomQrPayload(r.code),
    created_by: r.created_by,
    expires_at: r.expires_at.toISOString(),
  };
}

export const isRoomLive = (r: Pick<RoomRow, 'closed_at' | 'expires_at'>, nowMs: number) =>
  r.closed_at === null && r.expires_at.getTime() > nowMs;

/** Throws 410 ROOM_EXPIRED unless the room is open and unexpired. */
export function assertRoomLive(r: RoomRow, nowMs: number): void {
  if (!isRoomLive(r, nowMs)) {
    throw new HttpError('ROOM_EXPIRED', 'This room has closed.', {
      expires_at: r.expires_at.toISOString(),
      closed_at: r.closed_at?.toISOString() ?? null,
    });
  }
}

/** The room by id (a non-UUID id is simply unknown), or 404 NOT_FOUND. */
export async function getRoomOr404(db: Pick<Db, 'select'>, roomId: string): Promise<RoomRow> {
  if (!Uuid.safeParse(roomId).success) throw new HttpError('NOT_FOUND', 'No such room.');
  const [r] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!r) throw new HttpError('NOT_FOUND', 'No such room.');
  return r;
}

/** Is `userId` a current member (joined, not left) of `roomId`? */
export async function isActiveMember(
  db: Pick<Db, 'select'>,
  roomId: string,
  userId: string,
): Promise<boolean> {
  const [m] = await db
    .select({ user_id: roomMembers.user_id })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.room_id, roomId),
        eq(roomMembers.user_id, userId),
        isNull(roomMembers.left_at),
      ),
    )
    .limit(1);
  return !!m;
}

// ---- face_enrolled ----------------------------------------------------------------------
// face_enrollments (DATA-MODEL §5.3) arrived with migration 0006 (src/face). The probe below is
// kept so a database that has not run 0006 yet still works. Until
// it does, every member reports face_enrolled=false; once the table exists this picks it up
// without a code change. The probe result is cached only once it is true.
let faceTableKnown = false;
async function faceEnrolledIds(db: Reader, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  if (!faceTableKnown) {
    const rows = await db.execute<{ ok: boolean }>(
      sql`SELECT to_regclass('public.face_enrollments') IS NOT NULL AS ok`,
    );
    if (!rows[0]?.ok) return new Set();
    faceTableKnown = true;
  }
  const rows = await db.execute<{ user_id: string }>(
    sql`SELECT user_id::text AS user_id FROM face_enrollments
        WHERE status = 'active' AND user_id IN ${userIds}`,
  );
  return new Set(rows.map((r) => r.user_id));
}

// ---- presence ---------------------------------------------------------------------------

/**
 * Tracks `online` per §2.3 ("a live WS within 30 s"): online while the hub has a socket for
 * the user, and for PRESENCE_ONLINE_GRACE_MS after the last one closes. On every transition
 * (online, and offline once the grace ends) it bumps room_members.last_seen_at and pushes
 * `room.presence` to each of the user's live rooms.
 */
export class PresenceTracker {
  private readonly lastOffline = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly deps: Pick<AppDeps, 'db' | 'hub' | 'log' | 'now'>,
    private readonly graceMs = PRESENCE_ONLINE_GRACE_MS,
  ) {
    this.unsubscribe = deps.hub.onPresence((userId, online) => this.onChange(userId, online));
  }

  isOnline(userId: string): boolean {
    if (this.deps.hub.isUserOnline(userId)) return true;
    const off = this.lastOffline.get(userId);
    return off !== undefined && this.deps.now() - off < this.graceMs;
  }

  stop(): void {
    this.unsubscribe();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private onChange(userId: string, online: boolean): void {
    const t = this.timers.get(userId);
    if (t) clearTimeout(t);
    this.timers.delete(userId);
    if (online) {
      const wasInGrace = this.isOnlineByGrace(userId);
      this.lastOffline.delete(userId);
      this.fire(userId, !wasInGrace);
      return;
    }
    this.lastOffline.set(userId, this.deps.now());
    this.fire(userId, false); // last_seen_at only; still "online" during the grace
    const timer = setTimeout(() => {
      this.timers.delete(userId);
      this.lastOffline.delete(userId);
      this.fire(userId, true);
    }, this.graceMs);
    timer.unref();
    this.timers.set(userId, timer);
  }

  private isOnlineByGrace(userId: string): boolean {
    const off = this.lastOffline.get(userId);
    return off !== undefined && this.deps.now() - off < this.graceMs;
  }

  private fire(userId: string, broadcast: boolean): void {
    void this.touchAndBroadcast(userId, broadcast).catch((err: unknown) =>
      this.deps.log.warn('rooms.presence_failed', { user_id: userId, err }),
    );
  }

  private async touchAndBroadcast(userId: string, broadcast: boolean): Promise<void> {
    const { db } = this.deps;
    // Monotonic: fire() does not serialize its writes (an online and an offline touch, or two
    // trackers on one hub, can commit out of order), so an older timestamp must never
    // overwrite a newer one.
    const seenAt = new Date(this.deps.now()).toISOString();
    const touched = await db
      .update(roomMembers)
      .set({
        last_seen_at: sql`GREATEST(${roomMembers.last_seen_at}, ${seenAt}::timestamptz)`,
      })
      .where(and(eq(roomMembers.user_id, userId), isNull(roomMembers.left_at)))
      .returning({ room_id: roomMembers.room_id });
    if (!broadcast) return;
    for (const { room_id } of touched) await publishPresence(this.deps, this, room_id);
  }
}

/** Current members of a room (left members excluded), oldest join first. */
export async function loadMembers(
  db: Reader,
  presence: Pick<PresenceTracker, 'isOnline'>,
  roomId: string,
): Promise<RoomMember[]> {
  const rows = await db
    .select({
      id: users.id,
      display_name: users.display_name,
      wallet_pubkey: users.wallet_pubkey,
      deleted_at: users.deleted_at,
      last_seen_at: roomMembers.last_seen_at,
    })
    .from(roomMembers)
    .innerJoin(users, eq(users.id, roomMembers.user_id))
    .where(and(eq(roomMembers.room_id, roomId), isNull(roomMembers.left_at)))
    .orderBy(asc(roomMembers.joined_at), asc(users.id));
  const live = rows.filter((r) => r.deleted_at === null);
  const enrolled = await faceEnrolledIds(
    db,
    live.map((r) => r.id),
  );
  const out: RoomMember[] = [];
  for (const r of live) {
    const user = userRefOf(r);
    if (!user) continue; // wallet-less (unclaimed demo) accounts can't be challenged yet
    out.push({
      user,
      face_enrolled: enrolled.has(r.id),
      online: presence.isOnline(r.id),
      last_seen_at: r.last_seen_at.toISOString(),
    });
  }
  return out;
}

/** Pushes the `room.presence` control frame (§3.1) to room:<roomId>. */
export async function publishPresence(
  deps: Pick<AppDeps, 'db' | 'hub'>,
  presence: Pick<PresenceTracker, 'isOnline'>,
  roomId: string,
): Promise<RoomMember[]> {
  const members = await loadMembers(deps.db, presence, roomId);
  deps.hub.publishToRoom(roomId, { op: 'room.presence', room_id: roomId, members });
  return members;
}
