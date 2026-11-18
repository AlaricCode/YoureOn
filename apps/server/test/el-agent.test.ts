/* eslint-disable @typescript-eslint/no-explicit-any -- OpenAPI fragments and plan bodies are untyped JSON */
// scripts/el-agent.ts, ready for the key: the CLI (flags + env), the dry run (what the judge will
// be, never the secret value), and every body it sends checked against ElevenLabs' own OpenAPI
// schema (test/fixtures/elevenlabs-openapi-subset.json, refreshed by scripts/el-openapi-subset.ts)
// so a misspelt field or an LLM ElevenLabs does not serve fails here, not at 3 AM. No network.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_LLM,
  DEFAULT_WEBHOOK_TOOLS,
  WEBHOOK_TOOL_SPECS,
} from '@youre-on/shared/judge/el-config';
import {
  EL_AGENT_LLMS,
  EL_REASONING_EFFORTS,
  EL_TTS_MODELS,
} from '@youre-on/shared/judge/el-enums';
import {
  agentIdLines,
  parseAgentCli,
  PLACEHOLDER_BASE_URL,
  planSummary,
} from '../src/voice/agent-cli';
import { dryRunPlan, isSubset, type SyncAction } from '../src/voice/agent-sync';
import {
  checkPlan,
  checkValue,
  pathTemplate,
  plannedRequests,
  requestBodySchema,
  type OpenApiDoc,
} from '../src/voice/openapi-check';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../../..');
const SUBSET = join(here, 'fixtures/elevenlabs-openapi-subset.json');
const doc = JSON.parse(readFileSync(SUBSET, 'utf8')) as OpenApiDoc;

const SECRET = 'Zk9-the-tool-secret-value';
const BASE = 'https://youre-on.fly.dev';
const ENV = {
  ELEVENLABS_API_KEY: 'xi-not-a-real-key',
  ELEVENLABS_TOOL_SECRET: SECRET,
  PUBLIC_BASE_URL: BASE,
};

const planFor = (argv: string[] = [], env: Record<string, string | undefined> = ENV) => {
  const r = parseAgentCli(argv, env);
  if (!r.ok) throw new Error(r.error);
  return dryRunPlan(r.cli.opts);
};
const errorsOf = (plan: SyncAction[]) => checkPlan(doc, plan).flatMap((r) => r.errors);
const agentBodyOf = (plan: SyncAction[]) => plan.find((a) => a.resource === 'agent')!.body as any;

/** The enum the OpenAPI fragment gives for a property, wherever it sits (anyOf / $ref inlined). */
function enumAt(node: any, prop: string): string[] | null {
  if (!node || typeof node !== 'object') return null;
  if (node.properties?.[prop]) {
    const found = findEnum(node.properties[prop]);
    if (found) return found;
  }
  for (const v of Object.values(node)) {
    const e = enumAt(v, prop);
    if (e) return e;
  }
  return null;
}
function findEnum(node: any): string[] | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.enum)) return node.enum;
  for (const k of ['anyOf', 'oneOf', 'allOf'])
    for (const alt of node[k] ?? []) {
      const e = findEnum(alt);
      if (e) return e;
    }
  return null;
}

