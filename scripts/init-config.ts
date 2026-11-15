#!/usr/bin/env -S npx tsx
// ESCROW §10.3 step 7 / TASKS D1-L3: initialize_config with the §3.1 demo values.
//   admin            = the deployer key (must be the program's upgrade authority: NotUpgradeAuthority)
//   judge / appeal   = judge-keypair.json / appeal-keypair.json pubkeys from --keys-dir
//   allowed_mints    = [--mint] (default Circle devnet USDC, packages/shared USDC_MINT_DEVNET)
//
//   SOLANA_RPC_URL=... npm run init-config -- [--keys-dir <dir>] [--mint <mint>]
//
// Idempotent: when the Config PDA already exists it prints the stored values (and any difference
// from the wanted ones) instead of failing. Changing a live Config is update_config's job.
import {
  fetchMaybeConfig,
  findConfigPda,
  getInitializeConfigInstructionAsync,
  ESCROW_PROGRAM_ADDRESS,
} from '@youre-on/shared/escrow-client';

import { fmtSol, keysDirFrom, parseCli, rpcUrlFrom, run } from './lib/cli';
import {
  buildSimulated,
  connect,
  explorerAddress,
  explorerTx,
  fmtMs,
  lamportsOf,
  sendAndConfirm,
  upgradeAuthorityOf,
} from './lib/chain';
import { assertUsdcLikeMint, DEMO_CONFIG, MINT_OPTION, mintFrom } from './lib/demo';
import { loadRoles } from './lib/keys';
import { configDiff, printConfig } from './lib/config-view';

const USAGE = `usage: npm run init-config -- [--url <rpc>] [--keys-dir <dir>] [--mint <mint>]
initialize_config with the ESCROW §3.1 demo values; prints the Config PDA. Idempotent.`;

run(async () => {
  const { values } = parseCli(USAGE, MINT_OPTION);
  const chain = await connect(rpcUrlFrom(values.url));
  const keys = await loadRoles(keysDirFrom(values['keys-dir']), [
    'deployer',
    'judge',
    'appeal',
  ] as const);
  const mint = mintFrom(values.mint);
  const [configPda] = await findConfigPda();
  console.log(`cluster ${chain.cluster} (${chain.label})`);
  console.log(`program ${ESCROW_PROGRAM_ADDRESS}`);
  console.log(`Config PDA ${configPda}\n`);

  const wanted = {
    admin: keys.deployer.address,
    judgeAuthority: keys.judge.address,
    appealAuthority: keys.appeal.address,
    ...DEMO_CONFIG,
    allowedMints: [mint],
    paused: false,
  };

  const existing = await fetchMaybeConfig(chain.rpc, configPda, { commitment: 'confirmed' });
  if (existing.exists) {
    console.log('Config already initialized (no transaction sent):');
    printConfig(existing.data);
    const diff = configDiff(existing.data, wanted);
    if (diff.length) {
      console.log(`\nDIFFERS from the wanted demo values (use update_config to change):`);
      for (const d of diff) console.log(`  ${d}`);
    } else {
      console.log('\nmatches the demo values');
    }
    console.log(`\n${explorerAddress(chain, configPda)}`);
    return;
  }

  const { programData, authority } = await upgradeAuthorityOf(chain.rpc, ESCROW_PROGRAM_ADDRESS);
  if (authority !== keys.deployer.address) {
    throw new Error(
      `upgrade authority is ${authority ?? 'None (immutable)'}, not the deployer ${keys.deployer.address}: ` +
        'initialize_config would fail with NotUpgradeAuthority',
    );
  }
  await assertUsdcLikeMint(chain.rpc, mint);
  const bal = await lamportsOf(chain.rpc, keys.deployer.address);
  console.log(
    `deployer ${keys.deployer.address} holds ${fmtSol(bal)} (pays ~0.0027 SOL Config rent)`,
  );

  const ix = await getInitializeConfigInstructionAsync({
    admin: keys.deployer,
    programData,
    judgeAuthority: wanted.judgeAuthority,
    appealAuthority: wanted.appealAuthority,
    maxStake: wanted.maxStake,
    appealWindowSecs: wanted.appealWindowSecs,
    acceptDeadlineSecs: wanted.acceptDeadlineSecs,
    resolveDeadlineSecs: wanted.resolveDeadlineSecs,
    appealResolveSecs: wanted.appealResolveSecs,
    allowedMints: wanted.allowedMints,
  });
  const built = await buildSimulated(
    chain.rpc,
    keys.deployer,
    [ix],
    { kind: 'blockhash' },
    {
      label: 'initialize_config',
    },
  );
  const landed = await sendAndConfirm(chain.rpc, built.tx);
  console.log(
    `initialize_config ${landed.signature}\n  CU ${built.simulatedUnits} (limit ${built.cuLimit}), ${built.size} B, ` +
      `processed ${fmtMs(landed.processedMs)}, confirmed ${fmtMs(landed.confirmedMs)}\n  ${explorerTx(chain, landed.signature)}\n`,
  );

  const after = await fetchMaybeConfig(chain.rpc, configPda, { commitment: 'confirmed' });
  if (!after.exists) throw new Error('Config missing after a confirmed initialize_config');
  printConfig(after.data);
  const diff = configDiff(after.data, wanted);
  if (diff.length) throw new Error(`stored Config differs from the args: ${diff.join('; ')}`);
  console.log(`\nConfig PDA ${configPda}\n${explorerAddress(chain, configPda)}`);
});
