// The pair's head-to-head record in party terms (A = this bet's challenger), for the GG moment
// (packages/shared/src/gg.ts PairRecord). Counts come from face/service.ts headToHead (A's view:
// chain-confirmed settlements plus labelled is_seed history, DATA-MODEL §7.1); the streak from the
// pair's latest settled outcomes. A bet being conceded is not 'settled' yet (the projector writes
// that after the payout confirms), so this is the record BEFORE the bet: recordAfter() adds it.
//
// After the feat/rivalry-scan merge, h2h carries its own streak: use that instead of pairStreak().
import { sql } from 'drizzle-orm';
import type { Db } from '@youre-on/db';
import { GG_RIVAL_MIN, type PairRecord } from '@youre-on/shared/gg';
import type { Party } from '@youre-on/shared/primitives';
import { headToHead } from '../face/service';

type Reader = Pick<Db, 'select' | 'execute'>;

/** How many of the pair's latest settled bets the streak looks at. */
export const STREAK_LOOKBACK = 20;

/** The run of same-winner results ending at the pair's latest settled bet, in this bet's parties. */
export async function pairStreak(
  db: Reader,
  aId: string,
  bId: string,
): Promise<PairRecord['streak']> {
  const rows = await db.execute<{ outcome: string | null; party_a_id: string }>(sql`
    SELECT outcome, party_a_id FROM bets
    WHERE onchain_status = 'settled'
      AND ((party_a_id = ${aId} AND party_b_id = ${bId})
        OR (party_a_id = ${bId} AND party_b_id = ${aId}))
    ORDER BY settled_at DESC NULLS LAST, created_at DESC
    LIMIT ${STREAK_LOOKBACK}`);
  let streak: { party: Party; length: number } | null = null;
  for (const r of rows) {
    // The winner as a user, then as a party of THIS bet (the pair may have swapped roles).
    const winnerUser =
      r.outcome === 'party_a'
        ? r.party_a_id
        : r.outcome === 'party_b'
          ? r.party_a_id === aId
            ? bId
            : aId
          : null;
    if (!winnerUser) break; // a push (split / refund) ends the run
    const party: Party = winnerUser === aId ? 'A' : 'B';
    if (!streak) streak = { party, length: 1 };
    else if (streak.party === party) streak.length += 1;
    else break;
  }
  return streak;
}

/** The pair's record before this bet, in party terms. */
export async function pairRecord(db: Reader, aId: string, bId: string): Promise<PairRecord> {
  const h = await headToHead(db, aId, bId);
  const total = h.wins + h.losses + h.pushes;
  return {
    a_wins: h.wins,
    b_wins: h.losses,
    pushes: h.pushes,
    total,
    streak: await pairStreak(db, aId, bId),
    rival: total >= GG_RIVAL_MIN,
    includes_seed: h.includes_seed,
  };
}
