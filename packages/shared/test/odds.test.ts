/* eslint-disable @typescript-eslint/no-explicit-any -- proposal fixtures are loosely typed */
// Odds: the challenge category, the fair-odds math, stakes / bounds / labels, the offer fold, the
// realtime events, propose_terms stake_b_usd, the odds read-back, and the suggestion's guard.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORY_BASE_RATE, classifyChallenge } from '../src/challenge-category';
import {
  attemptsRate,
  band,
  checkOddsStakes,
  clampChance,
  fairOdds,
  favoredParty,
  nearestRung,
  offerLine,
  ratioLabel,
  shrunkRate,
  stakesFor,
  statLine,
  toWinLine,
} from '../src/odds-math';
import { agreedFor, foldOdds, type OddsOffer } from '../src/odds';
import { parseRealtimeEvent } from '../src/realtime';
import { Terms } from '../src/terms';
import { mapProposeTermsArgs, stakeIssue } from '../src/judge/propose-terms';
import {
  evaluateProposeTerms,
  proposeTermsReply,
  readbackSay,
  SAY_MAX_CHARS,
} from '../src/judge/reply';
import { buildJudgePrompt } from '../src/judge/persona';
import {
  guardReason,
  oddsOutputSchema,
  suggestSay,
  templateReason,
  type OddsFacts,
} from '../src/judge/suggest-odds';
import { typedTermsArgs, typedTermsRequest } from '../src/judge/typed-terms';
import { skillTerms } from './fixtures';

const BOTTLE = JSON.parse(
  readFileSync(join(import.meta.dirname, '../src/judge/fixtures/01-bottle-flip.json'), 'utf8'),
).sample_args as Record<string, unknown>;
const D = (n: number) => BigInt(Math.round(n * 100)) * 10_000n;

describe('classifyChallenge', () => {
  it.each([
    ['Jake lands a water bottle flip upright on the table.', 'bottle_flip'],
    ['Jake flips the bottle so it lands on its cap.', 'bottle_flip'],
    ['Logan throws a paper ball into the bin.', 'throw'],
    ['Jake sinks a free throw.', 'throw'],
    ['Logan tosses a coin into the cup.', 'throw'],
    ['Jake catches a spun coin on the back of the hand.', 'other'],
    ['Logan does ten push-ups.', 'other'],
    ['JAKE LANDS A BOTTLE FLIP', 'bottle_flip'],
  ])('%s -> %s', (claim, cat) => {
    expect(classifyChallenge({ claim })).toBe(cat);
  });
  it('legacy seed rows classify by title', () => {
    expect(classifyChallenge({ title: 'Demo history: Bottle flip' })).toBe('bottle_flip');
    expect(classifyChallenge({ title: 'Demo history: Paper ball in the bin' })).toBe('throw');
    expect(classifyChallenge({ title: 'Demo history: Coin catch' })).toBe('other');
  });
});

