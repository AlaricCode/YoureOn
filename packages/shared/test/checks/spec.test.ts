// SAM 3.1 camera checks, design final.md §1 + §6: the CheckSpec schema, its lints, the canonical
// order, and the fixed-template readback.
import { describe, expect, it } from 'vitest';
import { jcs } from '../../src/jcs';
import {
  type Assertion,
  canonicalizeCheckSpec,
  CheckSpec,
  describeChecks,
  plural,
  READBACK_MAX_CHARS,
  subjectKeys,
} from '../../src/checks/spec';

const v = (e: string, window = 'end') => ({ p: 'visible', e, window });

/** The 10 example bets (final_examples.txt); 4 (coin) is checks: null. */
const EXAMPLES: Record<string, unknown> = {
  '1 bottle flip': {
    predicates: 'p1',
    entities: [{ key: 'bottle', prompt: 'bottle', count: 1 }],
    assertions: [
      { role: 'gate', test: v('bottle') },
      { role: 'need', test: { p: 'at_rest', e: 'bottle', ref: null } },
      { role: 'need', test: { p: 'upright', e: 'bottle' } },
    ],
  },
  '2a hoop': {
    predicates: 'p1',
    entities: [{ key: 'hoop', prompt: 'basketball hoop', count: 1 }],
    assertions: [{ role: 'gate', test: v('hoop', 'landing') }],
  },
  '2b bin': {
    predicates: 'p1',
    entities: [
      { key: 'ball', prompt: 'ball', count: 1 },
      { key: 'bin', prompt: 'bin', count: 1 },
    ],
    assertions: [
      { role: 'gate', test: v('bin') },
      { role: 'need', test: { p: 'ends_at', a: 'ball', b: 'bin' } },
    ],
  },
  '3 cups': {
    predicates: 'p1',
    entities: [
      { key: 'cup', prompt: 'cup', count: 3 },
      { key: 'table', prompt: 'table', count: 1 },
    ],
    assertions: [
      { role: 'gate', test: v('table') },
      { role: 'need', test: { p: 'at_rest', e: 'cup', ref: 'table' } },
      { role: 'need', test: { p: 'stacked', e: 'cup' } },
    ],
  },
  '5 paper': {
    predicates: 'p1',
    entities: [
      { key: 'can', prompt: 'trash can', count: 1 },
      { key: 'paper', prompt: 'paper ball', count: 1 },
    ],
    assertions: [
      { role: 'gate', test: v('can') },
      { role: 'need', test: { p: 'ends_at', a: 'paper', b: 'can' } },
    ],
  },
  '6 spoon': {
    predicates: 'p1',
    entities: [
      { key: 'face', prompt: 'face', count: 1 },
      { key: 'spoon', prompt: 'spoon', count: 1 },
    ],
    assertions: [
      { role: 'gate', test: v('face', 'landing') },
      { role: 'need', test: { p: 'touching', a: 'spoon', b: 'face', window: 'last_3s' } },
    ],
  },
  '7 cans': {
    predicates: 'p1',
    entities: [
      { key: 'can', prompt: 'can', count: 3 },
      { key: 'table', prompt: 'table', count: 1 },
    ],
    assertions: [
      { role: 'gate', test: v('can', 'start') },
      { role: 'gate', test: v('table') },
      { role: 'need', test: { p: 'moved_from_start', e: 'can', of: 'all', ref: 'table' } },
    ],
  },
  '8 chair': {
    predicates: 'p1',
    entities: [
      { key: 'chair', prompt: 'chair', count: 1 },
      { key: 'person', prompt: 'person', count: 1 },
    ],
    assertions: [
      { role: 'gate', test: v('chair') },
      { role: 'need', test: { p: 'switched_sides', a: 'person', b: 'chair' } },
    ],
  },
  '9 grape': {
    predicates: 'p1',
    entities: [
      { key: 'face', prompt: 'face', count: 1 },
      { key: 'grape', prompt: 'grape', count: 1 },
    ],
    assertions: [
      { role: 'gate', test: v('face') },
      { role: 'need', test: { p: 'ends_at', a: 'grape', b: 'face' } },
    ],
  },
  '10 frisbee': {
    predicates: 'p1',
    entities: [
      { key: 'frisbee', prompt: 'frisbee', count: 1 },
      { key: 'table', prompt: 'table', count: 1 },
    ],
    assertions: [
      { role: 'gate', test: v('table') },
      { role: 'need', test: { p: 'on_top', a: 'frisbee', b: 'table' } },
      { role: 'need', test: { p: 'at_rest', e: 'frisbee', ref: 'table' } },
    ],
  },
};

