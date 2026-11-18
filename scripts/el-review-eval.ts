#!/usr/bin/env -S npx tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- ElevenLabs JSON responses are untyped */
// Real-ElevenLabs eval of the GG moment's spoken review (request_review) on a THROWAWAY agent:
// does the judge call request_review for "check that again" (and not for "GG" / cheering / after
// PAID), speak the tool's "say", and voice the GG vs timeout PAID lines right? Uses ElevenLabs
// agent testing (POST /v1/convai/agent-testing/create, /agents/{id}/run-tests,
// GET /test-invocations/{id}); simulate-conversation is deprecated.
//
//   npx tsx --env-file-if-exists=apps/server/.env scripts/el-review-eval.ts --dry-run
//   npx tsx --env-file-if-exists=apps/server/.env scripts/el-review-eval.ts [--repeat=2]
//   npx tsx --env-file-if-exists=apps/server/.env scripts/el-review-eval.ts --cleanup
//
// Safety (the live judge 'youre-on-judge' serves the live server and must never change):
//   - its own agent 'youre-on-judge-test-gg' (tags youre-on, test-gg) and its own request_review
//     tool (URL https://example.com/..., no secret header: the tests evaluate the CALL, never the
//     webhook). No secret is created. It never reads ELEVENLABS_AGENT_ID and never PATCHes.
//   - it does not use scripts/el-agent.ts: that finds tools and the secret by name and PATCHes
//     them, and they are shared with the live agent.
//   - only POST, GET and DELETE of the ids THIS run created (saved to --state as they are made, so
//     --cleanup recovers after a crash). Never a delete by name.
//   - every body is checked against ElevenLabs' public OpenAPI document before it is sent.
//   - the API key never appears in the output.
// Spend: 11 tests x --repeat (default 2) Haiku turns + the evaluator calls: a few cents.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentBody,
  CLIENT_TOOLS,
  DEFAULT_WEBHOOK_TOOLS,
  toolRequest,
  webhookToolConfig,
} from '@youre-on/shared/judge/el-config';
import { JUDGE_AGENT_NAME, type JudgeToolName } from '@youre-on/shared/judge/persona';
import type { Ruling } from '@youre-on/shared/ruling';
import { rulingCue } from '../apps/server/src/judge/cues';
import { payoutCue } from '../apps/server/src/payout/service';
import {
  checkValue,
  requestBodySchema,
  type OpenApiDoc,
} from '../apps/server/src/voice/openapi-check';

export const EVAL_AGENT_NAME = 'youre-on-judge-test-gg';
export const EVAL_TAGS = ['youre-on', 'test-gg'];
const TEST_PREFIX = 'yo-gg-';
const OPENAPI_URL = 'https://api.elevenlabs.io/openapi.json';
const API = 'https://api.elevenlabs.io';

const err = (l: string) => process.stderr.write(`${l}\n`);
const out = (l: string) => process.stdout.write(`${l}\n`);
function fail(msg: string): never {
  err(`el-review-eval: ${msg}`);
  process.exit(1);
}

// ---- the conversation the tests replay ---------------------------------------------------------

const NAMES = { A: 'Logan', B: 'Jake' };
const VARS = {
  bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
  party_a_name: NAMES.A,
  party_b_name: NAMES.B,
  max_stake_usd: '20',
};
const RULING: Ruling = {
  schema_version: 1,
  ruling_id: '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516',
  bet_id: VARS.bet_id,
  outcome: 'A_WINS',
  claim_result: 'NOT_MET',
  confidence: 0.93,
  reason: 'The bottle landed on its side in frame 2.',
  cited_frames: [2],
  frame_hashes: ['ab'.repeat(32)],
  model: 'anthropic/claude-test',
  evidence_hash: 'cd'.repeat(32),
  terms_hash: 'ef'.repeat(32),
  created_at: '2026-11-21T18:06:31.000Z',
  stage: 'attempt',
  attempt_no: 1,
  redo_reason: null,
  void_reason: null,
};
const RULING_LINE = rulingCue(RULING, NAMES, 10).text;
const PAID_GG = payoutCue('PartyA', { to_a: 10_000_000n, to_b: 0n }, NAMES, {
  via: 'gg',
  record: {
    a_wins: 5,
    b_wins: 7,
    pushes: 0,
    total: 12,
    streak: { party: 'A', length: 1 },
    rival: true,
    includes_seed: true,
  },
}).text;
const PAID_TIMEOUT = payoutCue('PartyA', { to_a: 10_000_000n, to_b: 0n }, NAMES, {
  via: 'timeout',
}).text;

