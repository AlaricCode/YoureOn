// TASKS D0-J3 deterministic checks: fixtures validate, the propose_terms projection maps into
// TermsProposal per API-CONTRACT §4.3, the guardrail prefilter refuses per category, and every
// tool reply stays under 300 B.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GuardrailRefusal, RefusalCategory, TermsProposal } from '../../src/negotiation';
import { FIXTURE_COUNTS, SpokenBetFixture } from '../../src/judge/fixture-schema';
import {
  mapProposeTermsArgs,
  PROPOSE_TERMS_BODY_SCHEMA,
  ProposeTermsArgs,
  type ElProperty,
} from '../../src/judge/propose-terms';
import { matchRefusalCategory, prefilterRefusal, REFUSAL_QUIPS } from '../../src/judge/guardrails';
import {
  evaluateProposeTerms,
  fitReply,
  proposeTermsReply,
  readbackSay,
  SAY_MAX_CHARS,
  spokenUsd,
  TOOL_REPLY_MAX_BYTES,
} from '../../src/judge/reply';
import { buildJudgePrompt, FIRST_MESSAGE, renderPersona } from '../../src/judge/persona';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, '../../src/judge/fixtures');
const files = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
const raw = files.map((f) => ({
  file: f,
  json: JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as unknown,
}));
const fixtures = raw.map(({ json }) => SpokenBetFixture.parse(json));
const byteLen = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).length;

const BOTTLE = fixtures.find((f) => f.id === '01-bottle-flip')!.sample_args;
const withIds = (args: object) => ({
  conversation_id: 'conv_123',
  bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
  ...args,
});

describe('fixtures (D0-J3)', () => {
  it('there are 12: 8 benign (2 need clarification) and 4 refusals, one per BRIEF 5c category', () => {
    expect(fixtures).toHaveLength(FIXTURE_COUNTS.total);
    const kinds = fixtures.map((f) => f.kind);
    expect(kinds.filter((k) => k === 'benign')).toHaveLength(FIXTURE_COUNTS.benign);
    expect(kinds.filter((k) => k === 'clarify')).toHaveLength(FIXTURE_COUNTS.clarify);
    expect(fixtures.filter((f) => f.kind !== 'refusal')).toHaveLength(8);
    const cats = fixtures.filter((f) => f.kind === 'refusal').map((f) => f.refusal_category);
    expect(cats.sort()).toEqual(['alcohol_drugs', 'dangerous', 'minors', 'self_harm']);
  });

  it('file names match ids, and every fixture allows at most 2 clarifying questions', () => {
    for (const [i, f] of fixtures.entries()) {
      expect(files[i]).toBe(`${f.id}.json`);
      expect(f.max_questions).toBeLessThanOrEqual(2);
    }
  });

  it('the schema rejects a malformed fixture (strict keys, refusal without category)', () => {
    const ok = raw[0]!.json as Record<string, unknown>;
    expect(SpokenBetFixture.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      SpokenBetFixture.safeParse({ ...ok, kind: 'refusal', refusal_category: null }).success,
    ).toBe(false);
    expect(SpokenBetFixture.safeParse({ ...ok, max_questions: 3 }).success).toBe(false);
  });

  for (const f of fixtures.filter((x) => x.kind !== 'refusal')) {
    it(`${f.id}: sample_args maps to expected_proposal, a valid TermsProposal, ok:true`, () => {
      const m = mapProposeTermsArgs(f.sample_args);
      expect(m).toEqual({ ok: true, proposal: f.expected_proposal });
      expect(TermsProposal.safeParse(f.expected_proposal).success).toBe(true);
      expect(prefilterRefusal(f.expected_proposal!)).toBeNull();
      const ev = evaluateProposeTerms(withIds(f.sample_args), { realWorldEnabled: true });
      expect(ev.kind).toBe('proposal');
      const reply = proposeTermsReply(ev, { rev: 1 });
      expect(reply.ok).toBe(true);
      expect(reply.next).toBe(
        f.sample_args.edge_cases.length || f.sample_args.type === 'real_world' ? 'readback' : 'ask',
      );
      expect(byteLen(reply)).toBeLessThanOrEqual(TOOL_REPLY_MAX_BYTES);
      // checks agree with the expected proposal (they grade the live LLM run)
      const p = f.expected_proposal!;
      const c = f.checks!;
      expect([p.type, p.performer, p.yes_party, p.amount]).toEqual([
        c.type,
        c.performer,
        c.yes_party,
        c.amount,
      ]);
      if (c.attempts) expect(p.attempts).toEqual(c.attempts);
      if (c.market_side) expect(p.market_query?.a_side).toBe(c.market_side);
      for (const kw of c.edge_case_mentions ?? [])
        expect(
          p.edge_cases.some((e) => `${e.question} ${e.answer}`.toLowerCase().includes(kw)),
        ).toBe(true);
    });
  }

  for (const f of fixtures.filter((x) => x.kind === 'refusal')) {
    it(`${f.id}: refused as ${f.refusal_category} with a PG-13 quip, inline`, () => {
      const ev = evaluateProposeTerms(withIds(f.sample_args));
      expect(ev.kind).toBe('refused');
      if (ev.kind !== 'refused') return;
      expect(ev.refusal.category).toBe(f.refusal_category);
      expect(GuardrailRefusal.safeParse(ev.refusal).success).toBe(true);
      const reply = proposeTermsReply(ev);
      expect(reply).toEqual({
        ok: false,
        refused: f.refusal_category,
        say: REFUSAL_QUIPS[f.refusal_category!],
        next: 'end',
      });
      expect(byteLen(reply)).toBeLessThanOrEqual(TOOL_REPLY_MAX_BYTES);
    });
  }
});