const BOTTLE = EXAMPLES['1 bottle flip'] as CheckSpec;
const clone = <T>(x: T): T => structuredClone(x);
/** Canonicalize, then report the lint messages (empty when it parses). */
function issues(s: unknown, canonical = true): string[] {
  const input = canonical ? canonicalizeCheckSpec(s as CheckSpec) : s;
  const r = CheckSpec.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}
const spec = (entities: [string, string, number][], assertions: [string, object][]) => ({
  predicates: 'p1',
  entities: entities.map(([key, prompt, count]) => ({ key, prompt, count })),
  assertions: assertions.map(([role, test]) => ({ role, test })),
});

describe('CheckSpec: the example specs (§6, final_examples.txt)', () => {
  it.each(Object.entries(EXAMPLES))('%s parses as written (canonical order), <= 0.6 KB', (_, s) => {
    expect(CheckSpec.safeParse(s).success).toBe(true);
    expect(jcs(s).length).toBeLessThanOrEqual(600);
    expect(jcs(canonicalizeCheckSpec(s as CheckSpec))).toBe(jcs(s));
  });

  it('canonicalizeCheckSpec: any order of the same meaning gives the same bytes', () => {
    for (const s of Object.values(EXAMPLES) as CheckSpec[]) {
      const shuffled = {
        ...s,
        entities: [...s.entities].reverse(),
        assertions: [...s.assertions].reverse(),
      };
      expect(jcs(canonicalizeCheckSpec(shuffled))).toBe(jcs(s));
    }
  });

  it('subjects are the e/a of non-visible predicates; refs and visible-only keys are not', () => {
    expect([...subjectKeys(EXAMPLES['3 cups'] as CheckSpec)]).toEqual(['cup']);
    expect([...subjectKeys(EXAMPLES['2a hoop'] as CheckSpec)]).toEqual([]);
    expect([...subjectKeys(EXAMPLES['8 chair'] as CheckSpec)]).toEqual(['person']);
  });
});

