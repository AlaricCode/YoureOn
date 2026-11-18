// SCHEMAS §4 / §5.2 settlement: classifyContract, settlementOutcome, settlementRuling.
// The settled numbers are Gemini's real BTC05M2611180240 settlement (recorded 2026-11-18,
// apps/server/test/fixtures/gemini-btc5m.json): line 64389.6, settled 64367.38366666667, "no".
import { describe, expect, it } from 'vitest';
import { GeminiSettlementRecord } from '../src/evidence';
import { hashJcs } from '../src/jcs';
import { Ruling, GEMINI_SETTLEMENT_MODEL } from '../src/ruling';
import {
  classifyContract,
  formatPrice,
  geminiEventUrl,
  sameDecimal,
  settlementOutcome,
  settlementReason,
  settlementRecord,
  settlementRuling,
  verifySettlement,
} from '../src/settlement';
import type { MarketRef } from '../src/terms';

const BET = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
const TERMS_HASH = 'ab'.repeat(32);
const STRIKE = {
  value: '64389.6',
  type: 'reference',
  availableAt: '2026-11-18T02:35:00.000Z',
} as const;

const market = (over: Partial<MarketRef> = {}): MarketRef => ({
  venue: 'gemini',
  eventTicker: 'BTC05M2611180240',
  instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
  side: 'YES',
  priceAtLock: '0.62',
  priceSource: 'mid',
  quotedAt: '2026-11-18T02:36:30.000Z',
  strike: { ...STRIKE },
  expiry: '2026-11-18T02:40:00.000Z',
  ...over,
});

const record = (
  state: Parameters<typeof settlementRecord>[0]['state'],
  over: Partial<Parameters<typeof settlementRecord>[0]> = {},
) =>
  settlementRecord({
    bet_id: BET,
    terms_hash: TERMS_HASH,
    eventTicker: 'BTC05M2611180240',
    instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
    state,
    settlementValue: '64367.38366666667',
    strike: { ...STRIKE },
    resolvedAt: '2026-11-18T02:40:05.521Z',
    source_url: geminiEventUrl('BTC05M2611180240'),
    response_sha256: 'cd'.repeat(32),
    fetched_at: '2026-11-18T02:40:08.000Z',
    ...over,
  });

const ruling = (
  rec: GeminiSettlementRecord,
  terms: { yes_party: 'A' | 'B'; market: MarketRef | null } = { yes_party: 'A', market: market() },
) =>
  settlementRuling({
    ruling_id: '9b1d2c3e-4f50-4a61-8b72-c3d4e5f60718',
    created_at: '2026-11-18T02:40:08.100Z',
    terms: { bet_id: BET, ...terms },
    terms_hash: TERMS_HASH,
    record: rec,
  });

describe('classifyContract', () => {
  it('settled with a side; casing is tolerated', () => {
    expect(classifyContract({ status: 'settled', resolutionSide: 'no' })).toEqual({
      kind: 'settled',
      side: 'no',
    });
    expect(classifyContract({ status: 'Settled', resolutionSide: 'YES' })).toEqual({
      kind: 'settled',
      side: 'yes',
    });
  });

  it('voided under any of the names Gemini might use', () => {
    for (const status of ['invalid', 'cancelled', 'canceled', 'Voided', 'void'])
      expect(classifyContract({ status })).toEqual({ kind: 'invalid' });
  });

  it('anything else is still pending, including settled without a usable side', () => {
    for (const status of ['active', 'closed', 'under_review', 'approved'])
      expect(classifyContract({ status }).kind).toBe('pending');
    expect(classifyContract({ status: 'settled', resolutionSide: null })).toEqual({
      kind: 'pending',
      status: 'settled',
    });
    expect(classifyContract({ status: 'settled', resolutionSide: 'maybe' }).kind).toBe('pending');
  });
});