describe('propose_terms projection (API-CONTRACT §4.3)', () => {
  it('body schema: required list and properties exactly as specified, ids from dynamic variables', () => {
    expect(PROPOSE_TERMS_BODY_SCHEMA.required).toEqual([
      'type',
      'claim',
      'performer',
      'yes_party',
      'attempts',
      'success_criteria',
      'failure_criteria',
      'edge_cases',
      'amount_usd',
      'market_side',
      'deadline_minutes',
    ]);
    expect(Object.keys(PROPOSE_TERMS_BODY_SCHEMA.properties)).toEqual([
      'conversation_id',
      'bet_id',
      ...PROPOSE_TERMS_BODY_SCHEMA.required,
    ]);
    expect(PROPOSE_TERMS_BODY_SCHEMA.properties.conversation_id).toEqual({
      type: 'string',
      dynamic_variable: 'system__conversation_id',
    });
    expect(PROPOSE_TERMS_BODY_SCHEMA.properties.bet_id).toEqual({
      type: 'string',
      dynamic_variable: 'bet_id',
    });
  });

  it('uses only the ElevenLabs subset (no pattern, min/max, nullable)', () => {
    const allowed = new Set([
      'type',
      'description',
      'enum',
      'properties',
      'required',
      'items',
      'dynamic_variable',
    ]);
    const walk = (p: ElProperty) => {
      for (const k of Object.keys(p)) expect(allowed.has(k)).toBe(true);
      if (p.type === 'object') Object.values(p.properties).forEach(walk);
      if (p.type === 'array') walk(p.items);
      if ('enum' in p && p.enum) expect(p.enum.every((e) => typeof e === 'string')).toBe(true);
      // ElevenLabs: dynamic_variable and description are mutually exclusive
      if ('dynamic_variable' in p && p.dynamic_variable) expect('description' in p).toBe(false);
    };
    walk(PROPOSE_TERMS_BODY_SCHEMA);
  });

  it('maps: normText, none->null, parseUsd, evidence_source, market_query, deadline 0->null, asked_by', () => {
    const m = mapProposeTermsArgs({
      ...BOTTLE,
      claim: '  Jake   lands a water bottle flip upright on the table. ',
      amount_usd: '$5.2',
      deadline_minutes: 15,
    });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.proposal.claim).toBe('Jake lands a water bottle flip upright on the table.');
    expect(m.proposal.amount).toBe('5200000');
    expect(m.proposal.deadline_minutes).toBe(15);
    expect(m.proposal.evidence_source).toBe('camera');
    expect(m.proposal.market_query).toBeNull();
    expect(m.proposal.edge_cases.every((e) => e.asked_by === 'judge')).toBe(true);
  });

  it('strips stray keys from the agent instead of failing (SCHEMAS §3)', () => {
    const m = mapProposeTermsArgs(
      withIds({ ...BOTTLE, confidence: 0.9, attempts: { ...BOTTLE.attempts, note: 'x' } }),
    );
    expect(m.ok).toBe(true);
  });

  it('a __proto__ key in the body cannot smuggle fields past the parse', () => {
    const { claim: _claim, ...rest } = BOTTLE;
    const body = JSON.parse(
      `{"__proto__": {"claim": "Jake lands it."}, ${JSON.stringify(rest).slice(1)}`,
    );
    expect(mapProposeTermsArgs(body).ok).toBe(false);
  });

  it.each([
    ['attempts: single with count 3', { attempts: { count: 3, rule: 'single' } }, 'attempts'],
    ['attempts: best_of even', { attempts: { count: 2, rule: 'best_of' } }, 'attempts'],
    ['attempts: unknown rule', { attempts: { count: 1, rule: 'once' } }, 'attempts.rule'],
    ['no success criteria', { success_criteria: [] }, 'success_criteria'],
    [
      '6 success criteria',
      { success_criteria: ['a', 'b', 'c', 'd', 'e', 'f'] },
      'success_criteria',
    ],
    ['empty claim', { claim: '   ' }, 'claim'],
    ['claim too long', { claim: 'x'.repeat(201) }, 'claim'],
    ['5 edge cases', { edge_cases: Array(5).fill({ question: 'q?', answer: 'a.' }) }, 'edge_cases'],
    ['skill with performer none', { performer: 'none' }, 'performer'],
    [
      'real_world with market_side none',
      { type: 'real_world', performer: 'none', market_side: 'none' },
      'market_query.a_side',
    ],
    [
      'real_world best_of',
      {
        type: 'real_world',
        performer: 'none',
        market_side: 'YES',
        yes_party: 'A',
        attempts: { count: 3, rule: 'best_of' },
      },
      'attempts',
    ],
    [
      'real_world yes_party vs side',
      { type: 'real_world', performer: 'none', market_side: 'NO', yes_party: 'A' },
      'yes_party',
    ],
    ['performer enum', { performer: 'C' }, 'performer'],
    ['float count', { attempts: { count: 1.5, rule: 'single' } }, 'attempts.count'],
  ])('rejects %s', (_name, patch, path) => {
    const m = mapProposeTermsArgs({ ...BOTTLE, ...patch });
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.issues.map((i) => i.path)).toContain(path);
  });

  it('amount and deadline problems become DraftIssues the judge can speak', () => {
    const bad = evaluateProposeTerms({ ...BOTTLE, amount_usd: 'five' });
    expect(bad).toMatchObject({ kind: 'issue', issue: { code: 'AMBIGUOUS' } });
    const far = evaluateProposeTerms({ ...BOTTLE, deadline_minutes: 60 });
    expect(proposeTermsReply(far)).toMatchObject({ ok: false, fix: 'DEADLINE_TOO_FAR' });
  });

  it('over-cap is a counter-proposal, not a refusal (SCHEMAS §3)', () => {
    const ev = evaluateProposeTerms({ ...BOTTLE, amount_usd: '50' });
    expect(proposeTermsReply(ev)).toEqual({
      ok: false,
      fix: 'STAKE_ABOVE_MAX',
      say: 'Max is twenty dollars a person.',
    });
    expect(
      proposeTermsReply(evaluateProposeTerms({ ...BOTTLE, amount_usd: '0.05' })),
    ).toMatchObject({ fix: 'STAKE_BELOW_MIN' });
    expect(evaluateProposeTerms({ ...BOTTLE, amount_usd: '20' }).kind).toBe('proposal');
    // a lower server cap (MAX_STAKE_MICRO) is honoured
    expect(
      evaluateProposeTerms({ ...BOTTLE, amount_usd: '15' }, { maxStake: 10_000_000n }),
    ).toMatchObject({ issue: { code: 'STAKE_ABOVE_MAX' } });
  });

  it('a refusal outranks every other answer, also when the call does not parse', () => {
    const unsafe = { ...BOTTLE, claim: 'Jake chugs a beer.', amount_usd: '50' };
    expect(evaluateProposeTerms(unsafe).kind).toBe('refused');
    expect(evaluateProposeTerms({ claim: 'Jake chugs a beer.' })).toMatchObject({
      kind: 'refused',
      refusal: { category: 'alcohol_drugs' },
    });
  });

  it('real_world gets NO_MARKET until the market service is enabled', () => {
    const btc = fixtures.find((f) => f.id === '08-btc-closer')!.sample_args;
    expect(proposeTermsReply(evaluateProposeTerms(btc))).toMatchObject({
      ok: false,
      fix: 'NO_MARKET',
    });
    expect(evaluateProposeTerms(btc, { realWorldEnabled: true }).kind).toBe('proposal');
  });

  it('ProposeTermsArgs requires the dynamic-variable ids', () => {
    expect(ProposeTermsArgs.safeParse(BOTTLE).success).toBe(false);
    expect(ProposeTermsArgs.safeParse(withIds(BOTTLE)).success).toBe(true);
  });
});

