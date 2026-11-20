#!/usr/bin/env -S npx tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- ElevenLabs JSON responses are loosely typed */
// A throwaway ElevenLabs simulation of the judge's odds talk (feat/odds verification). NOT wired
// into npm scripts and NOT scripts/el-agent.ts: that one finds and PATCHes the live agent and its
// shared tools by name. This script only ever POSTs NEW resources with unique names (a secret,
// the three webhook tools, an agent named youre-on-judge-odds-sim-<suffix>, one simulation test
// per scenario), runs them with POST /v1/convai/agents/{id}/run-tests (the agent-testing API:
// simulate-conversation was sunset on 2026-10-31) with every tool mocked (tool_mock_overrides by
// tool id, fallback raise_error, so no webhook is ever called: the tools point at an .invalid
// host), checks the transcripts, and DELETEs everything it created in `finally`, even on failure
// (tools with ?force=true: a just-deleted agent can still hold them for a while).
//
//   npx tsx --env-file-if-exists=apps/server/.env scripts/el-sim-odds.ts
//
// Scenarios:
//   1. "I'll give you three to one, fifteen against five." -> a propose_terms call with
//      amount_usd "15" and stake_b_usd "5", and the agent speaks the mocked `say`.
//   2. "Judge, what odds are fair?" -> a suggest_odds call (performer B, a claim with "bottle"),
//      the agent speaks the mocked `say` and asks whether both agree, adding no numbers.
//   3. After the 3:1 read-back, "make it two to one, my ten against your five" -> propose_terms
//      again with amount_usd "10" and stake_b_usd "5", and the new read-back.
// The API key is never printed (errors are scrubbed of it).
import { randomBytes } from 'node:crypto';
import {
  agentBody,
  toolRequest,
  webhookToolConfig,
  type WebhookToolName,
} from '../packages/shared/src/judge/el-config';
import type { JudgeToolName } from '../packages/shared/src/judge/persona';

const KEY = process.env.ELEVENLABS_API_KEY ?? '';
if (!KEY) {
  process.stderr.write('el-sim-odds: ELEVENLABS_API_KEY is not set\n');
  process.exit(2);
}
const BASE = 'https://api.elevenlabs.io';
const SFX = randomBytes(4).toString('hex');
const scrub = (s: string) => s.split(KEY).join('<redacted>');
const log = (s: string) => process.stdout.write(`${scrub(s)}\n`);

