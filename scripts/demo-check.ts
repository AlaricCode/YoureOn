#!/usr/bin/env -S npx tsx
// Pitch-morning GO / NO-GO: one read-only command over everything the money path needs.
//
//   npm run demo-check -- [--server https://youre-on.fly.dev] [--demo-key <token>] [--url <rpc>]
//                         [--fee-payer <pubkey>] [--json]
//
//   server   GET /health (reachable, latency, clock skew) and GET /v1/demo/health (needs the admin
//            key: --demo-key or env DEMO_ADMIN_TOKEN): chain configured, fee payer SOL, nonce
//            pool, demo-a / demo-b / treasury USDC, RPC p50 / p95, keeper, orphan escrow, Gemini
//            relay, and every other server warning.
//   chain    with --url or env SOLANA_RPC_URL, independently of the server: cluster (mainnet is
//            refused), the program is deployed, Config exists and is not paused, the fee payer's
//            SOL, the nonce-pool accounts (authority = fee payer), demo wallets' USDC, live escrow
//            bets past a deadline (what the crank would send).
//   stream   with env QN_API_KEY + QN_STREAM_ID: the QuickNode Stream's status (REST GET).
//
// Sends nothing, signs nothing, reads no keypair. Exit 0 = GO (warnings allowed), 1 = NO-GO.
import {
  address,
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
} from '@solana/kit';

import { BET_RENT_PAYER_OFFSET, exitActionFor } from '@youre-on/shared/chain/exits';
import { FEE_PAYER_PUBKEY, USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import { NONCE_POOL_SIZE } from '@youre-on/shared/constants';
import {
  BET_DISCRIMINATOR,
  BetStatus,
  ESCROW_PROGRAM_ADDRESS,
  fetchMaybeConfig,
  findConfigPda,
  getBetDecoder,
} from '@youre-on/shared/escrow-client';

import { parseCli, run } from './lib/cli';
import { ataBalance, chainNow, connect, lamportsOf, type Chain } from './lib/chain';
import {
  evaluateBasicHealth,
  evaluateDemoHealth,
  evaluateStream,
  formatChecks,
  overall,
  THRESHOLDS,
  type Check,
  type DemoHealth,
} from './lib/demo-check';
import { readPoolNonce } from './lib/nonce';

const USAGE = `usage: npm run demo-check -- [--server <url>] [--demo-key <token>] [--url <rpc>] [--fee-payer <pubkey>] [--json]
Read-only GO / NO-GO for the pitch. Defaults: --server https://youre-on.fly.dev,
--demo-key $DEMO_ADMIN_TOKEN, --url $SOLANA_RPC_URL (chain checks skipped without one),
Stream status with $QN_API_KEY + $QN_STREAM_ID.`;

const DEFAULT_SERVER = 'https://youre-on.fly.dev';
const TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS, what = 'request'): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

const errText = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 140);

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; ms: number; body: unknown } | { error: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, ms: Date.now() - t0, body };
  } catch (e) {
    return { error: errText(e) };
  }
}

