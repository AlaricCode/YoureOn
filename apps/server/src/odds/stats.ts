// The performer's record the judge's odds are grounded in (PerformerStats): overall W–L, W–L as
// the performer of THIS kind of challenge (category derived from each final card's claim), recent
// results, streak, and the head-to-head with this opponent (face/service.ts headToHead). Settled
// bets only, including labelled demo history (bets.is_seed -> includes_seed).
//
// One query (the performer's last 200 settled bets joined to their final terms), then a pure
// fold (computeStats) so the rules are unit-testable without a database.
// Spec: docs/planning/SCHEMAS.md §3.5.
import { sql } from 'drizzle-orm';
import {
  CATEGORY_LABEL,
  classifyChallenge,
  type ChallengeCategory,
} from '@youre-on/shared/challenge-category';
import type { PerformerStats } from '@youre-on/shared/odds';
import type { Party } from '@youre-on/shared/primitives';
import type { AppDeps } from '../context';
import { headToHead } from '../face/service';

export const STATS_ROW_LIMIT = 200;

export type StatsRow = {
  id: string;
  is_seed: boolean;
  settled_at: Date | string | null;
  outcome: 'party_a' | 'party_b' | 'split' | 'refund' | null;
  party_a_id: string;
  party_b_id: string;
  title: string | null;
  /** The final terms (bet_terms_versions.terms), or null when the bet has none. */
  t: {
    type?: string;
    claim?: string;
    performer?: 'A' | 'B' | null;
    yes_party?: 'A' | 'B';
    success_criteria?: string[];
  } | null;
} & Record<string, unknown>;

export async function loadStatsRows(db: AppDeps['db'], userId: string): Promise<StatsRow[]> {
  const rows = await db.execute<StatsRow>(sql`
    SELECT b.id, b.is_seed, b.settled_at, b.outcome, b.party_a_id, b.party_b_id, b.title,
           tv.terms AS t
    FROM bets b
    LEFT JOIN bet_terms_versions tv ON tv.bet_id = b.id AND tv.is_final
    WHERE b.onchain_status = 'settled' AND (b.party_a_id = ${userId} OR b.party_b_id = ${userId})
    ORDER BY b.settled_at DESC NULLS LAST, b.id
    LIMIT ${STATS_ROW_LIMIT}`);
  return [...rows];
}

export type ComputedStats = Omit<PerformerStats, 'performer' | 'h2h'>;

/** The pure fold over the performer's settled rows (newest first). */
export function computeStats(
  rows: readonly StatsRow[],
  userId: string,
  category: ChallengeCategory,
): ComputedStats {
  const overall = { wins: 0, losses: 0, pushes: 0 };
  const inCat = { made: 0, tries: 0 };
  const asPerf = { made: 0, tries: 0 };
  const recent: Array<'W' | 'L'> = [];
  let includesSeed = false;
  for (const r of rows) {
    const mySide = r.party_a_id === userId ? 'party_a' : r.party_b_id === userId ? 'party_b' : null;
    if (!mySide || !r.outcome) continue;
    includesSeed ||= r.is_seed;
    if (r.outcome === 'split' || r.outcome === 'refund') {
      overall.pushes++;
      continue;
    }
    if (r.outcome === mySide) overall.wins++;
    else overall.losses++;

    const t = r.t;
    if (!t || t.type !== 'skill' || !t.performer || !t.yes_party) continue;
    const performerId = t.performer === 'A' ? r.party_a_id : r.party_b_id;
    if (performerId !== userId) continue;
    const made = r.outcome === (t.yes_party === 'A' ? 'party_a' : 'party_b');
    asPerf.tries++;
    if (made) asPerf.made++;
    if (recent.length < 5) recent.push(made ? 'W' : 'L');
    const cat = classifyChallenge({
      claim: t.claim ?? null,
      success_criteria: t.success_criteria ?? null,
    });
    if (cat === category) {
      inCat.tries++;
      if (made) inCat.made++;
    }
  }
  let streak: ComputedStats['streak'] = null;
  if (recent.length) {
    let n = 1;
    while (n < recent.length && recent[n] === recent[0]) n++;
    streak = { kind: recent[0]!, n };
  }
  return {
    category,
    category_label: CATEGORY_LABEL[category][0],
    overall,
    in_category: inCat,
    as_performer: asPerf,
    recent,
    streak,
    includes_seed: includesSeed,
  };
}

export async function performerStats(
  db: AppDeps['db'],
  i: {
    performerId: string;
    opponentId: string;
    category: ChallengeCategory;
    performerParty: Party;
    displayName: string;
  },
): Promise<PerformerStats> {
  const rows = await loadStatsRows(db, i.performerId);
  const c = computeStats(rows, i.performerId, i.category);
  const h2h = await headToHead(db, i.performerId, i.opponentId);
  return {
    performer: { party: i.performerParty, display_name: i.displayName },
    ...c,
    h2h,
    includes_seed: c.includes_seed || h2h.includes_seed,
  };
}
