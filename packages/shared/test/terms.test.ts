import { describe, expect, it } from 'vitest';
import {
  Attempts,
  ClarificationAsk,
  computeTermsHash,
  GuardrailRefusal,
  hashJcs,
  MicroUsdc,
  Stake,
  Terms,
  TermsDraft,
  TermsEnvelope,
  TermsProposal,
  TermsProposalLoose,
  TermsStepOutput,
  termsCode,
} from '../src';
import { realWorldTerms, skillTerms } from './fixtures';

const DOC_TERMS_HASH = '05860f0a9c9034685ddbed902667f8453258056a21de30138b430ba3903f998f';
type Mut = Record<string, unknown> & {
  stakes: Record<string, unknown>;
  party_b: Record<string, unknown>;
};
const fails = (input: unknown, path?: string): void => {
  const r = Terms.safeParse(input);
  expect(r.success).toBe(false);
  if (path && !r.success) expect(r.error.issues.map((i) => i.path.join('.'))).toContain(path);
};

describe('Terms (§2)', () => {
  it('§2.5 skill example parses and the terms code is the first 8 hex chars', () => {
    const { terms, terms_hash } = computeTermsHash(skillTerms());
    expect(terms.type).toBe('skill');
    expect(termsCode(terms_hash)).toBe('05860f0a');
  });

  it('§2.6 real-world example (pot $10 at 0.62 → $6.20 / $3.80) parses', () => {
    const t = Terms.parse(realWorldTerms());
    expect(t.stakes).toEqual({ a: '6200000', b: '3800000', currency: 'USDC' });
  });

  it('rejects unfair real-world stakes, side/yes_party mismatch, performer, early deadline', () => {
    fails(
      { ...realWorldTerms(), stakes: { a: '6100000', b: '3900000', currency: 'USDC' } },
      'stakes',
    );
    fails({ ...realWorldTerms(), yes_party: 'B' }, 'yes_party');
    fails({ ...realWorldTerms(), performer: 'A' }, 'performer');
    fails({ ...realWorldTerms(), market: null }, 'market');
    fails({ ...realWorldTerms(), evidence_source: 'camera' }, 'evidence_source');
    fails({ ...realWorldTerms(), deadline: '2026-11-21T18:09:00.000Z' }, 'deadline');
    fails({ ...realWorldTerms(), attempts: { count: 3, rule: 'best_of' } }, 'attempts');
  });

  it('enforces skill rules', () => {
    fails({ ...skillTerms(), performer: null }, 'performer');
    fails({ ...skillTerms(), evidence_source: 'gemini' }, 'evidence_source');
    // Odds (widened refinement, no version bump): unequal stakes up to 10:1 parse.
    expect(
      Terms.safeParse({ ...skillTerms(), stakes: { a: '5000000', b: '4000000', currency: 'USDC' } })
        .success,
    ).toBe(true);
    expect(
      Terms.safeParse({
        ...skillTerms(),
        stakes: { a: '15000000', b: '5000000', currency: 'USDC' },
      }).success,
    ).toBe(true);
    expect(
      Terms.safeParse({
        ...skillTerms(),
        stakes: { a: '1000000', b: '10000000', currency: 'USDC' },
      }).success,
    ).toBe(true);
    fails({ ...skillTerms(), stakes: { a: '11000000', b: '1000000', currency: 'USDC' } }, 'stakes');
    fails({ ...skillTerms(), stakes: { a: '100000', b: '1010000', currency: 'USDC' } }, 'stakes');
    fails({ ...skillTerms(), market: realWorldTerms().market }, 'market');
  });

  it('stakes: whole cents within [MIN_STAKE, MAX_STAKE]', () => {
    const withStake = (s: string) => ({
      ...skillTerms(),
      stakes: { a: s, b: s, currency: 'USDC' },
    });
    expect(Terms.safeParse(withStake('100000')).success).toBe(true);
    expect(Terms.safeParse(withStake('20000000')).success).toBe(true);
    fails(withStake('90000'));
    fails(withStake('20010000'));
    fails(withStake('5000001'));
  });

  it('parties must differ; deadline after created_at, whole seconds', () => {
    const t = skillTerms() as Mut;
    t.party_b.pubkey = (t.party_a as Record<string, unknown>).pubkey;
    fails(t, 'party_b.pubkey');
    fails({ ...skillTerms(), deadline: '2026-11-21T18:05:00.000Z' }, 'deadline');
    fails({ ...skillTerms(), deadline: '2026-11-21T18:15:00.500Z' });
  });

  it('hashed records have no optional keys: a missing key fails', () => {
    const t = skillTerms();
    delete t.market;
    fails(t);
  });

  it('attempts rules', () => {
    expect(Attempts.safeParse({ count: 1, rule: 'single' }).success).toBe(true);
    expect(Attempts.safeParse({ count: 3, rule: 'best_of' }).success).toBe(true);
    expect(Attempts.safeParse({ count: 2, rule: 'best_of' }).success).toBe(false);
    expect(Attempts.safeParse({ count: 2, rule: 'single' }).success).toBe(false);
    expect(Attempts.safeParse({ count: 1, rule: 'first_success' }).success).toBe(false);
    expect(Attempts.safeParse({ count: 6, rule: 'all_of' }).success).toBe(false);
  });

  it('safeParse never throws on malformed values (Zod 4 keeps running refinements after a failed regex)', () => {
    const rw = realWorldTerms();
    const cases: unknown[] = [
      { ...rw, stakes: { a: '5.5', b: '1e6', currency: 'USDC' } },
      { ...rw, market: { ...rw.market, priceAtLock: '0.6234567' } },
      { ...rw, market: { ...rw.market, priceAtLock: 'abc' }, deadline: 'not a date' },
      {
        ...skillTerms(),
        stakes: { a: '-1', b: 'x', currency: 'USDC' },
        created_at: '2026-02-30T00:00:00.000Z',
      },
    ];
    for (const c of cases) expect(() => Terms.safeParse(c)).not.toThrow();
    expect(() => MicroUsdc.safeParse('1.5')).not.toThrow();
    expect(() => Stake.safeParse('1.5')).not.toThrow();
  });

  it('array order is significant for the hash', () => {
    const t = skillTerms() as Mut & { success_criteria: string[] };
    t.success_criteria.reverse();
    expect(computeTermsHash(t).terms_hash).not.toBe(DOC_TERMS_HASH);
  });
});

