#!/usr/bin/env -S npx tsx
// The ElevenLabs judge as code (TASKS D0-J2). Creates or updates, idempotently, the workspace
// secret, the webhook and client tools, and the private agent: each is found by exact name and
// PATCHed only where it differs, so a second run is a no-op.
//
//   npx tsx --env-file-if-exists=apps/server/.env scripts/el-agent.ts --dry-run --check-openapi
//   npx tsx --env-file-if-exists=apps/server/.env scripts/el-agent.ts --check-openapi
//   ... scripts/el-agent.ts --agent-name=youre-on-judge-test-x   (a throwaway TEST agent: shared
//       tools / the secret are never PATCHed; see --help)
//
// Env (SETUP-CHECKLIST §7): ELEVENLABS_API_KEY, ELEVENLABS_TOOL_SECRET, PUBLIC_BASE_URL (the
// public HTTPS host the webhook tools call), optional ELEVENLABS_JUDGE_VOICE_ID and
// ELEVENLABS_AGENT_LLM. Flags: see USAGE in apps/server/src/voice/agent-cli.ts (--help).
// Ends with `ELEVENLABS_AGENT_ID=<id>`: put it in Fly (fly secrets set) and apps/server/.env.
import { readFile } from 'node:fs/promises';
import {
  agentIdLines,
  parseAgentCli,
  planSummary,
  USAGE,
} from '../apps/server/src/voice/agent-cli';
import {
  dryRunPlan,
  fetchElHttp,
  isTestAgent,
  syncAgent,
} from '../apps/server/src/voice/agent-sync';
import { checkPlan, type OpenApiDoc } from '../apps/server/src/voice/openapi-check';

const err = (l: string) => process.stderr.write(`${l}\n`);
const out = (l: string) => process.stdout.write(`${l}\n`);

function fail(msg: string): never {
  err(`el-agent: ${msg}`);
  process.exit(1);
}

/** The public OpenAPI document (a GET of the spec, no key), or a local copy of it. */
async function loadOpenApi(where: string): Promise<OpenApiDoc> {
  const text = /^https:\/\//.test(where)
    ? await fetch(where, { signal: AbortSignal.timeout(30_000) }).then(async (r) => {
        if (!r.ok) throw new Error(`GET ${where} -> HTTP ${r.status}`);
        return r.text();
      })
    : await readFile(where, 'utf8');
  const doc = JSON.parse(text) as OpenApiDoc;
  if (!doc || typeof doc.paths !== 'object') throw new Error(`${where} is not an OpenAPI document`);
  return doc;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return;
  }
  const parsed = parseAgentCli(argv, process.env);
  if (!parsed.ok) fail(`${parsed.error}\n\n${USAGE}`);
  const { cli } = parsed;
  for (const n of cli.notes) err(`el-agent: ${n}`);
  const plan = dryRunPlan(cli.opts);

  if (cli.checkOpenapi) {
    const doc = await loadOpenApi(cli.checkOpenapi);
    const results = checkPlan(doc, plan);
    let bad = 0;
    for (const r of results) {
      err(`openapi ${r.errors.length ? 'FAIL' : 'ok  '} ${r.method} ${r.path}  ${r.label}`);
      for (const e of r.errors) err(`          ${e}`);
      bad += r.errors.length;
    }
    if (bad) fail(`${bad} mismatch(es) against ${cli.checkOpenapi}; nothing was sent`);
    err(`el-agent: every body matches ${cli.checkOpenapi} (version ${doc.info?.version ?? '?'})`);
  }

  if (cli.dryRun) {
    for (const l of planSummary(plan)) err(l);
    out(JSON.stringify(plan, null, 2));
    for (const l of agentIdLines(null, process.env.ELEVENLABS_AGENT_ID)) err(l);
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY!;
  const http = fetchElHttp({ apiKey, redact: [cli.opts.toolSecret, apiKey] });
  const r = await syncAgent(http, { ...cli.opts, log: (l) => out(l) });
  const writes = r.actions.filter((a) => a.action !== 'noop').length;
  out(writes === 0 ? 'no changes (no-op)' : `${writes} write(s)`);
  if (isTestAgent(cli.opts)) {
    // A throwaway test agent: never the server's ELEVENLABS_AGENT_ID.
    out(
      `TEST agent ${cli.opts.agentName}: ${r.agent_id} (not for ELEVENLABS_AGENT_ID; delete it when done)`,
    );
    return;
  }
  for (const l of agentIdLines(r.agent_id, process.env.ELEVENLABS_AGENT_ID)) out(l);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
