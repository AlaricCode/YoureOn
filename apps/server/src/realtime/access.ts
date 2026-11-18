// DB-backed HubAccess: who may subscribe to what (API-CONTRACT §3.1/§3.2) and replay from
// bet_events (DATA-MODEL §5.19).
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { betEvents, bets, roomMembers, type Db } from '@youre-on/db';
import { resolveSession } from '../auth/sessions';
import type { AuthContext } from '../context';
import type { BetEnvelope, HubAccess } from './hub';

/** Max envelopes per socket replay; beyond this the client falls back to REST resync (§2.14). */
export const REPLAY_LIMIT = 1000;

export function dbHubAccess(db: Db, now: () => number = Date.now): HubAccess {
  return {
    async resolveToken(token) {
      try {
        return await resolveSession(db, token, now());
      } catch {
        return null;
      }
    },

    // Party devices (A's judge cam is a device of A, so it is covered) and stage sessions of
    // the bet's room.
    async canSeeBet(auth: AuthContext, betId) {
      const [b] = await db
        .select({ a: bets.party_a_id, b: bets.party_b_id, room_id: bets.room_id })
        .from(bets)
        .where(eq(bets.id, betId))
        .limit(1);
      if (!b) return false;
      if (
        auth.scopes.includes('app') &&
        auth.user_id &&
        (auth.user_id === b.a || auth.user_id === b.b)
      ) {
        return true;
      }
      return auth.scopes.includes('stage') && auth.room_id !== null && auth.room_id === b.room_id;
    },

    async canSeeRoom(auth: AuthContext, roomId) {
      if (auth.scopes.includes('stage')) return auth.room_id === roomId;
      if (!auth.user_id) return false;
      const [m] = await db
        .select({ room_id: roomMembers.room_id })
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.room_id, roomId),
            eq(roomMembers.user_id, auth.user_id),
            isNull(roomMembers.left_at),
          ),
        )
        .limit(1);
      return !!m;
    },

    // The events first, then the head: a row committed in between only raises last_seq, so
    // last_seq is never below the last returned seq (the client then asks again).
    async replay(betId, afterSeq, limit = REPLAY_LIMIT) {
      const rows = await db
        .select({ envelope: betEvents.envelope })
        .from(betEvents)
        .where(and(eq(betEvents.bet_id, betId), gt(betEvents.seq, afterSeq)))
        .orderBy(asc(betEvents.seq))
        .limit(limit);
      const [b] = await db
        .select({ last_seq: bets.last_seq })
        .from(bets)
        .where(eq(bets.id, betId))
        .limit(1);
      return {
        events: rows.map((r) => r.envelope as BetEnvelope),
        last_seq: b?.last_seq ?? afterSeq,
      };
    },
  };
}
