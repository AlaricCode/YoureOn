// SCHEMAS §4 + §5.2 `stage: 'settlement'`: Gemini's settled BTC 5-minute contract ->
// GeminiSettlementRecord -> Ruling, as pure functions (no I/O), so the server builds the ruling
// and any client can re-derive it from the record it was shown.
//
//   classifyContract()  what a Gemini event body says about one contract: still pending, settled
//                       (yes / no), or voided. Tolerant of Gemini's casing and of status names we
//                       have not seen yet (an `invalid` contract is still unseen: 0 of 173
//                       sampled, so cancelled / canceled / voided / void count as invalid too).
//   settlementOutcome() the record + the binding Terms.market -> MET / NOT_MET, or VOID
//                       'market_invalid' when Gemini voided the contract or settled it against a
//                       different line than the one bound into the terms (ambiguous).
//   settlementRuling()  the strict Ruling: confidence 1, cited_frames [], frame_hashes [],
//                       model rule/gemini-settlement@1, evidence_hash = hashJcs(record). No LLM.
//
// "yes" means Bitcoin finished at or above the line (the UP contract), so YES -> claim MET; the
// server maps MET through yes_party exactly as for camera rulings (toOutcome).
import { z } from 'zod/v4';
import { GeminiSettlementRecord } from './evidence';
import type { GeminiStrike } from './gemini';
import { hashJcs } from './jcs';
import { Hex32, otherParty, Signature, type Party } from './primitives';
import { GEMINI_SETTLEMENT_MODEL, Ruling, type ClaimResult } from './ruling';
import type { MarketRef } from './terms';

/** GET /v1/prediction-markets/events/{eventTicker}: the record's `source_url`. */
export const geminiEventUrl = (eventTicker: string, base = 'https://api.gemini.com'): string =>
  `${base}/v1/prediction-markets/events/${encodeURIComponent(eventTicker)}`;

/** Gemini statuses that mean "voided": the bet refunds (VOID 'market_invalid'). */
const VOIDED = new Set(['invalid', 'cancelled', 'canceled', 'voided', 'void']);

/** The settlement-relevant fields of one Gemini contract (tolerant: raw API values). */
export interface ContractSettlementInput {
  status: string;
  resolutionSide?: string | null | undefined;
  settlementValue?: string | number | null | undefined;
  resolvedAt?: string | null | undefined;
}

export type ContractState =
  /** Not settled yet: active / closed / under_review, or 'settled' without a usable side. */
  | { kind: 'pending'; status: string }
  | { kind: 'settled'; side: 'yes' | 'no' }
  | { kind: 'invalid' };

