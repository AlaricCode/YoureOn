import { describe, expect, it } from 'vitest';
import {
  AppealResult,
  AppealVote,
  countVote,
  decideAppeal,
  hashJcs,
  HearingRuling,
  HearingTurn,
  HearingVerdict,
  payout,
  Ruling,
  toHearingOutcome,
  toOnchainOutcome,
  toOutcome,
  VisionVerdict,
  type VoteCountedAs,
} from '../src';
import { appealVote, hearingRulingExample, rulingExample } from './fixtures';

const DOC_HEARING_HASH = 'a7721bbc9d1aebe51401ecfa0ebceda9f8845413517c60dabd406aea68fdd368';

describe('toOutcome (§5.1): claim_result mapped through yes_party', () => {
  it('"bet you can\'t" inversion: yes_party B, MET → B wins; NOT_MET → A wins', () => {
    expect(toOutcome({ claim_result: 'MET', confidence: 0.9 }, 'B')).toBe('B_WINS');
    expect(toOutcome({ claim_result: 'NOT_MET', confidence: 0.9 }, 'B')).toBe('A_WINS');
    expect(toOutcome({ claim_result: 'MET', confidence: 0.9 }, 'A')).toBe('A_WINS');
  });
  it('UNCLEAR or confidence < 0.8 → REDO; hearing maps REDO → VOID', () => {
    expect(toOutcome({ claim_result: 'UNCLEAR', confidence: 0.99 }, 'A')).toBe('REDO');
    expect(toOutcome({ claim_result: 'MET', confidence: 0.79 }, 'A')).toBe('REDO');
    expect(toOutcome({ claim_result: 'MET', confidence: 0.8 }, 'A')).toBe('A_WINS');
    expect(toHearingOutcome({ claim_result: 'MET', confidence: 0.75 }, 'A')).toBe('VOID');
    expect(toHearingOutcome({ claim_result: 'NOT_MET', confidence: 0.9 }, 'A')).toBe('B_WINS');
  });
  it('VisionVerdict is tolerant (strips unknown keys)', () => {
    const v = VisionVerdict.parse({
      claim_result: 'MET',
      confidence: 0.934,
      reason: 'ok',
      cited_frames: [1],
      contested: false,
      extra: 1,
    });
    expect(v).not.toHaveProperty('extra');
    expect(HearingVerdict.safeParse({ ...v, responses: { A: 'a', B: 'b' } }).success).toBe(true);
  });
});

describe('Ruling (§5.2)', () => {
  const base = () => rulingExample() as Record<string, unknown>;
  const issuesAt = (input: unknown): string[] => {
    const r = Ruling.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };
  it('redo_reason iff REDO; void_reason iff VOID; undecidable is hearing-only', () => {
    expect(
      issuesAt({ ...base(), outcome: 'REDO', redo_reason: null, claim_result: 'UNCLEAR' }),
    ).toContain('redo_reason');
    expect(issuesAt({ ...base(), redo_reason: 'unclear' })).toContain('redo_reason');
    expect(
      issuesAt({ ...base(), outcome: 'REDO', redo_reason: 'low_confidence', confidence: 0.75 }),
    ).toEqual([]);
    expect(issuesAt({ ...base(), outcome: 'VOID', void_reason: null })).toContain('void_reason');
    expect(issuesAt({ ...base(), outcome: 'VOID', void_reason: 'undecidable' })).toContain(
      'void_reason',
    );
    expect(issuesAt({ ...base(), outcome: 'VOID', void_reason: 'safety_stop' })).toEqual([]);
  });
  it('decisive outcomes need confidence ≥ 0.8; confidence is 2 dp', () => {
    expect(issuesAt({ ...base(), confidence: 0.79 })).toContain('outcome');
    expect(issuesAt({ ...base(), confidence: 0.934 })).toContain('confidence');
  });
  it('frames: citations point into frame_hashes; camera commits ≥ 1 frame', () => {
    expect(issuesAt({ ...base(), cited_frames: [8] })).toContain('cited_frames');
    expect(issuesAt({ ...base(), frame_hashes: [], cited_frames: [] })).toContain('frame_hashes');
    expect(
      issuesAt({ ...base(), frame_hashes: Array(25).fill('ab'.repeat(32)), cited_frames: [] }),
    ).toContain('frame_hashes');
  });
  it('a gemini settlement ruling commits no frames', () => {
    const settlement = {
      ...base(),
      stage: 'settlement',
      confidence: 1,
      cited_frames: [],
      frame_hashes: [],
      model: 'rule/gemini-settlement@1',
    };
    expect(issuesAt(settlement)).toEqual([]);
    expect(
      issuesAt({ ...settlement, frame_hashes: [(base().frame_hashes as string[])[0]] }),
    ).toContain('frame_hashes');
    expect(issuesAt({ ...settlement, outcome: 'VOID', void_reason: 'market_invalid' })).toEqual([]);
  });
  it('strict: an extra key is rejected', () => {
    expect(Ruling.safeParse({ ...base(), extra: 1 }).success).toBe(false);
  });
  it('onchain mapping', () => {
    expect(toOnchainOutcome('A_WINS')).toBe('PartyA');
    expect(toOnchainOutcome('B_WINS')).toBe('PartyB');
    expect(toOnchainOutcome('VOID')).toBe('Refund');
    expect(() => toOnchainOutcome('REDO')).toThrow();
  });
});

