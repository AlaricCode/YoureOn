// Rooms and presence, API-CONTRACT §2.3 (TASKS D0-J4):
//   POST /v1/rooms                      (S)          -> 201 {room_id, code, qr_payload, expires_at}
//   POST /v1/rooms/join                 (S)          -> 200 {room: RoomSummary, members: RoomMember[]}
//   POST /v1/rooms/:room_id/leave       (S)          -> 204
//   GET  /v1/rooms/:room_id/presence    (B, member)  -> 200 {members: RoomMember[]}
// plus the `room.presence` WS control frame to room:<room_id> on join, leave and every
// online/offline transition of a member.
import { and, eq, isNull } from 'drizzle-orm';
import { roomMembers, rooms } from '@youre-on/db';
import {
  CreateRoomRequest,
  JoinRoomRequest,
  parseRoomCode,
  ROOM_QR_PREFIX,
  roomQrPayload,
  type CreateRoomResponse,
  type JoinRoomResponse,
  type RoomPresenceResponse,
} from '@youre-on/shared/api';
import type { AppDeps, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireSession, requireSignedRequest } from '../auth/middleware';
import {
  assertRoomLive,
  generateRoomCode,
  getRoomOr404,
  isActiveMember,
  isUniqueViolation,
  loadMembers,
  PresenceTracker,
  publishPresence,
  ROOM_TTL_MS,
  roomSummary,
} from './service';

const trackers = new WeakMap<AppDeps['hub'], PresenceTracker>();

/** The presence tracker for this process's hub (created on first use). */
export function presenceFor(deps: Pick<AppDeps, 'db' | 'hub' | 'log' | 'now'>): PresenceTracker {
  let t = trackers.get(deps.hub);
  if (!t) trackers.set(deps.hub, (t = new PresenceTracker(deps)));
  return t;
}

function pushPresence(deps: AppDeps, roomId: string): void {
  void publishPresence(deps, presenceFor(deps), roomId).catch((err: unknown) =>
    deps.log.warn('rooms.presence_publish_failed', { room_id: roomId, err }),
  );
}

export const roomsRoutes: RouteModule = {
  name: 'rooms',
  register(app, deps) {
    presenceFor(deps);

    app.post('/v1/rooms', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      const body = await readBody(c, CreateRoomRequest);
      const now = deps.now();
      let created: typeof rooms.$inferSelect | undefined;
      for (let i = 0; i < 8 && !created; i++) {
        try {
          created = await deps.db.transaction(async (tx) => {
            const [r] = await tx
              .insert(rooms)
              .values({
                code: generateRoomCode(),
                name: body.name ?? null,
                kind: body.kind,
                join_method: 'code',
                created_by: me.user_id,
                created_at: new Date(now),
                expires_at: new Date(now + ROOM_TTL_MS),
              })
              .returning();
            await tx.insert(roomMembers).values({
              room_id: r!.id,
              user_id: me.user_id,
              joined_via: 'code',
              joined_at: new Date(now),
              last_seen_at: new Date(now),
            });
            return r!;
          });
        } catch (err) {
          if (!isUniqueViolation(err, 'rooms_code_uq')) throw err;
        }
      }
      if (!created) throw new HttpError('INTERNAL', 'Could not allocate a room code. Try again.');
      pushPresence(deps, created.id);
      const out: CreateRoomResponse = {
        room_id: created.id,
        code: created.code,
        qr_payload: roomQrPayload(created.code),
        expires_at: created.expires_at.toISOString(),
      };
      return c.json(out, 201);
    });

    app.post('/v1/rooms/join', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      const body = await readBody(c, JoinRoomRequest);
      const viaQr = body.qr_payload !== undefined;
      const raw = (body.code ?? body.qr_payload ?? '').trim();
      const code = viaQr && !raw.startsWith(ROOM_QR_PREFIX) ? null : parseRoomCode(raw);
      if (!code) {
        throw new HttpError('VALIDATION_FAILED', "That isn't a room code.", {
          issues: [
            {
              path: viaQr ? 'qr_payload' : 'code',
              message: viaQr
                ? `expected ${ROOM_QR_PREFIX}<6-char code>`
                : 'expected 6 characters (A-Z without I/O, 2-9)',
            },
          ],
        });
      }
      const [room] = await deps.db.select().from(rooms).where(eq(rooms.code, code)).limit(1);
      if (!room) throw new HttpError('NOT_FOUND', 'No room with that code.');
      const now = deps.now();
      assertRoomLive(room, now);
      // Idem: room_members PK. A re-join clears left_at.
      await deps.db
        .insert(roomMembers)
        .values({
          room_id: room.id,
          user_id: me.user_id,
          joined_via: viaQr ? 'qr' : 'code',
          joined_at: new Date(now),
          last_seen_at: new Date(now),
        })
        .onConflictDoUpdate({
          target: [roomMembers.room_id, roomMembers.user_id],
          set: { left_at: null, last_seen_at: new Date(now) },
        });
      const presence = presenceFor(deps);
      const members = await publishPresence(deps, presence, room.id);
      const out: JoinRoomResponse = { room: roomSummary(room), members };
      return c.json(out, 200);
    });

    app.post('/v1/rooms/:room_id/leave', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      const room = await getRoomOr404(deps.db, c.req.param('room_id'));
      const [m] = await deps.db
        .select({ left_at: roomMembers.left_at })
        .from(roomMembers)
        .where(and(eq(roomMembers.room_id, room.id), eq(roomMembers.user_id, me.user_id)))
        .limit(1);
      if (!m) throw new HttpError('NOT_IN_ROOM', "You're not in this room.");
      if (m.left_at === null) {
        await deps.db
          .update(roomMembers)
          .set({ left_at: new Date(deps.now()) })
          .where(
            and(
              eq(roomMembers.room_id, room.id),
              eq(roomMembers.user_id, me.user_id),
              isNull(roomMembers.left_at),
            ),
          );
        deps.hub.leaveRoom(me.user_id, room.id);
        pushPresence(deps, room.id);
      }
      return c.body(null, 204);
    });

    app.get('/v1/rooms/:room_id/presence', requireSession, async (c) => {
      const auth = c.get('auth');
      const room = await getRoomOr404(deps.db, c.req.param('room_id'));
      const allowed = auth.scopes.includes('stage')
        ? auth.room_id === room.id
        : auth.user_id !== null && (await isActiveMember(deps.db, room.id, auth.user_id));
      if (!allowed) throw new HttpError('NOT_IN_ROOM', "You're not in this room.");
      const out: RoomPresenceResponse = {
        members: await loadMembers(deps.db, presenceFor(deps), room.id),
      };
      return c.json(out, 200);
    });
  },
};