/** Independent chain reads (never through the server). */
async function chainChecks(
  url: string,
  o: { feePayer: Address; demoA: Address | null; demoB: Address | null; mint: Address },
): Promise<Check[]> {
  const out: Check[] = [];
  let chain: Chain;
  try {
    chain = await withTimeout(connect(url), TIMEOUT_MS, 'RPC connect');
  } catch (e) {
    return [{ id: 'rpc.cluster', verdict: 'NO-GO', detail: errText(e) }];
  }
  out.push({
    id: 'rpc.cluster',
    verdict: chain.cluster === 'devnet' ? 'GO' : 'WARN',
    detail: `${chain.cluster} (${chain.label})`,
  });
  const rpc = chain.rpc;
  const step = async (id: string, fn: () => Promise<Check | Check[]>) => {
    try {
      const r = await withTimeout(fn(), TIMEOUT_MS, id);
      out.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      out.push({ id, verdict: 'NO-GO', detail: errText(e) });
    }
  };

  await step('rpc.program', async () => {
    const { value } = await rpc
      .getAccountInfo(ESCROW_PROGRAM_ADDRESS, { commitment: 'confirmed', encoding: 'base64' })
      .send();
    return value?.executable
      ? { id: 'rpc.program', verdict: 'GO', detail: `${ESCROW_PROGRAM_ADDRESS} deployed` }
      : {
          id: 'rpc.program',
          verdict: 'NO-GO',
          detail: `${ESCROW_PROGRAM_ADDRESS} not deployed here`,
        };
  });
  await step('rpc.config', async () => {
    const [pda] = await findConfigPda();
    const cfg = await fetchMaybeConfig(rpc, pda, { commitment: 'confirmed' });
    if (!cfg.exists)
      return {
        id: 'rpc.config',
        verdict: 'NO-GO',
        detail: 'Config missing',
        fix: 'npm run init-config',
      };
    const allowed = cfg.data.allowedMints.includes(o.mint);
    return {
      id: 'rpc.config',
      verdict: cfg.data.paused || !allowed ? 'NO-GO' : 'GO',
      detail: `${pda}: ${cfg.data.paused ? 'PAUSED' : 'not paused'}, appeal window ${cfg.data.appealWindowSecs} s, mint ${allowed ? 'allowed' : 'NOT allowed'}`,
    };
  });
  await step('rpc.fee_payer_sol', async () => {
    const sol = Number(await lamportsOf(rpc, o.feePayer)) / 1e9;
    return {
      id: 'rpc.fee_payer_sol',
      verdict:
        sol >= THRESHOLDS.feePayerGoSol
          ? 'GO'
          : sol >= THRESHOLDS.feePayerWarnSol
            ? 'WARN'
            : 'NO-GO',
      detail: `${sol} SOL (${o.feePayer})`,
      ...(sol < THRESHOLDS.feePayerGoSol
        ? { fix: `solana airdrop 2 ${o.feePayer} --url devnet` }
        : {}),
    };
  });
  await step('rpc.nonce_accounts', async () => {
    let ok = 0;
    const bad: number[] = [];
    for (let k = 0; k < NONCE_POOL_SIZE; k++) {
      const n = await readPoolNonce(rpc, o.feePayer, k);
      if (n && n.authority === o.feePayer) ok++;
      else bad.push(k);
    }
    return {
      id: 'rpc.nonce_accounts',
      verdict: ok >= THRESHOLDS.noncesGo ? (bad.length ? 'WARN' : 'GO') : 'NO-GO',
      detail: `${ok}/${NONCE_POOL_SIZE} pool accounts exist with the fee payer as authority${bad.length ? ` (missing k=${bad.join(',')})` : ''}`,
      ...(bad.length ? { fix: 'npm run nonce-pool -- --url <rpc>' } : {}),
    };
  });
  for (const [id, who] of [
    ['rpc.demo_a_usdc', o.demoA],
    ['rpc.demo_b_usdc', o.demoB],
  ] as const) {
    if (!who) {
      out.push({ id, verdict: 'SKIP', detail: 'address unknown (no server health)' });
      continue;
    }
    await step(id, async () => {
      const b = await ataBalance(rpc, who, o.mint);
      return {
        id,
        verdict:
          b.amount >= THRESHOLDS.demoWalletGoMicro
            ? 'GO'
            : b.amount >= THRESHOLDS.demoWalletWarnMicro
              ? 'WARN'
              : 'NO-GO',
        detail: `$${(Number(b.amount) / 1e6).toFixed(2)} USDC (${who}${b.exists ? '' : ', no ATA'})`,
      };
    });
  }
  await step('rpc.escrow', async () => {
    const res = await rpc
      .getProgramAccounts(ESCROW_PROGRAM_ADDRESS, {
        commitment: 'confirmed',
        encoding: 'base64',
        filters: [
          {
            memcmp: {
              offset: 0n,
              bytes: getBase58Decoder().decode(BET_DISCRIMINATOR) as Base58EncodedBytes,
              encoding: 'base58',
            },
          },
          {
            memcmp: {
              offset: BigInt(BET_RENT_PAYER_OFFSET),
              bytes: o.feePayer as unknown as Base58EncodedBytes,
              encoding: 'base58',
            },
          },
        ],
      })
      .send();
    const now = await chainNow(rpc);
    const b64 = getBase64Encoder();
    const bets = res.map((r) => getBetDecoder().decode(b64.encode(r.account.data[0])));
    const due = bets.filter((b) => exitActionFor(b, now) !== null);
    const held = bets.reduce((s, b) => s + b.stakeA + b.stakeB, 0n);
    return {
      id: 'rpc.escrow',
      verdict: due.length ? 'WARN' : 'GO',
      detail: `${bets.length} live bet(s) holding $${(Number(held) / 1e6).toFixed(2)}; ${due.length} past a deadline${
        bets.length ? ` (${[...new Set(bets.map((b) => BetStatus[b.status]))].join(', ')})` : ''
      }`,
      ...(due.length
        ? {
            fix: 'the server sweeps them; if the server is down: npm run crank -- --devnet --payer <key>',
          }
        : {}),
    };
  });
  return out;
}

