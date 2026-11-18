#!/usr/bin/env -S npx tsx
// compile_checks eval (design final.md §1 "Compilation"): run the PRODUCTION compiler
// (apps/server/src/judge/compile-checks.ts, its prompt and few-shots) over HELD-OUT bets
// (apps/server/src/judge/checks-heldout.ts, none of them in the few-shots) and score each answer
// against loose expectations: decision, predicates that must / must not appear, allowed entity
// prompts, movers that must not be gated, and whether a model call was made at all.
//
//   npm run checks-eval -- [--mock] [--only <id>] [--json <file>] [--model <id>]
//   --mock   no network: a scripted fake answers each bet with its canned mock_output (checks the
//            wiring, the prompt build and the scoring; not the model).
//   live     (default) one Anthropic call per bet (two when the first answer fails validation).
//            Needs ANTHROPIC_API_KEY (read from apps/server/.env by the npm script). Costs money.
// Uses env CHECKS_MODEL (default claude-opus-5-5) unless --model. The key is never printed.
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../apps/server/src/env';
import { createLogger } from '../apps/server/src/log';
import { MockLlm, type MockReply } from '../apps/server/src/providers/mock/llm';
import { createProviders } from '../apps/server/src/providers/registry';
import type { ChatRequest } from '../apps/server/src/providers/types';
import { FEW_SHOTS } from '../apps/server/src/judge/checks-fewshots';
import { HELD_OUT, scoreHeldOut, type HeldOutBet } from '../apps/server/src/judge/checks-heldout';
import { compileChecks, type CompileChecksResult } from '../apps/server/src/judge/compile-checks';
import { buildCompilePrompt, PROMPT_VERSION } from '../apps/server/src/judge/compile-checks-prompt';
import { parseCli, run } from './lib/cli';

const USAGE = `usage: npm run checks-eval -- [--mock] [--only <id>] [--json <file>] [--model <id>]
Live mode needs ANTHROPIC_API_KEY and makes one Anthropic call per bet (two on a retry).`;

/** The fake for --mock: finds the bet by the claim in the last text part, answers its mock_output. */
function mockResponder(bets: readonly HeldOutBet[]) {
  return (req: ChatRequest<unknown>): MockReply => {
    const last = req.parts.at(-1);
    const text = last?.kind === 'text' ? last.text : '';
    const bet = bets.find((b) => text.includes(JSON.stringify(b.input.claim)));
    if (!bet) return { fail: 'error', message: 'mock: no held-out bet matches this prompt' };
    return { value: bet.mock_output };
  };
}

interface Row {
  id: string;
  expected: string;
  got: string;
  predicates: string;
  prompts: string;
  checks: { name: string; pass: boolean; detail: string }[];
  pass: boolean;
  latency_ms: number;
  attempts: number;
  status: string;
  why: string;
  error?: string;
  spec: CompileChecksResult['spec'];
}

const SHORT: Record<string, string> = {
  decision: 'dec',
  must_include: 'inc',
  must_not_include: 'exc',
  prompts: 'prm',
  gates: 'gate',
  calls: 'call',
};
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