describe('el-agent bodies vs the ElevenLabs OpenAPI schema (fixture, offline)', () => {
  it('the default plan (secret, 2 webhook + 3 client tools, agent) and its PATCH twins conform', () => {
    const plan = planFor();
    const reqs = plannedRequests(plan);
    expect(reqs.map((r) => `${r.method} ${pathTemplate(doc, r.path)}`)).toEqual([
      'POST /v1/convai/secrets',
      'PATCH /v1/convai/secrets/{secret_id}',
      ...[...DEFAULT_WEBHOOK_TOOLS, 'request_attempt', 'show_terms_card', 'cue'].flatMap(() => [
        'POST /v1/convai/tools',
        'PATCH /v1/convai/tools/{tool_id}',
      ]),
      'POST /v1/convai/agents/create',
      'PATCH /v1/convai/agents/{agent_id}',
    ]);
    for (const r of checkPlan(doc, plan)) expect([r.label, r.errors]).toEqual([r.label, []]);
  });

  it('every webhook tool, a judge voice, flash TTS and every effort conform too', () => {
    const all = Object.keys(WEBHOOK_TOOL_SPECS).join(',');
    expect(errorsOf(planFor([`--tools=${all}`, '--tts-model=eleven_flash_v2']))).toEqual([]);
    expect(
      errorsOf(planFor([], { ...ENV, ELEVENLABS_JUDGE_VOICE_ID: 'voice_judge_placeholder' })),
    ).toEqual([]);
    for (const e of [...EL_REASONING_EFFORTS, 'omit'])
      expect([e, errorsOf(planFor([`--reasoning-effort=${e}`]))]).toEqual([e, []]);
  });

  it('the strict check catches what the API would drop or reject', () => {
    const plan = planFor();
    const agent = structuredClone(agentBodyOf(plan));
    const schema = requestBodySchema(doc, 'POST', '/v1/convai/agents/create')!;
    expect(checkValue(doc, agent, schema, 'agent')).toEqual([]);
    agent.conversation_config.agent.prompt.temprature = 0; // a typo the API would ignore
    agent.conversation_config.agent.prompt.llm = 'claude-haiku-9';
    agent.conversation_config.tts.model_id = 'eleven_v9';
    agent.conversation_config.turn.turn_eagerness = 'sometimes';
    agent.conversation_config.conversation.max_duration_seconds = '1200';
    const errs = checkValue(doc, agent, schema, 'agent');
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /agent\.conversation_config\.agent\.prompt: unknown field "temprature"/,
        ),
        expect.stringMatching(/prompt\.llm: "claude-haiku-9" is not one of/),
        expect.stringMatching(/tts\.model_id: "eleven_v9" is not one of/),
        expect.stringMatching(/turn\.turn_eagerness: "sometimes" is not one of/),
        expect.stringMatching(/max_duration_seconds: string, expected integer/),
      ]),
    );
    const tool = structuredClone((plan[1]!.body as any).tool_config);
    tool.api_schema.request_body_schema.properties.claim.pattern = '^x';
    expect(
      checkValue(
        doc,
        { tool_config: tool },
        requestBodySchema(doc, 'POST', '/v1/convai/tools')!,
        'tool',
      ),
    ).toEqual([expect.stringMatching(/properties\.claim: unknown field "pattern"/)]);
  });

  it('the enum snapshots in shared/judge/el-enums match the schema', () => {
    expect(enumAt(doc, 'llm')).toEqual([...EL_AGENT_LLMS]);
    expect(enumAt(doc, 'reasoning_effort')).toEqual([...EL_REASONING_EFFORTS]);
    expect(enumAt(doc, 'model_id')).toEqual([...EL_TTS_MODELS]);
    // The judge's model is one ElevenLabs serves.
    expect(EL_AGENT_LLMS).toContain(DEFAULT_AGENT_LLM);
    expect(EL_AGENT_LLMS).toContain('claude-haiku-4-5'); // the documented A/B fallback
  });

  it('pathTemplate: the literal route wins over a parameter (agents/create, not {agent_id})', () => {
    expect(pathTemplate(doc, '/v1/convai/agents/create')).toBe('/v1/convai/agents/create');
    expect(pathTemplate(doc, '/v1/convai/agents/agent_123')).toBe('/v1/convai/agents/{agent_id}');
    expect(pathTemplate(doc, '/v1/convai/nope')).toBeNull();
  });
});

