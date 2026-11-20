// GET /v1/bets/:bet_id/settlement (a party's app session, or the stage session of the bet's
// room): the evidence chain of a Gemini bet, so anyone can check that the money moved on what
// Gemini said:
//   Gemini's raw response body --sha256--> record.response_sha256
//   GeminiSettlementRecord --hashJcs--> evidence_hash  (on chain at resolve)
//   settlement Ruling (commits to evidence_hash) --hashJcs--> ruling_hash  (on chain at resolve)
//   ruling.outcome = settlementOutcome(record, the line bound into the terms)
// `onchain` is read from the chain (markets/onchain.ts: the Bet account, or the resolve tx once
// the account is closed), never from bets.evidence_hash / ruling_hash: those are the server's own
// copy of what it sent. null when the bet is not resolved yet or the chain can't be read.
// The server runs the shared verifySettlement over exactly what it returns; clients can rerun it.
// 404 (not 403) for a bet the caller can't see, as GET /v1/bets/:id.
import { and, desc, eq } from 'drizzle-orm';
import { bets, chainTxs, geminiMarkets, rulings } from '@youre-on/db';
import { GeminiSettlementRecord } from '@youre-on/shared/evidence';
import { sha256Hex } from '@youre-on/shared/primitives';
import { Ruling } from '@youre-on/shared/ruling';
import { verifySettlement, type SettlementEvidence } from '@youre-on/shared/settlement';
import type { AuthContext } from '../context';
import { HttpError } from '../errors';
import type { LifecycleDeps } from '../lock/common';
import { loadEnvelope } from '../lock/terms';
import { readOnchainResolve } from './onchain';

function canRead(auth: AuthContext, bet: typeof bets.$inferSelect): boolean {
  if (auth.scopes.includes('app') && auth.user_id !== null)
    return bet.party_a_id === auth.user_id || bet.party_b_id === auth.user_id;
  return auth.scopes.includes('stage') && auth.room_id !== null && auth.room_id === bet.room_id;
}

export async function settlementEvidence(
  deps: LifecycleDeps,
  auth: AuthContext,
  betId: string,
): Promise<SettlementEvidence> {
  const [bet] = await deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
  if (!bet || !canRead(auth, bet)) throw new HttpError('NOT_FOUND', 'No such bet.');
  const [row] = await deps.db
    .select()
    .from(rulings)
    .where(and(eq(rulings.bet_id, betId), eq(rulings.stage, 'settlement')))
    .limit(1);
  const terms = (await loadEnvelope(deps.db, betId, { finalOnly: true }))?.envelope.terms;
  if (!row?.evidence_canonical || !terms?.market)
    throw new HttpError('NOT_FOUND', 'Gemini has not settled this bet yet.');
  const record = GeminiSettlementRecord.parse(JSON.parse(row.evidence_canonical));
  const ruling = Ruling.parse(JSON.parse(row.record_canonical));
  const [m] = await deps.db
    .select({ raw: geminiMarkets.settlement_raw, sha: geminiMarkets.settlement_response_sha256 })
    .from(geminiMarkets)
    .where(eq(geminiMarkets.instrument_symbol, record.contract.instrumentSymbol))
    .limit(1);
  // The contract's settling body, stored once: every bet on the contract is ruled on those same
  // bytes (markets/settlement.ts), so it is this record's body whenever the hashes agree.
  const raw = m?.raw && m.sha === record.response_sha256 ? m.raw : null;
  const [resolve] = await deps.db
    .select({ signature: chainTxs.signature })
    .from(chainTxs)
    .where(
      and(
        eq(chainTxs.bet_id, betId),
        eq(chainTxs.kind, 'resolve'),
        eq(chainTxs.status, 'confirmed'),
      ),
    )
    .orderBy(desc(chainTxs.rpc_confirmed_at))
    .limit(1);
  // Only once the server saw its resolve confirm (RULED or later) is there anything to read.
  const read =
    bet.ruling_hash || resolve
      ? await readOnchainResolve(deps, betId, resolve?.signature ?? null)
      : null;
  const onchain = read
    ? {
        evidence_hash: read.evidence_hash,
        ruling_hash: read.ruling_hash,
        resolve_signature: resolve?.signature ?? null,
        source: read.source,
      }
    : null;
  const verification = verifySettlement({
    record,
    evidence_hash: row.evidence_hash,
    ruling,
    ruling_hash: row.ruling_hash,
    terms: { yes_party: terms.yes_party, market: terms.market },
    body_sha256: raw === null ? null : sha256Hex(raw),
    onchain,
  });
  return {
    record,
    evidence_hash: row.evidence_hash,
    ruling,
    ruling_hash: row.ruling_hash,
    raw_body: raw,
    onchain,
    verification: { ok: verification.ok, checks: verification.checks as Record<string, boolean> },
  };
}
