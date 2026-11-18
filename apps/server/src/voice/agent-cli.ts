// The pure half of scripts/el-agent.ts: flags + env -> SyncOptions, and the text it prints.
// Kept here (not in the script) so it is unit-tested without spawning anything.
import {
  DEFAULT_AGENT_LLM,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TTS_MODEL,
  DEFAULT_WEBHOOK_TOOLS,
  TOOL_SECRET_HEADER,
  TOOL_SECRET_NAME,
  WEBHOOK_TOOL_SPECS,
  type WebhookToolName,
} from '@youre-on/shared/judge/el-config';
import {
  EL_AGENT_LLMS,
  EL_REASONING_EFFORTS,
  EL_TTS_MODELS,
  type ElReasoningEffort,
  type ElTtsModel,
} from '@youre-on/shared/judge/el-enums';
import { FIRST_MESSAGE, JUDGE_AGENT_NAME } from '@youre-on/shared/judge/persona';
import type { SyncAction, SyncOptions } from './agent-sync';
import { publicBaseUrlProblem } from './readiness';

export const ELEVENLABS_OPENAPI_URL = 'https://api.elevenlabs.io/openapi.json';
/** Placeholder base URL a dry run uses when PUBLIC_BASE_URL is unset. */
export const PLACEHOLDER_BASE_URL = 'https://<app>.fly.dev';

const KNOWN_FLAGS = [
  'dry-run',
  'rotate-secret',
  'tools',
  'llm',
  'llm-unchecked',
  'reasoning-effort',
  'tts-model',
  'retention-days',
  'check-openapi',
  'agent-name',
] as const;

export const USAGE = `usage: npx tsx --env-file-if-exists=apps/server/.env scripts/el-agent.ts [flags]

Creates or updates (find by name, PATCH only what differs) the workspace secret, the webhook
and client tools and the private judge agent; prints ELEVENLABS_AGENT_ID. A second run without
--rotate-secret is a no-op ("no changes (no-op)"); with it the secret is PATCHed every time.

env: ELEVENLABS_API_KEY, ELEVENLABS_TOOL_SECRET, PUBLIC_BASE_URL (https),
     optional ELEVENLABS_JUDGE_VOICE_ID, ELEVENLABS_AGENT_LLM (default ${DEFAULT_AGENT_LLM})

  --dry-run                 print the plan (summary on stderr, exact JSON bodies on stdout);
                            no ElevenLabs call, no key needed; the secret value is never printed
  --check-openapi[=<f|url>] check every body against ElevenLabs' public OpenAPI document
                            (default ${ELEVENLABS_OPENAPI_URL}; no key) and stop on a mismatch
  --rotate-secret           PATCH the workspace secret to ELEVENLABS_TOOL_SECRET (always one
                            write: the stored value is write-only, so it cannot be compared)
  --tools=a,b               webhook tools (default ${DEFAULT_WEBHOOK_TOOLS.join(',')})
  --llm=<id>                agent LLM (default ELEVENLABS_AGENT_LLM or ${DEFAULT_AGENT_LLM});
                            must be in ElevenLabs' LLM enum unless --llm-unchecked
  --reasoning-effort=<e>    ${EL_REASONING_EFFORTS.join('|')}|omit (default ${DEFAULT_REASONING_EFFORT})
  --tts-model=<id>          ${EL_TTS_MODELS.join('|')} (default ${DEFAULT_TTS_MODEL})
  --retention-days=<n>      conversation retention (default 1)
  --agent-name=<name>       a throwaway TEST agent of that name (default ${JUDGE_AGENT_NAME}, the live
                            judge). Tools and the secret are shared with the live judge, so this
                            never PATCHes them (a tool that differs stops the run); it creates only
                            what is missing plus its own agent (tags youre-on,test). Delete it
                            in the dashboard when done. Never set ELEVENLABS_AGENT_ID to it.`;

export interface AgentCli {
  dryRun: boolean;
  /** undefined = no OpenAPI check; otherwise a file path or URL. */
  checkOpenapi?: string;
  opts: Omit<SyncOptions, 'log'>;
  /** Printed to stderr before anything runs. */
  notes: string[];
}

export type ParseResult = { ok: true; cli: AgentCli } | { ok: false; error: string };

function flags(argv: readonly string[]): Record<string, string | true> | string {
  const out: Record<string, string | true> = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) return `unknown argument: ${a}`;
    if (!(KNOWN_FLAGS as readonly string[]).includes(m[1]!)) return `unknown flag --${m[1]}`;
    out[m[1]!] = m[2] ?? true;
  }
  return out;
}

