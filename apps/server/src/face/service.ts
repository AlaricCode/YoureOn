// Face data access (DATA-MODEL §5.3, §7.2) and the head-to-head record (§7.1, API-CONTRACT §2.14)
// the face-match response carries.
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { bets, faceEnrollments, roomMembers, rooms, type Db } from '@youre-on/db';
import type { HeadToHead } from '@youre-on/shared/api';
import { FACE_MATCH_RULE, type FaceModelRef, type FaceStatus } from '@youre-on/shared/face';

type Reader = Pick<Db, 'select' | 'execute'>;

export interface CandidateRow {
  user_id: string;
  embedding_ciphertext: Uint8Array;
  embedding_nonce: Uint8Array;
  key_id: string;
}

/**
 * DATA-MODEL §7.2: the active enrollments of the other current members of a live room, same model
 * and version only. The caller has already checked the scanner is a member.
 */
export async function roomCandidates(
  db: Reader,
  roomId: string,
  scannerId: string,
  model: FaceModelRef,
  nowMs: number,
): Promise<CandidateRow[]> {
  return db
    .select({
      user_id: faceEnrollments.user_id,
      embedding_ciphertext: faceEnrollments.embedding_ciphertext,
      embedding_nonce: faceEnrollments.embedding_nonce,
      key_id: faceEnrollments.key_id,
    })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.room_id))
    .innerJoin(faceEnrollments, eq(faceEnrollments.user_id, roomMembers.user_id))
    .where(
      and(
        eq(roomMembers.room_id, roomId),
        isNull(roomMembers.left_at),
        ne(roomMembers.user_id, scannerId),
        eq(faceEnrollments.status, 'active'),
        eq(faceEnrollments.model_name, model.name),
        eq(faceEnrollments.model_version, model.version),
        eq(faceEnrollments.embedding_dim, model.dim),
        isNull(rooms.closed_at),
        sql`${rooms.expires_at} > ${new Date(nowMs).toISOString()}`,
      ),
    )
    .limit(FACE_MATCH_RULE.maxCandidates);
}

export async function faceStatusOf(
  db: Reader,
  userId: string,
): Promise<{ status: FaceStatus; consent_version: string | null }> {
  const [r] = await db
    .select({ status: faceEnrollments.status, consent_version: faceEnrollments.consent_version })
    .from(faceEnrollments)
    .where(eq(faceEnrollments.user_id, userId))
    .limit(1);
  return r
    ? { status: r.status, consent_version: r.consent_version }
    : { status: 'none', consent_version: null };
}

/**
 * "You're 4-7 against Jake": settled bets between the two users, from `me`'s side. A win or loss
 * is a party_a / party_b outcome; a split or refund is a push. Net = my payout − my stake.
 */
export async function headToHead(db: Reader, me: string, them: string): Promise<HeadToHead> {
  const rows = await db
    .select({
      party_a_id: bets.party_a_id,
      outcome: bets.outcome,
      stake_a: bets.stake_a,
      stake_b: bets.stake_b,
      payout_a: bets.payout_a,
      payout_b: bets.payout_b,
      settled_at: bets.settled_at,
    })
    .from(bets)
    .where(
      and(
        or(
          and(eq(bets.party_a_id, me), eq(bets.party_b_id, them)),
          and(eq(bets.party_a_id, them), eq(bets.party_b_id, me)),
        ),
        sql`${bets.state} IN ('PAID', 'VOIDED')`,
      ),
    );
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let net = 0n;
  let last: Date | null = null;
  for (const r of rows) {
    const iAmA = r.party_a_id === me;
    const mine = iAmA ? 'party_a' : 'party_b';
    const theirs = iAmA ? 'party_b' : 'party_a';
    if (r.outcome === mine) wins++;
    else if (r.outcome === theirs) losses++;
    else pushes++;
    const stake = BigInt((iAmA ? r.stake_a : r.stake_b) ?? 0);
    const paid = BigInt((iAmA ? r.payout_a : r.payout_b) ?? 0);
    net += paid - stake;
    if (r.settled_at && (!last || r.settled_at > last)) last = r.settled_at;
  }
  const abs = net < 0n ? -net : net;
  const cents = abs / 10_000n;
  const usd = `$${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  return {
    wins,
    losses,
    pushes,
    net: net.toString(),
    net_display: net === 0n ? '$0.00' : `${net < 0n ? '−' : '+'}${usd}`,
    last_settled_at: last ? last.toISOString() : null,
    includes_seed: false,
  };
}
