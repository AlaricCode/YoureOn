// compile_checks (design final.md §1 "Compilation", §9): the few-shot data, the generated prompt
// and its version, the wire JSON schema, the held-out eval set, and the compiler with a fake LLM
// (no network, no key).
import { describe, expect, it } from 'vitest';
import { jcs } from '@youre-on/shared/jcs';
import { CompileInput, fromTerms } from '@youre-on/shared/checks/compile';
import {
  canonicalizeCheckSpec,
  CheckSpec,
  describeChecks,
  GATE_PREDICATES,
  MIN_COUNT_2_PREDICATES,
  MULTI_COUNT_PREDICATES,
  Predicate,
  READBACK_MAX_CHARS,
  type PredicateName,
} from '@youre-on/shared/checks/spec';
import { Terms } from '@youre-on/shared/terms';
import { skillTerms } from '../../../packages/shared/test/fixtures';
import { loadEnv } from '../src/env';
import { silentLogger } from '../src/log';
import { MockLlm, type MockReply } from '../src/providers/mock/llm';
import { createProviders } from '../src/providers/registry';
import type { ChatRequest } from '../src/providers/types';
import {
  CHALLENGE_TAGS,
  FEW_SHOTS,
  selectFewShots,
  type FewShot,
} from '../src/judge/checks-fewshots';
import { HELD_OUT, scoreHeldOut } from '../src/judge/checks-heldout';
import {
  buildCompilePrompt,
  COMPILE_CHECKS_OUTPUT,
  COMPILE_CHECKS_SYSTEM_PROMPT,
  COMPILED_CHECKS_JSON_SCHEMA,
  HOLD_SECONDS,
  PREDICATE_MEANINGS,
  predicateRules,
  promptVersionOf,
  PROMPT_VERSION,
  renderFewShots,
} from '../src/judge/compile-checks-prompt';
import { acceptSpec, compileChecks, type CompileChecksResult } from '../src/judge/compile-checks';

const PREDICATES = Predicate.options.map((o) => o.shape.p.value) as PredicateName[];

// ---- a tiny validator for the JSON-schema subset Anthropic structured outputs accept ---------

const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
]);
type S = Record<string, unknown>;

function keywordsOk(s: S, path = '$'): string[] {
  const bad = Object.keys(s)
    .filter((k) => !ALLOWED_KEYWORDS.has(k))
    .map((k) => `${path}.${k}`);
  if (s['type'] === 'object') {
    if (s['additionalProperties'] !== false)
      bad.push(`${path}: additionalProperties must be false`);
    const props = Object.keys((s['properties'] as S) ?? {});
    const req = (s['required'] as string[]) ?? [];
    if (props.length !== req.length || props.some((p) => !req.includes(p)))
      bad.push(`${path}: required must list every property`);
  }
  for (const [k, v] of Object.entries((s['properties'] as Record<string, S>) ?? {}))
    bad.push(...keywordsOk(v, `${path}.${k}`));
  if (s['items']) bad.push(...keywordsOk(s['items'] as S, `${path}[]`));
  ((s['anyOf'] as S[]) ?? []).forEach((a, i) => bad.push(...keywordsOk(a, `${path}|${i}`)));
  return bad;
}

function validates(s: S, v: unknown): boolean {
  if (s['anyOf']) return (s['anyOf'] as S[]).some((a) => validates(a, v));
  if ('const' in s && v !== s['const']) return false;
  if (s['enum'] && !(s['enum'] as unknown[]).includes(v)) return false;
  switch (s['type']) {
    case 'null':
      return v === null;
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return Number.isInteger(v);
    case 'array':
      return Array.isArray(v) && v.every((x) => validates(s['items'] as S, x));
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      const props = (s['properties'] as Record<string, S>) ?? {};
      if (Object.keys(o).some((k) => !(k in props))) return false;
      if (((s['required'] as string[]) ?? []).some((k) => !(k in o))) return false;
      return Object.entries(o).every(([k, x]) => validates(props[k]!, x));
    }
    default:
      return s['type'] === undefined;
  }
}

const wire = (f: FewShot) => ({
  decision: f.output.decision,
  why: f.output.why,
  spec: f.output.spec,
});

// ---- few-shot data ---------------------------------------------------------------------------

