// Beat 6: the stage's own re-check of a Gemini bet's evidence chain. Once a Gemini bet is ruled
// (the resolve landed, so its evidence hashes are on chain), the App fetches
// GET /v1/bets/:id/settlement (connection.ts fetchSettlement) and re-runs the shared
// verifySettlement over it here, never trusting the server's own `ok`, so the projector can show
// Gemini's bytes tied to the record, the ruling and the on-chain hashes (view.tsx MarketPanel).
import { sha256Hex } from '@youre-on/shared/primitives';
import { verifySettlement, type SettlementEvidence } from '@youre-on/shared/settlement';
import type { BetView, TickerState } from './ticker';

/** States in which a bet's resolve has landed (its evidence hashes are on chain). */
export const RULED_OR_LATER: ReadonlySet<string> = new Set([
  'RULED',
  'CONCEDED',
  'FINALIZED',
  'APPEALED',
  'APPEAL_RESOLVED',
  'PAID',
  'VOIDED',
]);

/** The stage's own re-check of a Gemini bet's evidence chain (verifySettlement). */
export interface Verification {
  ok: boolean;
  /** Gemini's raw response body was part of it (it hashed to the record's response_sha256). */
  body: boolean;
  /** The on-chain hashes were part of it (the resolve landed; read from the chain). */
  onchain: boolean;
  failed: string[];
}

/** "Gemini's response → record → on-chain evidence": only the links that were checked. */
export function verifiedChain(v: Pick<Verification, 'body' | 'onchain'>): string {
  return [v.body && "Gemini's response", 'record', v.onchain ? 'on-chain evidence' : 'ruling']
    .filter(Boolean)
    .join(' → ');
}

/** Re-runs the shared verifySettlement over GET /v1/bets/:id/settlement (never trusts its `ok`). */
export function verifyEvidence(bet: BetView, ev: SettlementEvidence): Verification | null {
  const t = bet.envelope?.terms;
  if (!t?.market) return null;
  const v = verifySettlement({
    record: ev.record,
    evidence_hash: ev.evidence_hash,
    ruling: ev.ruling,
    ruling_hash: ev.ruling_hash,
    terms: { yes_party: t.yes_party, market: t.market },
    body_sha256: ev.raw_body === null ? null : sha256Hex(ev.raw_body),
    onchain: ev.onchain,
  });
  return {
    ok: v.ok,
    body: v.checks.body_matches_record === true,
    onchain: v.checks.onchain_evidence === true && v.checks.onchain_ruling === true,
    failed: Object.entries(v.checks)
      .filter(([, good]) => !good)
      .map(([k]) => k.replace(/_/g, ' ')),
  };
}

/**
 * Gemini bets whose evidence chain the stage should fetch and re-check: Gemini's record has come
 * (market.settled) and the bet is RULED or later. Each with the state it is in, so the App can
 * ask once more on a later state when the first answer had no on-chain hashes yet.
 */
export function settlementFetches(
  s: Pick<TickerState, 'bets'>,
): Array<{ bet_id: string; state: string }> {
  return Object.values(s.bets).flatMap((b) =>
    b.settlement !== null &&
    b.envelope?.terms.market &&
    b.state !== null &&
    RULED_OR_LATER.has(b.state)
      ? [{ bet_id: b.bet_id, state: b.state }]
      : [],
  );
}
