import { describe, expect, it } from 'vitest';
import { compileMarket, LangError, marketTitle, parseYaml, readback, toYaml, validateProgram } from '../src/lang/index.js';
import { quoteProb, splitStakes } from '../src/lang/compileMarket.js';
import type { MarketPick, MarketQuote } from '../src/types.js';
import { CREATOR, CTX2, FRIEND, NAMES } from './lang-fixtures.js';

const NOW = 1_700_000_000_000;
const pick = (over: Partial<MarketPick> = {}): MarketPick => ({
  event_id: 'NBA-LAL-BOS',
  contract_id: 'LAL',
  side: 'yes',
  prob_bps: 7000,
  close_time_ms: NOW + 3_600_000,
  event_title: 'Lakers vs Celtics: who wins tonight at the Garden in Boston?',
  ...over,
});

describe('compileMarket (§11.4)', () => {
  it('single leg: 70/30 split, sides, outcome, time limit', () => {
    const q: MarketQuote = { picks: [pick()], total_units: 10_000_000 };
    const p = compileMarket(q, CREATOR, FRIEND, NOW);
    expect(p).toStrictEqual({
      version: 2,
      kind: 'market',
      participants: [CREATOR, FRIEND],
      sides: [0, 1],
      entities: [],
      legs: [
        {
          id: 1,
          actor_bound: false,
          attempt_window_frames: 0,
          market: { venue: 'gemini', event_id: 'NBA-LAL-BOS', contract_id: 'LAL', side: 'yes', prob_bps: 7000 },
        },
      ],
      outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
      stakes: [7_000_000, 3_000_000],
      time_limit_s: 3600 + 86400,
    });
    expect(validateProgram(p, CTX2).errors).toEqual([]);
  });

  it('no side uses 10000 − prob; clamping at 100/9900 bps', () => {
    expect(quoteProb([pick({ side: 'no' })])).toBe(3000n);
    expect(quoteProb([pick({ prob_bps: 10000 })])).toBe(9900n);
    expect(quoteProb([pick({ prob_bps: 0 })])).toBe(100n);
    expect(quoteProb([pick({ prob_bps: 9950, side: 'no' })])).toBe(100n);
  });

  it('stake split floors the proposer stake to whole cents', () => {
    expect(splitStakes(10_000_000n, 3333n)).toEqual({ proposer: 3_330_000n, counterparty: 6_670_000n });
    expect(splitStakes(1_000_000_000_000n, 9900n)).toEqual({ proposer: 990_000_000_000n, counterparty: 10_000_000_000n });
  });

  it('parlay: product of side probabilities, legs and-chained, latest close time', () => {
    const q: MarketQuote = {
      picks: [
        pick(),
        pick({ event_id: 'E2', contract_id: 'C2', side: 'no', prob_bps: 4000, close_time_ms: NOW + 7_200_500 }),
        pick({ event_id: 'E3', contract_id: 'C3', prob_bps: 5000 }),
      ],
      total_units: 10_000_000,
    };
    // P = 7000; P = 7000·6000/10000 = 4200; P = 4200·5000/10000 = 2100
    expect(quoteProb(q.picks)).toBe(2100n);
    const p = compileMarket(q, CREATOR, FRIEND, NOW);
    expect(p.stakes).toEqual([2_100_000, 7_900_000]);
    expect(p.outcome.condition).toEqual({
      op: 'and',
      args: [{ op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'leg', id: 2 }] }, { op: 'leg', id: 3 }],
    });
    expect(p.time_limit_s).toBe(7201 + 86400);
    expect(p.legs.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it('time limit is capped at 30 days', () => {
    const p = compileMarket({ picks: [pick({ close_time_ms: NOW + 40 * 86_400_000 })], total_units: 10_000_000 }, CREATOR, FRIEND, NOW);
    expect(p.time_limit_s).toBe(2_592_000);
  });

  it('rejects invalid quotes', () => {
    const bad: MarketQuote[] = [
      { picks: [], total_units: 10_000_000 },
      { picks: [pick(), pick({ event_id: 'a' }), pick({ event_id: 'b' }), pick({ event_id: 'c' }), pick({ event_id: 'd' })], total_units: 10_000_000 },
      { picks: [pick(), pick()], total_units: 10_000_000 },
      { picks: [pick({ prob_bps: 10001 })], total_units: 10_000_000 },
      { picks: [pick()], total_units: 15_000 }, // proposer 10_000, counterparty 5_000 < min
      { picks: [pick({ close_time_ms: NOW - 2 * 86_400_000 })], total_units: 10_000_000 },
    ];
    for (const q of bad) expect(() => compileMarket(q, CREATOR, FRIEND, NOW)).toThrow(LangError);
  });

  it('round-trips through toYaml/parseYaml and reads back', () => {
    const p = compileMarket({ picks: [pick(), pick({ event_id: 'E2', contract_id: 'C2', side: 'no' })], total_units: 50_000_000 }, CREATOR, FRIEND, NOW);
    const y = toYaml(p);
    expect(y).not.toContain('attempt_window_s');
    const r = parseYaml(y, CTX2);
    expect(r.ok && r.program).toStrictEqual(p);
    expect(readback(p, { names: NAMES }).slice(-2)).toEqual(['Stakes $10.50 / $39.50', 'Time limit 1500m']);
  });

  it('market YAML: forbidden fields and required time limit', () => {
    const base = `version: 2
kind: market
legs:
  - id: 1
    actor_bound: false
    market: {event_id: E, contract_id: C, side: yes, prob_bps: 5000}
outcome: side(A) wins iff leg 1; else side(B)
stakes: [10000, 10000]
time_limit_s: 100
`;
    const codes = (s: string): string[] => {
      const r = parseYaml(s, CTX2);
      return r.ok ? [] : r.errors.map((e) => e.code);
    };
    expect(codes(base)).toEqual([]);
    const r = parseYaml(base, CTX2);
    expect(r.ok && r.program.legs[0]!.market!.venue).toBe('gemini');
    expect(codes(base.replace('time_limit_s: 100\n', ''))).toEqual(['BAD_TIME_LIMIT']);
    expect(codes(base.replace('time_limit_s: 100', 'time_limit_s: 2592001'))).toEqual(['BAD_TIME_LIMIT']);
    expect(codes(base.replace('time_limit_s: 100', 'time_limit_s: 2592000'))).toEqual([]);
    expect(codes(base.replace('    market:', '    rule: success\n    market:'))).toEqual(['BAD_KIND']);
    expect(codes(base.replace('    market:', '    attempt_window_s: 5s\n    market:'))).toEqual(['BAD_KIND']);
    expect(codes(base.replace('actor_bound: false', 'actor_bound: true'))).toEqual(['ACTOR_BOUND_MISMATCH']);
    expect(codes(base.replace('stakes: [10000, 10000]', 'stake_each: 10000'))).toEqual(['BAD_KIND', 'BAD_STAKE']);
    expect(codes(base.replace('stakes: [10000, 10000]', 'stakes: [10000]'))).toEqual(['BAD_STAKE']);
    expect(codes(base.replace('prob_bps: 5000', 'prob_bps: 10001'))).toEqual(['LIMIT']);
    expect(codes(base.replace('side: yes', 'side: maybe'))).toEqual(['PARSE_ERROR']);
    expect(codes(base.replace('prob_bps: 5000}', 'prob_bps: 5000, venue: kalshi}'))).toEqual(['BAD_KIND']);
  });
});

describe('marketTitle', () => {
  it('truncates on a word boundary and appends +N for parlays', () => {
    expect(marketTitle({ picks: [pick()], total_units: 1 })).toBe('Lakers vs Celtics: who wins tonight at');
    expect(marketTitle({ picks: [pick({ event_title: 'Short title' }), pick({ event_id: 'x' })], total_units: 1 })).toBe('Short title +1');
  });
});
