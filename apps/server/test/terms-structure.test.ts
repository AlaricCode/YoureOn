// src/terms/structure.ts: a typed or spoken sentence becomes structured terms through one model
// call, and never blocks a bet when that call is not available. The regression: with the voice
// judge down, "let's do a challenge where I have to throw a paper ball into a trash trashcan"
// became the claim verbatim, with the OTHER player as the one who throws.
import { describe, expect, it } from 'vitest';
import { typedTermsArgs, typedTermsRequest } from '@youre-on/shared/judge/typed-terms';
import { evaluateProposeTerms } from '@youre-on/shared/judge/reply';
import type { ChatRequest, ChatResult, LlmProvider } from '../src/providers/types';
import {
  needsStructuring,
  STRUCTURE_OUTPUT,
  STRUCTURE_SYSTEM,
  StructuredClaim,
  structureClaim,
  usableClaim,
} from '../src/terms/structure';

const SAID = "let's do a challenge where I have to throw a paper ball into a trash trashcan";

const GOOD: StructuredClaim = {
  claim: 'Logan throws a paper ball into the trash can',
  performer: 'A',
  yes_party: 'A',
  success_criteria: ['The paper ball goes into the trash can and stays in.'],
  failure_criteria: ['The ball misses, or bounces out of the trash can.'],
  edge_cases: [
    { question: 'Does it count if it bounces off the rim and in?', answer: 'Yes. In is in.' },
  ],
};

type Chat = (req: ChatRequest<unknown>) => Promise<ChatResult<unknown>>;
const ok =
  (value: unknown): Chat =>
  async (req) => ({
    ok: true,
    vendor: req.vendor,
    model: req.model ?? 'm',
    latency_ms: 1,
    value,
    text: JSON.stringify(value),
  });

function depsWith(chat: Chat, name: 'live' | 'mock' = 'live') {
  const logs: { level: string; msg: string; data: unknown }[] = [];
  const calls: ChatRequest<unknown>[] = [];
  const llm = {
    name,
    chat: (req: ChatRequest<unknown>) => {
      calls.push(req);
      return chat(req);
    },
  } as unknown as LlmProvider;
  const log = {
    info: (msg: string, data: unknown) => void logs.push({ level: 'info', msg, data }),
    warn: (msg: string, data: unknown) => void logs.push({ level: 'warn', msg, data }),
  };
  const deps = {
    providers: { llm },
    env: { TERMS_MODEL: 'claude-haiku-5-5' },
    log,
  } as unknown as Parameters<typeof structureClaim>[0];
  return { deps, logs, calls };
}

const input = { said: SAID, aName: 'Logan', bName: 'Eva', betId: 'bet-1' };

describe('needsStructuring', () => {
  it('is true for a sentence the phone sent as its own only success condition', () => {
    expect(needsStructuring(typedTermsRequest({ claim: SAID, stakeUsd: 5, bName: 'Eva' }))).toBe(
      true,
    );
    expect(needsStructuring({ claim: SAID, amount_usd: '5' })).toBe(true);
    // whitespace and case do not hide it
    expect(
      needsStructuring({
        claim: 'Eva  makes it',
        amount_usd: '5',
        success_criteria: ['eva makes it'],
      }),
    ).toBe(true);
  });

  it('is false for terms that already have their own criteria, and for a market bet', () => {
    const flip = typedTermsRequest({
      claim: 'Eva lands a water bottle flip upright on the table. One try.',
      stakeUsd: 5,
      bName: 'Eva',
    });
    expect(flip.success_criteria!.length).toBeGreaterThan(1);
    expect(needsStructuring(flip)).toBe(false);
    expect(
      needsStructuring({
        claim: 'Eva makes it',
        amount_usd: '5',
        success_criteria: ['It goes in.'],
      }),
    ).toBe(false);
    expect(needsStructuring({ claim: 'BTC closes up', amount_usd: '5', type: 'real_world' })).toBe(
      false,
    );
  });
});

describe('usableClaim', () => {
  it('keeps third-person terms and ends the claim with a period', () => {
    expect(usableClaim(GOOD)!.claim).toBe('Logan throws a paper ball into the trash can.');
    expect(usableClaim({ ...GOOD, claim: 'Eva makes the shot.' })!.claim).toBe(
      'Eva makes the shot.',
    );
  });

  it('keeps at most two lines of each for the card, whatever the model sent', () => {
    const long = usableClaim({
      ...GOOD,
      success_criteria: ['one thing', 'two things', 'three things', 'four things'],
      failure_criteria: ['first foul', 'second foul', 'third foul'],
      edge_cases: [
        { question: 'First question?', answer: 'Yes.' },
        { question: 'Second question?', answer: 'No.' },
        { question: 'Third question?', answer: 'No.' },
      ],
    })!;
    expect(long.success_criteria).toEqual(['one thing', 'two things']);
    expect(long.failure_criteria).toEqual(['first foul', 'second foul']);
    expect(long.edge_cases.map((e) => e.question)).toEqual(['First question?', 'Second question?']);
  });

  it('refuses a claim that is still the sentence', () => {
    for (const claim of [
      'I throw a paper ball into the trash can.',
      "Let's do a challenge with a paper ball.",
      "Bet you can't make the shot.",
      'Logan throws my paper ball into the bin.',
    ])
      expect(usableClaim({ ...GOOD, claim }), claim).toBeNull();
  });
});

