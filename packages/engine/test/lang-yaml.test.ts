import { describe, expect, it } from 'vitest';
import { canonicalize, parseYaml, toYaml, validateProgram } from '../src/lang/index.js';
import type { Program } from '../src/types.js';
import {
  AI_JUDGED_AST,
  AI_JUDGED_YAML,
  CREATOR,
  CTX2,
  CTX4,
  CUP_TOWER_AST,
  CUP_TOWER_YAML,
  FRIEND,
  PAPER_BALL_AST,
  PAPER_BALL_YAML,
  PUSHUPS_AST,
  PUSHUPS_YAML,
  THIRD,
} from './lang-fixtures.js';

function ok(src: string, ctx = CTX2): { program: Program; warnings: { code: string; path: string }[] } {
  const r = parseYaml(src, ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

function codes(src: string, ctx = CTX2): string[] {
  const r = parseYaml(src, ctx);
  if (r.ok) return [];
  return r.errors.map((e) => e.code);
}

describe('parseYaml: worked examples (§15)', () => {
  it('15.1 paper-ball shot', () => {
    const r = ok(PAPER_BALL_YAML);
    expect(r.program).toStrictEqual(PAPER_BALL_AST);
    expect(r.warnings).toEqual([]);
  });

  it('15.2 cup tower (UNUSED_ENTITY warning for the fan)', () => {
    const r = ok(CUP_TOWER_YAML);
    expect(r.program).toStrictEqual(CUP_TOWER_AST);
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([['UNUSED_ENTITY', 'entities.fan']]);
  });

  it('15.3 push-ups (participants default to the 2-member huddle)', () => {
    expect(ok(PUSHUPS_YAML).program).toStrictEqual(PUSHUPS_AST);
  });

  it('15.4 ai_judged', () => {
    expect(ok(AI_JUDGED_YAML).program).toStrictEqual(AI_JUDGED_AST);
  });

  it('ai_judged: true synonym', () => {
    const src = AI_JUDGED_YAML.replace('kind: ai_judged', 'ai_judged: true');
    expect(ok(src).program).toStrictEqual(AI_JUDGED_AST);
    expect(codes(AI_JUDGED_YAML.replace('kind: ai_judged', 'kind: rules\nai_judged: true'))).toContain('BAD_KIND');
  });

  it('canonicalize is idempotent and needs no context for canonical input', () => {
    for (const ast of [PAPER_BALL_AST, CUP_TOWER_AST, PUSHUPS_AST, AI_JUDGED_AST]) {
      const p = ast as Program;
      expect(canonicalize(p)).toStrictEqual(p);
      expect(canonicalize(canonicalize(p, CTX2), CTX2)).toStrictEqual(p);
      expect(validateProgram(p, CTX2).errors).toEqual([]);
    }
  });
});

describe('toYaml round trip (§2.9)', () => {
  it('parseYaml(toYaml(p)) equals p for the worked examples', () => {
    for (const ast of [PAPER_BALL_AST, CUP_TOWER_AST, PUSHUPS_AST, AI_JUDGED_AST]) {
      const y = toYaml(ast as Program);
      expect(ok(y).program).toStrictEqual(ast);
    }
  });

  it('emits canonical key order, base58 persons, separators-free ints, full parentheses', () => {
    const y = toYaml(PAPER_BALL_AST as Program);
    expect(y).toBe(`version: 2
kind: rules
participants:
  - ${CREATOR}
  - ${FRIEND}
sides: [0, 1]
entities:
  shooter: person(${FRIEND})
  ball: object("crumpled paper ball")
  can: object("trash can")
  line: region(line)
legs:
  - id: 1
    actor_bound: true
    valid_attempt: ball released_by shooter and shooter behind line
    success: ball disappears_into can.opening or (ball inside can and ball at_rest 1s)
    rule: count(success) >= 1 within attempts 3
    attempt_window_s: 5s
outcome: side(B) wins iff leg 1; else side(A)
stake_each: 5000000
time_limit_s: 180
`);
  });

  it('round-trips precedence-sensitive and exotic expressions', () => {
    const exprs = [
      'not ball moving for_duration 2s',
      'ball present then_within 2.5s can present and anyone present',
      'ball present or can present and anyone present',
      'ball present or can present or anyone present',
      '(ball present or can present) and not (anyone present)',
      'ball near can 700 and ball near area',
      'near(ball, can, 0) or at_rest(ball, 100ms) or speed(ball) > 300',
      'ball direction up while ball speed != 0',
      '(ball moving before_deadline 3s) for_duration 1.5s',
      'not not ball present',
      'ball enters can.interior then_within 1s ball leaves area',
      'ball crosses mark or ball beyond mark or ball behind mark',
      'ball touches anyone and ball overlaps can and ball above can and ball below area',
      'ball disappears_into can',
      'standing(anyone) and anyone standing and rep_count(anyone) == 3',
    ];
    for (const s of exprs) {
      const src = `version: 2
entities:
  ball: object("ball")
  can: object("can")
  area: region(zone)
  mark: region(tap)
  anyone: person(any)
legs:
  - id: 1
    actor_bound: false
    success: ${s}
    rule: success
outcome: side(A) wins iff leg 1; else side(B)
stake_each: 1000000
`;
      const p1 = ok(src).program;
      const p2 = ok(toYaml(p1)).program;
      expect(p2, s).toStrictEqual(p1);
    }
  });

  it('round-trips a side-only person and a 4-participant program with explicit sides', () => {
    const src = `version: 2
participants: [${CREATOR}, ${FRIEND}, ${THIRD}]
sides: {A: [${CREATOR}, sam], B: [maya]}
entities:
  maya: person("maya")
  sam: person(p2)
  cup: object("Red   Cup ")
legs:
  - id: 1
    actor_bound: true
    success: cup inside sam
    rule: success before_deadline 10s
  - id: 2
    actor_bound: false
    success: cup present
    rule: count(success) > 2
outcome: side(maya) wins iff leg 1 false and (leg 2 or not leg 1); else side(other)
stake_each: 20_000
`;
    const p = ok(src, CTX4).program;
    expect(p.participants).toEqual([CREATOR, FRIEND, THIRD]);
    expect(p.sides).toEqual([0, 1, 0]);
    expect(p.entities[0]).toEqual({ name: 'maya', kind: 'person', participant: 1 });
    expect(p.entities[2]).toEqual({ name: 'cup', kind: 'object', phrase: 'red cup' });
    expect(p.outcome).toEqual({
      if_true: 1,
      condition: {
        op: 'and',
        args: [
          { op: 'not', arg: { op: 'leg', id: 1 } },
          { op: 'or', args: [{ op: 'leg', id: 2 }, { op: 'not', arg: { op: 'leg', id: 1 } }] },
        ],
      },
      else: 0,
    });
    expect(p.time_limit_s).toBe(120);
    const y = toYaml(p);
    expect(y).toContain('outcome: side(maya) wins iff');
    expect(ok(y, CTX4).program).toStrictEqual(p);
  });

  it('quotes scalars that would not survive as plain YAML', () => {
    const p = { ...(AI_JUDGED_AST as Program), question: 'Who wins: me or you? #1' };
    const y = toYaml(p);
    expect(y).toContain('question: "Who wins: me or you? #1"');
    expect(ok(y).program).toStrictEqual(p);
  });
});

describe('parseYaml: surface syntax', () => {
  it('accepts _ separators and multi-line plain scalars', () => {
    const p = ok(PAPER_BALL_YAML).program;
    expect(p.stake_each).toBe(5_000_000);
  });

  it('rejects unknown keys, bad versions and YAML syntax errors', () => {
    expect(codes(PAPER_BALL_YAML + 'colour: red\n')).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('version: 2', 'version: 3'))).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('version: 2\n', ''))).toEqual(['PARSE_ERROR']);
    expect(codes('version: 2\n  bad: [\n')).toContain('PARSE_ERROR');
    expect(codes('- 1\n- 2\n')).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('    rule:', '    colour: red\n    rule:'))).toEqual(['PARSE_ERROR']);
  });

  it('rejects duplicate keys', () => {
    expect(codes(PAPER_BALL_YAML.replace('  can:     object("trash can")', '  can: object("trash can")\n  can: object("bin")'))).toEqual([
      'PARSE_ERROR',
    ]);
  });

  it('rejects malformed integers', () => {
    expect(codes(PAPER_BALL_YAML.replace('5_000_000', '5_00_000'))).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('5_000_000', '-5'))).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('5_000_000', '5.5'))).toEqual(['PARSE_ERROR']);
  });

  it('reports expression parse errors with path and 1-based column', () => {
    const r = parseYaml(PAPER_BALL_YAML.replace('rule: count(success) >= 1 within attempts 3', 'rule: count(success) >= 1 within 3'), CTX2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ path: 'legs[0].rule', code: 'PARSE_ERROR', col: 28 });
  });

  it('rejects bad entity names and values', () => {
    expect(codes(PAPER_BALL_YAML.replace('  ball:    object', '  Ball:    object'))).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('  can:     object("trash can")', '  near: object("trash can")'))).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('object("trash can")', 'thing("trash can")'))).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('object("trash can")', 'object("trash can!")'))).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('region(tap)', 'region(circle)'))).toEqual(['PARSE_ERROR']);
  });

  it('requires actor_bound on every leg', () => {
    expect(codes(PAPER_BALL_YAML.replace('    actor_bound: true\n', ''))).toEqual(['PARSE_ERROR']);
  });

  it('attempt_window_s parses durations', () => {
    const p = ok(PAPER_BALL_YAML.replace('    rule:', '    attempt_window_s: 2.5s\n    rule:')).program;
    expect(p.legs[0]!.attempt_window_frames).toBe(25);
    expect(codes(PAPER_BALL_YAML.replace('    rule:', '    attempt_window_s: 5\n    rule:'))).toEqual(['PARSE_ERROR']);
    expect(codes(PAPER_BALL_YAML.replace('    rule:', '    attempt_window_s: 0s\n    rule:'))).toEqual(['LIMIT']);
    expect(codes(PAPER_BALL_YAML.replace('    rule:', '    attempt_window_s: 3601s\n    rule:'))).toEqual(['LIMIT']);
    expect(ok(PAPER_BALL_YAML.replace('    rule:', '    attempt_window_s: 3600s\n    rule:')).program.legs[0]!.attempt_window_frames).toBe(36000);
  });
});