describe('guardrail prefilter (SCHEMAS §3, BRIEF 5c)', () => {
  it.each<[string, string | null]>([
    ['Jake lands a water bottle flip upright on the table.', null],
    ['Logan makes a bank shot from the free-throw line.', null],
    ['Jake gets a high score on the arcade machine.', null],
    ['Jake flips a Diet Coke bottle onto its cap.', null],
    ['Jake takes a shot from half court.', null],
    ['Logan does a backflip on the grass.', null],
    ['Jake jumps off the roof into the pool.', 'dangerous'],
    ['Jake holds his breath for two minutes.', 'dangerous'],
    ['Jake eats a Tide Pod.', 'dangerous'],
    ['Jake drinks three shots of vodka.', 'alcohol_drugs'],
    ['Jake smokes a joint in one breath.', 'alcohol_drugs'],
    ['Jake gets high before the test.', 'alcohol_drugs'],
    ['Jake burns himself with a lighter.', 'self_harm'],
    ['Jake goes without food for three days.', 'self_harm'],
    ['My 12-year-old cousin beats Jake at chess.', 'minors'],
    ['A kid chugs a beer.', 'minors'],
    // ASR spells ages out (review fix)
    ["Logan's twelve-year-old brother beats Jake at arm wrestling.", 'minors'],
    ['My cousin, a fifteen year old, outruns Jake.', 'minors'],
    ["Jake's nephew, he's twelve, beats him at chess.", 'minors'],
    ['A 9yr old beats Jake at checkers.', 'minors'],
    ["Jake is five for five at free throws, he's ten for ten today.", null],
    ['Jake lands a flip from twelve feet away.', null],
    ['Jake steals a candy bar from the store.', 'illegal'],
    ['Jake kisses a stranger on the street.', 'other'],
  ])('%s -> %s', (text, cat) => {
    expect(matchRefusalCategory(text)).toBe(cat);
  });

  it('every category has a valid quip (NText 140, PG-13 one-liner)', () => {
    for (const c of RefusalCategory.options) {
      expect(
        GuardrailRefusal.safeParse({ refused: true, category: c, quip: REFUSAL_QUIPS[c] }).success,
      ).toBe(true);
      expect(REFUSAL_QUIPS[c].length).toBeLessThanOrEqual(140);
    }
  });

  it('scans edge cases and criteria too, not just the claim', () => {
    expect(
      prefilterRefusal({ ...mapOk(BOTTLE), failure_criteria: ['Spilling the beer.'] })?.category,
    ).toBe('alcohol_drugs');
  });
});