describe('structureClaim', () => {
  it('asks the fast model once, with both names and the sentence, and returns the terms', async () => {
    const { deps, calls, logs } = depsWith(ok(GOOD));
    const out = await structureClaim(deps, input);
    expect(out).toMatchObject({ performer: 'A', yes_party: 'A' });
    expect(out!.claim).toBe('Logan throws a paper ball into the trash can.');
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req).toMatchObject({ vendor: 'anthropic', model: 'claude-haiku-5-5', effort: 'low' });
    expect(req.thinking).toBe('disabled');
    expect(req.system).toBe(STRUCTURE_SYSTEM);
    expect(req.output).toBe(STRUCTURE_OUTPUT);
    const part = req.parts[0] as { kind: 'text'; text: string };
    expect(JSON.parse(part.text.replace(/^BET /, ''))).toEqual({
      party_a: 'Logan',
      party_b: 'Eva',
      said: SAID,
    });
    expect(logs.at(-1)).toMatchObject({ level: 'info', msg: 'terms.structured' });
  });

  it('does nothing off the live provider (tests, a dev server): no call, no spend', async () => {
    const { deps, calls } = depsWith(ok(GOOD), 'mock');
    expect(await structureClaim(deps, input)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null, never a throw, on a failed call, a throw, a timeout or unusable output', async () => {
    const failed = depsWith(async (req) => ({
      ok: false,
      vendor: req.vendor,
      model: 'm',
      latency_ms: 1,
      status: 'error',
      message: 'boom',
    }));
    expect(await structureClaim(failed.deps, input)).toBeNull();
    expect(failed.logs.at(-1)).toMatchObject({ level: 'warn', msg: 'terms.structure_failed' });

    const threw = depsWith(async () => {
      throw new Error('network');
    });
    expect(await structureClaim(threw.deps, input)).toBeNull();

    const slow = depsWith(() => new Promise(() => undefined));
    expect(await structureClaim(slow.deps, input, { timeoutMs: 20 })).toBeNull();
    expect(slow.logs.at(-1)).toMatchObject({
      msg: 'terms.structure_failed',
      data: { status: 'timeout' },
    });

    const firstPerson = depsWith(ok({ ...GOOD, claim: 'I throw a paper ball into the bin.' }));
    expect(await structureClaim(firstPerson.deps, input)).toBeNull();
  });
});

describe('the output schema and the prompt', () => {
  it('accepts the good terms and refuses malformed ones', () => {
    expect(StructuredClaim.safeParse(GOOD).success).toBe(true);
    expect(StructuredClaim.safeParse({ ...GOOD, performer: 'none' }).success).toBe(false);
    expect(StructuredClaim.safeParse({ ...GOOD, success_criteria: [] }).success).toBe(false);
    expect(StructuredClaim.safeParse({ ...GOOD, edge_cases: [] }).success).toBe(false);
    expect(StructuredClaim.safeParse({ ...GOOD, claim: 'x'.repeat(201) }).success).toBe(false);
  });

  it('names every field of the schema it sends, and the rules that went wrong before', () => {
    const props = STRUCTURE_OUTPUT.jsonSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(Object.keys(StructuredClaim.shape).sort());
    expect(STRUCTURE_OUTPUT.jsonSchema.required).toEqual(Object.keys(props));
    for (const field of Object.keys(props)) expect(STRUCTURE_SYSTEM).toContain(field);
    // who "I" is, and that nothing is added to what was asked
    expect(STRUCTURE_SYSTEM).toContain('"I" and "me" are party A');
    expect(STRUCTURE_SYSTEM).toContain(
      'no distance, count, number of tries, time limit or difficulty',
    );
    // short lines for a phone, and nothing about the clip (the first prompt let "six seconds"
    // into an edge case, which would have changed the bet)
    expect(STRUCTURE_SYSTEM).toContain('At most 90 characters');
    expect(STRUCTURE_SYSTEM).toContain('never mention the camera, the clip, the footage');
    expect(STRUCTURE_SYSTEM).not.toMatch(/six seconds|6 seconds/);
  });

  it('gives terms that pass the same checks as any proposal, complete', () => {
    const base = typedTermsRequest({ claim: SAID, stakeUsd: 5, bName: 'Eva' });
    const before = evaluateProposeTerms(typedTermsArgs(base), { realWorldEnabled: false });
    const after = evaluateProposeTerms(typedTermsArgs({ ...base, ...usableClaim(GOOD)! }), {
      realWorldEnabled: false,
    });
    expect(before.kind).toBe('proposal');
    expect(after.kind).toBe('proposal');
    if (after.kind !== 'proposal') return;
    expect(after.missing).toEqual([]);
    expect(after.proposal).toMatchObject({
      claim: 'Logan throws a paper ball into the trash can.',
      performer: 'A',
      yes_party: 'A',
    });
  });
});