describe('payout (§5.3)', () => {
  it('matches the payout table, including excess and the odd micro-unit', () => {
    expect(payout('PartyA', 6_200_000n, 10_000_000n)).toEqual({ to_a: 10_000_000n, to_b: 0n });
    expect(payout('PartyB', 6_200_000n, 10_000_000n)).toEqual({ to_a: 0n, to_b: 10_000_000n });
    expect(payout('Refund', 6_200_000n, 10_000_000n)).toEqual({
      to_a: 6_200_000n,
      to_b: 3_800_000n,
    });
    expect(payout('Split', 6_200_000n, 10_000_000n)).toEqual({
      to_a: 5_000_000n,
      to_b: 5_000_000n,
    });
    expect(payout('Refund', 6_200_000n, 10_000_005n)).toEqual({
      to_a: 6_200_000n,
      to_b: 3_800_005n,
    });
    expect(payout('Split', 1n, 3n)).toEqual({ to_a: 1n, to_b: 2n });
    expect(payout('Refund', 6_200_000n, 1_000n)).toEqual({ to_a: 1_000n, to_b: 0n });
  });
});

describe('Hearing (§6)', () => {
  it('§6 HearingTurn example parses and its transcript hash is sha256(transcript)', () => {
    const t = HearingTurn.parse({
      schema_version: 1,
      turn_id: 'a1c2e3f4-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
      hearing_id: 'c0ffee00-1234-4abc-8def-001122334455',
      bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
      turn_index: 0,
      party: 'A',
      started_at: '2026-11-21T18:07:10.000Z',
      ended_at: '2026-11-21T18:07:19.400Z',
      duration_ms: 9400,
      transcript: 'It hit the cap first and bounced, that is not a clean landing.',
      transcript_sha256: '953c8e3e419c0f4093a076139c70fb18d1ded6b4f7e7f87125806f0b2e2ab285',
      stt: 'elevenlabs',
    });
    expect(t.party).toBe('A');
    expect(HearingTurn.safeParse({ ...t, transcript: '' }).success).toBe(true);
  });
  const base = () => hearingRulingExample() as Record<string, unknown> & { arguments: unknown[] };
  it('never REDO; arguments are [A, B]; decisive needs ≥ 0.8; no void_reason key', () => {
    expect(HearingRuling.safeParse(base()).success).toBe(true);
    expect(HearingRuling.safeParse({ ...base(), outcome: 'REDO' }).success).toBe(false);
    expect(HearingRuling.safeParse({ ...base(), outcome: 'VOID', confidence: 0.5 }).success).toBe(
      true,
    );
    expect(HearingRuling.safeParse({ ...base(), confidence: 0.7 }).success).toBe(false);
    const b = base();
    expect(
      HearingRuling.safeParse({ ...b, arguments: [b.arguments[1], b.arguments[0]] }).success,
    ).toBe(false);
    expect(HearingRuling.safeParse({ ...base(), void_reason: null }).success).toBe(false);
    expect(() => HearingRuling.safeParse({ ...base(), arguments: [b.arguments[0]] })).not.toThrow();
    expect(HearingRuling.safeParse({ ...base(), arguments: [b.arguments[0]] }).success).toBe(false);
  });
});

