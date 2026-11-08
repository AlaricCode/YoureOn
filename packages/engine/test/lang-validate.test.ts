import { describe, expect, it } from 'vitest';
import { canonicalize, LangError, parseYaml, staticCheckpointBound, validateProgram } from '../src/lang/index.js';
import type { Program } from '../src/types.js';
import { CTX2, CTX4, oneLeg, PAPER_BALL_AST } from './lang-fixtures.js';

function codes(src: string, ctx = CTX2): string[] {
  const r = parseYaml(src, ctx);
  return r.ok ? [] : r.errors.map((e) => e.code);
}
function warnings(src: string, ctx = CTX2): string[] {
  const r = parseYaml(src, ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.warnings.map((w) => w.code);
}
const S = (success: string, extra: Partial<Parameters<typeof oneLeg>[0]> = {}): string[] => codes(oneLeg({ success, ...extra }));

const PERSON_ENTS = '  ball: object("ball")\n  me: person(p1)\n  mark: region(line)';
const A = (success: string, rule: string, extraLeg = ''): string =>
  oneLeg({ entities: PERSON_ENTS, success, rule, actorBound: true, extraLeg });

describe('operands (§2.7 BAD_OPERAND / BAD_SUBREGION / UNKNOWN_ENTITY)', () => {
  it('accepts every primitive with valid operands', () => {
    for (const s of [
      'ball overlaps can',
      'ball inside area',
      'ball above can.opening',
      'ball below anyone',
      'ball behind mark',
      'ball beyond mark',
      'ball crosses mark',
      'ball enters area',
      'ball enters can',
      'ball enters can.interior',
      'ball leaves can.opening',
      'ball disappears_into can.opening',
      'ball disappears_into area',
      'ball disappears_into can',
      'ball touches anyone',
      'ball released_by anyone',
      'ball near can.interior 14143',
      'anyone standing',
      'rep_count(anyone) >= 1000',
      'ball speed >= 100000',
      'ball at_rest 3600s',
    ]) {
      expect(S(s), s).toEqual([]);
    }
  });

  it('rejects unknown entities', () => {
    expect(S('ghost present')).toEqual(['UNKNOWN_ENTITY']);
    expect(S('ball inside ghost')).toEqual(['UNKNOWN_ENTITY']);
  });

  it('rejects sub-regions on a operands and on non-objects', () => {
    expect(S('can.opening inside area')).toEqual(['BAD_SUBREGION']);
    expect(S('ball inside area.interior')).toEqual(['BAD_SUBREGION']);
    expect(S('ball inside anyone.opening')).toEqual(['BAD_SUBREGION']);
  });

  it('rejects region a operands', () => {
    expect(S('area present')).toEqual(['BAD_OPERAND']);
    expect(S('mark overlaps ball')).toEqual(['BAD_OPERAND']);
  });

  it('line-only primitives need a line region', () => {
    expect(S('ball behind area')).toEqual(['BAD_OPERAND']);
    expect(S('ball beyond can')).toEqual(['BAD_OPERAND']);
    expect(S('ball crosses can.opening')).toEqual(['BAD_OPERAND']);
  });

  it('no other primitive may take a line region', () => {
    for (const op of ['overlaps', 'inside', 'above', 'below', 'near', 'enters', 'leaves', 'disappears_into', 'touches', 'released_by']) {
      expect(S(`ball ${op} mark`), op).toEqual(['BAD_OPERAND']);
    }
  });

  it('enters/leaves/disappears_into/released_by operand kinds', () => {
    expect(S('ball enters anyone')).toEqual(['BAD_OPERAND']);
    expect(S('ball leaves anyone')).toEqual(['BAD_OPERAND']);
    expect(S('ball disappears_into can.interior')).toEqual(['BAD_OPERAND']);
    expect(S('ball disappears_into anyone')).toEqual(['BAD_OPERAND']);
    expect(S('ball released_by can')).toEqual(['BAD_OPERAND']);
    expect(S('ball released_by area')).toEqual(['BAD_OPERAND']);
  });

  it('standing and rep_count need a person', () => {
    expect(S('ball standing')).toEqual(['BAD_OPERAND']);
    expect(S('rep_count(ball) >= 3')).toEqual(['BAD_OPERAND']);
  });

  it('region(tap) resolves by usage; mixed usage is BAD_OPERAND', () => {
    const ents = '  ball: object("ball")\n  spot: region(tap)';
    const lineP = parseYaml(oneLeg({ entities: ents, success: 'ball crosses spot' }), CTX2);
    expect(lineP.ok && lineP.program.entities[1]).toEqual({ name: 'spot', kind: 'region', shape: 'line' });
    const zoneP = parseYaml(oneLeg({ entities: ents, success: 'ball enters spot' }), CTX2);
    expect(zoneP.ok && zoneP.program.entities[1]).toEqual({ name: 'spot', kind: 'region', shape: 'zone' });
    expect(codes(oneLeg({ entities: ents, success: 'ball crosses spot and ball enters spot' }))).toEqual(['BAD_OPERAND']);
  });

  it('disappears_into an object is rewritten to .opening', () => {
    const r = parseYaml(oneLeg({ success: 'ball disappears_into can' }), CTX2);
    expect(r.ok && r.program.legs[0]!.success).toEqual({ op: 'disappears_into', a: { e: 'ball' }, b: { e: 'can', sub: 'opening' } });
  });
});

describe('leaf parameter ranges (LIMIT)', () => {
  it('boundaries', () => {
    expect(S('ball near can 14144')).toEqual(['LIMIT']);
    expect(S('ball near can 0')).toEqual([]);
    expect(S('ball speed > 100001')).toEqual(['LIMIT']);
    expect(S('rep_count(anyone) >= 1001')).toEqual(['LIMIT']);
    expect(S('ball at_rest 0s')).toEqual(['LIMIT']);
    expect(S('ball at_rest 3600.1s')).toEqual(['LIMIT']);
    expect(S('ball present for_duration 0ms')).toEqual(['LIMIT']);
    expect(S('ball present for_duration 3600s')).toEqual([]);
    expect(S('ball present then_within 3601s can present')).toEqual(['LIMIT']);
    expect(S('ball present before 3600s')).toEqual([]);
  });

  it('expression size limits: nodes, bytes, depth', () => {
    // 32 leaves + 31 ands = 63 nodes; 32·7 + 31 = 255 bytes; balanced depth 6.
    const leaves = (n: number): string[] => Array.from({ length: n }, (_, i) => (i % 2 ? 'ball present' : 'can present'));
    expect(S(leaves(32).join(' and '))).toEqual(['LIMIT']); // left-nested chain: depth 32
    const balanced = (xs: string[]): string => (xs.length === 1 ? xs[0]! : `(${balanced(xs.slice(0, xs.length / 2))}) and (${balanced(xs.slice(xs.length / 2))})`);
    expect(S(balanced(leaves(32)))).toEqual([]);
    // 33 leaves → 65 nodes.
    expect(S(`(${balanced(leaves(32))}) and ball moving`)).toEqual(['LIMIT']);
    // depth exactly 12 passes, 13 fails.
    const nots = (k: number): string => `${'not '.repeat(k)}ball present`;
    expect(S(nots(11))).toEqual([]);
    expect(S(nots(12))).toEqual(['LIMIT']);
    // bytes: 32 leaves of `before` wrappers: each leaf wrapped in before (5+7=12 bytes) → 31 ands + 32·12 = 415; nodes 95 → LIMIT (nodes)
    const wrapped = (xs: string[]): string => (xs.length === 1 ? `(${xs[0]!}) before 1s` : `(${wrapped(xs.slice(0, xs.length / 2))}) and (${wrapped(xs.slice(xs.length / 2))})`);
    expect(S(wrapped(leaves(16)))).toEqual([]); // 16·12 + 15 = 207 bytes, 47 nodes
  });

  it('condition limits', () => {
    // 17 legs is impossible; build a 33-node condition from not-chains over leg 1.
    const cond = `${'not '.repeat(11)}leg 1`;
    expect(codes(oneLeg({ success: 'ball present', outcome: `side(A) wins iff ${cond}; else side(B)` }))).toEqual([]);
    const deep = `${'not '.repeat(12)}leg 1`;
    expect(codes(oneLeg({ success: 'ball present', outcome: `side(A) wins iff ${deep}; else side(B)` }))).toEqual(['LIMIT']);
    const wide = Array.from({ length: 17 }, () => '(leg 1 and leg 1)').join(' or ');
    expect(codes(oneLeg({ success: 'ball present', outcome: `side(A) wins iff ${wide}; else side(B)` }))).toContain('LIMIT');
  });
});

describe('actor-bound legs (§2.7)', () => {
  it('ACTOR_BOUND_MISMATCH both ways', () => {
    expect(codes(oneLeg({ entities: PERSON_ENTS, success: 'me standing', actorBound: false }))).toEqual(['ACTOR_BOUND_MISMATCH']);
    expect(codes(oneLeg({ success: 'ball present', actorBound: true }))).toEqual(['ACTOR_BOUND_MISMATCH']);
    expect(codes(oneLeg({ entities: PERSON_ENTS, success: 'ball near me', actorBound: true }))).toEqual([]);
  });

  it('NEGATIVE_ACTOR_RULE', () => {
    expect(codes(A('me standing', 'never(success)'))).toEqual(['NEGATIVE_ACTOR_RULE']);
    for (const cmp of ['<', '<=', '==', '!=']) expect(codes(A('me standing', `count(success) ${cmp} 2`)), cmp).toEqual(['NEGATIVE_ACTOR_RULE']);
    expect(codes(A('me standing', 'count(success) >= 0'))).toEqual(['NEGATIVE_ACTOR_RULE']);
    expect(codes(A('me standing', 'count(success) > 0'))).toEqual([]);
    expect(codes(A('me standing', 'count(success) >= 1'))).toEqual([]);
    // Not actor-bound: negative rules are fine.
    expect(S('ball present', { rule: 'never(success)' })).toEqual([]);
    expect(S('ball present', { rule: 'count(success) < 3' })).toEqual([]);
  });

  it('CHECKPOINT_LIMIT: attempts ≤ 8 and k\' ≤ 8 for actor-bound counts', () => {
    const va = '    valid_attempt: ball released_by me\n';
    expect(codes(A('ball inside mark', 'x', va).replace('rule: x', 'rule: count(success) >= 1 within attempts 8').replace('ball inside mark', 'ball above me'))).toEqual([]);
    expect(codes(A('ball above me', 'count(success) >= 1 within attempts 9', va))).toEqual(['CHECKPOINT_LIMIT']);
    expect(codes(A('me standing', 'count(success) >= 8'))).toEqual([]);
    expect(codes(A('me standing', 'count(success) >= 9'))).toEqual(['CHECKPOINT_LIMIT']);
    expect(codes(A('me standing', 'count(success) > 7'))).toEqual([]);
    expect(codes(A('me standing', 'count(success) > 8'))).toEqual(['CHECKPOINT_LIMIT']);
    // Non-actor-bound: attempts up to 20.
    expect(S('ball present', { rule: 'count(success) >= 1 within attempts 20', extraLeg: '' }).length).toBeGreaterThan(0); // needs valid_attempt
  });

  it('static checkpoint bound sums n_anchor × |persons| over actor-bound legs', () => {
    const ents = '  ball: object("ball")\n  me: person(p1)\n  you: person(p0)';
    const leg = (id: number, success: string, rule: string): string =>
      `  - id: ${id}\n    actor_bound: true\n    success: ${success}\n    rule: ${rule}\n`;
    const prog = (legs: string): string =>
      `version: 2\nentities:\n${ents}\nlegs:\n${legs}outcome: side(A) wins iff leg 1; else side(B)\nstake_each: 10000\n`;
    // 4 × 2 persons = 8: ok.
    const ok8 = prog(leg(1, 'me near you', 'count(success) >= 4'));
    expect(codes(ok8)).toEqual([]);
    const r = parseYaml(ok8, CTX2);
    expect(r.ok && staticCheckpointBound(r.program)).toBe(8);
    // 4 × 2 + 1 = 9: too many.
    expect(codes(prog(leg(1, 'me near you', 'count(success) >= 4') + leg(2, 'me standing', 'success')))).toEqual(['CHECKPOINT_LIMIT']);
    // with attempts: n_anchor = min(k', N); persons from valid_attempt only.
    const withVa = prog(
      `  - id: 1\n    actor_bound: true\n    valid_attempt: ball released_by me\n    success: ball near you\n    rule: count(success) >= 5 within attempts 3\n` +
        leg(2, 'me near you', 'count(success) >= 2'),
    );
    const r2 = parseYaml(withVa, CTX2);
    expect(r2.ok).toBe(true);
    expect(r2.ok && staticCheckpointBound(r2.program)).toBe(3 * 1 + 2 * 2);
  });
});

describe('rules (BAD_RULE)', () => {
  const va = '    valid_attempt: ball released_by anyone\n';
  const withVa = (rule: string): string[] =>
    codes(oneLeg({ success: 'ball inside can', rule, extraLeg: '' }).replace('    success:', `${va}    success:`));
  it('within attempts requires valid_attempt and vice versa', () => {
    expect(S('ball present', { rule: 'count(success) >= 1 within attempts 3' })).toEqual(['BAD_RULE']);
    expect(withVa('count(success) >= 1')).toEqual(['BAD_RULE']);
    expect(withVa('success')).toEqual(['BAD_RULE']);
    expect(withVa('holds(success) for 1s')).toEqual(['BAD_RULE']);
    expect(withVa('count(success) >= 1 within attempts 3')).toEqual([]);
  });
  it('k and N ranges', () => {
    expect(S('ball present', { rule: 'count(success) >= 1000' })).toEqual([]);
    expect(S('ball present', { rule: 'count(success) >= 1001' })).toEqual(['BAD_RULE']);
    expect(withVa('count(success) >= 1 within attempts 20')).toEqual([]);
    expect(withVa('count(success) >= 1 within attempts 21')).toEqual(['BAD_RULE']);
    expect(withVa('count(success) >= 1 within attempts 0')).toEqual(['BAD_RULE']);
  });
  it('holds/before durations must fit the time limit', () => {
    expect(S('ball present', { rule: 'holds(success) for 30s', timeLimit: 30 })).toEqual([]);
    expect(S('ball present', { rule: 'holds(success) for 30.1s', timeLimit: 30 })).toEqual(['BAD_RULE']);
    expect(S('ball present', { rule: 'success before 31s', timeLimit: 30 })).toEqual(['BAD_RULE']);
    expect(S('ball present', { rule: 'success before 0s', timeLimit: 30 })).toEqual(['BAD_RULE']);
  });
});

describe('warnings', () => {
  it('UNUSED_ENTITY for unused objects and person_any only', () => {
    expect(warnings(oneLeg({ success: 'ball present' }))).toEqual(['UNUSED_ENTITY', 'UNUSED_ENTITY']);
  });
  it('PULSE_DURATION', () => {
    expect(warnings(oneLeg({ success: 'ball enters area for_duration 1s and can present and anyone present' }))).toEqual(['PULSE_DURATION']);
    expect(warnings(oneLeg({ success: 'ball inside area for_duration 1s and can present and anyone present' }))).toEqual([]);
  });
  it('UNWINNABLE', () => {
    const src = oneLeg({ success: 'ball inside can', rule: 'count(success) > 2 within attempts 2' }).replace(
      '    success:',
      '    valid_attempt: ball released_by anyone\n    success:',
    );
    expect(warnings(src)).toEqual(['UNWINNABLE']);
  });
});

describe('kind, stake, time limit', () => {
  it('BAD_STAKE', () => {
    expect(codes(oneLeg({ success: 'ball present' }).replace('stake_each: 1000000', 'stake_each: 9999'))).toEqual(['BAD_STAKE']);
    expect(codes(oneLeg({ success: 'ball present' }).replace('stake_each: 1000000', 'stake_each: 10000'))).toEqual([]);
    expect(codes(oneLeg({ success: 'ball present' }).replace('stake_each: 1000000', 'stake_each: 1_000_000_000_000'))).toEqual([]);
    expect(codes(oneLeg({ success: 'ball present' }).replace('stake_each: 1000000', 'stake_each: 1_000_000_000_001'))).toEqual(['BAD_STAKE']);
    expect(codes(oneLeg({ success: 'ball present' }).replace('stake_each: 1000000\n', ''))).toEqual(['BAD_STAKE']);
  });
  it('BAD_TIME_LIMIT', () => {
    expect(S('ball present', { timeLimit: 0 })).toEqual(['BAD_TIME_LIMIT']);
    expect(S('ball present', { timeLimit: 3600 })).toEqual([]);
    expect(S('ball present', { timeLimit: 3601 })).toEqual(['BAD_TIME_LIMIT']);
  });
  it('BAD_KIND', () => {
    expect(S('ball present', { top: 'question: "why?"\n' })).toEqual(['BAD_KIND']);
    expect(S('ball present', { top: 'stakes: [10000, 10000]\n' })).toEqual(['BAD_KIND']);
    expect(S('ball present', { top: 'kind: magic\n' })).toEqual(['BAD_KIND']);
    expect(
      codes(oneLeg({ success: 'ball present' }).replace('    rule: success', '    rule: success\n    market: {event_id: e, contract_id: c, side: yes, prob_bps: 5000}')),
    ).toEqual(['BAD_KIND']);
    expect(codes('version: 2\nentities:\n  ball: object("ball")\noutcome: side(A) wins iff leg 1; else side(B)\nstake_each: 10000\n')).toEqual([
      'BAD_KIND',
      'BAD_OUTCOME',
    ]);
    expect(codes('version: 2\nkind: ai_judged\noutcome: side(A) wins iff yes; else side(B)\nstake_each: 10000\n')).toEqual(['BAD_KIND']);
  });
  it('legs: id range, order, count', () => {
    const second = (id: number): string => `  - id: ${id}\n    actor_bound: false\n    success: can present\n    rule: success\n`;
    expect(S('ball present', { extraLeg: second(2) })).toEqual([]);
    expect(S('ball present', { extraLeg: second(1) })).toEqual(['LIMIT']);
    expect(S('ball present', { extraLeg: second(9) })).toEqual(['LIMIT']);
    expect(codes(oneLeg({ success: 'ball present' }).replace('id: 1', 'id: 0'))).toContain('LIMIT');
  });
});

describe('validateProgram on ASTs and canonicalize errors', () => {
  it('a valid canonical AST validates without a context', () => {
    expect(validateProgram(PAPER_BALL_AST as Program)).toEqual({ errors: [], warnings: [] });
  });
  it('checks huddle membership and enrollment when given a context', () => {
    const p = structuredClone(PAPER_BALL_AST) as Program;
    const unenrolled = { ...CTX2, huddle: [CTX2.huddle[0]!, { ...CTX2.huddle[1]!, enrolled: false }] };
    expect(validateProgram(p, unenrolled).errors.map((e) => e.code)).toEqual(['NOT_ENROLLED']);
    expect(validateProgram(p, { creator: CTX4.huddle[2]!.wallet, huddle: CTX4.huddle }).errors.map((e) => e.code)).toEqual(['UNKNOWN_PARTICIPANT']);
  });
  it('rejects non-canonical leftovers', () => {
    const p = structuredClone(PAPER_BALL_AST) as Program;
    (p.entities[3] as { shape: string }).shape = 'tap';
    expect(validateProgram(p).errors.map((e) => e.code)).toContain('PARSE_ERROR');
  });
  it('canonicalize throws LangError when a draft cannot be resolved', () => {
    expect(() =>
      canonicalize({
        version: 2,
        entities: [{ name: 'me', kind: 'person', member: 'p1' }],
        legs: [],
        outcome: { if_true: { side: 'A' }, condition: { op: 'yes' }, else: { side: 'B' } },
      }),
    ).toThrow(LangError);
  });
});
