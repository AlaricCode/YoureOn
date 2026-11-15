#!/usr/bin/env -S npx tsx
// LOCAL-ONLY fixture for the CR1-equivalent e2e check (ESCROW §9.2 CR1, TM-L10), driven by
// scripts/e2e-local.sh. Refuses any cluster but a local validator.
//
//   setup  --state <file>   with the server "stopped" (nothing but this script touches the chain):
//                           creates three bets with the demo keys, fee payer S as rent payer:
//                             L  Locked, resolve window 60 s (Config.resolve_deadline_secs is set
//                                to its minimum for this one bet, then restored: Bets snapshot it)
//                             O  Open, accept_deadline = now + 5 s
//                             R  Resolved (A wins), 10 s appeal window
//                           then waits on the chain clock until all three are due, and records
//                           balances + rent in <file>.
//   verify --state <file>   after `npm run crank`: every Bet and vault closed, each party's USDC
//                           exactly as the §6 payout says, and S up by exactly the rent of all
//                           six accounts (S paid no fee: the crank's own key did).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { address, type Instruction, type TransactionSigner } from '@solana/kit';

import {
  BetStatus,
  fetchConfig,
  fetchMaybeBet,
  findBetPda,
  findConfigPda,
  findVaultPda,
  getAcceptBetInstructionAsync,
  getCreateBetInstructionAsync,
  getResolveInstructionAsync,
  getUpdateConfigInstructionAsync,
  Outcome,
} from '@youre-on/shared/escrow-client';

import { keysDirFrom, parseCli, rpcUrlFrom, run } from './lib/cli';
import {
  ataBalance,
  buildSimulated,
  chainNow,
  connect,
  lamportsOf,
  sendAndConfirm,
  sleep,
  type Chain,
} from './lib/chain';
import { MINT_OPTION, mintFrom } from './lib/demo';
import { loadRoles } from './lib/keys';

const USAGE = `usage: npx tsx scripts/crank-fixture.ts setup|verify --state <file> [--url <rpc>]
       [--keys-dir <dir>] [--mint <mint>]       (local validator only)`;

const STAKE = 1_000_000n; // $1 per side
const RESOLVE_SECS_MIN = 60;

type Kind = 'L' | 'O' | 'R';
type State = {
  mint: string;
  sBefore: string;
  rent: string;
  aBefore: string;
  bBefore: string;
  bets: { kind: Kind; bet: string; vault: string; deadline: string }[];
};

function sha256(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}

function uuidBytes(u: string): Uint8Array {
  return Uint8Array.from(
    u
      .replaceAll('-', '')
      .match(/../g)!
      .map((h) => parseInt(h, 16)),
  );
}

async function send(
  chain: Chain,
  payer: TransactionSigner,
  ixs: Parameters<typeof buildSimulated>[2],
  label: string,
) {
  const built = await buildSimulated(chain.rpc, payer, ixs, { kind: 'blockhash' }, { label });
  await sendAndConfirm(chain.rpc, built.tx);
}