describe('TermsEnvelope (§2.3)', () => {
  const presentation = {
    title: 'Bottle flip',
    readback: 'Jake lands a water bottle flip upright on the table.',
    stakes_display: '$5 vs $5',
    odds_display: null,
    party_a_avatar_url: null,
    party_b_avatar_url: null,
  };
  it('accepts the matching hash and rejects a mismatch', () => {
    const terms = skillTerms();
    expect(
      TermsEnvelope.safeParse({ terms, terms_hash: DOC_TERMS_HASH, presentation }).success,
    ).toBe(true);
    const bad = TermsEnvelope.safeParse({ terms, terms_hash: hashJcs({ x: 1 }), presentation });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toBe('terms_hash mismatch');
  });
});

describe('negotiation (§3)', () => {
  const proposal = {
    type: 'skill',
    claim: 'Jake lands a water bottle flip upright on the table.',
    performer: 'B',
    yes_party: 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: ['The bottle comes to rest standing upright on its base.'],
    failure_criteria: [],
    edge_cases: [],
    evidence_source: 'camera',
    amount: '5000000',
    market_query: null,
    deadline_minutes: null,
  };
  it('TermsProposal is strict; the loose variant strips stray keys', () => {
    expect(TermsProposal.safeParse(proposal).success).toBe(true);
    expect(TermsProposal.safeParse({ ...proposal, stray: 1 }).success).toBe(false);
    expect(TermsProposalLoose.parse({ ...proposal, stray: 1 })).not.toHaveProperty('stray');
    expect(TermsProposal.safeParse({ ...proposal, deadline_minutes: 46 }).success).toBe(false);
  });
  it('§3 TermsDraft example parses', () => {
    const draft = TermsDraft.parse({
      bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
      revision: 2,
      proposal: {
        type: 'skill',
        claim: 'Jake lands a water bottle flip upright on the table.',
        performer: 'B',
        yes_party: 'B',
        evidence_source: 'camera',
        amount: '5000000',
        market_query: null,
      },
      missing: [
        'attempts',
        'success_criteria',
        'failure_criteria',
        'edge_cases',
        'deadline_minutes',
      ],
      clarifications: [
        {
          question: {
            question_id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
            index: 1,
            field: 'edge_cases',
            question: 'Does landing on the cap count, or only the base?',
            options: ['Base only', 'Cap counts'],
            addressed_to: 'both',
            asked_at: '2026-11-21T18:04:58.100Z',
          },
          answer: null,
        },
      ],
      issues: [],
      updated_at: '2026-11-21T18:04:58.100Z',
    });
    expect(draft.revision).toBe(2);
  });
  it('§3 ask step and refusal examples parse', () => {
    const step = TermsStepOutput.parse({
      kind: 'ask',
      ask: {
        field: 'attempts',
        question: 'One flip or best of three?',
        options: ['One flip', 'Best of three'],
        addressed_to: 'both',
      },
    });
    expect(step.kind).toBe('ask');
    expect(
      ClarificationAsk.safeParse({
        field: 'amount',
        question: 'How much?',
        options: [],
        addressed_to: 'A',
      }).success,
    ).toBe(true);
    expect(
      GuardrailRefusal.parse({
        refused: true,
        category: 'alcohol_drugs',
        quip: 'Chugging contests? I judge bottle flips, not liver function. Pick something else.',
      }).category,
    ).toBe('alcohol_drugs');
  });
});
