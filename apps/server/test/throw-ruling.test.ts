// A throw at a target is ruled from two indicators (judge/ruling decideThrow): did it go in (the
// object tracker, and ONLY the tracker) and was a rule broken (the vision judge's rule_broken).
// The reason is written from them in code. The vision judge never decides in or out.
import { describe, expect, it } from 'vitest';
import { CheckSpec } from '@youre-on/shared/checks/spec';
import { toOutcome } from '@youre-on/shared/ruling';

import { samPromptFor, throwEntities } from '../src/judge/camera-checks';
import { JudgeVerdict } from '../src/judge/checks';
import { JUDGE_SYSTEM_PROMPT, JUDGE_VERDICT_JSON_SCHEMA } from '../src/judge/prompt';
import { decideThrow, THROW_MODEL, type Judged } from '../src/judge/ruling';

const LABELS = { object: 'paper ball', target: 'bin' };
const IN = { call: 'in' as const, why: 'gone_at_the_mouth', frames: [5, 6], last_seen: 6 };
const OUT = { call: 'out' as const, why: 'rests_outside', frames: [9, 10, 11], last_seen: 11 };
const UNKNOWN = {
  call: 'unknown' as const,
  why: 'lost_away_from_target',
  frames: [],
  last_seen: 7,
};
const CLEAN = { broken: false, note: '' };
const STEPPED = { broken: true, note: 'Logan stepped past the boot before he threw.' };

/** A vision verdict whose own claim and free text must never reach a throw's ruling. */
const vision = (
  claim: 'MET' | 'NOT_MET' | 'UNCLEAR',
  rule: { broken: boolean; note: string } | null,
): Judged => ({
  kind: 'verdict',
  model: 'anthropic/claude-sonnet-5-5',
  verdict: {
    claim_result: claim,
    confidence: 0.9,
    reason: 'The ball leaves his hand toward the counter. His foot is close to the line.',
    cited_frames: [5, 7],
    contested: false,
  },
  disagreement: null,
  rule,
});

const verdictOf = (j: Judged) => {
  if (j.kind !== 'verdict') throw new Error('expected a verdict');
  return j;
};

describe('decideThrow: the tracker says where it went', () => {
  it('in and no rule broken: MET, whatever the vision judge wrote', () => {
    // the real case: the vision judge voided a make ("I never see it land inside")
    const j = verdictOf(decideThrow(vision('UNCLEAR', CLEAN), IN, LABELS));
    expect(j.verdict.claim_result).toBe('MET');
    expect(j.verdict.reason).toBe(
      'The paper ball went in (tracked to frame 6). No rule was broken.',
    );
    expect(j.verdict.cited_frames).toEqual([5, 6]);
    expect(j.verdict.confidence).toBe(0.92);
    expect(toOutcome(j.verdict, 'B')).toBe('B_WINS');
    expect(j.thrown).toEqual({ call: 'in', why: 'gone_at_the_mouth' });
  });

  it('in but a rule was broken: NOT_MET, and the reason says both', () => {
    // the real case (bet e9ec7f78): it went in and he stepped over the line
    const j = verdictOf(decideThrow(vision('NOT_MET', STEPPED), IN, LABELS));
    expect(j.verdict.claim_result).toBe('NOT_MET');
    expect(j.verdict.reason).toBe(
      'The paper ball went in (tracked to frame 6), but Logan stepped past the boot before he threw, so it does not count.',
    );
    expect(toOutcome(j.verdict, 'B')).toBe('A_WINS');
  });

  it('out: NOT_MET; a broken rule is added, never invented', () => {
    const clean = verdictOf(decideThrow(vision('UNCLEAR', CLEAN), OUT, LABELS));
    expect(clean.verdict.claim_result).toBe('NOT_MET');
    expect(clean.verdict.reason).toBe(
      'The paper ball missed the bin (tracked to frame 11). No rule was broken.',
    );
    const cheat = verdictOf(
      decideThrow(
        vision('MET', { broken: true, note: 'He threw from in front of the boot.' }),
        OUT,
        LABELS,
      ),
    );
    expect(cheat.verdict.reason).toBe(
      'The paper ball missed the bin (tracked to frame 11). Also, he threw from in front of the boot.',
    );
  });

  it("the vision judge's own claim never changes the result", () => {
    // it wrote NOT_MET ("toward the counter"); the track says in and no rule was broken
    expect(verdictOf(decideThrow(vision('NOT_MET', CLEAN), IN, LABELS)).verdict.claim_result).toBe(
      'MET',
    );
    // it wrote MET; the track says out
    expect(verdictOf(decideThrow(vision('MET', CLEAN), OUT, LABELS)).verdict.claim_result).toBe(
      'NOT_MET',
    );
  });

  it('a vision call that failed: the track alone decides, under its own model id', () => {
    const failed: Judged = {
      kind: 'failure',
      model: 'anthropic/x',
      status: 'timeout',
      message: 'slow',
    };
    const j = verdictOf(decideThrow(failed, IN, LABELS));
    expect(j.model).toBe(THROW_MODEL);
    expect(j.verdict.claim_result).toBe('MET');
  });
});