type Turn = Record<string, unknown>;
let clock = 40;
const user = (message: string): Turn => ({ role: 'user', message, time_in_call_secs: clock++ });
const agent = (message: string): Turn => ({ role: 'agent', message, time_in_call_secs: clock++ });
/** The judge's request_review call with its server reply (as the transcript records it). */
const reviewCall = (toolId: string, heard: string, reply: object): Turn => ({
  role: 'agent',
  message: '',
  time_in_call_secs: clock++,
  tool_calls: [
    {
      type: 'webhook',
      request_id: 'req_review_1',
      tool_name: 'request_review',
      tool_id: toolId,
      params_as_json: JSON.stringify({ heard }),
      tool_has_been_called: true,
    },
  ],
  tool_results: [
    {
      type: 'webhook',
      request_id: 'req_review_1',
      tool_name: 'request_review',
      tool_id: toolId,
      result_value: JSON.stringify(reply),
      is_error: false,
      tool_has_been_called: true,
    },
  ],
});
const RULED: Turn[] = [
  user(RULING_LINE),
  agent(
    'Ruling: Logan wins. The bottle landed on its side in frame 2. Jake, tap GG, or say "check it again" for a review.',
  ),
];
const AFTER_GG: Turn[] = [
  ...RULED,
  user(PAID_GG),
  agent('Classy GG, Jake. Logan, the ten dollars are yours.'),
];

export interface EvalTest {
  key: string;
  /** 'must' = must pass on every repeat; 'should' = at least one of the repeats. */
  bar: 'must' | 'should';
  body: (toolId: string) => Record<string, unknown>;
}

const toolTest =
  (name: string, history: Turn[], absent: boolean) =>
  (toolId: string): Record<string, unknown> => ({
    name: `${TEST_PREFIX}${name}`,
    type: 'tool',
    chat_history: history,
    dynamic_variables: VARS,
    tool_call_parameters: {
      referenced_tool: { id: toolId, type: 'webhook' },
      verify_absence: absent,
      parameters: [],
    },
    check_any_tool_matches: true,
  });
const llmTest =
  (
    name: string,
    history: (toolId: string) => Turn[],
    condition: string,
    good: string,
    bad: string,
  ) =>
  (toolId: string): Record<string, unknown> => ({
    name: `${TEST_PREFIX}${name}`,
    type: 'llm',
    chat_history: history(toolId),
    dynamic_variables: VARS,
    success_condition: condition,
    success_examples: [{ response: good, type: 'success' }],
    failure_examples: [{ response: bad, type: 'failure' }],
  });

export const TESTS: EvalTest[] = [
  {
    key: 'T1',
    bar: 'must',
    body: toolTest('t1-check-again', [...RULED, user('No way. Check that again.')], false),
  },
  {
    key: 'T2',
    bar: 'must',
    body: toolTest('t2-wrong-review', [...RULED, user("That's wrong, review it.")], false),
  },
  {
    key: 'T3',
    bar: 'must',
    body: toolTest('t3-replay-appeal', [...RULED, user('I want a replay. I appeal!')], false),
  },
  {
    key: 'T4',
    bar: 'must',
    body: toolTest('t4-gg-not-review', [...RULED, user('GG. Good game, Logan.')], true),
  },
  {
    key: 'T5',
    bar: 'must',
    body: toolTest('t5-cheer-not-review', [...RULED, user("Let's goooo, Logan!")], true),
  },
  {
    key: 'T6',
    bar: 'must',
    body: toolTest('t6-after-paid-no-call', [...AFTER_GG, user('Wait, check that again.')], true),
  },
  {
    key: 'T7',
    bar: 'should',
    body: llmTest(
      't7-after-paid-final',
      () => [...AFTER_GG, user('Wait, check that again.')],
      'The agent says, in two sentences or fewer, that the ruling or bet is final / over (or that GG was already called). It does not promise, start or file a review, replay or appeal.',
      'Too late, Jake. GG was called and the ruling is final.',
      "Sure, I'll send it to the panel for a review.",
    ),
  },
  {
    key: 'T8',
    bar: 'should',
    body: llmTest(
      't8-window-closed',
      (id) => [
        ...RULED,
        user('I want a replay.'),
        reviewCall(id, 'I want a replay', {
          ok: false,
          fix: 'WINDOW_CLOSED',
          say: 'Too late. The ruling stands.',
        }),
      ],
      'The agent says (nearly word for word) "Too late. The ruling stands." It does not claim that an appeal or review was filed, requested or started.',
      'Too late. The ruling stands.',
      'Review requested. The panel will take a look.',
    ),
  },
  {
    key: 'T9',
    bar: 'should',
    body: llmTest(
      't9-review-requested',
      (id) => [
        ...RULED,
        user('No way, check that again.'),
        reviewCall(id, 'check that again', {
          ok: true,
          say: 'Review requested. Jake, confirm on your phone.',
        }),
      ],
      'The agent tells Jake to confirm on his phone (close to "Review requested. Jake, confirm on your phone."). It does not say the ruling changed, that Jake won, or that an appeal was filed.',
      'Review requested. Jake, confirm on your phone.',
      'The ruling is overturned. Jake wins.',
    ),
  },
  {
    key: 'T10',
    bar: 'should',
    body: llmTest(
      't10-paid-gg',
      () => [...RULED, user(PAID_GG)],
      "The agent praises Jake's GG or sportsmanship and congratulates Logan, in two sentences or fewer.",
      'Classy GG, Jake. Logan, the ten dollars are yours.',
      'Logan wins ten dollars.',
    ),
  },
  {
    key: 'T11',
    bar: 'should',
    body: llmTest(
      't11-paid-timeout',
      () => [...RULED, user(PAID_TIMEOUT)],
      "The agent congratulates Logan and mentions that the clock ran out or that Jake did not say GG. It does not praise Jake's sportsmanship. Two sentences or fewer.",
      "Clock's out and no GG from Jake. Logan, take your ten dollars.",
      'What a gracious GG from Jake! Congrats, Logan.',
    ),
  },
];

