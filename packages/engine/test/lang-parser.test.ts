import { describe, expect, it } from 'vitest';
import { durationToFrames, framesToReadback, framesToYamlDuration, lexRuleText, parseExpr, parseOutcome, parseRule } from '../src/lang/index.js';
import { ParseFailure } from '../src/lang/errors.js';
import type { Expr } from '../src/types.js';

const P = (e: string): Expr => ({ op: 'present', a: { e } });

function failCol(fn: () => unknown): { col: number; code: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParseFailure) return { col: e.col, code: e.code };
    throw e;
  }
  throw new Error('expected a ParseFailure');
}

describe('lexer (§2.5.1)', () => {
  it('tokenizes with longest match', () => {
    const toks = lexRuleText('count(success)>=1 within attempts 3');
    expect(toks.map((t) => t.t)).toEqual(['REF', 'PUNCT', 'REF', 'PUNCT', 'CMP', 'INT', 'REF', 'REF', 'INT', 'EOF']);
    expect(lexRuleText('a<=b')[1]).toMatchObject({ t: 'CMP', text: '<=' });
    expect(lexRuleText('a!=b')[1]).toMatchObject({ t: 'CMP', text: '!=' });
    expect(lexRuleText('1_000_000')[0]).toMatchObject({ t: 'INT', value: 1000000 });
    expect(lexRuleText('can.opening')[0]).toMatchObject({ t: 'REF', name: 'can', sub: 'opening', keyword: false });
    expect(lexRuleText('and')[0]).toMatchObject({ t: 'REF', keyword: true });
    expect(lexRuleText('line')[0]).toMatchObject({ t: 'REF', keyword: false });
    expect(lexRuleText('side(A)')[2]).toMatchObject({ t: 'SIDEL', text: 'A' });
  });

  it('durations: seconds, decimals, ms, ceil to frames', () => {
    expect(lexRuleText('1s')[0]).toMatchObject({ t: 'DUR', frames: 10 });
    expect(lexRuleText('1.5s')[0]).toMatchObject({ t: 'DUR', frames: 15 });
    expect(lexRuleText('0.01s')[0]).toMatchObject({ t: 'DUR', frames: 1 });
    expect(lexRuleText('150ms')[0]).toMatchObject({ t: 'DUR', frames: 2 });
    expect(lexRuleText('100ms')[0]).toMatchObject({ t: 'DUR', frames: 1 });
    expect(lexRuleText('0s')[0]).toMatchObject({ t: 'DUR', frames: 0 });
    expect(lexRuleText('99999.999s')[0]).toMatchObject({ t: 'DUR', frames: 1000000 });
    expect(lexRuleText('9999999ms')[0]).toMatchObject({ t: 'DUR', frames: 100000 });
    expect(durationToFrames('3600s')).toBe(36000);
    expect(durationToFrames('1ms')).toBe(1);
  });

  it('PARSE_ERROR with column for malformed tokens', () => {
    expect(failCol(() => lexRuleText('5sec'))).toEqual({ col: 1, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('x 5m'))).toEqual({ col: 3, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('x 1_00'))).toEqual({ col: 3, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('x 1.5'))).toEqual({ col: 4, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('x 100000s'))).toEqual({ col: 3, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('ab & c'))).toEqual({ col: 4, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('Ball'))).toEqual({ col: 2, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('x = 1'))).toEqual({ col: 3, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('can.top'))).toEqual({ col: 4, code: 'PARSE_ERROR' });
    expect(failCol(() => lexRuleText('a'.repeat(25)))).toEqual({ col: 1, code: 'PARSE_ERROR' });
  });

  it('duration rendering', () => {
    expect(framesToYamlDuration(10)).toBe('1s');
    expect(framesToYamlDuration(15)).toBe('1.5s');
    expect(framesToYamlDuration(1)).toBe('0.1s');
    expect(framesToYamlDuration(1800)).toBe('180s');
    expect(framesToReadback(15)).toBe('1.5s');
    expect(framesToReadback(590)).toBe('59s');
    expect(framesToReadback(600)).toBe('1m');
    expect(framesToReadback(900)).toBe('1m 30s');
    expect(framesToReadback(605)).toBe('60.5s');
  });
});

