#!/usr/bin/env -S npx tsx
// TASKS D1-L3 DoD: reads the Config PDA from the chain and prints the demo values (ESCROW §3.1),
// plus the program's upgrade authority. Read-only; needs no keys.
//
//   SOLANA_RPC_URL=... npm run check-config -- [--mint <mint>] [--keys-dir <dir>]
//
// Exits 1 when the Config is missing or differs from the demo values. The authorities are also
// compared with the keypairs in --keys-dir when that directory holds them.
import { existsSync } from 'node:fs';

import type { Address } from '@solana/kit';

import {
  ESCROW_PROGRAM_ADDRESS,
  fetchMaybeConfig,
  findConfigPda,
} from '@youre-on/shared/escrow-client';

import { keysDirFrom, parseCli, rpcUrlFrom, run } from './lib/cli';
import { connect, explorerAddress, upgradeAuthorityOf } from './lib/chain';
import { configDiff, printConfig } from './lib/config-view';
import { DEMO_CONFIG, MINT_OPTION, mintFrom } from './lib/demo';
import { keyPath, loadRole, type KeyRole } from './lib/keys';

const USAGE = `usage: npm run check-config -- [--url <rpc>] [--mint <mint>] [--keys-dir <dir>]
Prints the onchain Config and checks it against the ESCROW §3.1 demo values.`;

run(async () => {
  const { values } = parseCli(USAGE, MINT_OPTION);
  const chain = await connect(rpcUrlFrom(values.url));
  const [configPda] = await findConfigPda();
  console.log(`cluster ${chain.cluster} (${chain.label})`);
  console.log(`program ${ESCROW_PROGRAM_ADDRESS}`);
  const { programData, authority } = await upgradeAuthorityOf(chain.rpc, ESCROW_PROGRAM_ADDRESS);
  console.log(`program data ${programData}, upgrade authority ${authority ?? 'None (immutable)'}`);
  console.log(`Config PDA ${configPda}\n${explorerAddress(chain, configPda)}\n`);

  const cfg = await fetchMaybeConfig(chain.rpc, configPda, { commitment: 'confirmed' });
  if (!cfg.exists) throw new Error('Config is not initialized (run: npm run init-config)');
  printConfig(cfg.data);

  const dir = keysDirFrom(values['keys-dir']);
  const fromKeys = async (role: KeyRole): Promise<Address | undefined> =>
    existsSync(keyPath(dir, role)) ? (await loadRole(dir, role)).address : undefined;
  const diff = configDiff(cfg.data, {
    ...DEMO_CONFIG,
    admin: await fromKeys('deployer'),
    judgeAuthority: await fromKeys('judge'),
    appealAuthority: await fromKeys('appeal'),
    allowedMints: [mintFrom(values.mint)],
    paused: false,
  });
  if (cfg.data.admin !== authority) {
    console.log(
      `\nnote: admin ${cfg.data.admin} != current upgrade authority (allowed after rotation)`,
    );
  }
  if (diff.length) {
    throw new Error(`Config differs from the demo values:\n  ${diff.join('\n  ')}`);
  }
  console.log('\nOK: Config matches the ESCROW §3.1 demo values');
});
