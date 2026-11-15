#!/usr/bin/env -S npx tsx
// The ElevenLabs judge as code (TASKS D0-J2). Creates or updates, idempotently, the workspace
// secret, the webhook and client tools, and the private agent. A second run is a no-op.
//
//   npx tsx --env-file-if-exists=apps/server/.env scripts/el-agent.ts --dry-run
//   npx tsx --env-file-if-exists=apps/server/.env scripts/el-agent.ts
//
// Env (SETUP-CHECKLIST §7): ELEVENLABS_API_KEY, ELEVENLABS_TOOL_SECRET, PUBLIC_BASE_URL (the
// public HTTPS host the webhook tools call), optional ELEVENLABS_JUDGE_VOICE_ID.
// Flags:
//   --dry-run                 print the exact JSON each first-run request would send; no HTTP,
//                             no key needed (secret value and unknown ids are placeholders)
//   --rotate-secret           PATCH the workspace secret to ELEVENLABS_TOOL_SECRET
//   --tools=a,b               webhook tools to register (default: propose_terms; each needs a
//                             live /el/tools/<name> handler)
//   --llm=<id>                default claude-haiku-5-5 (FINDINGS §3.8)
//   --reasoning-effort=<e>    none|minimal|low|medium|omit (default low; PENDING-KEY)
//   --tts-model=<id>          eleven_v4_turbo (default) | eleven_flash_v2
//   --retention-days=<n>      conversation retention (default 1; PENDING-KEY: dashboard minimum)
// Prints `ELEVENLABS_AGENT_ID=<id>` at the end: put it in fly.toml [env] / apps/server/.env.
import {
  dryRunPlan,
  fetchElHttp,
  syncAgent,
  type SyncOptions,
} from '../apps/server/src/voice/agent-sync';
import { WEBHOOK_TOOL_SPECS, type WebhookToolName } from '@youre-on/shared/judge/el-config';

type Effort = 'none' | 'minimal' | 'low' | 'medium';

function flags(argv: string[]) {
  const out: Record<string, string | true> = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unknown argument: ${a}`);
    out[m[1]!] = m[2] ?? true;
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`el-agent: ${msg}\n`);
  process.exit(1);
}

async function main() {
  const f = flags(process.argv.slice(2));
  const known = [
    'dry-run',
    'rotate-secret',
    'tools',
    'llm',
    'reasoning-effort',
    'tts-model',
    'retention-days',
  ];
  for (const k of Object.keys(f)) if (!known.includes(k)) fail(`unknown flag --${k}`);
  const dryRun = f['dry-run'] === true;
  const env = (k: string) => (process.env[k] ? process.env[k] : undefined);

  const tools = typeof f.tools === 'string' ? f.tools.split(',').map((s) => s.trim()) : undefined;
  for (const t of tools ?? [])
    if (!(t in WEBHOOK_TOOL_SPECS)) fail(`--tools: unknown webhook tool ${t}`);
  const effortFlag = f['reasoning-effort'];
  let reasoningEffort: Effort | null | undefined;
  if (effortFlag === 'omit') reasoningEffort = null;
  else if (typeof effortFlag === 'string') {
    if (!['none', 'minimal', 'low', 'medium'].includes(effortFlag))
      fail('--reasoning-effort: none|minimal|low|medium|omit');
    reasoningEffort = effortFlag as Effort;
  }
  const tts = f['tts-model'];
  if (tts !== undefined && tts !== 'eleven_v4_turbo' && tts !== 'eleven_flash_v2')
    fail('--tts-model: eleven_v4_turbo | eleven_flash_v2');
  const retention =
    typeof f['retention-days'] === 'string' ? Number(f['retention-days']) : undefined;
  if (retention !== undefined && !Number.isInteger(retention)) fail('--retention-days: integer');

  let baseUrl = env('PUBLIC_BASE_URL');
  if (!baseUrl) {
    if (!dryRun) fail('PUBLIC_BASE_URL is not set (the Fly HTTPS URL the webhook tools call)');
    baseUrl = 'https://<app>.fly.dev';
    process.stderr.write('el-agent: PUBLIC_BASE_URL unset; dry run uses https://<app>.fly.dev\n');
  } else if (!/^https:\/\//.test(baseUrl))
    fail('PUBLIC_BASE_URL must be https:// (ElevenLabs calls it from the internet)');
  const voiceId = env('ELEVENLABS_JUDGE_VOICE_ID');
  if (!voiceId)
    process.stderr.write(
      'el-agent: ELEVENLABS_JUDGE_VOICE_ID unset; the agent uses the default voice\n',
    );

  const opts: SyncOptions = {
    baseUrl,
    toolSecret: env('ELEVENLABS_TOOL_SECRET') ?? '',
    rotateSecret: f['rotate-secret'] === true,
    webhookTools: tools as WebhookToolName[] | undefined,
    agent: {
      ...(voiceId ? { voiceId } : {}),
      ...(typeof f.llm === 'string' ? { llm: f.llm } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(tts ? { ttsModel: tts } : {}),
      ...(retention !== undefined ? { retentionDays: retention } : {}),
    },
    log: (l) => process.stdout.write(`${l}\n`),
  };

  if (dryRun) {
    process.stdout.write(`${JSON.stringify(dryRunPlan(opts), null, 2)}\n`);
    return;
  }
  const apiKey = env('ELEVENLABS_API_KEY');
  if (!apiKey) fail('ELEVENLABS_API_KEY is not set');
  if (!opts.toolSecret) fail('ELEVENLABS_TOOL_SECRET is not set (openssl rand -base64 32)');
  const http = fetchElHttp({ apiKey, redact: [opts.toolSecret, apiKey] });
  const r = await syncAgent(http, opts);
  const writes = r.actions.filter((a) => a.action !== 'noop').length;
  process.stdout.write(`${writes === 0 ? 'no changes (no-op)' : `${writes} write(s)`}\n`);
  process.stdout.write(`ELEVENLABS_AGENT_ID=${r.agent_id}\n`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