describe('formatPrice / sameDecimal', () => {
  it('formats exact decimals half-up to cents with separators', () => {
    expect(formatPrice('64367.38366666667')).toBe('$64,367.38');
    expect(formatPrice('64389.6')).toBe('$64,389.60');
    expect(formatPrice('99999.995')).toBe('$100,000.00');
    expect(formatPrice('7')).toBe('$7.00');
    expect(formatPrice(null)).toBe('?');
    expect(formatPrice('n/a')).toBe('n/a');
  });
  it('compares lines without trailing zeros', () => {
    expect(sameDecimal('64389.60', '64389.6')).toBe(true);
    expect(sameDecimal('64389.6', '64389.61')).toBe(false);
    expect(sameDecimal(null, null)).toBe(true);
    expect(sameDecimal('1', null)).toBe(false);
  });
});

describe('settlementRuling (§5.2 stage settlement)', () => {
  it('Gemini NO with A on UP (yes_party A): B wins, NOT_MET, deterministic fields', () => {
    const rec = record({ kind: 'settled', side: 'no' });
    const r = ruling(rec);
    expect(Ruling.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      stage: 'settlement',
      attempt_no: 1,
      outcome: 'B_WINS',
      claim_result: 'NOT_MET',
      confidence: 1,
      cited_frames: [],
      frame_hashes: [],
      model: GEMINI_SETTLEMENT_MODEL,
      redo_reason: null,
      void_reason: null,
      evidence_hash: hashJcs(rec),
      terms_hash: TERMS_HASH,
    });
    expect(r.reason).toBe(
      'Gemini settled DOWN: Bitcoin finished at $64,367.38, below the $64,389.60 line.',
    );
  });

  it('Gemini YES: the yes_party wins (A when A holds UP, B when A took DOWN)', () => {
    const rec = record({ kind: 'settled', side: 'yes' }, { settlementValue: '64400.1' });
    expect(ruling(rec).outcome).toBe('A_WINS');
    expect(ruling(rec, { yes_party: 'B', market: market({ side: 'NO' }) }).outcome).toBe('B_WINS');
    expect(ruling(rec).reason).toBe(
      'Gemini settled UP: Bitcoin finished at $64,400.10, at or above the $64,389.60 line.',
    );
  });

  it('A on DOWN (yes_party B) and Gemini NO: A wins', () => {
    const rec = record({ kind: 'settled', side: 'no' });
    expect(ruling(rec, { yes_party: 'B', market: market({ side: 'NO' }) }).outcome).toBe('A_WINS');
  });

  it('a voided contract is VOID market_invalid (refund), with no settlement value', () => {
    const rec = record({ kind: 'invalid' });
    expect(rec.contract).toMatchObject({
      status: 'invalid',
      resolutionSide: null,
      settlementValue: null,
    });
    const r = ruling(rec);
    expect(r).toMatchObject({
      outcome: 'VOID',
      void_reason: 'market_invalid',
      claim_result: 'UNCLEAR',
      redo_reason: null,
    });
    expect(r.reason).toContain('voided');
  });

  it('settled against a different line than the locked one is ambiguous: VOID', () => {
    const rec = record(
      { kind: 'settled', side: 'yes' },
      { strike: { ...STRIKE, value: '64390.1' } },
    );
    expect(settlementOutcome(rec, market())).toEqual({ outcome: 'VOID', why: 'strike_mismatch' });
    expect(ruling(rec)).toMatchObject({ outcome: 'VOID', void_reason: 'market_invalid' });
    expect(settlementReason(rec, { outcome: 'VOID', why: 'strike_mismatch' })).toContain(
      'different line',
    );
    // a trailing zero is the same line
    const same = record(
      { kind: 'settled', side: 'yes' },
      { strike: { ...STRIKE, value: '64389.60' } },
    );
    expect(ruling(same).outcome).toBe('A_WINS');
  });

  it("a settled body without the line still settles on Gemini's side", () => {
    const rec = record({ kind: 'settled', side: 'no' }, { strike: { ...STRIKE, value: null } });
    const r = ruling(rec);
    expect(r.outcome).toBe('B_WINS');
    expect(r.reason).toBe('Gemini settled DOWN: Bitcoin finished at $64,367.38, below the line.');
  });

  it('a record for another contract or bet never rules this one', () => {
    const other = record({ kind: 'settled', side: 'yes' }, { eventTicker: 'BTC05M2611180245' });
    expect(ruling(other).outcome).toBe('VOID');
    expect(() =>
      settlementRuling({
        ruling_id: '9b1d2c3e-4f50-4a61-8b72-c3d4e5f60718',
        created_at: '2026-11-18T02:40:08.100Z',
        terms: { bet_id: BET, yes_party: 'A', market: market() },
        terms_hash: 'ef'.repeat(32),
        record: record({ kind: 'settled', side: 'yes' }),
      }),
    ).toThrow(/another bet/);
    expect(() =>
      ruling(record({ kind: 'settled', side: 'yes' }), { yes_party: 'A', market: null }),
    ).toThrow(/not a market bet/);
  });

  it('a record fetched from the REPLAY feed says so in the reason', () => {
    const rec = record(
      { kind: 'settled', side: 'no' },
      { source_url: 'replay://gemini/v1/prediction-markets/events/BTC05M2611180240' },
    );
    expect(ruling(rec).reason).toBe(
      'Replay of a recorded round. Gemini settled DOWN: Bitcoin finished at $64,367.38, below the $64,389.60 line.',
    );
  });

  it('verifySettlement: every link of the chain, and each forgery caught', () => {
    const rec = record({ kind: 'settled', side: 'no' });
    const r = ruling(rec);
    const base = {
      record: rec,
      evidence_hash: hashJcs(rec),
      ruling: r,
      ruling_hash: hashJcs(r),
      terms: { yes_party: 'A' as const, market: market() },
      body_sha256: rec.response_sha256,
      onchain: { evidence_hash: hashJcs(rec), ruling_hash: hashJcs(r) },
    };
    expect(verifySettlement(base)).toEqual({
      ok: true,
      checks: {
        body_matches_record: true,
        record_hash: true,
        ruling_commits_record: true,
        ruling_hash: true,
        outcome_follows_gemini: true,
        onchain_evidence: true,
        onchain_ruling: true,
      },
    });
    // missing inputs are left out, not failed
    const partial = verifySettlement({ ...base, body_sha256: null, onchain: null });
    expect(partial.ok).toBe(true);
    expect(Object.keys(partial.checks)).not.toContain('onchain_evidence');
    // forgeries
    expect(verifySettlement({ ...base, body_sha256: 'ee'.repeat(32) }).checks).toMatchObject({
      body_matches_record: false,
    });
    const flipped = { ...rec, contract: { ...rec.contract, resolutionSide: 'yes' as const } };
    expect(verifySettlement({ ...base, record: flipped })).toMatchObject({
      ok: false,
      checks: { record_hash: false, outcome_follows_gemini: false },
    });
    const wrongWinner = { ...r, outcome: 'A_WINS' as const };
    expect(
      verifySettlement({ ...base, ruling: wrongWinner, ruling_hash: hashJcs(wrongWinner) }).checks,
    ).toMatchObject({ ruling_hash: true, outcome_follows_gemini: false, onchain_ruling: false });
    expect(
      verifySettlement({ ...base, onchain: { evidence_hash: 'ff'.repeat(32), ruling_hash: null } })
        .checks,
    ).toMatchObject({ onchain_evidence: false });
  });

  it('the record is strict and hashes stably', () => {
    const rec = record({ kind: 'settled', side: 'no' });
    expect(GeminiSettlementRecord.parse(rec)).toEqual(rec);
    expect(hashJcs(rec)).toBe(hashJcs(JSON.parse(JSON.stringify(rec))));
    expect(rec.source_url).toBe(
      'https://api.gemini.com/v1/prediction-markets/events/BTC05M2611180240',
    );
  });
});