describe('expression grammar (§2.5.2) precedence table', () => {
  it('level 1: postfix binds tightest', () => {
    expect(parseExpr('ball moving for_duration 2s and x present')).toEqual({
      op: 'and',
      args: [{ op: 'for_duration', frames: 20, arg: { op: 'moving', a: { e: 'ball' } } }, P('x')],
    });
  });
  it('level 2: not over postfix', () => {
    expect(parseExpr('not ball moving for_duration 2s')).toEqual({
      op: 'not',
      arg: { op: 'for_duration', frames: 20, arg: { op: 'moving', a: { e: 'ball' } } },
    });
  });
  it('level 3: then_within', () => {
    expect(parseExpr('a present then_within 2s b present and c present')).toEqual({
      op: 'and',
      args: [{ op: 'then_within', frames: 20, first: P('a'), then: P('b') }, P('c')],
    });
  });
  it('level 4: while binds tighter than and', () => {
    expect(parseExpr('a present and b present while c present')).toEqual({
      op: 'and',
      args: [P('a'), { op: 'and', args: [P('b'), P('c')] }],
    });
  });
  it('level 5: and over or', () => {
    expect(parseExpr('a present or b present and c present')).toEqual({
      op: 'or',
      args: [P('a'), { op: 'and', args: [P('b'), P('c')] }],
    });
  });
  it('level 6: or is left-associative', () => {
    expect(parseExpr('a present or b present or c present')).toEqual({
      op: 'or',
      args: [{ op: 'or', args: [P('a'), P('b')] }, P('c')],
    });
  });
  it('then_within is left-associative; multiple postfixes chain', () => {
    expect(parseExpr('a present then_within 1s b present then_within 2s c present')).toEqual({
      op: 'then_within',
      frames: 20,
      first: { op: 'then_within', frames: 10, first: P('a'), then: P('b') },
      then: P('c'),
    });
    expect(parseExpr('a present for_duration 1s before_deadline 3s')).toEqual({
      op: 'before',
      frames: 30,
      arg: { op: 'for_duration', frames: 10, arg: P('a') },
    });
  });
  it('parentheses override', () => {
    expect(parseExpr('(a present or b present) and c present')).toEqual({
      op: 'and',
      args: [{ op: 'or', args: [P('a'), P('b')] }, P('c')],
    });
  });
});

describe('expression atoms', () => {
  it('infix and functional forms are equivalent', () => {
    const pairs: [string, string][] = [
      ['ball overlaps can', 'overlaps(ball, can)'],
      ['ball released_by me', 'released_by(ball, me)'],
      ['ball near can', 'near(ball, can)'],
      ['ball near can 900', 'near(ball, can, 900)'],
      ['ball moving', 'moving(ball)'],
      ['ball intact', 'intact(ball)'],
      ['ball at_rest 2s', 'at_rest(ball, 2s)'],
      ['ball speed > 300', 'speed(ball) > 300'],
      ['ball direction left', 'direction(ball, left)'],
    ];
    for (const [a, b] of pairs) expect(parseExpr(a), a).toEqual(parseExpr(b));
  });
  it('builds canonical leaf nodes', () => {
    expect(parseExpr('ball near can')).toEqual({ op: 'near', a: { e: 'ball' }, b: { e: 'can' }, dist: 500 });
    expect(parseExpr('rep_count(me) >= 20')).toEqual({ op: 'rep_count', a: { e: 'me' }, cmp: '>=', value: 20 });
    expect(parseExpr('ball speed <= 1_000')).toEqual({ op: 'speed', a: { e: 'ball' }, cmp: '<=', value: 1000 });
    expect(parseExpr('ball direction down')).toEqual({ op: 'direction', a: { e: 'ball' }, dir: 'down' });
    expect(parseExpr('ball enters can.interior')).toEqual({ op: 'enters', a: { e: 'ball' }, b: { e: 'can', sub: 'interior' } });
  });
  it('rejects malformed expressions', () => {
    const bad = [
      'ball',
      'ball and can',
      'ball overlaps',
      'ball overlaps near',
      'overlaps(ball, can, 3)',
      'ball direction north',
      'ball speed 300',
      'rep_count(me) 20',
      'ball present)',
      '(ball present',
      'ball present ball present',
      'ball for_duration 2s',
      'ball present for_duration 2',
      'ball present and',
      'side(A)',
      '',
    ];
    for (const s of bad) expect(() => parseExpr(s), s).toThrow(ParseFailure);
  });
  it('caps input length (LIMIT)', () => {
    const long = Array.from({ length: 400 }, () => 'a present').join(' and ');
    expect(failCol(() => parseExpr(long)).code).toBe('LIMIT');
  });
});