/** The throwaway request_review tool: no secret header, a URL that is never called. */
export function evalToolBody() {
  const cfg = webhookToolConfig('request_review', 'https://example.com', 'unused');
  return toolRequest({
    ...cfg,
    api_schema: { ...cfg.api_schema, request_headers: {} },
  });
}

/** The throwaway agent: the production prompt (+ request_review, skip_turn), only our tool. */
export function evalAgentBody(toolId: string) {
  const promptTools = new Set<JudgeToolName>([
    ...DEFAULT_WEBHOOK_TOOLS,
    ...CLIENT_TOOLS,
    'request_review',
    'skip_turn',
  ]);
  const body = agentBody({
    toolIds: [toolId],
    promptTools,
    name: EVAL_AGENT_NAME,
    tags: EVAL_TAGS,
  });
  if (body.name === JUDGE_AGENT_NAME) throw new Error('refusing to touch the live judge');
  return body;
}

// ---- HTTP + state ----------------------------------------------------------------------------

interface State {
  tool_id?: string;
  agent_id?: string;
  test_ids: string[];
}

async function loadState(path: string): Promise<State> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as State;
  } catch {
    return { test_ids: [] };
  }
}

function http(apiKey: string) {
  const scrub = (s: string) => (apiKey ? s.split(apiKey).join('<redacted>') : s);
  return async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => {
    const res = await fetch(API + path, {
      method,
      headers: {
        'xi-api-key': apiKey,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        scrub(`ElevenLabs ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 800)}`),
      );
    return text ? (JSON.parse(text) as Record<string, any>) : {};
  };
}

async function loadOpenApi(where: string): Promise<OpenApiDoc> {
  const text = /^https:\/\//.test(where)
    ? await fetch(where, { signal: AbortSignal.timeout(30_000) }).then((r) => {
        if (!r.ok) throw new Error(`GET ${where} -> HTTP ${r.status}`);
        return r.text();
      })
    : await readFile(where, 'utf8');
  return JSON.parse(text) as OpenApiDoc;
}

function check(doc: OpenApiDoc, method: string, path: string, body: unknown, label: string) {
  const schema = requestBodySchema(doc, method, path);
  if (!schema) throw new Error(`no request schema for ${method} ${path}`);
  const errors = checkValue(doc, body, schema, label);
  if (errors.length)
    throw new Error(`${label} does not match the OpenAPI schema:\n  ${errors.join('\n  ')}`);
}

async function cleanup(call: ReturnType<typeof http>, statePath: string, st: State) {
  // A 404 is gone already (an earlier cleanup got that far).
  const gone = (e: Error) => /HTTP 404/.test(e.message);
  for (const id of [...st.test_ids])
    await call('DELETE', `/v1/convai/agent-testing/${encodeURIComponent(id)}`).then(
      () => out(`deleted test ${id}`),
      (e: Error) => (gone(e) ? undefined : err(`delete test ${id}: ${e.message}`)),
    );
  if (st.agent_id)
    await call('DELETE', `/v1/convai/agents/${encodeURIComponent(st.agent_id)}`).then(
      () => out(`deleted agent ${st.agent_id}`),
      (e: Error) => (gone(e) ? undefined : err(`delete agent ${st.agent_id}: ${e.message}`)),
    );
  if (st.tool_id) {
    const path = `/v1/convai/tools/${encodeURIComponent(st.tool_id)}`;
    await call('DELETE', path).then(
      () => out(`deleted tool ${st.tool_id}`),
      async (e: Error) => {
        // A deleted agent can still hold the tool for a while ("in use by: Unknown / Main").
        // The tool is this run's own (no live agent ever references its id): force it, unless
        // a live agent other than ours shows up as a dependent.
        if (gone(e)) return;
        if (!/HTTP 409/.test(e.message)) return err(`delete tool ${st.tool_id}: ${e.message}`);
        const deps: Record<string, any> = await call(
          'GET',
          `${path}/dependent-agents?page_size=100`,
        ).catch(() => ({}));
        const others = ((deps.agents ?? []) as Array<Record<string, any>>).filter(
          (a) => a.id && a.id !== st.agent_id && a.type !== 'unknown',
        );
        if (others.length)
          return err(`tool ${st.tool_id} is used by ${others.map((a) => a.id).join(', ')}: left`);
        await call('DELETE', `${path}?force=true`).then(
          () => out(`deleted tool ${st.tool_id} (force: only our deleted agent held it)`),
          (e2: Error) => err(`delete tool ${st.tool_id}: ${e2.message}`),
        );
      },
    );
  }
  // Nothing of ours may be left (listed by name; deleted only by the ids above).
  const agents = (await call('GET', `/v1/convai/agents?search=${EVAL_AGENT_NAME}&page_size=100`))
    .agents as Array<{ name: string; agent_id: string }>;
  const tests = (await call('GET', `/v1/convai/agent-testing?search=${TEST_PREFIX}&page_size=100`))
    .tests as Array<{ name: string; id: string }> | undefined;
  const tool = st.tool_id
    ? await call('GET', `/v1/convai/tools/${encodeURIComponent(st.tool_id)}`).then(
        () => true,
        () => false,
      )
    : false;
  const leftAgents = (agents ?? []).filter((a) => a.name === EVAL_AGENT_NAME);
  const leftTests = (tests ?? []).filter((t) => t.name.startsWith(TEST_PREFIX));
  out(
    `left over: agents named ${EVAL_AGENT_NAME}: ${leftAgents.length}, tests ${TEST_PREFIX}*: ${leftTests.length}, our tool: ${tool ? 'still there' : 'gone'}`,
  );
  if (!leftAgents.length && !leftTests.length && !tool) await rm(statePath, { force: true });
  return leftAgents.length + leftTests.length + (tool ? 1 : 0);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  const value = (n: string) => flag(n)?.split('=').slice(1).join('=') || undefined;
  const dryRun = !!flag('dry-run');
  const repeat = Number(value('repeat') ?? 2);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) fail('--repeat: 1..5');
  const only = value('only')?.split(',');
  const statePath = value('state') ?? join(tmpdir(), 'youre-on-el-review-eval.json');
  const doc = await loadOpenApi(value('openapi') ?? OPENAPI_URL);
  const tests = TESTS.filter((t) => !only || only.includes(t.key));

  // Every body, checked before anything is sent (placeholder ids on a dry run).
  check(doc, 'POST', '/v1/convai/tools', evalToolBody(), 'tool');
  check(doc, 'POST', '/v1/convai/agents/create', evalAgentBody('tool_x'), 'agent');
  for (const t of tests)
    check(doc, 'POST', '/v1/convai/agent-testing/create', t.body('tool_x'), t.key);
  check(
    doc,
    'POST',
    '/v1/convai/agents/agent_x/run-tests',
    { tests: [{ test_id: 'x' }], repeat_count: repeat },
    'run-tests',
  );
  err(`el-review-eval: every body matches the OpenAPI schema (${tests.length} tests)`);
  if (dryRun) {
    out(
      JSON.stringify(
        { tool: evalToolBody(), tests: tests.map((t) => t.body('<tool_id>')) },
        null,
        2,
      ),
    );
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) fail('ELEVENLABS_API_KEY is not set');
  const call = http(apiKey);
  const st = await loadState(statePath);
  const save = () => writeFile(statePath, JSON.stringify(st));
  if (flag('cleanup')) {
    const left = await cleanup(call, statePath, st);
    process.exit(left ? 1 : 0);
  }
  if (st.tool_id || st.agent_id || st.test_ids.length)
    fail(`${statePath} lists resources of an earlier run: run --cleanup first`);

  // Never two tools named request_review in the workspace (el-agent finds tools by name).
  const existing = (
    (await call('GET', '/v1/convai/tools?search=request_review&page_size=100')).tools as Array<{
      tool_config: { name: string };
    }>
  ).filter((t) => t.tool_config.name === 'request_review');
  if (existing.length)
    fail('the workspace already has a request_review tool; this eval creates its own: not running');

  let code = 0;
  try {
    st.tool_id = String((await call('POST', '/v1/convai/tools', evalToolBody())).id);
    await save();
    out(`created tool request_review ${st.tool_id}`);
    st.agent_id = String(
      (await call('POST', '/v1/convai/agents/create', evalAgentBody(st.tool_id))).agent_id,
    );
    await save();
    out(`created agent ${EVAL_AGENT_NAME} ${st.agent_id}`);
    const idOf = new Map<string, string>();
    for (const t of tests) {
      const id = String(
        (await call('POST', '/v1/convai/agent-testing/create', t.body(st.tool_id))).id,
      );
      st.test_ids.push(id);
      idOf.set(id, t.key);
      await save();
    }
    out(`created ${tests.length} tests; running x${repeat}`);
    const inv = await call(
      'POST',
      `/v1/convai/agents/${encodeURIComponent(st.agent_id)}/run-tests`,
      {
        tests: st.test_ids.map((test_id) => ({ test_id })),
        repeat_count: repeat,
      },
    );
    const invId = String(inv.id);
    let runs: Array<Record<string, any>> = inv.test_runs ?? [];
    const until = Date.now() + 6 * 60_000;
    while (Date.now() < until) {
      const r = await call('GET', `/v1/convai/test-invocations/${encodeURIComponent(invId)}`);
      runs = r.test_runs ?? [];
      if (runs.length && runs.every((x) => x.status !== 'pending')) break;
      await new Promise((res) => setTimeout(res, 4_000));
    }
    let credits = 0;
    const byKey = new Map<string, { pass: number; total: number; notes: string[] }>();
    for (const run of runs) {
      const key = idOf.get(String(run.test_id)) ?? String(run.test_id);
      const e = byKey.get(key) ?? { pass: 0, total: 0, notes: [] };
      e.total += 1;
      if (run.status === 'passed') e.pass += 1;
      else {
        const said = (run.agent_responses ?? [])
          .map(
            (m: Record<string, any>) =>
              m.message ??
              (m.tool_calls ?? []).map((c: Record<string, any>) => `[${c.tool_name}]`).join(''),
          )
          .filter(Boolean)
          .join(' | ');
        const why = run.condition_result?.rationale?.summary ?? run.condition_result?.result ?? '';
        e.notes.push(
          `${run.status}: ${String(said).slice(0, 160)} ${why ? `(${String(why).slice(0, 160)})` : ''}`,
        );
      }
      credits += Number(run.credits_used ?? 0);
      byKey.set(key, e);
    }
    out('');
    for (const t of tests) {
      const e = byKey.get(t.key) ?? { pass: 0, total: 0, notes: ['no result'] };
      const ok = t.bar === 'must' ? e.total > 0 && e.pass === e.total : e.pass >= 1;
      if (!ok) code = 1;
      out(`${ok ? 'PASS' : 'FAIL'} ${t.key.padEnd(4)} ${String(e.pass)}/${e.total}  (${t.bar})`);
      for (const n of e.notes) out(`       ${n}`);
    }
    out(`credits_used: ${credits}`);
  } catch (e) {
    err(`el-review-eval: ${(e as Error).message}`);
    code = 1;
  } finally {
    const left = await cleanup(call, statePath, st).catch((e: Error) => {
      err(`cleanup: ${e.message} (re-run with --cleanup; state in ${statePath})`);
      return 1;
    });
    if (left) code = 1;
  }
  process.exit(code);
}

if (process.argv[1]?.endsWith('el-review-eval.ts'))
  main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
