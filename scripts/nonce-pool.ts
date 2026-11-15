#!/usr/bin/env -S npx tsx
// ESCROW §10.3 step 9 / §5.0.1, DATA-MODEL §5.20: the lock's durable-nonce pool.
// NONCE_POOL_SIZE (5) System nonce accounts at createAccountWithSeed(fee payer, "yo-nonce-<k>",
// System), authority = the fee payer, so the lock stays at 3 signatures and a phone can verify pool
// membership from the pinned fee-payer pubkey alone (§5.0.2).
//
//   SOLANA_RPC_URL=... npm run nonce-pool -- [--keys-dir <dir>] [--count 5] [--database-url <pg>]
//
// Idempotent: existing accounts are verified (owner System, initialized, authority = fee payer),
// missing ones are created (CreateAccountWithSeed + InitializeNonceAccount, fee payer pays the
// 1,056,640-lamport rent). Prints every address and its nonce value read at `confirmed`.
// --database-url: upserts the `nonce_pool` rows when that table exists, else prints the SQL.
import {
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getNonceSize,
} from '@solana-program/system';

import { NONCE_POOL_SIZE, NONCE_SEED_MAX } from '@youre-on/shared/constants';
import { nonceSeed } from '@youre-on/shared/chain/constants';

import { fmtSol, keysDirFrom, parseCli, rpcUrlFrom, run } from './lib/cli';
import {
  buildSimulated,
  connect,
  explorerAddress,
  explorerTx,
  fmtMs,
  lamportsOf,
  sendAndConfirm,
} from './lib/chain';
import { DB_OPTION, lit, openDb, tableExists } from './lib/db';
import { loadRole } from './lib/keys';
import { poolAddress, readPoolNonce, SYSTEM, type PoolEntry } from './lib/nonce';

const USAGE = `usage: npm run nonce-pool -- [--url <rpc>] [--keys-dir <dir>] [--count ${NONCE_POOL_SIZE}] [--database-url <pg>]
Creates/verifies seed indexes 0..count-1 (max ${NONCE_SEED_MAX}).`;

function upsertSql(entries: readonly PoolEntry[], readAt: string): string {
  const rows = entries
    .map(
      (e) =>
        `  (${e.k}, ${lit(e.account)}, ${lit(e.authority)}, 'free', ${lit(e.value)}, ${lit(readAt)})`,
    )
    .join(',\n');
  return `INSERT INTO nonce_pool (seed_index, nonce_account, authority, status, nonce_value, value_read_at)
VALUES
${rows}
ON CONFLICT (seed_index) DO UPDATE
  SET nonce_value = EXCLUDED.nonce_value, value_read_at = EXCLUDED.value_read_at
  WHERE nonce_pool.status = 'free' AND nonce_pool.nonce_account = EXCLUDED.nonce_account;`;
}

run(async () => {
  const { values } = parseCli(USAGE, { count: { type: 'string' }, ...DB_OPTION });
  const count = Number(values.count ?? NONCE_POOL_SIZE);
  if (!Number.isInteger(count) || count < 1 || count > NONCE_SEED_MAX) {
    throw new Error(`--count must be an integer in [1, ${NONCE_SEED_MAX}]`);
  }
  const chain = await connect(rpcUrlFrom(values.url));
  const feePayer = await loadRole(keysDirFrom(values['keys-dir']), 'fee-payer');
  console.log(`cluster ${chain.cluster} (${chain.label})`);
  console.log(
    `fee payer (base + nonce authority) ${feePayer.address}, ${fmtSol(await lamportsOf(chain.rpc, feePayer.address))}\n`,
  );

  const space = BigInt(getNonceSize());
  const rent = await chain.rpc.getMinimumBalanceForRentExemption(space).send();
  const missing: number[] = [];
  for (let k = 0; k < count; k++) {
    if (!(await readPoolNonce(chain.rpc, feePayer.address, k))) missing.push(k);
  }
  if (missing.length) {
    console.log(
      `creating ${missing.length} nonce account(s): k = ${missing.join(', ')} (rent ${rent} lamports each)`,
    );
  }
  await Promise.all(
    missing.map(async (k) => {
      const seed = nonceSeed(k);
      const account = await poolAddress(feePayer.address, k);
      const built = await buildSimulated(
        chain.rpc,
        feePayer,
        [
          getCreateAccountWithSeedInstruction({
            payer: feePayer,
            newAccount: account,
            baseAccount: feePayer,
            base: feePayer.address,
            seed,
            amount: rent,
            space,
            programAddress: SYSTEM,
          }),
          getInitializeNonceAccountInstruction({
            nonceAccount: account,
            nonceAuthority: feePayer.address,
          }),
        ],
        { kind: 'blockhash' },
        { label: `nonce k=${k}` },
      );
      const landed = await sendAndConfirm(chain.rpc, built.tx);
      console.log(
        `  k=${k} created, confirmed ${fmtMs(landed.confirmedMs)}  ${explorerTx(chain, landed.signature)}`,
      );
    }),
  );

  const entries: PoolEntry[] = [];
  for (let k = 0; k < count; k++) {
    const e = await readPoolNonce(chain.rpc, feePayer.address, k);
    if (!e) throw new Error(`nonce k=${k} missing after creation`);
    entries.push(e);
  }
  const readAt = new Date().toISOString();
  console.log(`\nnonce pool (values read at confirmed, ${readAt}):`);
  console.log(`  ${'k'.padEnd(2)} ${'seed'.padEnd(11)} ${'nonce account'.padEnd(44)} nonce value`);
  for (const e of entries) {
    console.log(
      `  ${String(e.k).padEnd(2)} ${nonceSeed(e.k).padEnd(11)} ${e.account.padEnd(44)} ${e.value}`,
    );
  }
  console.log(`  explorer (k=0): ${explorerAddress(chain, entries[0]!.account)}`);

  const sqlText = upsertSql(entries, readAt);
  if (!values['database-url']) {
    console.log(
      `\n(no --database-url) SQL for the nonce_pool rows (DATA-MODEL §5.20):\n${sqlText}`,
    );
    return;
  }
  const sql = openDb(values['database-url']);
  try {
    if (!(await tableExists(sql, 'nonce_pool'))) {
      console.log(
        `\nnonce_pool table not found in this database (no migration yet); SQL to run later:\n${sqlText}`,
      );
      return;
    }
    await sql.unsafe(sqlText);
    const rows = await sql<{ seed_index: number; status: string; nonce_value: string | null }[]>`
      SELECT seed_index, status::text AS status, nonce_value FROM nonce_pool ORDER BY seed_index`;
    console.log(`\nnonce_pool rows upserted (${rows.length} total):`);
    for (const r of rows) console.log(`  ${r.seed_index} ${r.status} ${r.nonce_value ?? 'NULL'}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
