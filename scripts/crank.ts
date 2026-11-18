#!/usr/bin/env -S npx tsx
// ESCROW §1.2 / TM-L10 / §9.2 CR1 (TASKS D3-L2): the permissionless crank. If the server is gone,
// anyone with a funded key runs this to push every escrow Bet whose deadline passed to its exit
// (timeout_refund or finalize) and close it, returning all rent to the stored rent payer (S).
// The payer gets nothing but the fees it paid. Logic: scripts/lib/crank.ts.
//
//   SOLANA_RPC_URL=http://127.0.0.1:8899 npm run crank -- --payer <keypair.json> [--dry-run]
//
// Local validators by default. A devnet RPC is refused unless --devnet is passed (the
// server-gone emergency on devnet); mainnet is always refused (lib/chain connect()).
import { BetStatus } from '@youre-on/shared/escrow-client';

import { expandPath, fmtSol, parseCli, rpcUrlFrom, run } from './lib/cli';
import { chainNow, connect, explorerTx, lamportsOf } from './lib/chain';
import { crankOnce } from './lib/crank';
import { loadKeypairFile } from './lib/keys';

const USAGE = `usage: npm run crank -- [--url <rpc>] --payer <keypair.json> [--dry-run] [--devnet] [--only <pda,...>] [--skip <pda,...>]
Settles and closes every escrow Bet whose deadline has passed; rent goes to each Bet's rent payer.
  --payer    any funded keypair (solana-keygen JSON); pays the fees only
  --dry-run  list what would be sent, send nothing
  --devnet   allow a devnet RPC (default: local validators only)`;

run(async () => {
  const { values } = parseCli(USAGE, {
    payer: { type: 'string' },
    'dry-run': { type: 'boolean' },
    devnet: { type: 'boolean' },
    only: { type: 'string' },
    skip: { type: 'string' },
  });
  if (!values.payer) {
    console.error(`--payer is required\n\n${USAGE}`);
    process.exit(2);
  }
  const chain = await connect(rpcUrlFrom(values.url));
  if (chain.cluster !== 'localnet' && !values.devnet) {
    throw new Error(
      `RPC ${chain.label} is ${chain.cluster}: pass --devnet to crank a public cluster`,
    );
  }
  const payer = await loadKeypairFile(expandPath(values.payer));
  const now = await chainNow(chain.rpc);
  console.log(`cluster ${chain.cluster} (${chain.label}), chain clock ${now}`);
  console.log(`payer ${payer.address} (${fmtSol(await lamportsOf(chain.rpc, payer.address))})`);

  const results = await crankOnce(chain.rpc, payer, now, {
    dryRun: values['dry-run'] ?? false,
    log: (l) => console.log(l),
    only: pdaSet(values.only),
    skip: pdaSet(values.skip),
  });
  const due = results.filter((r) => r.action);
  console.log(`\n${results.length} bet(s) on chain, ${due.length} due`);
  for (const r of due) {
    const what = r.signature
      ? `sent ${explorerTx(chain, r.signature)}`
      : r.error
        ? `FAILED ${r.error}`
        : 'would send';
    console.log(`  ${r.address} ${BetStatus[r.status]} -> ${r.action}: ${what}`);
  }
  const failed = due.filter((r) => r.error);
  if (failed.length) throw new Error(`${failed.length} bet(s) could not be cranked`);
});

/** Comma-separated Bet PDAs (--only / --skip). */
function pdaSet(v: string | undefined): Set<string> {
  return new Set(
    (v ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
}