/** argv (without node + script) and env -> what el-agent will do, or the error to exit with. */
export function parseAgentCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseResult {
  const f = flags(argv);
  if (typeof f === 'string') return { ok: false, error: f };
  const fail = (error: string): ParseResult => ({ ok: false, error });
  const get = (k: string) => (env[k] ? env[k] : undefined);
  const dryRun = f['dry-run'] === true;
  const notes: string[] = [];

  const tools = typeof f.tools === 'string' ? f.tools.split(',').map((s) => s.trim()) : undefined;
  for (const t of tools ?? [])
    if (!(t in WEBHOOK_TOOL_SPECS)) return fail(`--tools: unknown webhook tool ${t}`);

  const llm =
    typeof f.llm === 'string' ? f.llm : (get('ELEVENLABS_AGENT_LLM') ?? DEFAULT_AGENT_LLM);
  if (!llm) return fail('--llm: empty');
  if (!(EL_AGENT_LLMS as readonly string[]).includes(llm)) {
    if (f['llm-unchecked'] !== true)
      return fail(
        `--llm: ${llm} is not in ElevenLabs' LLM enum (snapshot 2026-11-18; Claude options: ${EL_AGENT_LLMS.filter((m) => m.startsWith('claude-') && !m.includes('@')).join(', ')}). Pass --llm-unchecked if ElevenLabs added it since.`,
      );
    notes.push(`--llm ${llm} is not in the 2026-11-18 enum snapshot (--llm-unchecked)`);
  }

  let reasoningEffort: ElReasoningEffort | null | undefined;
  const effort = f['reasoning-effort'];
  if (effort === 'omit') reasoningEffort = null;
  else if (typeof effort === 'string') {
    if (!(EL_REASONING_EFFORTS as readonly string[]).includes(effort))
      return fail(`--reasoning-effort: ${EL_REASONING_EFFORTS.join('|')}|omit`);
    reasoningEffort = effort as ElReasoningEffort;
  } else if (effort === true) return fail('--reasoning-effort needs a value');
  const effectiveEffort =
    reasoningEffort === undefined ? DEFAULT_REASONING_EFFORT : reasoningEffort;
  if (llm.startsWith('claude-') && (effectiveEffort === 'none' || effectiveEffort === 'minimal'))
    notes.push(
      `reasoning effort ${effectiveEffort}: the Anthropic API has no such effort (low..max); ElevenLabs may reject it or map it`,
    );

  const tts = f['tts-model'];
  if (tts === true) return fail('--tts-model needs a value');
  if (tts !== undefined && !(EL_TTS_MODELS as readonly string[]).includes(tts))
    return fail(`--tts-model: ${EL_TTS_MODELS.join(' | ')}`);

  let retentionDays: number | undefined;
  if (f['retention-days'] !== undefined) {
    const n = Number(f['retention-days']);
    if (f['retention-days'] === true || !Number.isInteger(n) || n < 0)
      return fail('--retention-days: a whole number of days');
    retentionDays = n;
  }

  let baseUrl = get('PUBLIC_BASE_URL');
  if (!baseUrl) {
    if (!dryRun)
      return fail('PUBLIC_BASE_URL is not set (the Fly HTTPS URL the webhook tools call)');
    baseUrl = PLACEHOLDER_BASE_URL;
    notes.push(`PUBLIC_BASE_URL unset; the dry run uses ${PLACEHOLDER_BASE_URL}`);
  } else {
    const problem = publicBaseUrlProblem(baseUrl);
    if (problem) return fail(problem);
  }

  const voiceId = get('ELEVENLABS_JUDGE_VOICE_ID');
  if (!voiceId)
    notes.push('ELEVENLABS_JUDGE_VOICE_ID unset; the agent uses the ElevenLabs default voice');

  const toolSecret = get('ELEVENLABS_TOOL_SECRET') ?? '';
  if (!dryRun) {
    if (!get('ELEVENLABS_API_KEY')) return fail('ELEVENLABS_API_KEY is not set');
    if (!toolSecret) return fail('ELEVENLABS_TOOL_SECRET is not set (openssl rand -base64 32)');
  }

  const agentName = f['agent-name'];
  if (agentName === true) return fail('--agent-name needs a value');
  if (agentName !== undefined && !/^[a-z0-9][a-z0-9-]{2,63}$/.test(agentName))
    return fail('--agent-name: lowercase letters, digits and dashes (3-64)');
  if (agentName !== undefined && agentName !== JUDGE_AGENT_NAME) {
    if (f['rotate-secret'] === true)
      return fail('--rotate-secret with --agent-name: the secret is shared with the live judge');
    notes.push(
      `--agent-name ${agentName}: a TEST agent; shared tools / the secret are never PATCHed`,
    );
  }

  const check = f['check-openapi'];
  return {
    ok: true,
    cli: {
      dryRun,
      ...(check !== undefined
        ? { checkOpenapi: check === true ? ELEVENLABS_OPENAPI_URL : check }
        : {}),
      notes,
      opts: {
        baseUrl,
        toolSecret,
        rotateSecret: f['rotate-secret'] === true,
        ...(agentName !== undefined ? { agentName } : {}),
        webhookTools: tools as WebhookToolName[] | undefined,
        agent: {
          llm,
          ...(voiceId ? { voiceId } : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(tts ? { ttsModel: tts as ElTtsModel } : {}),
          ...(retentionDays !== undefined ? { retentionDays } : {}),
        },
      },
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- reads the plan's JSON bodies */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The human summary of a dry-run plan (what the judge will be), for stderr. */
export function planSummary(plan: readonly SyncAction[]): string[] {
  const agent = plan.find((a) => a.resource === 'agent')?.body as any;
  const tools = plan.filter((a) => a.resource === 'tool').map((a) => (a.body as any).tool_config);
  const prompt = agent?.conversation_config?.agent?.prompt ?? {};
  const tts = agent?.conversation_config?.tts ?? {};
  const lines = [
    `agent           ${agent?.name ?? JUDGE_AGENT_NAME} (private: enable_auth=${String(agent?.platform_settings?.auth?.enable_auth)})`,
    `llm             ${prompt.llm}  reasoning_effort=${prompt.reasoning_effort ?? '(omitted)'}  temperature=${prompt.temperature === null ? 'omitted' : String(prompt.temperature)}  max_tokens=${prompt.max_tokens}  backup=${prompt.backup_llm_config?.preference}`,
    `voice           ${tts.voice_id ?? '(ElevenLabs default voice)'}  tts=${tts.model_id}  speed=${tts.speed}`,
    `first message   ${agent?.conversation_config?.agent?.first_message ?? FIRST_MESSAGE}`,
    `secret          workspace secret "${TOOL_SECRET_NAME}" = ELEVENLABS_TOOL_SECRET (value never printed)`,
  ];
  for (const t of tools) {
    if (t.type === 'webhook') {
      const header = Object.entries(t.api_schema?.request_headers ?? {})
        .map(
          ([k, v]) =>
            `${k}: {secret_id of ${TOOL_SECRET_NAME}}${(v as any)?.secret_id ? '' : ' (MISSING)'}`,
        )
        .join(', ');
      lines.push(
        `webhook tool    ${t.name.padEnd(16)} POST ${t.api_schema.url}  [${header || `no ${TOOL_SECRET_HEADER}!`}]  pre_tool_speech=${t.pre_tool_speech}`,
      );
    } else
      lines.push(
        `client tool     ${t.name.padEnd(16)} expects_response=${String(t.expects_response)}`,
      );
  }
  const p = String(prompt.prompt ?? '');
  const guard = p.indexOf('# What you refuse');
  lines.push(`prompt          ${p.length} chars; guardrail section:`);
  for (const l of (guard >= 0 ? p.slice(guard) : p).split('\n').slice(0, 9))
    lines.push(`                ${clip(l, 110)}`);
  return lines;
}

/** The closing lines: the env var to set, and how. */
export function agentIdLines(agentId: string | null, currentEnvId: string | undefined): string[] {
  if (!agentId)
    return [
      'ELEVENLABS_AGENT_ID=<the agent_id POST /v1/convai/agents/create returns: a real run prints it>',
      ...(currentEnvId
        ? [
            `(the environment has ELEVENLABS_AGENT_ID=${currentEnvId}; a real run finds "${JUDGE_AGENT_NAME}" by name and keeps its id)`,
          ]
        : []),
    ];
  return [
    `ELEVENLABS_AGENT_ID=${agentId}`,
    ...(currentEnvId && currentEnvId !== agentId
      ? [`warning: the environment has ELEVENLABS_AGENT_ID=${currentEnvId}, not ${agentId}`]
      : []),
    `next: fly secrets set ELEVENLABS_AGENT_ID=${agentId} -a youre-on   (and ELEVENLABS_AGENT_ID=${agentId} in apps/server/.env)`,
  ];
}