run(async () => {
  const { values } = parseCli(USAGE, {
    server: { type: 'string' },
    'demo-key': { type: 'string' },
    'fee-payer': { type: 'string' },
    json: { type: 'boolean' },
  });
  const server = (values.server ?? process.env['YO_SERVER_URL'] ?? DEFAULT_SERVER).replace(
    /\/$/,
    '',
  );
  const demoKey = values['demo-key'] ?? process.env['DEMO_ADMIN_TOKEN'];
  const rpcUrl = values.url ?? process.env['SOLANA_RPC_URL'];
  const checks: Check[] = [];

  checks.push(...evaluateBasicHealth(await getJson(`${server}/health`), Date.now()));
  const demo = demoKey
    ? await getJson(`${server}/v1/demo/health`, { 'X-YO-Demo-Key': demoKey })
    : null;
  checks.push(...evaluateDemoHealth(demo, Date.now()));
  const h = demo && !('error' in demo) && demo.status === 200 ? (demo.body as DemoHealth) : null;

  if (rpcUrl) {
    const feePayer = values['fee-payer'] ?? h?.fee_payer ?? FEE_PAYER_PUBKEY;
    if (!feePayer) checks.push({ id: 'rpc', verdict: 'SKIP', detail: 'no fee payer address' });
    else
      checks.push(
        ...(await chainChecks(rpcUrl, {
          feePayer: address(feePayer),
          demoA: h?.custodial?.a ? address(h.custodial.a) : null,
          demoB: h?.custodial?.b ? address(h.custodial.b) : null,
          mint: address(process.env['USDC_MINT'] ?? USDC_MINT_DEVNET),
        })),
      );
  } else
    checks.push({
      id: 'rpc',
      verdict: 'SKIP',
      detail: 'no --url / SOLANA_RPC_URL: chain checked via the server only',
    });

  const qnKey = process.env['QN_API_KEY'];
  const qnStream = process.env['QN_STREAM_ID'];
  const stream =
    qnKey && qnStream
      ? await getJson(
          `https://api.quicknode.com/streams/rest/v1/streams/${encodeURIComponent(qnStream)}`,
          { 'x-api-key': qnKey, accept: 'application/json' },
        )
      : null;
  checks.push(evaluateStream(stream, h?.stream?.last_delivery_at));

  if (values.json)
    console.log(JSON.stringify({ verdict: overall(checks), server, checks }, null, 2));
  else {
    console.log(`demo-check ${new Date().toISOString()}  server ${server}\n`);
    console.log(formatChecks(checks));
  }
  if (overall(checks) === 'NO-GO') process.exit(1);
});
