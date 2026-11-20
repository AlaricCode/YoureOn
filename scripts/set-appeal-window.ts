#!/usr/bin/env -S npx tsx
// update_config appeal_window_secs: how long the loser has to say GG or appeal after a ruling
// (docs/runbook.md "Timing"). An admin transaction signed by the deployer key. New bets only:
// a bet keeps the window it was created with (ESCROW I11).
//
//   SOLANA_RPC_URL=... npx tsx scripts/set-appeal-window.ts --secs 20 [--keys-dir <dir>]
//
// Afterwards set APPEAL_WINDOW_S to the same number on the server (the RULING cue's gg_secs).
// Without --secs it only prints the stored Config.
import {
  fetchMaybeConfig,
  findConfigPda,
  getUpdateConfigInstructionAsync,
} from '@youre-on/shared/escrow-client';

import { keysDirFrom, parseCli, rpcUrlFrom, run } from './lib/cli';
import { buildSimulated, connect, explorerTx, sendAndConfirm } from './lib/chain';
import { loadRoles } from './lib/keys';

const USAGE = `usage: npx tsx scripts/set-appeal-window.ts [--url <rpc>] [--keys-dir <dir>] [--secs <n>]
update_config appeal_window_secs = n (5 to 120). Without --secs, prints the stored value.`;

run(async () => {
  const { values } = parseCli(USAGE, { secs: { type: 'string' } });
  const chain = await connect(rpcUrlFrom(values.url));
  const [configPda] = await findConfigPda();
  const before = await fetchMaybeConfig(chain.rpc, configPda, { commitment: 'confirmed' });
  if (!before.exists) throw new Error(`no Config at ${configPda}`);
  console.log(`cluster ${chain.cluster}; appeal_window_secs = ${before.data.appealWindowSecs}`);
  if (values.secs === undefined) return;

  const secs = Number(values.secs);
  if (!Number.isInteger(secs) || secs < 5 || secs > 120) throw new Error('--secs must be 5 to 120');
  if (secs === before.data.appealWindowSecs) {
    console.log('already set; no transaction sent');
    return;
  }
  const keys = await loadRoles(keysDirFrom(values['keys-dir']), ['deployer'] as const);
  if (before.data.admin !== keys.deployer.address)
    throw new Error(`Config admin is ${before.data.admin}, not the deployer key`);
  const ix = await getUpdateConfigInstructionAsync({
    admin: keys.deployer,
    newAdmin: null,
    judgeAuthority: null,
    appealAuthority: null,
    maxStake: null,
    appealWindowSecs: secs,
    acceptDeadlineSecs: null,
    resolveDeadlineSecs: null,
    appealResolveSecs: null,
    allowedMints: null,
    paused: null,
  });
  const built = await buildSimulated(
    chain.rpc,
    keys.deployer,
    [ix],
    { kind: 'blockhash' },
    {
      label: `update_config appeal_window_secs=${secs}`,
    },
  );
  const landed = await sendAndConfirm(chain.rpc, built.tx);
  console.log(`update_config ${landed.signature}\n  ${explorerTx(chain, landed.signature)}`);
  const after = await fetchMaybeConfig(chain.rpc, configPda, { commitment: 'confirmed' });
  if (after.exists) console.log(`appeal_window_secs is now ${after.data.appealWindowSecs}`);
});