describe('replies (API-CONTRACT §4.2)', () => {
  it('the Beat 2 read-back is a server template over the proposal', () => {
    expect(readbackSay(mapOk(BOTTLE))).toBe(
      'Jake lands a water bottle flip upright on the table. One try. No. Only upright on its base counts. One flip. Five dollars each.',
    );
  });

  it('say stays within 200 chars and replies within 300 B even with long fields', () => {
    const long = mapOk({
      ...BOTTLE,
      claim: `Jake ${'really '.repeat(26)}lands it.`,
      edge_cases: Array(4).fill({
        question: 'q?',
        answer: 'A rule that is quite long and keeps going for a while.',
      }),
      deadline_minutes: 30,
    });
    const say = readbackSay(long);
    expect(say.length).toBeLessThanOrEqual(SAY_MAX_CHARS);
    const reply = proposeTermsReply(
      { kind: 'proposal', proposal: long, missing: [] },
      { rev: 12, code: '0586·0f0a' },
    );
    expect(byteLen(reply)).toBeLessThanOrEqual(TOOL_REPLY_MAX_BYTES);
    const invalid = proposeTermsReply({
      kind: 'invalid',
      issues: Array(10).fill({ path: 'success_criteria.0', message: 'x'.repeat(80) }),
    });
    expect(byteLen(invalid)).toBeLessThanOrEqual(TOOL_REPLY_MAX_BYTES);
    expect(fitReply({ ok: true, say: 'é'.repeat(400) })).toSatisfy(
      (r: object) => byteLen(r) <= TOOL_REPLY_MAX_BYTES,
    );
  });

  it('missing edge cases on a skill bet -> next ask (≤ 2 questions total is the prompt rule)', () => {
    const ev = evaluateProposeTerms({ ...BOTTLE, edge_cases: [] });
    expect(proposeTermsReply(ev, { rev: 1 })).toMatchObject({
      ok: true,
      rev: 1,
      missing: ['edge_cases'],
      next: 'ask',
    });
  });

  it('spoken amounts', () => {
    expect(spokenUsd('5000000')).toBe('five dollars');
    expect(spokenUsd('20000000')).toBe('twenty dollars');
    expect(spokenUsd('1000000')).toBe('one dollar');
    expect(spokenUsd('100000')).toBe('ten cents');
    expect(spokenUsd('5200000')).toBe('$5.20');
  });
});