run(async () => {
  const { values } = parseCli(USAGE, {
    mock: { type: 'boolean' },
    only: { type: 'string' },
    json: { type: 'string' },
    model: { type: 'string' },
  });
  const mock = values.mock === true;

  // Held-out must stay out of the few-shots (also enforced by the server tests).
  const fsIds = new Set(FEW_SHOTS.map((f) => f.id));
  const fsClaims = new Set(FEW_SHOTS.map((f) => f.input.claim));
  const leak = HELD_OUT.filter((b) => fsIds.has(b.id) || fsClaims.has(b.input.claim));
  if (leak.length)
    throw new Error(`held-out bets in FEW_SHOTS: ${leak.map((b) => b.id).join(', ')}`);

  const bets = values.only ? HELD_OUT.filter((b) => b.id === values.only) : [...HELD_OUT];
  if (!bets.length)
    throw new Error(
      `no held-out bet '${values.only}' (have: ${HELD_OUT.map((b) => b.id).join(', ')})`,
    );

  const key = process.env.ANTHROPIC_API_KEY;
  if (!mock && !key) {
    console.error(
      'checks-eval: ANTHROPIC_API_KEY is not set (put it in apps/server/.env), or pass --mock',
    );
    process.exit(2);
  }
  const env = loadEnv({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/none',
    LLM_PROVIDER: 'live',
    ALLOW_SPEND: 'true',
    ANTHROPIC_API_KEY: mock ? 'mock-run' : key,
    CHECKS_MODEL: values.model ?? process.env.CHECKS_MODEL,
  });
  const providers = createProviders(
    env,
    mock ? { overrides: { llm: new MockLlm(mockResponder(bets)) } } : {},
  );
  const deps = { env, providers, log: createLogger('warn') };

  const calls = bets.filter((b) => b.expect.model_calls > 0).length;
  const sample = buildCompilePrompt(bets[0]!.input);
  console.log(
    `checks-eval: ${bets.length} held-out bets, model ${env.CHECKS_MODEL}, prompt ${PROMPT_VERSION} ` +
      `(${FEW_SHOTS.length} few-shots, stable prefix ${sample.chars.stable} chars, bet part ~${sample.chars.bet} chars)`,
  );
  console.log(
    mock
      ? `MOCK: ${calls} scripted calls, no network.`
      : `LIVE: ${calls} Anthropic calls (up to ${calls * 2} with retries) to ${env.CHECKS_MODEL}.`,
  );

  const rows: Row[] = [];
  for (const bet of bets) {
    // No cache: every run measures the model.
    const r = await compileChecks(deps, bet.input, { cache: null });
    const checks = scoreHeldOut(bet, r);
    rows.push({
      id: bet.id,
      expected: bet.expect.decision,
      got: r.decision,
      predicates:
        r.spec?.assertions.map((a) => `${a.role === 'gate' ? 'G:' : ''}${a.test.p}`).join(' ') ??
        '-',
      prompts: r.spec?.entities.map((e) => `${e.prompt}×${e.count}`).join(', ') ?? '-',
      checks,
      pass: checks.every((c) => c.pass),
      latency_ms: r.latency_ms,
      attempts: r.attempts,
      status: r.status,
      why: r.why,
      ...(r.error ? { error: r.error } : {}),
      spec: r.spec,
    });
  }

  console.log('');
  console.log(
    `${pad('id', 26)} ${pad('exp/got', 22)} ${pad('predicates', 44)} ${pad('dec inc exc prm gate call', 32)} ${pad('ms', 6)} try`,
  );
  for (const r of rows) {
    const marks = r.checks.map((c) => `${SHORT[c.name] ?? c.name}${c.pass ? '+' : '-'}`).join(' ');
    console.log(
      `${pad(r.id, 26)} ${pad(`${r.expected}/${r.got}`, 22)} ${pad(r.predicates, 44)} ${pad(marks, 32)} ${pad(String(r.latency_ms), 6)} ${r.attempts}${r.status === 'fallback' ? ' FALLBACK' : ''}`,
    );
    for (const c of r.checks.filter((c) => !c.pass)) console.log(`    FAIL ${c.name}: ${c.detail}`);
    if (r.error) console.log(`    error: ${r.error}`);
  }
  const passed = rows.filter((r) => r.pass).length;
  const decisions = rows.filter((r) => r.expected === r.got).length;
  const fallbacks = rows.filter((r) => r.status === 'fallback').length;
  const retries = rows.filter((r) => r.attempts > 1).length;
  const lat = rows
    .filter((r) => r.attempts > 0)
    .map((r) => r.latency_ms)
    .sort((a, b) => a - b);
  console.log('');
  console.log(
    `summary: ${passed}/${rows.length} bets pass every expectation; decision ${decisions}/${rows.length}; ` +
      `fallbacks ${fallbacks}; retries ${retries}; latency median ${lat[Math.floor(lat.length / 2)] ?? '-'} ms, ` +
      `max ${lat.at(-1) ?? '-'} ms; prompt ${PROMPT_VERSION}; model ${env.CHECKS_MODEL}${mock ? ' (mock)' : ''}`,
  );
  if (values.json) {
    writeFileSync(
      values.json,
      JSON.stringify(
        {
          prompt_version: PROMPT_VERSION,
          model: env.CHECKS_MODEL,
          mock,
          at: new Date().toISOString(),
          rows,
        },
        null,
        2,
      ),
    );
    console.log(`wrote ${values.json}`);
  }
  if (passed !== rows.length) process.exitCode = 1;
});