describe('fair-odds math', () => {
  it('shrunkRate: 1 for 1 is not 100 %; 0 for 0 is the base; worked numbers', () => {
    expect(shrunkRate(1, 1, 0.25)).toBeCloseTo(0.4);
    expect(shrunkRate(0, 0, 0.25)).toBe(0.25);
    expect(shrunkRate(10, 12, 0.25)).toBeCloseTo(0.6875);
    expect(shrunkRate(6, 8, 0.25)).toBeCloseTo(7 / 12);
    expect(shrunkRate(1, 5, 0.4)).toBeCloseTo(2.6 / 9);
  });
  it('attemptsRate per rule', () => {
    expect(attemptsRate(0.25, { count: 1, rule: 'single' })).toBe(0.25);
    expect(attemptsRate(0.5, { count: 3, rule: 'first_success' })).toBeCloseTo(0.875);
    expect(attemptsRate(0.5, { count: 2, rule: 'all_of' })).toBeCloseTo(0.25);
    expect(attemptsRate(0.5, { count: 3, rule: 'best_of' })).toBeCloseTo(0.5);
    expect(attemptsRate(0.25, { count: 3, rule: 'best_of' })).toBeCloseTo(
      3 * 0.25 ** 2 * 0.75 + 0.25 ** 3,
    );
  });
  it('clampChance holds the 10:1 bound', () => {
    expect(clampChance(0.01)).toBeCloseTo(1 / 11);
    expect(clampChance(0.999)).toBeCloseTo(10 / 11);
    expect(fairOdds(0.001).r).toBeCloseTo(10);
  });
  it('worked numbers: band and nearest', () => {
    // Jake 10-2 on flips
    let f = fairOdds(shrunkRate(10, 12, 0.25));
    expect(f).toMatchObject({ favored: 'performer' });
    expect(f.r).toBeCloseTo(2.2);
    expect(band(f.r)).toEqual(['2:1', '3:1']);
    expect(nearestRung(f.r)).toBe('2:1');
    // Jake 6-2
    f = fairOdds(shrunkRate(6, 8, 0.25));
    expect(f.r).toBeCloseTo(1.4);
    expect(band(f.r)).toEqual(['1:1', '3:2']);
    expect(nearestRung(f.r)).toBe('3:2');
    // Logan 1 for 5 on throws
    f = fairOdds(shrunkRate(1, 5, 0.4));
    expect(f.favored).toBe('opponent');
    expect(f.r).toBeCloseTo(2.46, 2);
    expect(band(f.r)).toEqual(['2:1', '3:1']);
    expect(nearestRung(f.r)).toBe('3:1');
    // a bottle flip, no history
    f = fairOdds(0.25);
    expect(f).toEqual({ favored: 'opponent', r: 3 });
    expect(band(3)).toEqual(['3:1']);
    // Jake 12-1
    f = fairOdds(shrunkRate(12, 13, 0.25));
    expect(f.r).toBeCloseTo(3.25);
    expect(band(f.r)).toEqual(['3:1', '5:1']);
    expect(nearestRung(f.r)).toBe('3:1');
    expect(fairOdds(0.5)).toEqual({ favored: null, r: 1 });
    expect(band(1)).toEqual(['1:1']);
    expect(band(50)).toEqual(['10:1']);
  });
});

describe('stakes', () => {
  it('stakesFor: the underdog stakes base, the favourite base × ratio, rounded to the cent', () => {
    expect(stakesFor({ ratio: '3:2', favored: 'A', baseMicro: D(5) })).toEqual({
      a: D(7.5),
      b: D(5),
    });
    expect(stakesFor({ ratio: '3:1', favored: 'B', baseMicro: D(5) })).toEqual({
      a: D(5),
      b: D(15),
    });
    expect(stakesFor({ ratio: '1:1', favored: 'A', baseMicro: D(5) })).toEqual({
      a: D(5),
      b: D(5),
    });
    expect(stakesFor({ ratio: '3:1', favored: null, baseMicro: D(5) })).toEqual({
      a: D(5),
      b: D(5),
    });
    // 3:2 at $0.15 -> 0.225 rounds half-up to 0.23
    expect(stakesFor({ ratio: '3:2', favored: 'A', baseMicro: D(0.15) })).toEqual({
      a: D(0.23),
      b: D(0.15),
    });
  });
  it('stakesFor: the favourite capped at max_stake; the underdog floored to the cent', () => {
    expect(stakesFor({ ratio: '3:1', favored: 'A', baseMicro: D(10), maxStake: D(20) })).toEqual({
      a: D(20),
      b: D(6.66),
    });
  });
  it('stakesFor: an underdog below MIN_STAKE is ODDS_TOO_LONG', () => {
    expect(stakesFor({ ratio: '10:1', favored: 'A', baseMicro: D(5), maxStake: D(0.5) })).toEqual({
      issue: expect.objectContaining({ code: 'STAKE_ABOVE_MAX' }),
    });
    expect(stakesFor({ ratio: '10:1', favored: 'A', baseMicro: D(0.5), maxStake: D(0.5) })).toEqual(
      { issue: expect.objectContaining({ code: 'ODDS_TOO_LONG' }) },
    );
  });
  it('checkOddsStakes', () => {
    expect(checkOddsStakes(D(15), D(5))).toBeNull();
    expect(checkOddsStakes(D(10), D(1))).toBeNull();
    expect(checkOddsStakes(D(11), D(1))?.code).toBe('ODDS_TOO_LONG');
    expect(checkOddsStakes(D(21), D(5))?.code).toBe('STAKE_ABOVE_MAX');
    expect(checkOddsStakes(D(0.05), D(0.1))?.code).toBe('STAKE_BELOW_MIN');
    expect(checkOddsStakes(D(5) + 1n, D(5))?.code).toBe('AMBIGUOUS');
    expect(checkOddsStakes(D(15), D(5), D(10))?.code).toBe('STAKE_ABOVE_MAX');
  });
  it('ratioLabel / favoredParty / toWinLine', () => {
    expect(ratioLabel(D(5), D(5))).toBe('Even');
    expect(ratioLabel(D(15), D(5))).toBe('3 to 1');
    expect(ratioLabel(D(5), D(15))).toBe('3 to 1');
    expect(ratioLabel(D(7.5), D(5))).toBe('3 to 2');
    expect(ratioLabel(D(20), D(6.66))).toBe('3 to 1');
    expect(ratioLabel(D(15), D(7))).toBe('15 to 7');
    expect(ratioLabel(D(7.3), D(3.4))).toBe('2.1 to 1');
    expect(favoredParty(D(15), D(5))).toBe('A');
    expect(favoredParty(D(5), D(15))).toBe('B');
    expect(favoredParty(D(5), D(5))).toBeNull();
    expect(toWinLine(D(5), D(20))).toBe('You put in $5 to win $20');
  });
});