export function classifyContract(c: ContractSettlementInput): ContractState {
  const status = c.status.trim().toLowerCase();
  if (VOIDED.has(status)) return { kind: 'invalid' };
  if (status === 'settled') {
    const side = typeof c.resolutionSide === 'string' ? c.resolutionSide.trim().toLowerCase() : '';
    if (side === 'yes' || side === 'no') return { kind: 'settled', side };
  }
  return { kind: 'pending', status };
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** "64389.60" and "64389.6" are the same line. Non-decimals compare as themselves. */
export function sameDecimal(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const norm = (s: string) =>
    DECIMAL.test(s) && s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return norm(a) === norm(b);
}

/** "64367.38366666667" -> "$64,367.38" (half-up to cents; exact decimal string math). */
export function formatPrice(s: string | null): string {
  if (s === null || !DECIMAL.test(s)) return s ?? '?';
  const [whole, frac = ''] = s.split('.') as [string, string?];
  let cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  if ((frac[2] ?? '0') >= '5') cents += 1n;
  const w = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${w}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export type SettlementDecision =
  | { outcome: 'MET' | 'NOT_MET'; side: 'yes' | 'no' }
  | { outcome: 'VOID'; why: 'invalid' | 'strike_mismatch' };

/** The record vs the binding market reference (the line latched at lock). */
export function settlementOutcome(
  record: GeminiSettlementRecord,
  market: Pick<MarketRef, 'strike' | 'eventTicker' | 'instrumentSymbol'>,
): SettlementDecision {
  const c = record.contract;
  if (c.status === 'invalid' || c.resolutionSide === null)
    return { outcome: 'VOID', why: 'invalid' };
  // Gemini's settled line must be the line we bound into the terms; anything else is ambiguous.
  // (A settled body that omits the line is not a mismatch: Gemini's side still decides.)
  if (
    c.eventTicker !== market.eventTicker ||
    c.instrumentSymbol !== market.instrumentSymbol ||
    (market.strike.value !== null &&
      c.strike.value !== null &&
      !sameDecimal(c.strike.value, market.strike.value))
  )
    return { outcome: 'VOID', why: 'strike_mismatch' };
  return { outcome: c.resolutionSide === 'yes' ? 'MET' : 'NOT_MET', side: c.resolutionSide };
}

/** The spoken / displayed ruling reason (≤ 280 chars, normalized text). */
export function settlementReason(record: GeminiSettlementRecord, d: SettlementDecision): string {
  const reason = liveReason(record, d);
  // the server's REPLAY feed (a recorded round replayed when Gemini's API is down) says so
  return record.source_url.startsWith('replay:') ? `Replay of a recorded round. ${reason}` : reason;
}

function liveReason(record: GeminiSettlementRecord, d: SettlementDecision): string {
  const c = record.contract;
  if (d.outcome === 'VOID')
    return d.why === 'invalid'
      ? 'Gemini voided this contract, so nobody wins and both stakes go back.'
      : 'Gemini settled against a different line than the one locked in, so both stakes go back.';
  const up = d.side === 'yes';
  const vs = up ? 'at or above' : 'below';
  const at = c.settlementValue === null ? '' : ` at ${formatPrice(c.settlementValue)}`;
  const line = c.strike.value === null ? 'the line' : `the ${formatPrice(c.strike.value)} line`;
  return `Gemini settled ${up ? 'UP' : 'DOWN'}: Bitcoin finished${at}, ${vs} ${line}.`;
}

export interface SettlementRulingInput {
  ruling_id: string;
  created_at: string;
  terms: { bet_id: string; yes_party: Party; market: MarketRef | null };
  terms_hash: string;
  record: GeminiSettlementRecord;
}

/** Strict SCHEMAS Ruling for the settlement (throws only on a bug: the record must parse). */
export function settlementRuling(i: SettlementRulingInput): Ruling {
  const record = GeminiSettlementRecord.parse(i.record);
  if (!i.terms.market) throw new Error('settlementRuling: not a market bet');
  if (record.bet_id !== i.terms.bet_id || record.terms_hash !== i.terms_hash)
    throw new Error('settlementRuling: record is for another bet');
  const d = settlementOutcome(record, i.terms.market);
  let outcome: Ruling['outcome'];
  let claim: ClaimResult;
  if (d.outcome === 'VOID') {
    outcome = 'VOID';
    claim = 'UNCLEAR';
  } else {
    claim = d.outcome;
    const winner = d.outcome === 'MET' ? i.terms.yes_party : otherParty(i.terms.yes_party);
    outcome = winner === 'A' ? 'A_WINS' : 'B_WINS';
  }
  return Ruling.parse({
    schema_version: 1,
    ruling_id: i.ruling_id,
    bet_id: i.terms.bet_id,
    stage: 'settlement',
    attempt_no: 1,
    outcome,
    claim_result: claim,
    redo_reason: null,
    void_reason: outcome === 'VOID' ? 'market_invalid' : null,
    confidence: 1,
    reason: settlementReason(record, d),
    cited_frames: [],
    frame_hashes: [],
    model: GEMINI_SETTLEMENT_MODEL,
    evidence_hash: hashJcs(record),
    terms_hash: i.terms_hash,
    created_at: i.created_at,
  });
}

/** Builds the strict record from a classified contract (the server adds the HTTP provenance). */
export function settlementRecord(i: {
  bet_id: string;
  terms_hash: string;
  eventTicker: string;
  instrumentSymbol: string;
  state: Exclude<ContractState, { kind: 'pending' }>;
  settlementValue: string | null;
  strike: GeminiStrike;
  resolvedAt: string | null;
  source_url: string;
  response_sha256: string;
  fetched_at: string;
}): GeminiSettlementRecord {
  return GeminiSettlementRecord.parse({
    schema_version: 1,
    kind: 'gemini_settlement',
    bet_id: i.bet_id,
    terms_hash: i.terms_hash,
    contract: {
      eventTicker: i.eventTicker,
      instrumentSymbol: i.instrumentSymbol,
      status: i.state.kind === 'invalid' ? 'invalid' : 'settled',
      resolutionSide: i.state.kind === 'settled' ? i.state.side : null,
      settlementValue: i.state.kind === 'settled' ? i.settlementValue : null,
      strike: i.strike,
      resolvedAt: i.resolvedAt,
    },
    source_url: i.source_url,
    response_sha256: i.response_sha256,
    fetched_at: i.fetched_at,
  });
}

/** One link of the evidence chain: Gemini's bytes -> record -> ruling -> on chain. */
export type SettlementCheckName =
  | 'body_matches_record'
  | 'record_hash'
  | 'ruling_commits_record'
  | 'ruling_hash'
  | 'outcome_follows_gemini'
  | 'onchain_evidence'
  | 'onchain_ruling';

/**
 * Anyone can re-check a Gemini settlement: the raw body hashes to record.response_sha256, the
 * record hashes to evidence_hash, the ruling commits to it and hashes to ruling_hash, the outcome
 * is what settlementOutcome gives for the record and the bound line, and the resolve tx put the
 * same two hashes on chain. A check whose input is missing (no raw body, not resolved yet) is
 * left out rather than failed.
 */
export function verifySettlement(i: {
  record: GeminiSettlementRecord;
  evidence_hash: string;
  ruling: Ruling;
  ruling_hash: string;
  terms: { yes_party: Party; market: MarketRef };
  /** sha256 of the raw response body, computed by the caller (no hashing of bytes here). */
  body_sha256?: string | null;
  onchain?: { evidence_hash: string | null; ruling_hash: string | null } | null;
}): { ok: boolean; checks: Partial<Record<SettlementCheckName, boolean>> } {
  const checks: Partial<Record<SettlementCheckName, boolean>> = {};
  if (i.body_sha256) checks.body_matches_record = i.body_sha256 === i.record.response_sha256;
  checks.record_hash = hashJcs(i.record) === i.evidence_hash;
  checks.ruling_commits_record =
    i.ruling.evidence_hash === i.evidence_hash &&
    i.ruling.terms_hash === i.record.terms_hash &&
    i.ruling.bet_id === i.record.bet_id;
  checks.ruling_hash = hashJcs(i.ruling) === i.ruling_hash;
  const d = settlementOutcome(i.record, i.terms.market);
  const expected =
    d.outcome === 'VOID'
      ? 'VOID'
      : (d.outcome === 'MET' ? i.terms.yes_party : otherParty(i.terms.yes_party)) === 'A'
        ? 'A_WINS'
        : 'B_WINS';
  checks.outcome_follows_gemini = i.ruling.outcome === expected;
  if (i.onchain?.evidence_hash)
    checks.onchain_evidence = i.onchain.evidence_hash === i.evidence_hash;
  if (i.onchain?.ruling_hash) checks.onchain_ruling = i.onchain.ruling_hash === i.ruling_hash;
  return { ok: Object.values(checks).every(Boolean), checks };
}

/** GET /v1/bets/:bet_id/settlement (a party, or the stage of the bet's room). */
export const settlementPath = (betId: string) => `/v1/bets/${encodeURIComponent(betId)}/settlement`;

/** The evidence chain of a Gemini bet, for anyone to re-check with verifySettlement. */
export const SettlementEvidence = z.object({
  record: GeminiSettlementRecord,
  evidence_hash: Hex32,
  ruling: Ruling,
  ruling_hash: Hex32,
  /** Gemini's response body byte for byte (UTF-8), when this record's fetch is the one kept. */
  raw_body: z.string().nullable(),
  /**
   * What the resolve put on chain, as the server read it from the chain (null until RULED, or
   * when the chain can't be read): `source` is the open Bet account, or the confirmed resolve
   * transaction's instruction data once finalize + close_bet closed the account.
   */
  onchain: z
    .object({
      evidence_hash: Hex32.nullable(),
      ruling_hash: Hex32.nullable(),
      resolve_signature: Signature.nullable(),
      source: z.enum(['bet_account', 'resolve_tx']).optional(),
    })
    .nullable(),
  verification: z.object({ ok: z.boolean(), checks: z.record(z.string(), z.boolean()) }),
});
export type SettlementEvidence = z.infer<typeof SettlementEvidence>;