run(async () => {
  const { values, positionals } = parseCli(USAGE, { ...MINT_OPTION, state: { type: 'string' } });
  const mode = positionals[0];
  if ((mode !== 'setup' && mode !== 'verify') || !values.state) {
    console.error(USAGE);
    process.exit(2);
  }
  const chain = await connect(rpcUrlFrom(values.url));
  if (chain.cluster !== 'localnet')
    throw new Error(`crank-fixture is local-only (${chain.cluster})`);
  const keys = await loadRoles(keysDirFrom(values['keys-dir']), [
    'deployer',
    'fee-payer',
    'judge',
    'demo-a',
    'demo-b',
  ] as const);
  const S = keys['fee-payer'];
  const A = keys['demo-a'];
  const B = keys['demo-b'];
  const mint = mintFrom(values.mint);
  const [configPda] = await findConfigPda();

  if (mode === 'verify') {
    const st = JSON.parse(readFileSync(values.state, 'utf8')) as State;
    for (const b of st.bets) {
      if ((await fetchMaybeBet(chain.rpc, address(b.bet))).exists)
        throw new Error(`bet ${b.kind} ${b.bet} still open`);
      const v = await chain.rpc
        .getAccountInfo(address(b.vault), { commitment: 'confirmed' })
        .send();
      if (v.value) throw new Error(`vault of ${b.kind} still exists`);
    }
    // L: both refunded; O: A refunded (B never paid); R: A wins B's stake.
    const a = (await ataBalance(chain.rpc, A.address, mint)).amount;
    const b = (await ataBalance(chain.rpc, B.address, mint)).amount;
    const wantA = BigInt(st.aBefore) + STAKE;
    const wantB = BigInt(st.bBefore) - STAKE;
    if (a !== wantA || b !== wantB)
      throw new Error(`balances A ${a} (want ${wantA}), B ${b} (want ${wantB})`);
    const s = await lamportsOf(chain.rpc, S.address);
    const wantS = BigInt(st.sBefore) + BigInt(st.rent);
    if (s !== wantS) throw new Error(`fee payer S ${s} lamports, want ${wantS} (rent -> S)`);
    if (
      (await lamportsOf(chain.rpc, A.address)) !== 0n ||
      (await lamportsOf(chain.rpc, B.address)) !== 0n
    )
      throw new Error('party wallets must hold 0 lamports');
    console.log(`CR1 ok: 3 bets settled and closed, A ${a}, B ${b}, S +${st.rent} lamports rent`);
    return;
  }

  // ---- setup ----------------------------------------------------------------------------------
  const config = (await fetchConfig(chain.rpc, configPda, { commitment: 'confirmed' })).data;
  const aBefore = await ataBalance(chain.rpc, A.address, mint);
  const bBefore = await ataBalance(chain.rpc, B.address, mint);
  if (aBefore.amount < 3n * STAKE || bBefore.amount < 2n * STAKE)
    throw new Error('demo parties need USDC (run fund first)');
  const updateResolveSecs = async (secs: number) =>
    send(
      chain,
      S,
      [
        await getUpdateConfigInstructionAsync({
          admin: keys.deployer,
          newAdmin: null,
          judgeAuthority: null,
          appealAuthority: null,
          maxStake: null,
          appealWindowSecs: null,
          acceptDeadlineSecs: null,
          resolveDeadlineSecs: secs,
          appealResolveSecs: null,
          allowedMints: null,
          paused: null,
        }),
      ],
      `update_config resolve_deadline_secs=${secs}`,
    );

  const make = async (kind: Kind, acceptIn: bigint, lock: boolean) => {
    const id = uuidBytes(randomUUID());
    const [bet] = await findBetPda({ betId: id });
    const [vault] = await findVaultPda({ betId: id });
    const termsHash = sha256(`crank-fixture:${kind}:${bet}`);
    const now = await chainNow(chain.rpc);
    const ixs: Instruction[] = [
      await getCreateBetInstructionAsync({
        payer: S,
        partyA: A,
        mint,
        partyAToken: aBefore.ata,
        betId: id,
        partyB: B.address,
        stakeA: STAKE,
        stakeB: STAKE,
        termsHash,
        acceptDeadline: now + acceptIn,
      }),
    ];
    if (lock) {
      ixs.push(
        await getAcceptBetInstructionAsync({
          payer: S,
          partyB: B,
          bet,
          vault,
          mint,
          partyBToken: bBefore.ata,
          expectedTermsHash: termsHash,
          expectedStakeA: STAKE,
          expectedStakeB: STAKE,
          expectedPartyA: A.address,
        }),
      );
    }
    await send(chain, S, ixs, `${kind}: create_bet${lock ? '+accept_bet' : ''}`);
    return { bet, vault };
  };

  // L: snapshot a 60 s resolve window, then put the demo value back.
  await updateResolveSecs(RESOLVE_SECS_MIN);
  const L = await make('L', 300n, true);
  await updateResolveSecs(config.resolveDeadlineSecs);
  const O = await make('O', 5n, false);
  const R = await make('R', 300n, true);
  await send(
    chain,
    S,
    [
      await getResolveInstructionAsync({
        payer: S,
        judgeAuthority: keys.judge,
        bet: R.bet,
        outcome: Outcome.PartyA,
        evidenceHash: sha256(`crank-fixture-evidence:${R.bet}`),
        rulingHash: sha256(`crank-fixture-ruling:${R.bet}`),
      }),
    ],
    'R: resolve(PartyA)',
  );

  const bets: State['bets'] = [];
  let rent = 0n;
  let latest = 0n;
  for (const [kind, x] of [
    ['L', L],
    ['O', O],
    ['R', R],
  ] as const) {
    const acc = await fetchMaybeBet(chain.rpc, x.bet, { commitment: 'confirmed' });
    if (!acc.exists) throw new Error(`${kind} missing`);
    const d = acc.data;
    const want = { L: BetStatus.Locked, O: BetStatus.Open, R: BetStatus.Resolved }[kind];
    if (d.status !== want) throw new Error(`${kind} is ${BetStatus[d.status]}`);
    const deadline =
      kind === 'L' ? d.resolveDeadline : kind === 'O' ? d.acceptDeadline : d.appealDeadline;
    if (deadline > latest) latest = deadline;
    rent += (await lamportsOf(chain.rpc, x.bet)) + (await lamportsOf(chain.rpc, x.vault));
    bets.push({ kind, bet: x.bet, vault: x.vault, deadline: deadline.toString() });
    console.log(`${kind} ${x.bet} ${BetStatus[d.status]}, due at ${deadline}`);
  }

  process.stdout.write(`waiting for the chain clock to reach ${latest}`);
  for (;;) {
    if ((await chainNow(chain.rpc, 'confirmed')) >= latest) break;
    process.stdout.write('.');
    await sleep(2000);
  }
  process.stdout.write('\n');

  // Balances from BEFORE any deposit: after the crank, L and O are refunds (net 0) and R pays A
  // B's stake, so verify expects A = aBefore + STAKE and B = bBefore - STAKE.
  const state: State = {
    mint,
    sBefore: (await lamportsOf(chain.rpc, S.address)).toString(),
    rent: rent.toString(),
    aBefore: aBefore.amount.toString(),
    bBefore: bBefore.amount.toString(),
    bets,
  };
  writeFileSync(values.state, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`state -> ${values.state}`);
});