describe('decideThrow: the tracker cannot say', () => {
  it('no rule broken: a retake, never the vision judge deciding in or out', () => {
    for (const claim of ['MET', 'NOT_MET', 'UNCLEAR'] as const) {
      for (const track of [UNKNOWN, null]) {
        const j = verdictOf(decideThrow(vision(claim, CLEAN), track, LABELS));
        expect(j.verdict.claim_result, `${claim}`).toBe('UNCLEAR');
        expect(j.verdict.reason).toBe(
          'The tracker could not follow the paper ball to the bin. Run it back.',
        );
        expect(toOutcome(j.verdict, 'B')).toBe('REDO');
      }
    }
    expect(verdictOf(decideThrow(vision('MET', CLEAN), UNKNOWN, LABELS)).thrown).toEqual({
      call: 'unknown',
      why: 'lost_away_from_target',
    });
    expect(verdictOf(decideThrow(vision('MET', CLEAN), null, LABELS)).thrown).toEqual({
      call: 'unknown',
      why: 'no_reply',
    });
  });

  it('a rule seen broken loses on its own, wherever the ball went', () => {
    const j = verdictOf(decideThrow(vision('MET', STEPPED), UNKNOWN, LABELS));
    expect(j.verdict.claim_result).toBe('NOT_MET');
    expect(j.verdict.reason).toBe(
      'Logan stepped past the boot before he threw, so it does not count.',
    );
    expect(toOutcome(j.verdict, 'B')).toBe('A_WINS');
  });

  it('the vision call failed too: a retake', () => {
    const failed: Judged = {
      kind: 'failure',
      model: 'anthropic/x',
      status: 'timeout',
      message: 'slow',
    };
    const j = verdictOf(decideThrow(failed, null, LABELS));
    expect(j.verdict.claim_result).toBe('UNCLEAR');
  });

  it('every reason fits the ruling record', () => {
    const long = { broken: true, note: 'x'.repeat(200) };
    for (const t of [IN, OUT, UNKNOWN, null])
      expect(
        verdictOf(decideThrow(vision('MET', long), t, LABELS)).verdict.reason.length,
      ).toBeLessThanOrEqual(280);
  });
});

describe('the vision judge is only the cheat detector for a throw', () => {
  it('its answer carries the rule flag and no field for whether the object went in', () => {
    const props = Object.keys(JUDGE_VERDICT_JSON_SCHEMA.properties);
    expect(props).toContain('rule_broken');
    expect(props).toContain('rule_note');
    expect(props).not.toContain('object_result');
    expect(Object.keys(JudgeVerdict.shape)).not.toContain('object_result');
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/rule_broken: true when the frames show a rule/);
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/"Close to the line" is not an answer/);
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