describe('TermsV1 odds refinement', () => {
  const withStakes = (a: string, b: string) => ({
    ...skillTerms(),
    stakes: { a, b, currency: 'USDC' },
  });
  it('15/5 skill parses; 11/1 fails; whole cents and the cap still apply per side', () => {
    expect(Terms.safeParse(withStakes('15000000', '5000000')).success).toBe(true);
    expect(Terms.safeParse(withStakes('11000000', '1000000')).success).toBe(false);
    expect(Terms.safeParse(withStakes('25000000', '5000000')).success).toBe(false);
    expect(Terms.safeParse(withStakes('15000001', '5000000')).success).toBe(false);
  });
});

// ---- the fold ----------------------------------------------------------------------------------

const BET = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
let seq = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const offer = (
  n: number,
  from: OddsOffer['from'],
  a: string,
  b: string,
  parent: string | null = null,
): OddsOffer => ({
  offer_id: uuid(n),
  n,
  parent_id: parent,
  from,
  stakes: { a, b },
  ratio_label: ratioLabel(a, b),
  favored: favoredParty(a, b),
  terms_hash: 'ab'.repeat(32),
  suggestion: null,
  created_at: '2026-11-18T10:00:00.000Z',
});
const ev = (type: string, payload: unknown) => ({
  v: 1,
  type,
  bet_id: BET,
  seq: ++seq,
  ts: '2026-11-18T10:00:00.000Z',
  source: 'server',
  payload,
});
const offered = (o: OddsOffer) => ev('odds.offered', { offer: o });
const answered = (id: string, party: 'A' | 'B', answer: string, by: string | null = null) =>
  ev('odds.answered', { offer_id: id, party, answer, by_offer_id: by });