async function el(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'xi-api-key': KEY,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(scrub(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`));
  return text ? JSON.parse(text) : null;
}

const TOOLS = [
  'propose_terms',
  'confirm_terms',
  'suggest_odds',
] as const satisfies readonly WebhookToolName[];
const VARS = {
  bet_id: '00000000-0000-4000-8000-0000000000aa',
  party_a_name: 'Logan',
  party_b_name: 'Jake',
  max_stake_usd: '20',
};

const PROPOSE_SAY =
  'Jake lands a water bottle flip upright on the table. One try. No. Only upright on its base counts. Logan puts in fifteen, Jake puts in five; winner takes twenty.';
const SUGGEST_SAY =
  "Jake is 10 for 12 on bottle flips, and 12-4 against Logan. I'd make it two to one: Logan puts in five, Jake puts in ten. Both agree?";
const MOCKS = {
  propose_terms: {
    default_return_value: JSON.stringify({
      ok: true,
      rev: 1,
      say: PROPOSE_SAY,
      odds: 'tap_accept',
      next: 'readback',
    }),
    default_is_error: false,
  },
  confirm_terms: {
    default_return_value: JSON.stringify({
      ok: false,
      fix: 'ODDS_PENDING',
      say: 'Odds first. Both of you tap Accept on your phones.',
    }),
    default_is_error: false,
  },
  suggest_odds: {
    default_return_value: JSON.stringify({
      ok: true,
      ratio: '2:1',
      a: '$5',
      b: '$10',
      pct: 69,
      say: SUGGEST_SAY,
    }),
    default_is_error: false,
  },
};

interface Turn {
  role: 'user' | 'agent';
  message?: string | null;
  tool_calls?: Array<{ tool_name: string; params_as_json: string }>;
}

// Scenario 3 picks up after the 3:1 read-back ("make it two to one" -> a re-propose at 10/5).
const PROPOSE_SAY_2 =
  'Jake lands a water bottle flip upright on the table. One try. No. Only upright on its base counts. Logan puts in ten, Jake puts in five; winner takes fifteen.';
const FIRST_ARGS = {
  conversation_id: 'sim',
  bet_id: '00000000-0000-4000-8000-0000000000aa',
  type: 'skill',
  claim: 'Jake lands a water bottle flip upright on the table.',
  performer: 'B',
  yes_party: 'B',
  attempts: { count: 1, rule: 'single' },
  success_criteria: ['The bottle lands upright on its base on the table.'],
  failure_criteria: ['The bottle lands on its cap or side.'],
  edge_cases: [
    { question: 'Does landing on the cap count?', answer: 'No. Only upright on its base counts.' },
  ],
  amount_usd: '15',
  stake_b_usd: '5',
  market_side: 'none',
  deadline_minutes: 0,
};
const AFTER_3_TO_1 = [
  {
    role: 'user',
    time_in_call_secs: 0,
    message:
      "Judge! Logan bets Jake can't land a bottle flip upright on the table. I'll give you three to one: my fifteen against your five. Cap doesn't count, one try.",
  },
  {
    role: 'agent',
    time_in_call_secs: 4,
    message: null,
    tool_calls: [
      {
        type: 'webhook',
        request_id: 'req-1',
        tool_name: 'propose_terms',
        params_as_json: JSON.stringify(FIRST_ARGS),
        tool_has_been_called: true,
      },
    ],
    tool_results: [
      {
        type: 'webhook',
        request_id: 'req-1',
        tool_name: 'propose_terms',
        result_value: MOCKS.propose_terms.default_return_value,
        is_error: false,
        tool_has_been_called: true,
      },
    ],
  },
  {
    role: 'agent',
    time_in_call_secs: 6,
    message: `${PROPOSE_SAY} Both of you tap Accept on your phones.`,
  },
];

type Mocks = typeof MOCKS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resources to delete in `finally`. */
const made: {
  agent?: string;
  tools: string[];
  toolIds: Record<string, string>;
  secret?: string;
  tests: string[];
} = {
  tools: [],
  toolIds: {},
  tests: [],
};

/** One simulation test on the throwaway agent: create, run, poll, return the transcript. */
async function simulate(
  agentId: string,
  scenario: string,
  firstUserLine: string,
  o: { mocks?: Mocks; history?: unknown[]; conditions?: string[] } = {},
): Promise<Turn[]> {
  const mocks = o.mocks ?? MOCKS;
  const overrides = Object.fromEntries(
    TOOLS.map((name) => [
      made.toolIds[name]!,
      [
        {
          mock_result: mocks[name].default_return_value,
          is_error: false,
          parameter_conditions: [],
        },
      ],
    ]),
  );
  const history = [
    ...(o.history ?? []),
    { role: 'user', time_in_call_secs: (o.history?.length ?? 0) * 3, message: firstUserLine },
  ];
  const test = await el('POST', '/v1/convai/agent-testing/create', {
    type: 'simulation',
    name: `yo-odds-sim-${SFX}-${made.tests.length + 1}`,
    simulation_scenario: `${scenario}\nYour first line has already been said: "${firstUserLine}"`,
    chat_history: history,
    dynamic_variables: VARS,
    simulation_max_turns: 8,
    tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' },
    tool_mock_overrides: overrides,
    success_conditions: o.conditions ?? ['The agent called a tool and spoke its returned "say".'],
  });
  made.tests.push(test.id);
  const inv = await el('POST', `/v1/convai/agents/${agentId}/run-tests`, {
    tests: [{ test_id: test.id }],
  });
  const deadline = Date.now() + 240_000;
  for (;;) {
    const r = await el('GET', `/v1/convai/test-invocations/${inv.id}`);
    const run = r.test_runs?.[0];
    if (run && run.status !== 'pending') {
      log(
        `  test ${run.status}: ${scrub(JSON.stringify(run.condition_result?.rationale ?? null)).slice(0, 300)}`,
      );
      return (run.agent_responses ?? []) as Turn[];
    }
    if (Date.now() > deadline) throw new Error(`test invocation ${inv.id} still pending`);
    await sleep(3_000);
  }
}

const calls = (t: Turn[], name: string) =>
  t.flatMap((x) => x.tool_calls ?? []).filter((c) => c.tool_name === name);
const agentText = (t: Turn[]) =>
  t
    .filter((x) => x.role === 'agent' && x.message)
    .map((x) => x.message!)
    .join(' \n ');
const dump = (t: Turn[]) =>
  t.map(
    (x) =>
      `  ${x.role}: ${x.message ?? ''}${(x.tool_calls ?? []).map((c) => ` [${c.tool_name} ${c.params_as_json}]`).join('')}`,
  );

/**
 * This script runs REAL ElevenLabs agent tests and spends the account's credits. It only runs
 * when that is asked for on purpose (EL_TEST_SPEND=yes): the credits ran out on 2026-11-19 with
 * the voice judge down for the rest of the day.
 */
function requireSpendOptIn(name: string): void {
  if (process.env['EL_TEST_SPEND'] === 'yes') return;
  console.error(
    `${name}: refusing to run. It runs real ElevenLabs agent tests and spends credits. ` +
      'Set EL_TEST_SPEND=yes to run it on purpose.',
  );
  process.exit(2);
}

async function main() {
  requireSpendOptIn('el-sim-odds');
  let failed = 0;
  const check = (ok: boolean, what: string) => {
    log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
    if (!ok) failed++;
  };
  try {
    const secret = await el('POST', '/v1/convai/secrets', {
      type: 'new',
      name: `yo-odds-sim-${SFX}`,
      value: randomBytes(24).toString('base64url'),
    });
    made.secret = secret.secret_id;
    for (const name of TOOLS) {
      const t = await el(
        'POST',
        '/v1/convai/tools',
        toolRequest(webhookToolConfig(name, `https://odds-sim-${SFX}.invalid`, made.secret!)),
      );
      made.tools.push(t.id);
      made.toolIds[name] = t.id;
    }
    const promptTools = new Set<JudgeToolName>(TOOLS);
    const body = agentBody({ toolIds: made.tools, promptTools, retentionDays: 1 });
    const agent = await el('POST', '/v1/convai/agents/create', {
      ...body,
      name: `youre-on-judge-odds-sim-${SFX}`,
      tags: ['youre-on-sim'],
    });
    made.agent = agent.agent_id;
    log(`created agent ${made.agent}, tools ${made.tools.join(',')}, secret ${made.secret}`);

    // 1. odds talk -> propose_terms with both stakes
    const t1 = await simulate(
      made.agent!,
      'You play two friends, Logan (the challenger) and Jake, in front of a bet judge. Logan bets Jake cannot land a water bottle flip upright on the table, one try, landing on the cap does not count. Logan offers odds: three to one, his fifteen dollars against Jake\'s five. Answer any question in a few words. When the judge reads the terms back, say "Yes, we are both in." Stop after that.',
      "Judge! Logan bets Jake can't land a bottle flip upright on the table. I'll give you three to one: my fifteen against your five. Cap doesn't count, one try.",
    );
    log('transcript 1:');
    for (const l of dump(t1)) log(l);
    const p = calls(t1, 'propose_terms').map((c) => JSON.parse(c.params_as_json));
    check(p.length > 0, 'scenario 1: propose_terms was called');
    check(
      p.some((x) => String(x.amount_usd) === '15' && String(x.stake_b_usd) === '5'),
      'scenario 1: amount_usd "15" and stake_b_usd "5"',
    );
    check(
      /fifteen/i.test(agentText(t1)) && /five/i.test(agentText(t1)),
      'scenario 1: the agent read both stakes back',
    );

    // 2. "what odds are fair?" -> suggest_odds
    const t2 = await simulate(
      made.agent!,
      'You play two friends, Logan (the challenger) and Jake. The bet: Jake lands a water bottle flip upright on the table, one try, five dollars each. You want the judge to set fair odds. Ask once "Judge, what odds are fair?", then when the judge suggests odds say "Sounds fair." Stop after that.',
      "Logan bets Jake can't land a water bottle flip upright on the table, one try, five dollars each. Judge, what odds are fair?",
    );
    log('transcript 2:');
    for (const l of dump(t2)) log(l);
    const s = calls(t2, 'suggest_odds').map((c) => JSON.parse(c.params_as_json));
    check(s.length > 0, 'scenario 2: suggest_odds was called');
    check(
      s.some((x) => x.performer === 'B' && /bottle/i.test(String(x.claim ?? ''))),
      'scenario 2: performer B, claim mentions the bottle',
    );
    const said = agentText(t2);
    check(
      /10 for 12|ten for twelve/i.test(said) && /two to one/i.test(said),
      'scenario 2: the agent spoke the suggestion',
    );
    check(/agree|deal|in\?/i.test(said), 'scenario 2: the agent asked whether both agree');
    const invented = (said.match(/\b\d+\b/g) ?? []).filter(
      (n) => !['10', '12', '4', '5', '2', '1', '69'].includes(n),
    );
    check(
      invented.length === 0,
      `scenario 2: no invented numbers (${invented.join(',') || 'none'})`,
    );

    // 3. "make it two to one" after the 3:1 read-back -> propose_terms again at 10 / 5
    const mocks3 = {
      ...MOCKS,
      propose_terms: {
        default_return_value: JSON.stringify({
          ok: true,
          rev: 2,
          say: PROPOSE_SAY_2,
          odds: 'tap_accept',
          next: 'readback',
        }),
        default_is_error: false,
      },
    };
    const t3 = await simulate(
      made.agent!,
      'You play Logan and Jake, two friends at a bet judge. The judge just read back a three to one bet. Change it: say "Actually, make it two to one. My ten against your five." When the judge reads the new terms back, say "Yes, we are both in." Stop after that.',
      'Actually, make it two to one. My ten against your five.',
      { mocks: mocks3, history: AFTER_3_TO_1 },
    );
    log('transcript 3:');
    for (const l of dump(t3)) log(l);
    const p3 = calls(t3, 'propose_terms').map((c) => JSON.parse(c.params_as_json));
    check(
      p3.some((x) => String(x.amount_usd) === '10' && String(x.stake_b_usd) === '5'),
      'scenario 3: re-proposed with amount_usd "10" and stake_b_usd "5"',
    );
    check(
      /ten/i.test(agentText(t3)) && /fifteen/i.test(agentText(t3)),
      'scenario 3: the agent read the new stakes back (ten, five; winner takes fifteen)',
    );
  } finally {
    // Delete everything this run created: tests, the agent, the tools (force: the deleted
    // agent's branch can still reference them), then the secret (retried until unreferenced).
    const del = async (what: string, path: string, tries = 1) => {
      for (let i = 1; ; i++) {
        try {
          await el('DELETE', path);
          log(`deleted ${what} ${path.split('/').pop()!.split('?')[0]}`);
          return;
        } catch (e) {
          if (i >= tries) {
            log(`COULD NOT DELETE ${what} ${path}: ${(e as Error).message}`);
            failed++;
            return;
          }
          await sleep(3_000);
        }
      }
    };
    for (const id of made.tests) await del('test', `/v1/convai/agent-testing/${id}`);
    if (made.agent) await del('agent', `/v1/convai/agents/${made.agent}`);
    for (const id of made.tools) await del('tool', `/v1/convai/tools/${id}?force=true`, 3);
    if (made.secret) await del('secret', `/v1/convai/secrets/${made.secret}`, 5);
  }
  if (failed) {
    log(`${failed} check(s) failed`);
    process.exit(1);
  }
  log('all checks passed');
}

main().catch((e: unknown) => {
  log(`el-sim-odds: ${(e as Error).message}`);
  process.exit(1);
});