describe('rule grammar (§2.5.3)', () => {
  it('parses every form', () => {
    expect(parseRule('success')).toEqual({ kind: 'exists' });
    expect(parseRule('never(success)')).toEqual({ kind: 'never' });
    expect(parseRule('never ( success )')).toEqual({ kind: 'never' });
    expect(parseRule('count(success) >= 1 within attempts 3')).toEqual({ kind: 'count', cmp: '>=', k: 1, attempts: 3 });
    expect(parseRule('count(success) == 2')).toEqual({ kind: 'count', cmp: '==', k: 2, attempts: 0 });
    expect(parseRule('holds(success) for 10s')).toEqual({ kind: 'holds', frames: 100 });
    expect(parseRule('success before 60s')).toEqual({ kind: 'before', frames: 600 });
    expect(parseRule('success before_deadline 1.5s')).toEqual({ kind: 'before', frames: 15 });
  });
  it('rejects malformed rules', () => {
    for (const s of ['successes', 'count(success)', 'count(success) >= 1 within 3', 'holds(success) 10s', 'never(x)', 'success before', 'success and', 'exists']) {
      expect(() => parseRule(s), s).toThrow(ParseFailure);
    }
  });
});

describe('outcome grammar (§2.5.4)', () => {
  it('parses side refs and conditions', () => {
    expect(parseOutcome('side(shooter) wins iff leg 1 true; else side(creator)')).toEqual({
      if_true: { entity: 'shooter' },
      condition: { op: 'leg', id: 1 },
      else: { side: 'creator' },
    });
    expect(parseOutcome('side(B) wins iff yes; else side(A)')).toEqual({
      if_true: { side: 'B' },
      condition: { op: 'yes' },
      else: { side: 'A' },
    });
    expect(parseOutcome('side(A) wins iff not leg 1 or leg 2 false and (leg 3); else side(other)').condition).toEqual({
      op: 'or',
      args: [
        { op: 'not', arg: { op: 'leg', id: 1 } },
        { op: 'and', args: [{ op: 'not', arg: { op: 'leg', id: 2 } }, { op: 'leg', id: 3 }] },
      ],
    });
  });
  it('rejects malformed outcomes', () => {
    for (const s of [
      'side(A) wins iff leg 1 else side(B)',
      'side(A) wins leg 1; else side(B)',
      'side(C) wins iff leg 1; else side(B)',
      'side(A) wins iff leg; else side(B)',
      'side(a.opening) wins iff leg 1; else side(B)',
      'side(A) wins iff leg 1; else side(B) extra',
      'side(A) wins iff yes and leg 1; else side(B)',
    ]) {
      expect(() => parseOutcome(s), s).toThrow(ParseFailure);
    }
  });
});
