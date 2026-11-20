// The frozen Terms of a bet, for the judge: the is_final row of bet_terms_versions, which the
// terms flow (lock/terms.ts) writes. A different source can be injected with
// createJudgeRoutes({ loadTerms }).
import { sql } from 'drizzle-orm';
import type { Db } from '@youre-on/db';
import { hashJcs } from '@youre-on/shared/jcs';
import { Terms } from '@youre-on/shared/terms';
import type { BetRow } from '../bets/snapshot';

export type TermsLoader = (db: Db, bet: BetRow) => Promise<Terms | null>;

/** The is_final row of bet_terms_versions, strictly parsed; null if missing. */
export const loadFinalTerms: TermsLoader = async (db, bet) => {
  const rows = await db.execute<{ canonical_json: string }>(
    sql`SELECT canonical_json FROM bet_terms_versions
        WHERE bet_id = ${bet.id} AND is_final ORDER BY version DESC LIMIT 1`,
  );
  const raw = rows[0]?.canonical_json;
  if (!raw) return null;
  return Terms.parse(JSON.parse(raw));
};

/** Terms that are safe to judge on: they hash to the bet's frozen terms_hash. */
export function termsMatchBet(terms: Terms, bet: Pick<BetRow, 'terms_hash'>): boolean {
  return bet.terms_hash !== null && hashJcs(terms) === bet.terms_hash;
}
