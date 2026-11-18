#!/usr/bin/env -S npx tsx
// Refreshes apps/server/test/fixtures/elevenlabs-openapi-subset.json: ElevenLabs' public OpenAPI
// document (no key), pruned to the request bodies scripts/el-agent.ts sends, so the el-agent unit
// test checks the agent config against the real API schema offline.
//
//   npx tsx scripts/el-openapi-subset.ts [<openapi.json path or https URL>]
//
// Default source: https://api.elevenlabs.io/openapi.json. After a refresh, re-run the server
// tests: a failure means ElevenLabs changed a field el-agent sends (or EL_AGENT_LLMS /
// EL_TTS_MODELS / EL_REASONING_EFFORTS in packages/shared/src/judge/el-enums.ts need the new
// values).
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { WEBHOOK_TOOL_SPECS, type WebhookToolName } from '@youre-on/shared/judge/el-config';
import { ELEVENLABS_OPENAPI_URL } from '../apps/server/src/voice/agent-cli';
import { dryRunPlan } from '../apps/server/src/voice/agent-sync';
import { checkPlan, subsetForPlan, type OpenApiDoc } from '../apps/server/src/voice/openapi-check';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/server/test/fixtures/elevenlabs-openapi-subset.json',
);

/** Every body shape el-agent can send: default tools, all five webhook tools, a set voice. */
export function coveragePlan() {
  const base = { baseUrl: 'https://youre-on.fly.dev', toolSecret: 'x' };
  return [
    ...dryRunPlan(base),
    ...dryRunPlan({
      ...base,
      webhookTools: Object.keys(WEBHOOK_TOOL_SPECS) as WebhookToolName[],
      agent: { voiceId: 'voice_placeholder', ttsModel: 'eleven_flash_v2', retentionDays: 0 },
    }),
  ];
}

async function main() {
  const src = process.argv[2] ?? ELEVENLABS_OPENAPI_URL;
  const text = /^https:\/\//.test(src)
    ? await fetch(src, { signal: AbortSignal.timeout(30_000) }).then((r) => {
        if (!r.ok) throw new Error(`GET ${src} -> HTTP ${r.status}`);
        return r.text();
      })
    : await readFile(src, 'utf8');
  const doc = JSON.parse(text) as OpenApiDoc;
  const plan = coveragePlan();
  const bad = checkPlan(doc, plan).filter((r) => r.errors.length);
  for (const r of bad) process.stderr.write(`FAIL ${r.label}\n  ${r.errors.join('\n  ')}\n`);
  const subset = {
    $comment: `ElevenLabs OpenAPI ${doc.info?.version ?? '?'}, read ${new Date().toISOString().slice(0, 10)} from ${/^https:\/\//.test(src) ? src : `a saved copy of ${ELEVENLABS_OPENAPI_URL}`}, pruned by scripts/el-openapi-subset.ts to the bodies scripts/el-agent.ts sends. Do not edit by hand.`,
    ...subsetForPlan(doc, plan),
  };
  // Written prettier-formatted, so `prettier --check` stays green after a refresh.
  const options = (await resolveConfig(OUT)) ?? {};
  await writeFile(OUT, await format(JSON.stringify(subset), { ...options, filepath: OUT }));
  process.stdout.write(`wrote ${OUT} (${Buffer.byteLength(JSON.stringify(subset))} bytes)\n`);
  if (bad.length) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((e: unknown) => {
    process.stderr.write(`el-openapi-subset: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
