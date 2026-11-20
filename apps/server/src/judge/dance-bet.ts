// Is this bet a Dance Off (Terms.type 'dance_off')? The bets row has no type column
// (evidence_source is 'camera' like a skill bet), so the frozen terms say, or, failing that, a
// dance-off ruling (model rule/dance-off@1) on the bet. Appeals and the spoken review are gated
// on it (the score is deterministic, so there is nothing to appeal), as Gemini bets are.
import { and, desc, eq } from 'drizzle-orm';
import { betTermsVersions, rulings } from '@youre-on/db';
import { DANCE_TERMS_TYPE } from '@youre-on/shared/dance/terms';
import { CALLED_OFF_MODEL, DANCE_OFF_MODEL } from '@youre-on/shared/ruling';
import type { Tx } from '../lock/common';

/** Works with deps.db or inside a transaction. */
export async function isDanceOffBet(db: Pick<Tx, 'select'>, betId: string): Promise<boolean> {
  const [final] = await db
    .select({ json: betTermsVersions.canonical_json })
    .from(betTermsVersions)
    .where(and(eq(betTermsVersions.bet_id, betId), eq(betTermsVersions.is_final, true)))
    .orderBy(desc(betTermsVersions.version))
    .limit(1);
  if (final) {
    try {
      if ((JSON.parse(final.json) as { type?: unknown }).type === DANCE_TERMS_TYPE) return true;
    } catch {
      // unreadable terms: fall through to the rulings
    }
  }
  const [ruled] = await db
    .select({ id: rulings.id })
    .from(rulings)
    .where(and(eq(rulings.bet_id, betId), eq(rulings.model, DANCE_OFF_MODEL)))
    .limit(1);
  return ruled !== undefined;
}

/**
 * Was this bet called off (a rule/called-off@1 VOID, ./call-off.ts)? Both players agreed (or the
 * operator voided it), so there is nothing to appeal: the appeal routes refuse it like a dance off.
 */
export async function isCalledOffBet(db: Pick<Tx, 'select'>, betId: string): Promise<boolean> {
  const [ruled] = await db
    .select({ id: rulings.id })
    .from(rulings)
    .where(and(eq(rulings.bet_id, betId), eq(rulings.model, CALLED_OFF_MODEL)))
    .limit(1);
  return ruled !== undefined;
}
