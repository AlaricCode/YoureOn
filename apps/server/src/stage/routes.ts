// Stage laptop routes (API-CONTRACT §1.3 "Stage and demo", §2.14, §2.17):
//   POST /v1/stage/session {stage_key, room_id | room_code} -> 201 StageSessionResponse (scope
//        `stage`, plus `demo` when DEMO_MODE=true). room_code: the 6-char code (or QR payload). 404 unless STAGE_KEY is configured. The key is compared in
//        constant time; 10/min per client IP.
//   GET  /v1/bets/:bet_id -> BetSnapshot, for a party of the bet or a stage session of its room
//        (cold start / resync).
// Also fans the Gemini relay's snapshots out as `stage.market` to every room that has a live
// stage session (§3.1; ≤ 2/s: the relay polls every 2 s).
import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import { apiSessions, betEvents, bets, rooms, type Db } from '@youre-on/db';
import { BetSnapshot, parseRoomCode } from '@youre-on/shared/api';
import { AppealResult } from '@youre-on/shared/appeal';
import { BetState } from '@youre-on/shared/bet-state';
import { HearingRuling } from '@youre-on/shared/hearing';
import { BetId, Hex32, Uuid } from '@youre-on/shared/primitives';
import { Ruling } from '@youre-on/shared/ruling';
import { TermsEnvelope } from '@youre-on/shared/terms';
import type { AppDeps, AppEnv, AuthContext, RouteModule } from '../context';
import { requireSession } from '../auth/middleware';
import { TOKEN_PREFIX } from '../auth/sessions';
import { randomB64Url, sha256Hex } from '../crypto';
import { HttpError, validationError } from '../errors';
import { readBody } from '../http/body';
import { betSnapshot, loadUserRefs, partyOf, type SnapshotExtras } from '../bets/snapshot';
import { stageCors } from './cors';

/** A stage session outlives a pitch day, not a week. */
export const STAGE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const STAGE_SESSION_BUCKET = { limit: 10, windowMs: 60_000 } as const;
/** How long the list of stage rooms (for stage.market fan-out) is cached. */
export const STAGE_ROOMS_TTL_MS = 15_000;

/**
 * Exactly one of `room_id` and `room_code`: the presenter can type the 6-char code phone A shows
 * (or paste its youreon://room/ QR payload) instead of the room's uuid.
 */
export const StageSessionRequest = z
  .object({
    stage_key: z.string().min(1).max(256),
    room_id: Uuid.optional(),
    room_code: z.string().max(64).optional(),
  })
  .superRefine((b, ctx) => {
    if ((b.room_id === undefined) === (b.room_code === undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['room_id'],
        message: 'exactly one of room_id, room_code',
      });
    else if (b.room_code !== undefined && parseRoomCode(b.room_code) === null)
      ctx.addIssue({ code: 'custom', path: ['room_code'], message: 'not a room code' });
  });
export const StageSessionResponse = z.object({
  token: z.string(),
  session_id: Uuid,
  room_id: Uuid,
  scopes: z.array(z.enum(['stage', 'demo'])),
  expires_at: z.string(),
});
export type StageSessionResponse = z.infer<typeof StageSessionResponse>;

/** Constant-time on equal-length digests, so neither content nor length leaks. */
export function stageKeyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(sha256Hex(given), 'hex');
  const b = Buffer.from(sha256Hex(expected), 'hex');
  return timingSafeEqual(a, b);
}