describe('foldOdds', () => {
  it('A offers, B counters, A accepts: agreed by stakes', () => {
    const o1 = offer(1, 'A', '15000000', '5000000');
    const o2 = offer(2, 'B', '20000000', '5000000', o1.offer_id);
    const s = foldOdds([
      offered(o1),
      answered(o1.offer_id, 'B', 'countered', o2.offer_id),
      offered(o2),
      answered(o2.offer_id, 'A', 'accepted'),
    ]);
    expect(s.open).toBeNull();
    expect(s.status).toEqual({ [o1.offer_id]: 'countered', [o2.offer_id]: 'agreed' });
    expect(agreedFor(s, { a: '20000000', b: '5000000' })).toBe(true);
    expect(agreedFor(s, { a: '15000000', b: '5000000' })).toBe(false);
    expect(s.count).toBe(2);
  });
  it('the author counts as accepted; a new offer supersedes the open one', () => {
    const o1 = offer(1, 'A', '15000000', '5000000');
    let s = foldOdds([offered(o1)]);
    expect(s.open?.offer_id).toBe(o1.offer_id);
    expect(s.accepted_by).toEqual(['A']);
    const o2 = offer(2, 'A', '10000000', '5000000');
    s = foldOdds([offered(o1), offered(o2)]);
    expect(s.status[o1.offer_id]).toBe('superseded');
    expect(s.open?.offer_id).toBe(o2.offer_id);
  });
  it('a judge offer needs both taps', () => {
    const j = offer(1, 'judge', '5000000', '15000000');
    let s = foldOdds([offered(j), answered(j.offer_id, 'A', 'accepted')]);
    expect(s.open?.offer_id).toBe(j.offer_id);
    expect(s.accepted_by).toEqual(['A']);
    expect(s.agreed).toEqual([]);
    s = foldOdds([
      offered(j),
      answered(j.offer_id, 'A', 'accepted'),
      answered(j.offer_id, 'B', 'accepted'),
    ]);
    expect(s.open).toBeNull();
    expect(agreedFor(s, { a: '5000000', b: '15000000' })).toBe(true);
  });
  it('withdrawn closes; answers to a closed offer are ignored; odds.agreed alone also agrees', () => {
    const o1 = offer(1, 'B', '5000000', '10000000');
    let s = foldOdds([offered(o1), answered(o1.offer_id, 'B', 'withdrawn')]);
    expect(s.open).toBeNull();
    s = foldOdds([
      offered(o1),
      answered(o1.offer_id, 'B', 'withdrawn'),
      answered(o1.offer_id, 'A', 'accepted'),
    ]);
    expect(s.agreed).toEqual([]);
    s = foldOdds([
      offered(o1),
      ev('odds.agreed', {
        offer_id: o1.offer_id,
        stakes: o1.stakes,
        ratio_label: '2 to 1',
        terms_hash: 'cd'.repeat(32),
      }),
    ]);
    expect(agreedFor(s, o1.stakes)).toBe(true);
    expect(s.agreed[0]!.terms_hash).toBe('cd'.repeat(32));
  });
  it('the new realtime events parse; a 12:1 offer does not', () => {
    const o1 = offer(1, 'A', '15000000', '5000000');
    for (const e of [
      offered(o1),
      answered(o1.offer_id, 'B', 'accepted'),
      ev('odds.agreed', {
        offer_id: o1.offer_id,
        stakes: o1.stakes,
        ratio_label: '3 to 1',
        terms_hash: 'ab'.repeat(32),
      }),
    ])
      expect(parseRealtimeEvent(e).ok).toBe(true);
    expect(parseRealtimeEvent(offered(offer(2, 'A', '12000000', '1000000'))).ok).toBe(true); // Stake only checks per side
    expect(parseRealtimeEvent(answered(o1.offer_id, 'B', 'maybe')).ok).toBe(false);
  });
});

describe('offer copy', () => {
  const o = offer(1, 'B', '5000000', '15000000');
  it('offerLine for each viewer', () => {
    expect(offerLine('Jake', o, 'A')).toBe('Jake offers 3 to 1: your $5 to win $20');
    expect(offerLine('Jake', o, 'B')).toBe('You offer 3 to 1: your $15 to win $20');
    expect(offerLine('Jake', { ...o, stakes: { a: '15000000', b: '5000000' } }, 'A')).toBe(
      'Jake asks 3 to 1: your $15 to win $20',
    );
    expect(offerLine('Judge', { ...o, from: 'judge' }, 'A')).toBe('Judge suggests 3 to 1');
    expect(offerLine('Jake', o, null)).toBe('Jake offers 3 to 1');
  });
  it('statLine', () => {
    expect(
      statLine(
        {
          category_label: 'Bottle flip',
          in_category: { made: 10, tries: 12 },
          h2h: { wins: 4, losses: 7 },
        },
        'Logan',
      ),
    ).toBe('Bottle flips 10–2 · vs Logan 4–7');
  });
});