describe('persona (D0-J3)', () => {
  it('states the §4.1 prompt rules and the refusal categories', () => {
    const p = buildJudgePrompt(
      new Set(['propose_terms', 'confirm_terms', 'request_attempt', 'cue']),
    );
    for (const s of [
      'one or two word reaction',
      'at most 2 edge-case questions',
      '[EVENT]',
      'never say money moved',
      'hold the button',
      'propose_terms',
      'confirm_terms',
    ])
      expect(p).toContain(s);
    for (const c of RefusalCategory.options) expect(p).toContain(`- ${c}:`);
    // tools that are not registered are not mentioned
    expect(p).not.toContain('open_hearing');
    expect(p).not.toContain('file_appeal');
  });

  it('the spoken accept is theatre even before confirm_terms is registered (§4.1)', () => {
    const p = buildJudgePrompt(new Set(['propose_terms']));
    expect(p).toContain('is theatre');
    expect(p).toContain('hold the button on their own phone');
    expect(p).not.toContain('confirm_terms');
    expect(buildJudgePrompt(new Set(['propose_terms', 'confirm_terms']))).toContain(
      'call confirm_terms with who you heard',
    );
  });

  it('a refused confirm (INVITE_PENDING) is spoken and retried, never claimed as locked', () => {
    const p = buildJudgePrompt(new Set(['propose_terms', 'confirm_terms']));
    expect(p).toContain('If confirm_terms answers ok false, speak its "say" and wait');
    expect(p).toContain('INVITE_PENDING');
    // B's tap arrives as an [EVENT] line (bets/invite.ts), the judge's cue to call it again.
    expect(p).toContain('"[EVENT] INVITE_ACCEPTED" tells you when they have');
    expect(buildJudgePrompt(new Set(['propose_terms']))).not.toContain('INVITE_PENDING');
  });

  it('dynamic variables render', () => {
    expect(renderPersona(FIRST_MESSAGE, { party_a_name: 'Logan', party_b_name: 'Jake' })).toBe(
      "Order. Court is in session. Logan, Jake: what's the bet?",
    );
  });
});

function mapOk(args: object): TermsProposal {
  const m = mapProposeTermsArgs(args);
  if (!m.ok) throw new Error(JSON.stringify(m.issues));
  return m.proposal;
}
