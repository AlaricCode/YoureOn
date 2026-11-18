#!/usr/bin/env -S npx tsx
// QuickNode Streams for the You're On escrow (API-CONTRACT §5.1; the QuickNode bounty's "Stream
// with a filter and a destination as a core data source"): create / list / get / pause / resume
// / delete the Stream that feeds POST /webhooks/quicknode (the projector), plus test-filter and a
// signed probe of the deployed webhook. Reads QUICKNODE_API_KEY from the environment and never
// prints it or the webhook security token (only sha256 fingerprints).
//
// One-command activation (once the key exists):
//   QUICKNODE_API_KEY=... npm run qn-stream -- create --fly-app youre-on
// which: picks the security token (env QN_STREAM_SECURITY_TOKEN, else the token file, else a new
// one written there, 0600) -> probes the webhook -> only if the server does not verify it yet
// (404 / 401) and with --fly-app, `fly secrets import`s it (that restarts the machines) and probes
// until the server verifies a delivery signed with it -> refuses a duplicate Stream name (unless
// --replace) -> creates the Stream PAUSED with that token -> checks the token QuickNode returned
// -> activates it. Without --fly-app it prints the exact `fly secrets import` command and stops
// at the probe if the server does not hold the token yet (a Stream delivering to a server that
// answers 401/404 auto-pauses after 3 failed retries).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { expandPath, run } from './lib/cli';
import {
  API_KEY_ENV,
  buildCreateBody,
  createStream,
  DEFAULT_BASE_URL,
  DEFAULT_FLY_APP,
  DEFAULT_TOKEN_FILE,
  describeRequest,
  fingerprint,
  probeAdvice,
  probeUntil,
  QN_STREAMS_API,
  qnCall,
  redact,
  renderFilterJs,
  req,
  resolveToken,
  resumeStream,
  STREAM_TEMPLATE_PATH,
  streamsOf,
  summarize,
  tokenLine,
  tokenOf,
  TOKEN_ENV,
  webhookUrlOf,
  writeTokenFile,
  type QnRequest,
  type StreamIo,
} from './lib/quicknode';

const USAGE = `usage: npm run qn-stream -- <command> [options]

commands
  create        create the Stream (paused), verify the token, then activate it
  list          list the account's Streams (no secrets printed)
  get <id>      show one Stream            [--token-out <file>: save its security token, 0600]
  pause <id>    pause it (do this when idle: ~11 M credits/day at 24/7)
  resume <id>   activate it again (probes the webhook first)
  delete <id>   delete it (needs --yes)
  test-filter   run filter.js on one devnet block on QuickNode's side   --block <slot>
  probe         POST a delivery signed with the token to the webhook (no QuickNode key needed)
  body          print the create request (= create --dry-run)

options
  --url <https base>   webhook host (default ${DEFAULT_BASE_URL}; the path is /webhooks/quicknode)
  --name <name>        Stream name (default: infra/quicknode/stream.json name)
  --token-file <path>  security token file (default ${DEFAULT_TOKEN_FILE})
  --fly-app <app>      create/resume: if the server does not verify the token yet, set the Fly
                       secret ${TOKEN_ENV} (fly secrets import; restarts the machines)
  --paused             create: leave the Stream paused
  --replace            create: delete an existing Stream with the same name first
  --quicknode-token    create: let QuickNode generate the token (fallback), then save + verify it
  --skip-probe         create/resume: do not check the webhook first
  --probe-wait <s>     keep probing up to <s> seconds (default 0; 120 after setting the secret)
  --dry-run            print the request(s) and send nothing (no API key needed)
  --full               with --dry-run / --json: include filter_function
  --json               print the (redacted) API response
  --yes                confirm delete

env
  ${API_KEY_ENV}       QuickNode console API key with Streams enabled (required unless --dry-run / probe)
  ${TOKEN_ENV}   optional: reuse this token (e.g. the value already in the Fly secret)`;

const OPTIONS = {
  url: { type: 'string' },
  name: { type: 'string' },
  'token-file': { type: 'string' },
  'token-out': { type: 'string' },
  'fly-app': { type: 'string' },
  paused: { type: 'boolean' },
  replace: { type: 'boolean' },
  'quicknode-token': { type: 'boolean' },
  'skip-probe': { type: 'boolean' },
  'probe-wait': { type: 'string' },
  'dry-run': { type: 'boolean' },
  full: { type: 'boolean' },
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
  block: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
};