describe('FEW_SHOTS', () => {
  it('has 8-10 examples with unique ids and claims', () => {
    expect(FEW_SHOTS.length).toBeGreaterThanOrEqual(8);
    expect(FEW_SHOTS.length).toBeLessThanOrEqual(10);
    expect(new Set(FEW_SHOTS.map((f) => f.id)).size).toBe(FEW_SHOTS.length);
    expect(new Set(FEW_SHOTS.map((f) => f.input.claim)).size).toBe(FEW_SHOTS.length);
    for (const f of FEW_SHOTS) expect(f.id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it.each(FEW_SHOTS.map((f) => [f.id, f] as const))(
    '%s: valid input, canonical valid spec (or null), readback renders',
    (_id, f) => {
      expect(CompileInput.parse(f.input)).toEqual(f.input);
      expect(f.input.type).toBe('skill');
      expect(f.input.attempts.rule).toBe('single');
      expect(f.output.why.length).toBeLessThanOrEqual(200);
      expect(f.note.length).toBeGreaterThan(20);
      expect(f.tags.length).toBeGreaterThan(0);
      if (f.output.decision === 'judge_only') {
        expect(f.output.spec).toBeNull();
        expect(f.tags).toContain('judge_only');
        expect(describeChecks(null)).toBe('Judge only, no ref cam.');
      } else {
        const spec = CheckSpec.parse(f.output.spec);
        expect(jcs(canonicalizeCheckSpec(spec))).toBe(jcs(f.output.spec));
        expect(f.tags).not.toContain('judge_only');
        const rb = describeChecks(spec);
        expect(rb.length).toBeLessThanOrEqual(READBACK_MAX_CHARS);
        expect(rb).not.toContain('and more');
      }
    },
  );

  it('covers every predicate, both roles, every tag, and has >= 2 judge_only examples', () => {
    const used = new Set(
      FEW_SHOTS.flatMap((f) => f.output.spec?.assertions.map((a) => a.test.p) ?? []),
    );
    expect([...PREDICATES].filter((p) => !used.has(p))).toEqual([]);
    const tags = new Set(FEW_SHOTS.flatMap((f) => f.tags));
    expect(CHALLENGE_TAGS.filter((t) => !tags.has(t))).toEqual([]);
    expect(
      FEW_SHOTS.filter((f) => f.output.decision === 'judge_only').length,
    ).toBeGreaterThanOrEqual(2);
  });

  // Pins what every example MEANS, so a tuning edit that still lints (swapped a/b, a gate moved to
  // the wrong entity) shows up here as a reviewable diff. Update this map together with the data.
  it('golden: each example compiles to exactly these assertions and this readback', () => {
    const sig = (f: FewShot) =>
      f.output.spec?.assertions.map((a) => {
        const { p, ...args } = a.test;
        return `${a.role}:${p}(${Object.values(args).join(',')})`;
      }) ?? null;
    expect(Object.fromEntries(FEW_SHOTS.map((f) => [f.id, sig(f)]))).toEqual({
      bottle_flip_upright: [
        'gate:visible(bottle,end)',
        'need:at_rest(bottle,)',
        'need:upright(bottle)',
      ],
      paper_ball_trash_can: ['gate:visible(can,end)', 'need:ends_at(paper,can)'],
      cup_stack_three: ['gate:visible(table,end)', 'need:at_rest(cup,table)', 'need:stacked(cup)'],
      knock_over_three_cans: [
        'gate:visible(can,start)',
        'gate:visible(table,end)',
        'need:moved_from_start(can,all,table)',
      ],
      spoon_on_nose_3s: ['gate:visible(face,landing)', 'need:touching(spoon,face,last_3s)'],
      jump_over_chair: ['gate:visible(chair,end)', 'need:switched_sides(person,chair)'],
      phone_slide_stays_on_table: [
        'gate:visible(table,end)',
        'need:on_top(phone,table)',
        'need:at_rest(phone,table)',
      ],
      coin_flip_heads: null,
      catch_behind_back: null,
      keepy_uppy_ten: null,
    });
    const rb = Object.fromEntries(
      FEW_SHOTS.filter((f) => f.output.spec).map((f) => [
        f.id,
        describeChecks(CheckSpec.parse(f.output.spec)),
      ]),
    );
    const offline = ' If the ref cam is offline, the judge decides alone.';
    expect(rb).toEqual({
      bottle_flip_upright:
        'Ref cam: the bottle fully in shot at the end; the bottle comes to rest; the bottle stands upright. Film from the side.' +
        offline,
      paper_ball_trash_can:
        'Ref cam: the trash can in shot at the end; the paper ball not seen lying away from the trash can.' +
        offline,
      cup_stack_three:
        'Ref cam: the table in shot at the end; all 3 cups come to rest; all 3 cups end stacked, one on top.' +
        offline,
      knock_over_three_cans:
        'Ref cam: all 3 cans fully in shot at the start; the table in shot at the end; no can still where it started.' +
        offline,
      spoon_on_nose_3s:
        "Ref cam: the face in shot for the last second; the spoon touching the face for the last 3 seconds. Stop filming while it's still balanced." +
        offline,
      jump_over_chair:
        'Ref cam: the chair in shot at the end; the person starts on one side of the chair and ends on the other. Film from the side.' +
        offline,
      phone_slide_stays_on_table:
        'Ref cam: the table in shot at the end; the phone ends on the table; the phone comes to rest.' +
        offline,
    });
  });

  it('selectFewShots: all in order by default; tag filter keeps judge_only, order and max', () => {
    const input = FEW_SHOTS[0]!.input;
    expect(selectFewShots(input)).toEqual([...FEW_SHOTS]);
    const stack = selectFewShots(input, { tags: ['stack'] });
    expect(stack.map((f) => f.id)).toEqual(
      FEW_SHOTS.filter((f) => f.tags.includes('stack') || f.tags.includes('judge_only')).map(
        (f) => f.id,
      ),
    );
    // max trims tag matches first: the judge_only counterweight survives any cap that holds it.
    const judgeOnlyIds = FEW_SHOTS.filter((f) => f.tags.includes('judge_only')).map((f) => f.id);
    const capped = selectFewShots(input, { tags: ['landing', 'throw_into', 'stack'], max: 4 });
    expect(capped.map((f) => f.id)).toEqual(['bottle_flip_upright', ...judgeOnlyIds]);
    const none = selectFewShots(input, { tags: ['landing', 'throw_into', 'stack'], max: 3 });
    expect(none.map((f) => f.id)).toEqual(judgeOnlyIds);
    const roomy = selectFewShots(input, { tags: ['stack'], max: 5 });
    expect(roomy.map((f) => f.id)).toEqual(['cup_stack_three', ...judgeOnlyIds]);
    expect(selectFewShots(input, { max: 3 })).toEqual(FEW_SHOTS.slice(0, 3));
  });
});

// ---- held-out set ----------------------------------------------------------------------------

describe('HELD_OUT', () => {
  it('is disjoint from FEW_SHOTS (ids and claims) and has unique ids', () => {
    const ids = new Set(FEW_SHOTS.map((f) => f.id));
    const claims = new Set(FEW_SHOTS.map((f) => f.input.claim));
    expect(HELD_OUT.filter((b) => ids.has(b.id) || claims.has(b.input.claim))).toEqual([]);
    expect(new Set(HELD_OUT.map((b) => b.id)).size).toBe(HELD_OUT.length);
  });

  it.each(HELD_OUT.map((b) => [b.id, b] as const))(
    '%s: valid input, valid mock output that meets its own expectations',
    (_id, b) => {
      CompileInput.parse(b.input);
      if (b.mock_output.spec) CheckSpec.parse(canonicalizeCheckSpec(b.mock_output.spec));
      const attempts = b.expect.model_calls;
      const res = scoreHeldOut(b, { ...b.mock_output, attempts });
      expect(res.filter((r) => !r.pass)).toEqual([]);
    },
  );

  it('scoring catches a wrong answer', () => {
    const b = HELD_OUT.find((x) => x.id === 'sock_into_laundry_basket')!;
    const res = scoreHeldOut(b, {
      decision: 'checks',
      attempts: 1,
      spec: {
        entities: [
          { key: 'sock', prompt: 'sock' },
          { key: 'bin', prompt: 'trash bin' },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'sock' } },
          { role: 'need', test: { p: 'on_top' } },
        ],
      },
    });
    const failed = res.filter((r) => !r.pass).map((r) => r.name);
    expect(failed).toEqual(['must_include', 'must_not_include', 'prompts', 'gates']);
  });

  it('gate scoring is window-aware: a knocked-off can may be gated at start, never late', () => {
    const b = HELD_OUT.find((x) => x.id === 'can_off_fence')!;
    const base = structuredClone(b.mock_output.spec!);
    const ok = scoreHeldOut(b, { decision: 'checks', spec: base, attempts: 1 });
    expect(ok.every((r) => r.pass)).toBe(true);
    for (const window of ['end', 'landing'] as const) {
      const late = structuredClone(base);
      late.assertions.push({ role: 'gate', test: { p: 'visible', e: 'can', window } });
      const res = scoreHeldOut(b, { decision: 'checks', spec: late, attempts: 1 });
      expect(res.find((r) => r.name === 'gates')).toMatchObject({
        pass: false,
        detail: 'can@late',
      });
    }
  });

  it('book_on_head_walk rejects "face" as the anchor', () => {
    const b = HELD_OUT.find((x) => x.id === 'book_on_head_walk')!;
    const spec = structuredClone(b.mock_output.spec!);
    spec.entities = spec.entities.map((e) => (e.key === 'head' ? { ...e, prompt: 'face' } : e));
    const res = scoreHeldOut(b, { decision: 'checks', spec, attempts: 1 });
    expect(res.find((r) => r.name === 'prompts')).toMatchObject({ pass: false, detail: 'face' });
  });
});

// ---- prompt ------------------------------------------------------------------------------------

describe('compile_checks prompt', () => {
  const input = HELD_OUT[0]!.input;

  it('is deterministic; stable part first and cached; the bet last', () => {
    const a = buildCompilePrompt(input);
    const b = buildCompilePrompt(input);
    expect(b).toEqual(a);
    expect(a.prompt_version).toBe(PROMPT_VERSION);
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(a.parts).toHaveLength(2);
    expect(a.parts[0]).toMatchObject({ kind: 'text', cache: true });
    expect(a.parts[1]).toMatchObject({ kind: 'text' });
    expect((a.parts[1] as { cache?: boolean }).cache).toBeUndefined();
    expect((a.parts[1] as { text: string }).text).toContain(JSON.stringify(input));
    expect((a.parts[0] as { text: string }).text).not.toContain(input.claim);
    // The stable part does not depend on the bet.
    const other = buildCompilePrompt(HELD_OUT[1]!.input);
    expect(other.system).toBe(a.system);
    expect(other.parts[0]).toEqual(a.parts[0]);
    expect(a.fewshot_ids).toEqual(FEW_SHOTS.map((f) => f.id));
  });

  it('renders every few-shot as an input/output pair with its note', () => {
    const text = (buildCompilePrompt(input).parts[0] as { text: string }).text;
    for (const f of FEW_SHOTS) {
      expect(text).toContain(`INPUT: ${JSON.stringify(f.input)}`);
      expect(text).toContain(`OUTPUT: ${JSON.stringify(wire(f))}`);
      expect(text).toContain(f.note);
    }
  });

  it('PROMPT_VERSION changes when an example (or the selection) changes', () => {
    const base = promptVersionOf(COMPILE_CHECKS_SYSTEM_PROMPT, renderFewShots(FEW_SHOTS));
    expect(base).toBe(PROMPT_VERSION);
    const edited = FEW_SHOTS.map((f, i) => (i === 0 ? { ...f, note: `${f.note} Edited.` } : f));
    expect(promptVersionOf(COMPILE_CHECKS_SYSTEM_PROMPT, renderFewShots(edited))).not.toBe(base);
    const reordered = [...FEW_SHOTS].reverse();
    expect(promptVersionOf(COMPILE_CHECKS_SYSTEM_PROMPT, renderFewShots(reordered))).not.toBe(base);
    expect(buildCompilePrompt(input, { max: 5 }).prompt_version).not.toBe(base);
  });

  it('catalogue is generated from the schemas: every predicate, arg and enum value', () => {
    const s = COMPILE_CHECKS_SYSTEM_PROMPT;
    for (const o of Predicate.options) {
      const p = o.shape.p.value as PredicateName;
      const args = Object.keys(o.shape).filter((k) => k !== 'p');
      expect(s).toContain(`- ${p}(${args.join(', ')}) [`);
      expect(s).toContain(PREDICATE_MEANINGS[p].true);
      expect(s).toContain(PREDICATE_MEANINGS[p].false);
    }
    expect(s).toContain('window: one of start|end|landing');
    expect(s).toContain('window: one of end|landing|last_2s|last_3s|last_5s');
    expect(s).toContain('of: one of any|all');
    expect(s).toContain('- visible(e, window) [gate or need; count > 1 allowed]');
    expect(s).toContain('- upright(e) [need only; count-1 entities only]');
    expect(s).toContain('- stacked(e) [need only; count >= 2 required]');
  });

  it('catalogue rule tags match what CheckSpec.parse accepts, for every predicate', () => {
    // Build each predicate behaviourally: as a gate, with count-2 subjects, with count-1 subjects.
    const ents = (n: number) => [
      { key: 'x', prompt: 'thing', count: n },
      { key: 'y', prompt: 'other', count: n },
    ];
    const anchor = { key: 'z', prompt: 'table', count: 1 };
    const testFor = (o: (typeof Predicate.options)[number]) => {
      const t: Record<string, unknown> = { p: o.shape.p.value };
      for (const k of Object.keys(o.shape).filter((k) => k !== 'p')) {
        t[k] = k === 'e' || k === 'a' ? 'x' : k === 'b' ? 'y' : k === 'ref' ? 'z' : null;
        if (k === 'window') t[k] = 'end';
        if (k === 'of') t[k] = 'all';
      }
      return t;
    };
    const accepts = (o: (typeof Predicate.options)[number], role: string, n: number) => {
      const test = testFor(o);
      const keys = new Set(Object.values(test));
      const entities = [...ents(n), anchor].filter((e) => keys.has(e.key));
      const spec = { predicates: 'p1', entities, assertions: [{ role, test }] };
      return CheckSpec.safeParse(canonicalizeCheckSpec(spec as never)).success;
    };
    for (const o of Predicate.options) {
      const p = o.shape.p.value as PredicateName;
      const argKeys = Object.keys(o.shape).filter((k) => k !== 'p');
      const tags = predicateRules(p, argKeys);
      expect(COMPILE_CHECKS_SYSTEM_PROMPT).toContain(
        `- ${p}(${argKeys.join(', ')}) [${tags.join('; ')}]`,
      );
      expect(tags.includes('gate or need'), p).toBe(accepts(o, 'gate', 2) || accepts(o, 'gate', 1));
      expect(tags.includes('gate or need'), p).toBe(
        (GATE_PREDICATES as readonly string[]).includes(p),
      );
      const two = accepts(o, 'need', 2);
      const one = accepts(o, 'need', 1);
      expect(tags.includes('count-1 entities only'), p).toBe(one && !two);
      expect(tags.includes('count > 1 allowed'), p).toBe(one && two);
      expect(tags.includes('count >= 2 required'), p).toBe(two && !one);
      expect((MULTI_COUNT_PREDICATES as readonly string[]).includes(p), p).toBe(two);
      expect((MIN_COUNT_2_PREDICATES as readonly string[]).includes(p), p).toBe(!one);
    }
  });

  it('hold rule lists the TouchWindow durations and says to round down', () => {
    expect(HOLD_SECONDS).toEqual([2, 3, 5]);
    expect(COMPILE_CHECKS_SYSTEM_PROMPT).toContain('Windows: last_2s, last_3s, last_5s.');
    expect(COMPILE_CHECKS_SYSTEM_PROMPT).toContain('largest N that is not longer than');
    expect(COMPILE_CHECKS_SYSTEM_PROMPT).toContain('for a hold under 2 s, do not use last_Ns');
  });
});

// ---- wire JSON schema --------------------------------------------------------------------------

describe('COMPILED_CHECKS_JSON_SCHEMA', () => {
  it('uses only supported keywords, additionalProperties:false and full required lists', () => {
    expect(keywordsOk(COMPILED_CHECKS_JSON_SCHEMA as unknown as S)).toEqual([]);
  });

  it('accepts every few-shot output and held-out mock output; zod round-trips them', () => {
    for (const o of [...FEW_SHOTS.map(wire), ...HELD_OUT.map((b) => b.mock_output)]) {
      expect(validates(COMPILED_CHECKS_JSON_SCHEMA as unknown as S, o)).toBe(true);
      const back = COMPILE_CHECKS_OUTPUT.schema.parse(JSON.parse(JSON.stringify(o)));
      expect(back).toEqual(o);
    }
  });

  it('rejects wrong shapes', () => {
    const s = COMPILED_CHECKS_JSON_SCHEMA as unknown as S;
    const ok = wire(FEW_SHOTS[0]!);
    expect(validates(s, { ...ok, extra: 1 })).toBe(false);
    expect(validates(s, { ...ok, decision: 'maybe' })).toBe(false);
    const spec = structuredClone(ok.spec) as unknown as { assertions: { test: S }[] };
    spec.assertions[0]!.test = { p: 'visible', e: 'bottle', window: 'later' };
    expect(validates(s, { ...ok, spec })).toBe(false);
    spec.assertions[0]!.test = { p: 'upright', e: 'bottle', ref: null };
    expect(validates(s, { ...ok, spec })).toBe(false);
  });
});

// ---- compiler ----------------------------------------------------------------------------------

const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused@127.0.0.1:1/none' });
const depsWith = (
  respond: (req: ChatRequest<unknown>, n: number) => MockReply | Promise<MockReply>,
) => {
  let n = 0;
  const llm = new MockLlm((req) => respond(req, ++n));
  return {
    llm,
    deps: { env, providers: createProviders(env, { overrides: { llm } }), log: silentLogger },
  };
};
const bottle = FEW_SHOTS.find((f) => f.id === 'bottle_flip_upright')!;
const input = HELD_OUT.find((b) => b.id === 'frisbee_lands_on_table')!.input;
const frisbeeSpec = HELD_OUT.find((b) => b.id === 'frisbee_lands_on_table')!.mock_output.spec!;
/** Valid but not in canonical order (needs reversed, entities reversed). */
const scrambled = {
  ...frisbeeSpec,
  entities: [...frisbeeSpec.entities].reverse(),
  assertions: [frisbeeSpec.assertions[2]!, frisbeeSpec.assertions[1]!, frisbeeSpec.assertions[0]!],
};
const checksReply = (spec: unknown): MockReply => ({
  value: { decision: 'checks', why: 'Because.', spec },
});
const run = (deps: ReturnType<typeof depsWith>['deps'], i = input) =>
  compileChecks(deps, i, { cache: null });

describe('compileChecks', () => {
  it('happy path: one medium-effort call to CHECKS_MODEL; spec canonicalized and parsed', async () => {
    const { llm, deps } = depsWith(() => checksReply(scrambled));
    const r = await run(deps);
    expect(r).toMatchObject({
      decision: 'checks',
      status: 'ok',
      attempts: 1,
      prompt_version: PROMPT_VERSION,
    });
    expect(r.model).toBe('anthropic/mock/claude-opus-5-5');
    expect(jcs(r.spec)).toBe(jcs(canonicalizeCheckSpec(frisbeeSpec)));
    expect(CheckSpec.parse(r.spec)).toEqual(r.spec);
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0]!;
    expect(req).toMatchObject({ vendor: 'anthropic', model: env.CHECKS_MODEL, effort: 'medium' });
    expect(req.maxOutputTokens).toBe(8000);
    expect(req.timeoutMs).toBe(20_000);
    expect(req.system).toBe(COMPILE_CHECKS_SYSTEM_PROMPT);
    expect(req.output.jsonSchema).toBe(COMPILED_CHECKS_JSON_SCHEMA);
    expect(req.parts).toEqual(buildCompilePrompt(input).parts);
  });

  it('judge_only answer -> spec null, status ok', async () => {
    const { deps } = depsWith(() => ({
      value: { decision: 'judge_only', why: 'Counting.', spec: null },
    }));
    expect(await run(deps)).toMatchObject({
      decision: 'judge_only',
      spec: null,
      status: 'ok',
      attempts: 1,
    });
  });

  it('retries once with the zod issues appended, then succeeds', async () => {
    const bad = structuredClone(frisbeeSpec) as unknown as { assertions: { role: string }[] };
    bad.assertions[1]!.role = 'gate'; // at_rest as a gate: lint error
    const { llm, deps } = depsWith((_req, n) => checksReply(n === 1 ? bad : frisbeeSpec));
    const r = await run(deps);
    expect(r).toMatchObject({ decision: 'checks', status: 'ok', attempts: 2 });
    expect(llm.calls).toHaveLength(2);
    const second = llm.calls[1]!.parts;
    expect(second.slice(0, 2)).toEqual(llm.calls[0]!.parts);
    expect(second).toHaveLength(3);
    const fix = (second[2] as { text: string }).text;
    expect(fix).toContain("only 'visible' can be a gate");
    expect(fix).toContain('Previous answer:');
  });

  it('retries after unparseable output and after decision/spec mismatch', async () => {
    const a = depsWith((_r, n) => (n === 1 ? { text: 'no json here' } : checksReply(frisbeeSpec)));
    expect(await run(a.deps)).toMatchObject({ status: 'ok', attempts: 2 });
    // The provider's parse error and the raw answer both reach the retry text.
    const fail = depsWith(() => ({ text: 'no json here' }));
    const probe = await fail.llm.chat(a.llm.calls[0]!);
    expect(probe.ok).toBe(false);
    const fixText = (a.llm.calls[1]!.parts[2] as { text: string }).text;
    expect(fixText).toContain(`- ${(probe as { message: string }).message}`);
    expect(fixText).toContain('Previous answer: no json here');
    const b = depsWith((_r, n) =>
      n === 1
        ? { value: { decision: 'judge_only', why: 'x', spec: frisbeeSpec } }
        : checksReply(frisbeeSpec),
    );
    const rb = await run(b.deps);
    expect(rb).toMatchObject({ status: 'ok', attempts: 2, decision: 'checks' });
    expect((b.llm.calls[1]!.parts[2] as { text: string }).text).toContain('requires spec null');
    const c = depsWith((_r, n) => (n === 1 ? checksReply(null) : checksReply(frisbeeSpec)));
    expect(await run(c.deps)).toMatchObject({ status: 'ok', attempts: 2 });
  });

  it('a why over 200 chars is trimmed, not rejected', async () => {
    const { deps } = depsWith(() => ({
      value: { decision: 'checks', why: `  ${'w'.repeat(250)}  `, spec: frisbeeSpec },
    }));
    const r = await run(deps);
    expect(r).toMatchObject({ status: 'ok', attempts: 1, decision: 'checks' });
    expect(r.why).toBe('w'.repeat(200));
  });

  it('a spec whose readback fails is rejected (acceptSpec guard)', () => {
    expect(acceptSpec(frisbeeSpec)).toMatchObject({ ok: true });
    expect(acceptSpec({ ...frisbeeSpec, entities: [] })).toMatchObject({ ok: false });
  });

  it('two failures -> judge_only fallback, never throws', async () => {
    const { llm, deps } = depsWith(() =>
      checksReply({ predicates: 'p1', entities: [], assertions: [] }),
    );
    const r = await run(deps);
    expect(r).toMatchObject({
      decision: 'judge_only',
      spec: null,
      status: 'fallback',
      attempts: 2,
    });
    expect(r.error).toMatch(/^invalid_spec: /);
    expect(llm.calls).toHaveLength(2);
  });

  it.each(['timeout', 'refusal', 'error'] as const)(
    '%s -> immediate fallback (no retry)',
    async (fail) => {
      const { llm, deps } = depsWith(() => ({ fail }));
      const r = await run(deps);
      expect(r).toMatchObject({
        decision: 'judge_only',
        spec: null,
        status: 'fallback',
        attempts: 1,
      });
      expect(r.error).toMatch(new RegExp(`^${fail}: `));
      expect(llm.calls).toHaveLength(1);
    },
  );

  it('opts.timeoutMs reaches the request', async () => {
    const { llm, deps } = depsWith(() => checksReply(frisbeeSpec));
    await compileChecks(deps, input, { cache: null, timeoutMs: 1234 });
    expect(llm.calls[0]!.timeoutMs).toBe(1234);
  });

  it('a provider that throws -> fallback', async () => {
    const deps = {
      env,
      providers: createProviders(env, {
        overrides: {
          llm: { name: 'mock' as const, chat: () => Promise.reject(new Error('boom')) },
        },
      }),
      log: silentLogger,
    };
    const r = await compileChecks(deps, input, { cache: null });
    expect(r).toMatchObject({ status: 'fallback', decision: 'judge_only', attempts: 1 });
    expect(r.error).toContain('boom');
  });

  it('multi-attempt and real_world bets -> judge_only without a model call', async () => {
    const { llm, deps } = depsWith(() => checksReply(frisbeeSpec));
    const multi = await run(deps, { ...input, attempts: { count: 3, rule: 'best_of' } });
    expect(multi).toMatchObject({
      decision: 'judge_only',
      spec: null,
      status: 'ok',
      attempts: 0,
      model: null,
    });
    const rw = await run(deps, { ...input, type: 'real_world' });
    expect(rw).toMatchObject({ decision: 'judge_only', status: 'ok', attempts: 0 });
    expect(llm.calls).toHaveLength(0);
  });

  it('invalid input -> fallback without a call', async () => {
    const { llm, deps } = depsWith(() => checksReply(frisbeeSpec));
    const r = await run(deps, { ...input, claim: '  padded  ' });
    expect(r).toMatchObject({ status: 'fallback', attempts: 0 });
    expect(llm.calls).toHaveLength(0);
  });

  it('cache: same input + prompt + model -> no second call; fallbacks are not cached', async () => {
    const cache = new Map<string, CompileChecksResult>();
    const { llm, deps } = depsWith(() => checksReply(frisbeeSpec));
    const a = await compileChecks(deps, input, { cache });
    const b = await compileChecks(deps, input, { cache });
    expect(llm.calls).toHaveLength(1);
    expect(b).toMatchObject({ cached: true, spec: a.spec, decision: 'checks' });
    const sonnet = await compileChecks(deps, input, { cache, model: 'claude-sonnet-5-5' });
    expect(llm.calls).toHaveLength(2); // the model is part of the key
    expect(llm.calls[1]!.model).toBe('claude-sonnet-5-5'); // and the request goes to it
    expect(sonnet.model).toBe('anthropic/mock/claude-sonnet-5-5');
    await compileChecks(deps, { ...input, claim: `${input.claim} Twice.` }, { cache });
    expect(llm.calls).toHaveLength(3);

    // The prompt version (few-shot selection) is part of the key, and the selection is sent.
    const sel = { max: 5 };
    const five = await compileChecks(deps, input, { cache, fewShots: sel });
    expect(llm.calls).toHaveLength(4);
    expect(five.prompt_version).not.toBe(PROMPT_VERSION);
    expect(five.prompt_version).toBe(buildCompilePrompt(input, sel).prompt_version);
    expect((llm.calls[3]!.parts[0] as { text: string }).text).toBe(
      renderFewShots(selectFewShots(input, sel)),
    );
    expect(await compileChecks(deps, input, { cache, fewShots: sel })).toMatchObject({
      cached: true,
    });
    expect(llm.calls).toHaveLength(4);

    // Hits are deep copies: mutating one result never changes a later hit.
    const m = await compileChecks(deps, input, { cache });
    m.spec!.assertions.length = 0;
    m.spec!.entities[0]!.prompt = 'mutated';
    const again = await compileChecks(deps, input, { cache });
    expect(again.spec).toEqual(a.spec);
    a.spec!.entities[0]!.prompt = 'mutated too';
    expect((await compileChecks(deps, input, { cache })).spec!.entities[0]!.prompt).not.toBe(
      'mutated too',
    );

    const f = depsWith(() => ({ fail: 'timeout' }));
    const fc = new Map<string, CompileChecksResult>();
    await compileChecks(f.deps, input, { cache: fc });
    await compileChecks(f.deps, input, { cache: fc });
    expect(f.llm.calls).toHaveLength(2);
    expect(fc.size).toBe(0);
  });

  it('fromTerms() takes exactly the compiler fields from real terms', async () => {
    const terms = Terms.parse(skillTerms());
    const ci = fromTerms(terms);
    expect(CompileInput.parse(ci)).toEqual(ci);
    expect(Object.keys(ci).sort()).toEqual([
      'attempts',
      'claim',
      'edge_cases',
      'failure_criteria',
      'success_criteria',
      'type',
    ]);
    const { llm, deps } = depsWith(() => checksReply(bottle.output.spec));
    await run(deps, ci);
    expect(llm.calls).toHaveLength(terms.attempts.rule === 'single' ? 1 : 0);
  });
});