// ---- voice ------------------------------------------------------------------------------------

describe('propose_terms stake_b_usd', () => {
  const sk = (stake_b_usd?: string, extra: Record<string, unknown> = {}) => ({
    ...BOTTLE,
    amount_usd: '15',
    ...(stake_b_usd !== undefined ? { stake_b_usd } : {}),
    ...extra,
  });
  it('absent / "" / equal -> even (null); "5" -> 5e6', () => {
    for (const v of [undefined, '', '15']) {
      const m = mapProposeTermsArgs(sk(v));
      expect(m.ok && m.proposal.amount_b).toBe(null);
    }
    const m = mapProposeTermsArgs(sk('5'));
    expect(m.ok && m.proposal).toMatchObject({ amount: '15000000', amount_b: '5000000' });
  });
  it('a bad stake_b_usd is AMBIGUOUS; real_world must leave it empty', () => {
    const bad = mapProposeTermsArgs(sk('five'));
    expect(!bad.ok && bad.draftIssue?.code).toBe('AMBIGUOUS');
    const rw = mapProposeTermsArgs(
      sk('5', {
        type: 'real_world',
        performer: 'none',
        yes_party: 'A',
        attempts: { count: 1, rule: 'single' },
        market_side: 'YES',
      }),
    );
    expect(!rw.ok && rw.issues.map((i) => i.path)).toContain('stake_b_usd');
  });
  it('stakeIssue: each side capped; ODDS_TOO_LONG beyond 10:1', () => {
    const p = (a: string, b: string | null) => ({
      ...(mapProposeTermsArgs(sk()) as { ok: true; proposal: any }).proposal,
      amount: a,
      amount_b: b,
    });
    expect(stakeIssue(p('15000000', '5000000'))).toBeNull();
    expect(stakeIssue(p('5000000', '25000000'))?.code).toBe('STAKE_ABOVE_MAX');
    expect(stakeIssue(p('20000000', '1000000'))?.code).toBe('ODDS_TOO_LONG');
  });
  it('the reply reads both stakes back with names and asks for the taps', () => {
    const e = evaluateProposeTerms({ conversation_id: 'c', bet_id: 'b', ...sk('5') });
    expect(e.kind).toBe('proposal');
    const r = proposeTermsReply(e, { names: { a: 'Logan', b: 'Jake' } });
    expect(r.say).toContain('Logan puts in fifteen, Jake puts in five; winner takes twenty.');
    expect(r.odds).toBe('tap_accept');
    const even = proposeTermsReply(
      evaluateProposeTerms({ conversation_id: 'c', bet_id: 'b', ...sk() }),
    );
    expect(even.say).toContain('Fifteen dollars each.');
    expect(even.odds).toBeUndefined();
  });
  it('readbackSay with odds fits 200 chars', () => {
    const m = mapProposeTermsArgs(sk('5'));
    const s = readbackSay((m as any).proposal, { a: 'Bartholomew-Jones', b: 'Maximiliana' });
    expect(s.length).toBeLessThanOrEqual(SAY_MAX_CHARS);
    expect(s).toMatch(/puts in fifteen, Maximiliana puts in five; winner takes twenty\.$/);
  });
  it('typed: stakeBUsd passes through typedTermsArgs', () => {
    const r = typedTermsRequest({
      claim: 'Jake sinks it.',
      stakeUsd: 15,
      stakeBUsd: 5,
      bName: 'Jake',
    });
    expect(r.stake_b_usd).toBe('5');
    expect(typedTermsArgs(r).stake_b_usd).toBe('5');
    expect(
      typedTermsRequest({ claim: 'x', stakeUsd: 5, stakeBUsd: 5, bName: 'J' }).stake_b_usd,
    ).toBeUndefined();
  });
  it('the persona has the # Odds section, and the suggest_odds bullet only with the tool', () => {
    const p = buildJudgePrompt(new Set(['propose_terms', 'confirm_terms', 'suggest_odds']));
    expect(p).toContain('# Odds');
    expect(p).toContain('call suggest_odds');
    expect(buildJudgePrompt(new Set(['propose_terms']))).not.toContain('suggest_odds');
  });
});