describe('CheckSpec lints (§6)', () => {
  it('strict: an unknown key anywhere is rejected', () => {
    const top = { ...clone(BOTTLE), extra: 1 };
    const ent = clone(BOTTLE) as { entities: object[] };
    ent.entities[0] = { ...ent.entities[0], id: 0 };
    const pred = clone(BOTTLE) as { assertions: object[] };
    pred.assertions[1] = {
      role: 'need',
      test: { p: 'upright', e: 'bottle', tolerance: 'roughly' },
    };
    for (const s of [top, ent, pred]) expect(CheckSpec.safeParse(s).success).toBe(false);
  });

  it('no optional keys: a missing ref is rejected (absence is an explicit null)', () => {
    const s = clone(BOTTLE) as { assertions: { test: Record<string, unknown> }[] };
    delete s.assertions[1]!.test.ref;
    expect(CheckSpec.safeParse(s).success).toBe(false);
  });

  it('prompts are 1-4 lowercase words; keys are a-z0-9_', () => {
    for (const prompt of ['Bottle', 'upright bottle on the table', 'bottle!', ''])
      expect(issues(spec([['b', prompt, 1]], [['gate', v('b')]])).length).toBeGreaterThan(0);
    expect(issues(spec([['Bottle', 'bottle', 1]], [['gate', v('Bottle')]])).length).toBeGreaterThan(
      0,
    );
    expect(issues(spec([['b', "trash can's lid", 1]], [['gate', v('b')]]))).toEqual([]);
  });

  it('a != b', () => {
    const s = spec(
      [['x', 'ball', 1]],
      [['need', { p: 'touching', a: 'x', b: 'x', window: 'end' }]],
    );
    expect(issues(s)).toContain('a and b must differ');
  });

  it('ref != e, and a ref has count 1', () => {
    expect(
      issues(spec([['b', 'bottle', 1]], [['need', { p: 'at_rest', e: 'b', ref: 'b' }]])),
    ).toContain('ref must differ from e');
    expect(
      issues(
        spec(
          [
            ['b', 'bottle', 1],
            ['t', 'table', 2],
          ],
          [['need', { p: 'at_rest', e: 'b', ref: 't' }]],
        ),
      ),
    ).toContain('ref must be a count-1 entity');
  });

  it('only visible can be a gate', () => {
    expect(issues(spec([['b', 'bottle', 1]], [['gate', { p: 'upright', e: 'b' }]]))).toContain(
      "only 'visible' can be a gate",
    );
  });

  it('gates are optional', () => {
    expect(issues(spec([['b', 'bottle', 1]], [['need', { p: 'upright', e: 'b' }]]))).toEqual([]);
  });

  it('count > 1 only in visible / at_rest / moved_from_start / stacked', () => {
    const two = (t: object) =>
      issues(
        spec(
          [
            ['c', 'cup', 3],
            ['t', 'table', 1],
          ],
          [['need', t]],
        ),
      );
    expect(two({ p: 'upright', e: 'c' })).toContain('upright needs count-1 entities');
    expect(two({ p: 'touching', a: 'c', b: 't', window: 'end' })).toContain(
      'touching needs count-1 entities',
    );
    expect(two({ p: 'on_top', a: 't', b: 'c' })).toContain('on_top needs count-1 entities');
    expect(two({ p: 'stacked', e: 'c' }).filter((m) => m.includes('count'))).toEqual([]);
    expect(two({ p: 'at_rest', e: 'c', ref: 't' })).toEqual([]);
  });

  it('stacked needs count >= 2', () => {
    expect(issues(spec([['c', 'cup', 1]], [['need', { p: 'stacked', e: 'c' }]]))).toContain(
      'stacked needs count >= 2',
    );
  });

  it("moved_from_start on a count-1 entity must use of: 'all'", () => {
    const t = (of: string) => ({ p: 'moved_from_start', e: 'c', of, ref: null });
    expect(issues(spec([['c', 'can', 1]], [['need', t('any')]]))).toContain("count 1 => of: 'all'");
    expect(issues(spec([['c', 'can', 1]], [['need', t('all')]]))).toEqual([]);
    expect(issues(spec([['c', 'can', 3]], [['need', t('any')]]))).toEqual([]);
  });

  it('the a of an ends_at is never gated at end or landing (start is fine)', () => {
    const ents: [string, string, number][] = [
      ['g', 'grape', 1],
      ['f', 'face', 1],
    ];
    const ends: [string, object] = ['need', { p: 'ends_at', a: 'g', b: 'f' }];
    for (const w of ['end', 'landing'])
      expect(issues(spec(ents, [['gate', v('g', w)], ends])).join()).toContain(
        'never gate it at end/landing',
      );
    expect(issues(spec(ents, [['gate', v('g', 'start')], ends]))).toEqual([]);
  });

  it('every assertion key resolves; every entity is used', () => {
    expect(issues(spec([['b', 'bottle', 1]], [['gate', v('x')]]))).toContain("unknown entity 'x'");
    expect(
      issues(
        spec(
          [
            ['b', 'bottle', 1],
            ['t', 'table', 1],
          ],
          [['gate', v('b')]],
        ),
      ),
    ).toContain("entity 't' is unused");
  });

  it('non-canonical order is rejected (canonicalizeCheckSpec fixes it)', () => {
    const s = clone(BOTTLE) as { assertions: Assertion[] };
    s.assertions.reverse();
    expect(issues(s, false)).toContain('not canonical (run canonicalizeCheckSpec)');
    expect(issues(s)).toEqual([]);
    const e = spec(
      [
        ['t', 'table', 1],
        ['b', 'bottle', 1],
      ],
      [
        ['gate', v('b')],
        ['gate', v('t')],
      ],
    );
    expect(issues(e, false)).toContain('not canonical (run canonicalizeCheckSpec)');
  });

  it('duplicate prompts, keys and assertions are rejected', () => {
    expect(
      issues(
        spec(
          [
            ['a', 'cup', 1],
            ['b', 'cup', 1],
          ],
          [
            ['gate', v('a')],
            ['gate', v('b')],
          ],
        ),
      ),
    ).toContain('duplicate prompt (SAM rejects them)');
    expect(
      issues(
        spec(
          [
            ['a', 'cup', 1],
            ['a', 'mug', 1],
          ],
          [['gate', v('a')]],
        ),
      ),
    ).toContain('duplicate entity key');
    expect(
      issues(
        spec(
          [['a', 'cup', 1]],
          [
            ['gate', v('a')],
            ['gate', v('a')],
          ],
        ),
      ),
    ).toContain('duplicate assertion');
  });

  it('at most 3 entities and 6 assertions; at least 1 of each; count 1..6', () => {
    const four = spec(
      [
        ['a', 'cup', 1],
        ['b', 'mug', 1],
        ['c', 'can', 1],
        ['d', 'jar', 1],
      ],
      ['a', 'b', 'c', 'd'].map((k) => ['gate', v(k)] as [string, object]),
    );
    expect(issues(four).length).toBeGreaterThan(0);
    const seven = spec(
      [
        ['a', 'cup', 1],
        ['b', 'mug', 1],
      ],
      [
        ['gate', v('a', 'start')],
        ['gate', v('a', 'end')],
        ['gate', v('a', 'landing')],
        ['gate', v('b', 'start')],
        ['gate', v('b', 'end')],
        ['gate', v('b', 'landing')],
        ['need', { p: 'upright', e: 'a' }],
      ],
    );
    expect(issues(seven).length).toBeGreaterThan(0);
    expect(issues({ ...seven, assertions: seven.assertions.slice(0, 6) })).toEqual([]);
    expect(issues(spec([['a', 'cup', 1]], [])).length).toBeGreaterThan(0);
    expect(issues(spec([['a', 'cup', 7]], [['gate', v('a')]])).length).toBeGreaterThan(0);
    expect(issues(spec([['a', 'cup', 0]], [['gate', v('a')]])).length).toBeGreaterThan(0);
  });

  it("predicates must be the literal 'p1'", () => {
    expect(CheckSpec.safeParse({ ...clone(BOTTLE), predicates: 'p2' }).success).toBe(false);
  });
});

