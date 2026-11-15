#!/usr/bin/env -S npx tsx
// TASKS D1-L6, ESCROW §10.2 "top-up job": moves devnet USDC from TREASURY to the given wallets until
// each holds the target (default $40), creating each wallet's USDC ATA with the FEE PAYER as payer.
// The treasury signs only the transfer (it holds 0 SOL); party wallets are never sent SOL.
//
//   SOLANA_RPC_URL=... npm run fund -- [--keys-dir <dir>] [--target 40] [--mint <mint>]
//                                      [--wallet <pubkey>]... [--dry-run]
//
// Default wallets: the custodial demo parties demo-a / demo-b from --keys-dir. Add the phones'
// device wallets with --wallet (repeatable) or as positional pubkeys.
import { address, type Address } from '@solana/kit';
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from '@solana-program/token';

import { fmtSol, fmtUsd, keysDirFrom, parseCli, rpcUrlFrom, run, usdToMicro } from './lib/cli';
import {
  ataBalance,
  buildSimulated,
  connect,
  explorerTx,
  fmtMs,
  lamportsOf,
  sendAndConfirm,
} from './lib/chain';
import { assertUsdcLikeMint, MINT_OPTION, mintFrom, REQUIRED_DECIMALS } from './lib/demo';
import { loadRoles } from './lib/keys';

const USAGE = `usage: npm run fund -- [--url <rpc>] [--keys-dir <dir>] [--target 40] [--mint <mint>]
                     [--wallet <pubkey>]... [<pubkey>...] [--dry-run]
Tops each wallet up to --target USD of the mint from the treasury (fee payer pays fees + ATA rent).`;

run(async () => {
  const { values, positionals } = parseCli(USAGE, {
    ...MINT_OPTION,
    target: { type: 'string' },
    wallet: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean' },
  });
  const chain = await connect(rpcUrlFrom(values.url));
  const dir = keysDirFrom(values['keys-dir']);
  const keys = await loadRoles(dir, ['fee-payer', 'treasury'] as const);
  const mint = mintFrom(values.mint);
  const target = usdToMicro(values.target ?? '40');
  await assertUsdcLikeMint(chain.rpc, mint);

  // Deduplicated: a wallet passed twice must not be topped up twice (each top-up reads the
  // balance before either transfer lands, so it would overshoot the target).
  const explicit = [...new Set([...(values.wallet ?? []), ...positionals])].map((w) => address(w));
  let wallets: { label: string; owner: Address }[];
  if (explicit.length) {
    wallets = explicit.map((owner, i) => ({ label: `wallet${i + 1}`, owner }));
  } else {
    const demo = await loadRoles(dir, ['demo-a', 'demo-b'] as const);
    wallets = [
      { label: 'demo-a', owner: demo['demo-a'].address },
      { label: 'demo-b', owner: demo['demo-b'].address },
    ];
  }
  for (const w of wallets) {
    if (w.owner === keys.treasury.address)
      throw new Error('a target wallet is the treasury itself');
  }

  console.log(`cluster ${chain.cluster} (${chain.label}), mint ${mint}, target ${fmtUsd(target)}`);
  const treasury = await ataBalance(chain.rpc, keys.treasury.address, mint);
  console.log(
    `treasury ${keys.treasury.address}: ${fmtUsd(treasury.amount)} (ATA ${treasury.ata})`,
  );
  console.log(
    `fee payer ${keys['fee-payer'].address}: ${fmtSol(await lamportsOf(chain.rpc, keys['fee-payer'].address))}\n`,
  );
  if (!treasury.exists) {
    throw new Error(
      'the treasury has no USDC account yet: fund it from faucet.circle.com (Solana Devnet) first',
    );
  }

  const plan: { label: string; owner: Address; ata: Address; before: bigint; need: bigint }[] = [];
  for (const w of wallets) {
    const b = await ataBalance(chain.rpc, w.owner, mint);
    plan.push({
      ...w,
      ata: b.ata,
      before: b.amount,
      need: b.amount >= target ? 0n : target - b.amount,
    });
  }
  const total = plan.reduce((s, p) => s + p.need, 0n);
  for (const p of plan) {
    console.log(
      `  ${p.label.padEnd(8)} ${p.owner}  has ${fmtUsd(p.before).padEnd(8)} needs ${fmtUsd(p.need)}`,
    );
  }
  console.log(`  total to move ${fmtUsd(total)}; treasury has ${fmtUsd(treasury.amount)}`);
  if (total > treasury.amount) {
    throw new Error(
      `treasury short by ${fmtUsd(total - treasury.amount)}: request more from faucet.circle.com ` +
        '(20 USDC per 2 h per address) to the treasury address above',
    );
  }
  if (values['dry-run']) {
    console.log('\n--dry-run: nothing sent');
    return;
  }

  for (const p of plan) {
    if (p.need === 0n) continue;
    const ixs = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: keys['fee-payer'],
        owner: p.owner,
        mint,
      }),
      getTransferCheckedInstruction({
        source: treasury.ata,
        mint,
        destination: p.ata,
        authority: keys.treasury,
        amount: p.need,
        decimals: REQUIRED_DECIMALS,
      }),
    ];
    const built = await buildSimulated(
      chain.rpc,
      keys['fee-payer'],
      ixs,
      { kind: 'blockhash' },
      {
        label: `fund ${p.label}`,
      },
    );
    const landed = await sendAndConfirm(chain.rpc, built.tx);
    console.log(
      `\n${p.label}: +${fmtUsd(p.need)} confirmed ${fmtMs(landed.confirmedMs)}\n  ${explorerTx(chain, landed.signature)}`,
    );
  }

  console.log('\nbalances after:');
  let bad = 0;
  for (const p of plan) {
    const b = await ataBalance(chain.rpc, p.owner, mint);
    const sol = await lamportsOf(chain.rpc, p.owner);
    const solNote = sol === 0n ? '0 SOL' : `WARN ${fmtSol(sol)} (party wallets should hold 0 SOL)`;
    if (b.amount < target) bad++;
    console.log(`  ${p.label.padEnd(8)} ${p.owner}  ${fmtUsd(b.amount).padEnd(8)} ${solNote}`);
  }
  const t = await ataBalance(chain.rpc, keys.treasury.address, mint);
  console.log(`  treasury ${keys.treasury.address}  ${fmtUsd(t.amount)}`);
  if (bad) throw new Error(`${bad} wallet(s) below the target after funding`);
});