function apiKey(): string {
  const k = process.env[API_KEY_ENV]?.trim();
  if (!k) throw new Error(`${API_KEY_ENV} is not set (a QuickNode console API key with Streams)`);
  return k;
}

const call = (r: QnRequest) => qnCall(fetch, apiKey(), r);

const io = (): StreamIo => ({
  fetch,
  apiKey: apiKey(),
  env: process.env,
  log: (line) => console.log(line),
  flyImport: flySecretsImport,
});

function show(v: Values, r: QnRequest) {
  console.log(describeRequest(r, { full: v.full }));
}

function printJson(v: Values, x: unknown) {
  console.log(JSON.stringify(redact(x, { full: v.full }), null, 2));
}

/** `fly secrets import -a <app>` with the token on stdin (never in argv, never echoed). */
async function flySecretsImport(app: string, token: string): Promise<void> {
  console.log(
    `setting the Fly secret ${TOKEN_ENV} on ${app} (fly secrets import; machines restart)`,
  );
  const runWith = (bin: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['secrets', 'import', '-a', app], {
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${bin} secrets import exited ${code}`)),
      );
      child.stdin.on('error', () => {}); // the CLI exiting early surfaces through 'exit'
      child.stdin.end(`${TOKEN_ENV}=${token}\n`);
    });
  try {
    await runWith('fly');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await runWith('flyctl').catch((e2: NodeJS.ErrnoException) => {
      throw new Error(
        e2.code === 'ENOENT' ? 'neither fly nor flyctl is on PATH' : `flyctl: ${e2.message}`,
      );
    });
  }
}

function securityNotes(base: string, flyApp: string, file: string) {
  return [
    '',
    'webhook security (apps/server/src/chain/quicknode.ts):',
    `  QuickNode signs every POST to ${webhookUrlOf(base)} with the Stream's security_token;`,
    `  the server verifies X-QN-Signature = hex HMAC-SHA256(${TOKEN_ENV}, X-QN-Nonce + X-QN-Timestamp + body)`,
    '  over the decompressed body and rejects |now - X-QN-Timestamp| > 300 s (401: 3 failed retries pause the Stream).',
    `  The Fly secret must equal the Stream's token:  fly secrets import -a ${flyApp} < ${file}`,
    `  Check it any time:  npm run qn-stream -- probe --url ${base}`,
  ].join('\n');
}

async function cmdCreate(v: Values) {
  const base = v.url ?? DEFAULT_BASE_URL;
  const file = expandPath(v['token-file'] ?? DEFAULT_TOKEN_FILE);
  const flyApp = v['fly-app'];
  if (v['dry-run']) {
    const t = resolveToken(process.env, file, { generate: false });
    const body = await buildCreateBody({
      baseUrl: base,
      token: t?.token ?? `qn_${'0'.repeat(64)}`,
      status: 'paused',
      name: v.name,
    });
    console.log(
      t
        ? tokenLine(t.source, t.token, file)
        : `security token: none yet (create generates one into ${file})`,
    );
    console.log('\n# 1. existing Streams with the same name (refused unless --replace)');
    show(v, req.list());
    console.log('\n# 2. create, paused, with our security token');
    show(v, req.create(body));
    if (!v.paused) {
      console.log('\n# 3. after the token check, activate it');
      show(v, { method: 'POST', url: `${QN_STREAMS_API}/{id}/activate` });
    }
    console.log(securityNotes(base, flyApp ?? DEFAULT_FLY_APP, file));
    return;
  }
  const { id, stream: final } = await createStream(io(), {
    baseUrl: base,
    tokenFile: file,
    flyApp,
    name: v.name,
    paused: v.paused,
    replace: v.replace,
    quicknodeToken: v['quicknode-token'],
    skipProbe: v['skip-probe'],
    probeWaitSecs: v['probe-wait'] === undefined ? undefined : Number(v['probe-wait']),
  });
  if (v.json) printJson(v, final);
  else console.log(summarize(final));
  console.log(securityNotes(base, flyApp ?? DEFAULT_FLY_APP, file));
  console.log(
    [
      '',
      'next:',
      `  watch deliveries:  fly logs -a ${flyApp ?? DEFAULT_FLY_APP} | grep chain.delivery`,
      '  end to end:        npm run smoke-devnet -- --database-url <pg>  (waits for the 5 chain_events rows)',
      `  when idle:         npm run qn-stream -- pause ${id}`,
    ].join('\n'),
  );
}

async function cmdResume(v: Values, id: string) {
  if (v['dry-run']) return show(v, req.activate(id));
  const stream = await resumeStream(io(), id, {
    baseUrl: v.url ?? DEFAULT_BASE_URL,
    tokenFile: expandPath(v['token-file'] ?? DEFAULT_TOKEN_FILE),
    flyApp: v['fly-app'],
    skipProbe: v['skip-probe'],
    probeWaitSecs: v['probe-wait'] === undefined ? undefined : Number(v['probe-wait']),
  });
  console.log(summarize(stream));
}

async function cmdTestFilter(v: Values) {
  const block = Number(v.block);
  if (!Number.isInteger(block) || block <= 0) throw new Error('--block <slot> is required');
  const t = JSON.parse(readFileSync(STREAM_TEMPLATE_PATH, 'utf8')) as {
    network: string;
    dataset: string;
  };
  const r = req.testFilter({
    network: t.network,
    dataset: t.dataset,
    filterJs: await renderFilterJs(),
    block,
  });
  if (v['dry-run']) return show(v, r);
  printJson(v, await call(r));
}

async function cmdProbe(v: Values) {
  const base = v.url ?? DEFAULT_BASE_URL;
  const file = expandPath(v['token-file'] ?? DEFAULT_TOKEN_FILE);
  const t = resolveToken(process.env, file, { generate: false });
  if (!t)
    throw new Error(`no token: set ${TOKEN_ENV} or create ${file} (npm run qn-stream -- create)`);
  console.log(tokenLine(t.source, t.token, file));
  if (v['dry-run']) {
    console.log(`POST ${webhookUrlOf(base)}  (body null, X-QN-* signed with the token)`);
    return;
  }
  const p = await probeUntil(
    { fetch, log: console.log },
    base,
    t.token,
    Number(v['probe-wait'] ?? 0),
  );
  const advice = probeAdvice(p, v['fly-app'] ?? DEFAULT_FLY_APP, file);
  if (!p.ok) throw new Error(`${webhookUrlOf(base)}: ${advice}`);
  console.log(`${webhookUrlOf(base)}: ${advice}`);
}

run(async () => {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { values: v, positionals } = parsed;
  const [cmd, arg] = positionals;
  if (v.help || !cmd) {
    console.log(USAGE);
    if (!v.help) process.exit(2);
    return;
  }
  const needId = () => {
    if (!arg) throw new Error(`${cmd} needs a stream id (npm run qn-stream -- list)`);
    return arg;
  };
  switch (cmd) {
    case 'create':
      return cmdCreate(v);
    case 'body':
      return cmdCreate({ ...v, 'dry-run': true });
    case 'list': {
      const r = req.list();
      if (v['dry-run']) return show(v, r);
      const streams = streamsOf(await call(r));
      if (v.json) return printJson(v, streams);
      if (streams.length === 0) console.log('no Streams');
      for (const s of streams) console.log(summarize(s));
      return;
    }
    case 'get': {
      const r = req.get(needId());
      if (v['dry-run']) return show(v, r);
      const s = (await call(r)) as Record<string, unknown>;
      if (v.json) printJson(v, s);
      else console.log(summarize(s));
      if (v['token-out']) {
        const t = tokenOf(s);
        if (!t) throw new Error('the response carries no security_token');
        writeTokenFile(expandPath(v['token-out']), t);
        console.log(
          `security token sha256:${fingerprint(t)} written to ${expandPath(v['token-out'])} (0600)`,
        );
      }
      return;
    }
    case 'pause': {
      const r = req.pause(needId());
      if (v['dry-run']) return show(v, r);
      await call(r);
      console.log(summarize((await call(req.get(arg!))) as Record<string, unknown>));
      return;
    }
    case 'resume':
    case 'activate':
      return cmdResume(v, needId());
    case 'delete': {
      const r = req.delete(needId());
      if (v['dry-run']) return show(v, r);
      if (!v.yes) throw new Error('delete is permanent: pass --yes');
      await call(r);
      console.log(`deleted ${arg}`);
      return;
    }
    case 'test-filter':
      return cmdTestFilter(v);
    case 'probe':
      return cmdProbe(v);
    default:
      console.error(`unknown command ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
});