describe('suggestion words', () => {
  it('the wire schema for the model has only the band as an enum and no string/number constraints', () => {
    const o = oddsOutputSchema(['2:1', '3:1']);
    expect(o.jsonSchema.properties.ratio.enum).toEqual(['2:1', '3:1']);
    // Anthropic structured outputs reject minLength/maxLength/minimum/maximum (judge/prompt.ts).
    expect(JSON.stringify(o.jsonSchema)).not.toMatch(/maxLength|minLength|minimum|maximum/);
  });

  const facts: OddsFacts = {
    performer_name: 'Jake',
    opponent_name: 'Logan',
    category_plural: 'bottle flips',
    made: 10,
    tries: 12,
    chance_pct: 69,
    base_rate_pct: 25,
    sample_meaningful: true,
    h2h: { wins: 7, losses: 4 },
    overall: { wins: 12, losses: 5 },
    streak: { kind: 'W', n: 3 },
    stake_dollars: [10, 5],
    ratio: { num: 2, den: 1 },
    attempts_count: 1,
  };
  it('guardReason keeps facts-only reasons and rejects invented numbers', () => {
    expect(
      guardReason('Jake has landed 10 of 12 bottle flips and won three straight.', facts),
    ).toBe(true);
    expect(guardReason('Jake has landed 9 of 10 bottle flips.', facts)).toBe(false);
    expect(guardReason('Jake landed nine of his last ten.', facts)).toBe(false);
    expect(guardReason('Jake is seven and four against Logan.', facts)).toBe(true);
    expect(guardReason('Jake already won money on these.', facts)).toBe(false);
    expect(guardReason('x'.repeat(141), facts)).toBe(false);
    expect(guardReason('', facts)).toBe(false);
  });
  it('templateReason: meaningful, small sample, no history', () => {
    expect(templateReason(facts)).toBe('Jake is 10 for 12 on bottle flips, and 7-4 against Logan.');
    expect(templateReason({ ...facts, made: 1, tries: 1, sample_meaningful: false })).toBe(
      'Jake is 1 for 1 on bottle flips; small sample, so I lean on the usual 25%.',
    );
    const none = templateReason({ ...facts, made: 0, tries: 0, sample_meaningful: false });
    expect(none).toBe("Bottle flips land about a quarter of the time. That's my default.");
    for (const r of [templateReason(facts), none]) expect(guardReason(r, facts)).toBe(true);
  });
  it('suggestSay fits 200 chars, trimming the reason first', () => {
    const s = suggestSay({
      reason: 'Jake is 10 for 12 on bottle flips.',
      ratio: '2:1',
      stakes: { a: D(5), b: D(10) },
      names: { a: 'Logan', b: 'Jake' },
    });
    expect(s).toBe(
      "Jake is 10 for 12 on bottle flips. I'd make it two to one: Logan puts in five, Jake puts in ten. Both agree?",
    );
    const long = suggestSay({
      reason: 'x '.repeat(150),
      ratio: '3:2',
      stakes: { a: D(5), b: D(7.5) },
      names: { a: 'Logan', b: 'Jake' },
    });
    expect(long.length).toBeLessThanOrEqual(SAY_MAX_CHARS);
    expect(long).toMatch(/Jake puts in \$7\.50\. Both agree\?$/);
  });
  it('base rates', () => {
    expect(CATEGORY_BASE_RATE).toEqual({ bottle_flip: 0.25, throw: 0.4, other: 0.5 });
  });
});