describe('el-agent CLI (flags + env)', () => {
  it('defaults: the Haiku 5.5 judge, effort low, the two live webhook tools, the Fly URLs', () => {
    const plan = planFor();
    const prompt = agentBodyOf(plan).conversation_config.agent.prompt;
    expect(prompt).toMatchObject({
      llm: 'claude-haiku-5-5',
      reasoning_effort: 'low',
      temperature: null,
    });
    const urls = plan
      .filter((a) => a.resource === 'tool')
      .map((a) => (a.body as any).tool_config.api_schema?.url)
      .filter(Boolean);
    expect(urls).toEqual([`${BASE}/el/tools/propose_terms`, `${BASE}/el/tools/confirm_terms`]);
    // Every route a registered webhook tool names exists on the server (src/voice/routes.ts).
    const routes = readFileSync(join(here, '../src/voice/routes.ts'), 'utf8');
    for (const t of DEFAULT_WEBHOOK_TOOLS) expect(routes).toContain(`'/el/tools/${t}'`);
  });

  it('the LLM is configurable (flag or ELEVENLABS_AGENT_LLM) and must be one ElevenLabs serves', () => {
    expect(
      agentBodyOf(planFor(['--llm=claude-haiku-4-5'])).conversation_config.agent.prompt.llm,
    ).toBe('claude-haiku-4-5');
    expect(
      agentBodyOf(planFor([], { ...ENV, ELEVENLABS_AGENT_LLM: 'gemini-3.5-flash' }))
        .conversation_config.agent.prompt.llm,
    ).toBe('gemini-3.5-flash');
    const bad = parseAgentCli(['--llm=claude-haiku-9'], ENV);
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.error).toMatch(/not in ElevenLabs' LLM enum.*claude-haiku-5-5/);
    const forced = parseAgentCli(['--llm=claude-haiku-9', '--llm-unchecked'], ENV);
    expect(forced.ok && forced.cli.notes.join()).toMatch(/not in the 2026-11-18 enum snapshot/);
    // Claude has no "none"/"minimal" effort: allowed (ElevenLabs lists them) but flagged.
    const none = parseAgentCli(['--reasoning-effort=none'], ENV);
    expect(none.ok && none.cli.notes.join()).toMatch(/Anthropic API has no such effort/);
  });

  it('refuses what cannot work: bad flags, a non-https or private base URL, missing keys', () => {
    const err = (argv: string[], env: Record<string, string | undefined> = ENV) => {
      const r = parseAgentCli(argv, env);
      return r.ok ? null : r.error;
    };
    expect(err(['--nope'])).toMatch(/unknown flag --nope/);
    expect(err(['stray'])).toMatch(/unknown argument/);
    expect(err(['--tools=propose_terms,launch_missiles'])).toMatch(/unknown webhook tool/);
    expect(err(['--tts-model=eleven_v9'])).toMatch(/--tts-model/);
    expect(err(['--reasoning-effort=extreme'])).toMatch(/--reasoning-effort/);
    expect(err(['--retention-days=1.5'])).toMatch(/--retention-days/);
    expect(err([], { ...ENV, PUBLIC_BASE_URL: 'http://youre-on.fly.dev' })).toMatch(/https/);
    expect(err([], { ...ENV, PUBLIC_BASE_URL: 'https://localhost:8080' })).toMatch(/not reachable/);
    expect(err([], { ...ENV, PUBLIC_BASE_URL: undefined })).toMatch(/PUBLIC_BASE_URL is not set/);
    expect(err([], { ...ENV, ELEVENLABS_API_KEY: '' })).toMatch(/ELEVENLABS_API_KEY/);
    expect(err([], { ...ENV, ELEVENLABS_TOOL_SECRET: undefined })).toMatch(
      /ELEVENLABS_TOOL_SECRET/,
    );
    // A dry run needs neither key nor URL.
    const dry = parseAgentCli(['--dry-run'], {});
    expect(dry.ok && dry.cli.opts.baseUrl).toBe(PLACEHOLDER_BASE_URL);
    expect(parseAgentCli(['--check-openapi'], ENV)).toMatchObject({
      ok: true,
      cli: { checkOpenapi: 'https://api.elevenlabs.io/openapi.json' },
    });
  });

  it('the summary names the model, voice, URLs and the secret by reference only', () => {
    const lines = planSummary(
      planFor([], { ...ENV, ELEVENLABS_JUDGE_VOICE_ID: 'voice_judge' }),
    ).join('\n');
    expect(lines).toContain(
      'llm             claude-haiku-5-5  reasoning_effort=low  temperature=omitted',
    );
    expect(lines).toContain('voice           voice_judge  tts=eleven_v4_turbo');
    expect(lines).toContain(
      "Order. Court is in session. {{party_a_name}}, {{party_b_name}}: what's the bet?",
    );
    expect(lines).toContain(
      `POST ${BASE}/el/tools/propose_terms  [X-YO-Tool-Secret: {secret_id of yo-tool-secret}]`,
    );
    expect(lines).toContain('# What you refuse');
    expect(lines).toContain('client tool     request_attempt  expects_response=true');
    expect(lines).not.toContain(SECRET);
  });

  it('ELEVENLABS_AGENT_ID lines: unknown on a dry run; the id + the fly command after a run', () => {
    expect(agentIdLines(null, undefined)[0]).toMatch(/^ELEVENLABS_AGENT_ID=<the agent_id/);
    expect(agentIdLines('agent_1', undefined)).toEqual([
      'ELEVENLABS_AGENT_ID=agent_1',
      'next: fly secrets set ELEVENLABS_AGENT_ID=agent_1 -a youre-on   (and ELEVENLABS_AGENT_ID=agent_1 in apps/server/.env)',
    ]);
    expect(agentIdLines('agent_1', 'agent_0')[1]).toMatch(/^warning: .*agent_0, not agent_1/);
  });

  it('ElevenLabs returning tool_ids / client_events in another order is not a change', () => {
    expect(isSubset({ tool_ids: ['a', 'b'] }, { tool_ids: ['b', 'a'] })).toBe(true);
    expect(isSubset({ tool_ids: ['a', 'b'] }, { tool_ids: ['b', 'c'] })).toBe(false);
    expect(isSubset({ fillers: ['a', 'b'] }, { fillers: ['b', 'a'] })).toBe(false); // ordered
  });
});

