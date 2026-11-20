// A throw at a target: the object tracker decides whether it went in, the vision judge is the
// cheat detector (judge/ruling applyThrowOutcome, judge/camera-checks samPromptFor/throwEntities).
import { describe, expect, it } from 'vitest';
import { CheckSpec } from '@youre-on/shared/checks/spec';
import { toOutcome } from '@youre-on/shared/ruling';

import { samPromptFor, throwEntities } from '../src/judge/camera-checks';
import { applyThrowOutcome, THROW_MODEL, type Judged } from '../src/judge/ruling';

const LABELS = { object: 'paper ball', target: 'bin' };
const IN = { call: 'in' as const, why: 'gone_at_the_mouth', frames: [5, 6], last_seen: 6 };
const OUT = { call: 'out' as const, why: 'rests_outside', frames: [9, 10, 11], last_seen: 11 };

const vision = (
  claim: 'MET' | 'NOT_MET' | 'UNCLEAR',
  rule: { broken: boolean; note: string } | null,
): Judged => ({
  kind: 'verdict',
  model: 'anthropic/claude-sonnet-5-5',
  verdict: {
    claim_result: claim,
    confidence: 0.55,
    reason: "I can't confirm the result.",
    cited_frames: [],
    contested: false,
  },
  disagreement: null,
  rule,
});

const verdictOf = (j: Judged) => {
  if (j.kind !== 'verdict') throw new Error('expected a verdict');
  return j;
};

describe('applyThrowOutcome', () => {
  it('the track says it went in and no rule was broken: MET, whatever the vision judge thought', () => {
    // the real case: the vision judge voided a make ("I never see it land inside")
    const j = verdictOf(
      applyThrowOutcome(vision('UNCLEAR', { broken: false, note: '' }), IN, LABELS),
    );
    expect(j.verdict.claim_result).toBe('MET');
    expect(j.verdict.reason).toBe(
      "The paper ball went in: tracked from the throw to the bin's rim in frame 6, and it is in no frame after.",
    );
    expect(j.verdict.cited_frames).toEqual([5, 6]);
    expect(toOutcome(j.verdict, 'B')).toBe('B_WINS');
    expect(j.thrown).toEqual({ call: 'in', why: 'gone_at_the_mouth' });
    expect(j.veto).toBeNull();
  });

  it('it went in but a rule was broken: NOT_MET, and the reason says both', () => {
    const j = verdictOf(
      applyThrowOutcome(
        vision('MET', { broken: true, note: 'Logan stepped past the boot before he threw.' }),
        IN,
        LABELS,
      ),
    );
    expect(j.verdict.claim_result).toBe('NOT_MET');
    expect(j.verdict.reason).toBe(
      "The paper ball went in, tracked to the bin's rim in frame 6. But Logan stepped past the boot before he threw, so it does not count.",
    );
    expect(toOutcome(j.verdict, 'B')).toBe('A_WINS');
  });

  it('the track says it missed: NOT_MET; a broken rule is added, never invented', () => {
    const clean = verdictOf(
      applyThrowOutcome(vision('UNCLEAR', { broken: false, note: '' }), OUT, LABELS),
    );
    expect(clean.verdict.claim_result).toBe('NOT_MET');
    expect(clean.verdict.reason).toBe(
      'The paper ball missed: tracked to the floor outside the bin, still there in frame 11.',
    );
    expect(clean.verdict.reason).not.toMatch(/rule|boot/);
    const cheat = verdictOf(
      applyThrowOutcome(
        vision('MET', { broken: true, note: 'He threw from in front of the boot.' }),
        OUT,
        LABELS,
      ),
    );
    expect(cheat.verdict.reason).toBe(
      'The paper ball missed: tracked to the floor outside the bin in frame 11. Also, he threw from in front of the boot.',
    );
  });

  it('a vision call that failed: the track alone decides, under its own model id', () => {
    const failed: Judged = {
      kind: 'failure',
      model: 'anthropic/x',
      status: 'timeout',
      message: 'slow',
    };
    const j = verdictOf(applyThrowOutcome(failed, IN, LABELS));
    expect(j.model).toBe(THROW_MODEL);
    expect(j.verdict.claim_result).toBe('MET');
    expect(j.rule).toBeNull();
  });

  it('an older verdict with no rule finding counts as no rule broken', () => {
    expect(
      verdictOf(applyThrowOutcome(vision('UNCLEAR', null), IN, LABELS)).verdict.claim_result,
    ).toBe('MET');
  });

  it('every reason fits the ruling record', () => {
    const long = 'x'.repeat(200);
    for (const t of [IN, OUT]) {
      const j = verdictOf(
        applyThrowOutcome(vision('MET', { broken: true, note: long }), t, LABELS),
      );
      expect(j.verdict.reason.length).toBeLessThanOrEqual(280);
    }
  });
});

describe('the SAM prompt for a thrown object', () => {
  it('a small thrown thing named for what it is gets its look', () => {
    // on real frames SAM found nothing for these names and tracked "small white object"
    for (const p of ['paper ball', 'ball', 'crumpled paper', 'paper towel ball', 'tissue'])
      expect(samPromptFor(p, true), p).toBe('small white object');
  });

  it('other things, and anything that is not the thrown object, keep their prompt', () => {
    expect(samPromptFor('bottle', true)).toBe('bottle');
    expect(samPromptFor('can', true)).toBe('can');
    expect(samPromptFor('paper ball', false)).toBe('paper ball');
    expect(samPromptFor('bin', false)).toBe('bin');
  });

  it('throwEntities: the ends_at need names the thrown object and the target', () => {
    const spec = CheckSpec.parse({
      entities: [
        { key: 'bin', count: 1, prompt: 'bin' },
        { key: 'paper', count: 1, prompt: 'paper ball' },
      ],
      assertions: [
        { role: 'gate', test: { e: 'bin', p: 'visible', window: 'end' } },
        { role: 'need', test: { a: 'paper', b: 'bin', p: 'ends_at' } },
      ],
      predicates: 'p1',
    });
    expect(throwEntities(spec)).toEqual({ object: 'paper', target: 'bin' });
    expect(
      throwEntities({ ...spec, assertions: spec.assertions.filter((a) => a.role === 'gate') }),
    ).toBeNull();
  });
});