describe('describeChecks (§1 readback)', () => {
  it('the bottle flip, from fixed templates', () => {
    expect(describeChecks(BOTTLE)).toBe(
      'Ref cam: the bottle fully in shot at the end; the bottle comes to rest; the bottle stands upright. Film from the side. If the ref cam is offline, the judge decides alone.',
    );
  });

  it('null spec: judge only', () => {
    expect(describeChecks(null)).toBe('Judge only, no ref cam.');
  });

  it('subject vs reference wording, plurals and hold hints', () => {
    expect(describeChecks(EXAMPLES['3 cups'] as CheckSpec)).toContain('the table in shot');
    expect(describeChecks(EXAMPLES['3 cups'] as CheckSpec)).toContain('all 3 cups come to rest');
    expect(describeChecks(EXAMPLES['6 spoon'] as CheckSpec)).toContain(
      "Stop filming while it's still balanced.",
    );
    expect(describeChecks(EXAMPLES['6 spoon'] as CheckSpec)).toContain('for the last 3 seconds');
    expect(plural('glass')).toBe('glasses');
    expect(plural('cherry')).toBe('cherries');
  });

  it('always <= 400 chars, even for the largest spec', () => {
    for (const s of Object.values(EXAMPLES))
      expect(describeChecks(s as CheckSpec).length).toBeLessThanOrEqual(READBACK_MAX_CHARS);
    const long = (w: string) => `${w}aaaaaaaa bbbbbbbbbb cccccccccc dddddd`;
    const big = canonicalizeCheckSpec(
      spec(
        [
          ['a', long('a'), 1],
          ['b', long('b'), 1],
          ['c', long('c'), 3],
        ],
        [
          ['gate', v('b', 'landing')],
          ['need', { p: 'switched_sides', a: 'a', b: 'b' }],
          ['need', { p: 'touching', a: 'a', b: 'b', window: 'last_5s' }],
          ['need', { p: 'on_top', a: 'a', b: 'b' }],
          ['need', { p: 'upright', e: 'a' }],
          ['need', { p: 'stacked', e: 'c' }],
        ],
      ) as CheckSpec,
    );
    const parsed = CheckSpec.parse(big);
    const text = describeChecks(parsed);
    expect(text.length).toBeLessThanOrEqual(READBACK_MAX_CHARS);
    expect(text).toContain('and more');
  });
});