describe('Appeals (§7)', () => {
  it('§7 AppealVote example parses and counts', () => {
    const v = AppealVote.parse(appealVote());
    expect(countVote(v)).toBe('A_WINS');
    expect(countVote({ status: 'ok', outcome: 'B_WINS', confidence: 0.59 })).toBe('ABSTAIN');
    expect(countVote({ status: 'ok', outcome: 'REDO', confidence: 0.99 })).toBe('ABSTAIN');
    expect(countVote({ status: 'timeout', outcome: 'A_WINS', confidence: 0.99 })).toBe('ABSTAIN');
    expect(countVote({ status: 'ok', outcome: 'B_WINS', confidence: 0.6 })).toBe('B_WINS');
    expect(AppealVote.safeParse({ ...appealVote(), outcome: 'VOID' }).success).toBe(false);
  });

  const tally = (a: number, b: number, x: number): { counted_as: VoteCountedAs }[] => [
    ...Array<{ counted_as: VoteCountedAs }>(a).fill({ counted_as: 'A_WINS' }),
    ...Array<{ counted_as: VoteCountedAs }>(b).fill({ counted_as: 'B_WINS' }),
    ...Array<{ counted_as: VoteCountedAs }>(x).fill({ counted_as: 'ABSTAIN' }),
  ];
  it('§7 table (original = B_WINS)', () => {
    for (const [a, b, x] of [
      [3, 0, 0],
      [2, 1, 0],
      [2, 0, 1],
    ] as const)
      expect(decideAppeal('B_WINS', tally(a, b, x))).toMatchObject({
        final_outcome: 'A_WINS',
        decided_by: 'majority',
        flipped: true,
      });
    for (const [a, b, x] of [
      [0, 3, 0],
      [1, 2, 0],
      [0, 2, 1],
    ] as const)
      expect(decideAppeal('B_WINS', tally(a, b, x))).toMatchObject({
        final_outcome: 'B_WINS',
        decided_by: 'majority',
        flipped: false,
      });
    for (const [a, b, x] of [
      [1, 1, 1],
      [1, 0, 2],
      [0, 1, 2],
      [0, 0, 3],
    ] as const)
      expect(decideAppeal('B_WINS', tally(a, b, x))).toMatchObject({
        final_outcome: 'B_WINS',
        decided_by: 'upheld_no_majority',
        flipped: false,
      });
  });
  it('a VOID original becomes a win only with a majority', () => {
    expect(decideAppeal('VOID', tally(1, 1, 1)).final_outcome).toBe('VOID');
    expect(decideAppeal('VOID', tally(0, 2, 1))).toMatchObject({
      final_outcome: 'B_WINS',
      flipped: true,
    });
  });

  it('§7 AppealResult example (votes filled in per its comment) parses, original = §6 hash', () => {
    const hearing = HearingRuling.parse(hearingRulingExample());
    expect(hashJcs(hearing)).toBe(DOC_HEARING_HASH);
    const mk = (seat: number, provider: string, outcome: string, confidence: number) => {
      const v = {
        ...appealVote(),
        seat,
        provider,
        model: `${provider}/x`,
        outcome,
        confidence,
        counted_as: 'ABSTAIN',
      };
      return { ...v, counted_as: countVote(AppealVote.parse(v)) };
    };
    const votes = [
      mk(0, 'anthropic', 'B_WINS', 0.82),
      mk(1, 'openai', 'A_WINS', 0.71),
      mk(2, 'google', 'REDO', 0.55),
    ];
    const d = decideAppeal('B_WINS', votes);
    const result = AppealResult.parse({
      schema_version: 1,
      appeal_id: 'e9f8a7b6-c5d4-4e3f-a2b1-c0d9e8f7a6b5',
      bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
      appellant: 'A',
      original_outcome: 'B_WINS',
      original_ruling_hash: hashJcs(hearing),
      votes,
      tally: d.tally,
      final_outcome: d.final_outcome,
      decided_by: d.decided_by,
      flipped: d.flipped,
      evidence_hash: hearing.evidence_hash,
      frame_hashes: hearing.frame_hashes,
      terms_hash: hearing.terms_hash,
      created_at: '2026-11-21T18:07:45.300Z',
    });
    expect(result.tally).toEqual({ A_WINS: 1, B_WINS: 1, ABSTAIN: 1 });
    expect(result.final_outcome).toBe('B_WINS');
    expect(result.decided_by).toBe('upheld_no_majority');
    expect(AppealResult.safeParse({ ...result, votes: votes.slice(0, 2) }).success).toBe(false);
    expect(AppealResult.safeParse({ ...result, final_outcome: 'REDO' }).success).toBe(false);
  });
});