/** Fly's proxy overwrites Fly-Client-IP; X-Forwarded-For is client-controlled, so it is ignored. */
function clientIp(c: Context<AppEnv>): string {
  const fly = c.req.header('fly-client-ip');
  if (fly) return fly.trim();
  const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Rooms with an unexpired, unrevoked stage session (cached). */
export function stageRoomsCache(db: Db, now: () => number) {
  let cached: { at: number; rooms: string[] } | null = null;
  const extra = new Set<string>();
  return {
    /** A room that just got a session: fan out to it at once, before the cache refreshes. */
    add(roomId: string) {
      extra.add(roomId);
    },
    async list(): Promise<string[]> {
      const t = now();
      if (!cached || t - cached.at > STAGE_ROOMS_TTL_MS) {
        const rows = await db
          .selectDistinct({ room_id: apiSessions.room_id })
          .from(apiSessions)
          .where(
            and(
              sql`'stage' = ANY(${apiSessions.scopes})`,
              isNull(apiSessions.revoked_at),
              gt(apiSessions.expires_at, new Date(t)),
            ),
          );
        cached = { at: t, rooms: rows.flatMap((r) => (r.room_id ? [r.room_id] : [])) };
        extra.clear();
      }
      return [...new Set([...cached.rooms, ...extra])];
    },
  };
}

/** The newest bet_events payload of each requested type for a bet. */
async function latestPayloads(
  db: Db,
  betId: string,
  types: readonly string[],
): Promise<Map<string, unknown>> {
  const rows = await db
    .selectDistinctOn([betEvents.type], { type: betEvents.type, envelope: betEvents.envelope })
    .from(betEvents)
    .where(and(eq(betEvents.bet_id, betId), inArray(betEvents.type, [...types])))
    .orderBy(betEvents.type, desc(betEvents.seq));
  return new Map(rows.map((r) => [r.type, (r.envelope as { payload?: unknown }).payload]));
}

/**
 * The §2.18 snapshot with what the event log knows (the terms / ruling / appeal owners have no
 * tables yet): the latest terms envelope, ruling, appeal result, attempt number and prev state.
 * Anything that fails its shared schema is left null rather than failing the read.
 */
export async function loadBetSnapshot(
  deps: Pick<AppDeps, 'db'>,
  row: typeof bets.$inferSelect,
  viewerUserId: string | null,
): Promise<BetSnapshot> {
  const refs = await loadUserRefs(deps.db, [row.party_a_id, row.party_b_id]);
  const p = await latestPayloads(deps.db, row.id, [
    'terms.proposed',
    'ruling.issued',
    'appeal.result',
    'attempt.started',
    'bet.state',
  ]);
  const extras: SnapshotExtras = {};
  const env = z.object({ envelope: TermsEnvelope }).safeParse(p.get('terms.proposed'));
  if (env.success) extras.envelope = env.data.envelope;
  const ruling = z
    .object({ ruling: z.union([Ruling, HearingRuling]), ruling_hash: Hex32 })
    .safeParse(p.get('ruling.issued'));
  if (ruling.success) extras.latest_ruling = ruling.data;
  const appeal = z.object({ result: AppealResult }).safeParse(p.get('appeal.result'));
  if (appeal.success) extras.appeal = appeal.data.result;
  const attempt = z.object({ attempt_no: z.number().int() }).safeParse(p.get('attempt.started'));
  if (attempt.success) extras.attempt_no = attempt.data.attempt_no;
  const st = z.object({ state: BetState, prev: BetState.nullable() }).safeParse(p.get('bet.state'));
  if (st.success && st.data.state === row.state) extras.prev_state = st.data.prev;
  return BetSnapshot.parse(
    betSnapshot(
      row,
      { a: refs.get(row.party_a_id)!, b: refs.get(row.party_b_id)! },
      viewerUserId,
      extras,
    ),
  );
}

function canRead(auth: AuthContext, row: typeof bets.$inferSelect): boolean {
  if (auth.scopes.includes('app') && partyOf(row, auth.user_id) !== null) return true;
  return auth.scopes.includes('stage') && auth.room_id !== null && auth.room_id === row.room_id;
}

export const stageRoutes: RouteModule = {
  name: 'stage',
  register(app, deps) {
    const stageRooms = stageRoomsCache(deps.db, deps.now);

    deps.markets?.onSnapshot((snapshot) => {
      void stageRooms
        .list()
        .then((ids) => {
          for (const id of ids) deps.hub.publishToRoom(id, { op: 'stage.market', snapshot });
        })
        .catch((err: unknown) => deps.log.warn('stage.market_fanout_failed', { err }));
    });

    app.use('/v1/stage/*', stageCors(deps.env));
    app.use('/v1/bets/:bet_id', stageCors(deps.env));

    app.post('/v1/stage/session', async (c) => {
      const expected = deps.env.STAGE_KEY;
      if (!expected) throw new HttpError('NOT_FOUND', 'Not found.');
      deps.rateLimit?.take('stage_session', clientIp(c), STAGE_SESSION_BUCKET);
      const body = await readBody(c, StageSessionRequest);
      if (!stageKeyMatches(body.stage_key, expected)) {
        deps.log.warn('stage.session_denied', { room_id: body.room_id ?? null });
        throw new HttpError('AUTH_REQUIRED', 'Wrong stage key.');
      }
      const code = body.room_code !== undefined ? parseRoomCode(body.room_code) : null;
      const [room] = await deps.db
        .select({ id: rooms.id })
        .from(rooms)
        .where(code !== null ? eq(rooms.code, code) : eq(rooms.id, body.room_id!))
        .limit(1);
      if (!room) throw new HttpError('NOT_FOUND', 'No such room.');

      const now = deps.now();
      const token = TOKEN_PREFIX + randomB64Url(32);
      const scopes: Array<'stage' | 'demo'> = deps.env.DEMO_MODE ? ['stage', 'demo'] : ['stage'];
      const expires_at = new Date(now + STAGE_SESSION_TTL_MS);
      const [row] = await deps.db
        .insert(apiSessions)
        .values({
          token_sha256: sha256Hex(token),
          scopes,
          room_id: room.id,
          created_at: new Date(now),
          expires_at,
        })
        .returning({ id: apiSessions.id });
      stageRooms.add(room.id);
      deps.log.info('stage.session', { session_id: row!.id, room_id: room.id, scopes });
      const out: StageSessionResponse = {
        token,
        session_id: row!.id,
        room_id: room.id,
        scopes,
        expires_at: expires_at.toISOString(),
      };
      return c.json(out, 201);
    });

    app.get('/v1/bets/:bet_id', requireSession, async (c) => {
      const id = BetId.safeParse(c.req.param('bet_id'));
      if (!id.success) throw validationError(id.error);
      const [row] = await deps.db.select().from(bets).where(eq(bets.id, id.data)).limit(1);
      const auth = c.get('auth');
      // 404 for both "missing" and "not yours", so bet ids can't be probed.
      if (!row || !canRead(auth, row)) throw new HttpError('NOT_FOUND', 'No such bet.');
      return c.json(await loadBetSnapshot(deps, row, auth.user_id), 200);
    });
  },
};