/** Runs the real script (tsx) with a clean env: nothing here reaches ElevenLabs. */
function runScript(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/el-agent.ts', ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += String(d)));
    p.stderr.on('data', (d) => (stderr += String(d)));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('scripts/el-agent.ts --dry-run (subprocess)', () => {
  it('prints the exact JSON plan on stdout, the summary + agent id line on stderr, never the secret', async () => {
    const r = await runScript(['--dry-run', `--check-openapi=${SUBSET}`], ENV);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout) as SyncAction[];
    expect(plan).toEqual(planFor());
    expect(r.stderr).toContain('every body matches');
    expect(r.stderr).toMatch(/^ELEVENLABS_AGENT_ID=<the agent_id/m);
    expect(r.stderr).toContain(`POST ${BASE}/el/tools/confirm_terms`);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout + r.stderr).not.toContain(ENV.ELEVENLABS_API_KEY);
  }, 30_000);

  it('exits 1 with a reason (and sends nothing) on a bad flag or an off-schema body', async () => {
    const bad = await runScript(['--llm=claude-haiku-9'], ENV);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/el-agent: --llm: claude-haiku-9 is not in ElevenLabs' LLM enum/);
    // --llm-unchecked lets it past the CLI, and the schema check then stops it.
    const off = await runScript(
      ['--dry-run', '--llm=claude-haiku-9', '--llm-unchecked', `--check-openapi=${SUBSET}`],
      ENV,
    );
    expect(off.code).toBe(1);
    expect(off.stderr).toMatch(/openapi FAIL POST \/v1\/convai\/agents\/create/);
    expect(off.stderr).toMatch(/mismatch\(es\).*nothing was sent/);
  }, 30_000);
});