describe('persons, participants and sides (§2.4)', () => {
  const persons = (decl: string, ctx = CTX4): ReturnType<typeof parseYaml> =>
    parseYaml(
      `version: 2
entities:
  who: ${decl}
legs:
  - id: 1
    actor_bound: true
    success: who standing
    rule: success
outcome: side(who) wins iff leg 1; else side(other)
stake_each: 10000
`,
      ctx,
    );

  it('resolves base58, pN and display-name forms to the same participant', () => {
    for (const d of [`person(${FRIEND})`, 'person(p1)', 'person("Maya")', 'person("mAYA")']) {
      const r = persons(d);
      expect(r.ok, d).toBe(true);
      if (r.ok) {
        expect(r.program.participants).toEqual([CREATOR, FRIEND]);
        expect(r.program.entities[0]).toEqual({ name: 'who', kind: 'person', participant: 1 });
      }
    }
  });

  it('UNKNOWN_PARTICIPANT for unknown members', () => {
    for (const d of ['person(p7)', 'person("Nobody")', 'person(11111111111111111111111111111111)']) {
      const r = persons(d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(['UNKNOWN_PARTICIPANT']);
    }
  });

  it('NOT_ENROLLED for an unenrolled member', () => {
    const r = persons('person(p3)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(['NOT_ENROLLED']);
  });

  it('person(p0) with a larger huddle: creator only → PARTICIPANTS_UNRESOLVED', () => {
    const r = persons('person(p0)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(['PARTICIPANTS_UNRESOLVED']);
  });

  it('person(p0) with a 2-member huddle defaults to both members', () => {
    const r = persons('person(p0)', CTX2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.program.participants).toEqual([CREATOR, FRIEND]);
  });

  it('default participants follow huddle join order, not declaration order', () => {
    const r = parseYaml(
      `version: 2
participants: [${CREATOR}, ${THIRD}, ${FRIEND}]
sides: [0, 1, 1]
entities:
  sam: person(p2)
  maya: person(p1)
legs:
  - id: 1
    actor_bound: true
    success: sam near maya
    rule: success
outcome: side(A) wins iff leg 1; else side(B)
stake_each: 10000
`,
      CTX4,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.program.entities.map((e) => (e.kind === 'person' ? e.participant : -1))).toEqual([1, 2]);
    const r2 = parseYaml(
      `version: 2
sides: [0, 1, 1]
entities:
  sam: person(p2)
  maya: person(p1)
legs:
  - id: 1
    actor_bound: true
    success: sam near maya
    rule: success
outcome: side(A) wins iff leg 1; else side(B)
stake_each: 10000
`,
      CTX4,
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.program.participants).toEqual([CREATOR, FRIEND, THIRD]);
      expect(r2.program.entities.map((e) => (e.kind === 'person' ? e.participant : -1))).toEqual([2, 1]);
    }
  });

  it('DUPLICATE_PERSON', () => {
    expect(
      codes(
        `version: 2
entities:
  a: person(p1)
  b: person("Maya")
legs:
  - id: 1
    actor_bound: true
    success: a near b
    rule: success
outcome: side(A) wins iff leg 1; else side(B)
stake_each: 10000
`,
      ),
    ).toEqual(['DUPLICATE_PERSON']);
  });

  it('sides: required with > 2 participants; validated otherwise', () => {
    const base = `version: 2
participants: [${CREATOR}, ${FRIEND}, ${THIRD}]
SIDES
entities:
  ball: object("ball")
legs:
  - id: 1
    actor_bound: false
    success: ball present
    rule: success
outcome: side(A) wins iff leg 1; else side(B)
stake_each: 10000
`;
    expect(codes(base.replace('SIDES\n', ''), CTX4)).toEqual(['BAD_SIDES']);
    expect(codes(base.replace('SIDES', 'sides: [1, 0, 0]'), CTX4)).toEqual(['BAD_SIDES']);
    expect(codes(base.replace('SIDES', 'sides: [0, 0, 0]'), CTX4)).toEqual(['BAD_SIDES']);
    expect(codes(base.replace('SIDES', 'sides: [0, 1]'), CTX4)).toEqual(['BAD_SIDES']);
    expect(codes(base.replace('SIDES', 'sides: [0, 1, 2]'), CTX4)).toEqual(['BAD_SIDES']);
    expect(codes(base.replace('SIDES', `sides: {A: [${CREATOR}], B: [${FRIEND}]}`), CTX4)).toEqual(['BAD_SIDES']);
    expect(codes(base.replace('SIDES', `sides: {A: [${CREATOR}], B: [${FRIEND}, ${THIRD}, ${FRIEND}]}`), CTX4)).toEqual(['BAD_SIDES']);
    expect(codes(base.replace('SIDES', `sides: {A: [${CREATOR}], B: [${FRIEND}, Sam]}`), CTX4)).toEqual(['UNKNOWN_PARTICIPANT']);
    expect(codes(base.replace('SIDES', `sides: {A: [${CREATOR}], B: [${FRIEND}, ball]}`), CTX4)).toEqual(['BAD_SIDES']);
    expect(codes(base.replace('SIDES', `sides: {A: [${CREATOR}], C: [${FRIEND}, ${THIRD}]}`), CTX4)).toEqual(['BAD_SIDES']);
    const r = parseYaml(base.replace('SIDES', `sides: {A: [${CREATOR}, ${THIRD}], B: [${FRIEND}]}`), CTX4);
    expect(r.ok && r.program.sides).toEqual([0, 1, 0]);
  });

  it('participants: membership, count, creator first, distinct', () => {
    const base = `version: 2
participants: PARTS
entities:
  ball: object("ball")
legs:
  - id: 1
    actor_bound: false
    success: ball present
    rule: success
outcome: side(A) wins iff leg 1; else side(B)
stake_each: 10000
`;
    expect(codes(base.replace('PARTS', `[${CREATOR}]`))).toEqual(['LIMIT']);
    expect(codes(base.replace('PARTS', `[${FRIEND}, ${CREATOR}]`))).toEqual(['UNKNOWN_PARTICIPANT']);
    expect(codes(base.replace('PARTS', `[${CREATOR}, ${THIRD}]`))).toEqual(['UNKNOWN_PARTICIPANT']);
    expect(codes(base.replace('PARTS', `[${CREATOR}, ${CREATOR}]`))).toEqual(['UNKNOWN_PARTICIPANT']);
  });

  it('person entity not among explicit participants → UNKNOWN_PARTICIPANT', () => {
    expect(
      codes(
        `version: 2
participants: [${CREATOR}, ${FRIEND}]
entities:
  sam: person(p2)
legs:
  - id: 1
    actor_bound: true
    success: sam standing
    rule: success
outcome: side(A) wins iff leg 1; else side(B)
stake_each: 10000
`,
        CTX4,
      ),
    ).toEqual(['UNKNOWN_PARTICIPANT']);
  });

  it('UNUSED_PERSON for a person used by no leg and no side', () => {
    expect(
      codes(
        `version: 2
entities:
  ball: object("ball")
  maya: person(p1)
legs:
  - id: 1
    actor_bound: false
    success: ball present
    rule: success
outcome: side(A) wins iff leg 1; else side(B)
stake_each: 10000
`,
      ),
    ).toEqual(['UNUSED_PERSON']);
  });

  it('a person used only in side(...) is fine and does not make legs actor-bound', () => {
    const r = parseYaml(
      `version: 2
entities:
  ball: object("ball")
  maya: person(p1)
legs:
  - id: 1
    actor_bound: false
    success: ball present
    rule: success
outcome: side(maya) wins iff leg 1; else side(creator)
stake_each: 10000
`,
      CTX2,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.program.outcome).toEqual({ if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 });
  });

  it('outcome side errors', () => {
    const o = (s: string): string[] => codes(PUSHUPS_YAML.replace('outcome: side(me) wins iff leg 1 true; else side(other)', `outcome: ${s}`));
    expect(o('side(other) wins iff leg 1; else side(other)')).toEqual(['BAD_OUTCOME']);
    expect(o('side(me) wins iff leg 1; else side(creator)')).toEqual(['BAD_OUTCOME']);
    expect(o('side(A) wins iff leg 1; else side(A)')).toEqual(['BAD_OUTCOME']);
    expect(o('side(nobody) wins iff leg 1; else side(B)')).toEqual(['UNKNOWN_ENTITY']);
    expect(o('side(A) wins iff leg 2; else side(B)')).toEqual(['BAD_OUTCOME']);
    expect(o('side(A) wins iff yes; else side(B)')).toEqual(['BAD_OUTCOME']);
    expect(o('side(A) wins if leg 1; else side(B)')).toEqual(['PARSE_ERROR']);
    expect(o('side(other) wins iff leg 1; else side(B)')).toEqual([]);
  });

  it('side(person_any) is a BAD_OUTCOME', () => {
    expect(
      codes(`version: 2
entities:
  x: person(any)
legs:
  - id: 1
    actor_bound: false
    success: x standing
    rule: success
outcome: side(x) wins iff leg 1; else side(other)
stake_each: 10000
`),
    ).toEqual(['BAD_OUTCOME']);
  });
});
