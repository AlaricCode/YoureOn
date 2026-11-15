#!/usr/bin/env -S npx tsx
// TASKS D1-L5 / ESCROW §10.3 step 11: the end-to-end escrow smoke, with the custodial demo keys.
//   1. ONE atomic lock tx [AdvanceNonce, SetComputeUnitLimit, create_bet, accept_bet] on a pool
//      nonce, signed by exactly {fee payer, demo-a, demo-b} (ESCROW §5.0.1);
//   2. [SetComputeUnitLimit, resolve] signed by the fee payer + judge (A wins by default);
//   3. after the appeal window: [SetComputeUnitLimit, finalize, close_bet], fee payer only.
// Logs send -> processed -> confirmed per tx, CU and size, Explorer links, the 5 escrow events
// read back from the chain, and asserts both party wallets hold 0 lamports before and after
// (the fee payer paid every fee and the rent; BRIEF 5b).
//
//   SOLANA_RPC_URL=... npm run smoke-devnet -- [--keys-dir <dir>] [--mint <mint>] [--stake 1]
//        [--winner a|b] [--nonce-index 4] [--database-url <pg>] [--db-wait 120]
//
// --database-url: waits for the 5 events in chain_events (QuickNode Stream -> webhook, D1-L4),
// each exactly once on (signature, outer_ix, inner_ix). Without it that check is skipped.
import { createHash, randomUUID } from 'node:crypto';

import { isSome, type Signature } from '@solana/kit';

import { NONCE_POOL_SIZE } from '@youre-on/shared/constants';
import {
  BetStatus,
  ESCROW_PROGRAM_ADDRESS,
  fetchConfig,
  fetchMaybeBet,
  findBetPda,
  findConfigPda,
  findVaultPda,
  getAcceptBetInstructionAsync,
  getCloseBetInstructionAsync,
  getCreateBetInstructionAsync,
  getFinalizeInstructionAsync,
  getResolveInstructionAsync,
  Outcome,
} from '@youre-on/shared/escrow-client';

import { fmtSol, fmtUsd, keysDirFrom, parseCli, rpcUrlFrom, run, usdToMicro } from './lib/cli';
import {
  ataBalance,
  buildSimulated,
  chainNow,
  connect,
  explorerAddress,
  explorerTx,
  fmtMs,
  lamportsOf,
  sendAndConfirm,
  sleep,
  type Built,
  type Chain,
  type Landed,
} from './lib/chain';
import { DB_OPTION, openDb, tableExists, type Sql } from './lib/db';
import { MINT_OPTION, mintFrom } from './lib/demo';
import { escrowEventsOf, type ChainEvent } from './lib/events';
import { loadRoles } from './lib/keys';
import { readPoolNonce } from './lib/nonce';

const USAGE = `usage: npm run smoke-devnet -- [--url <rpc>] [--keys-dir <dir>] [--mint <mint>] [--stake 1]
          [--winner a|b] [--nonce-index ${NONCE_POOL_SIZE - 1}] [--database-url <pg>] [--db-wait 120]
Atomic lock -> resolve -> [finalize, close_bet] with the custodial demo keys.`;

/** UUID string -> 16 bytes in RFC 4122 textual order (ESCROW §2). */
function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`bad uuid ${uuid}`);
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

function sha256(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}

type Step = {
  name: string;
  built: Built;
  landed: Landed;
  events: ChainEvent[];
  cu: bigint | null;
  fee: bigint;
};

run(async () => {
  const { values } = parseCli(USAGE, {
    ...MINT_OPTION,
    ...DB_OPTION,
    stake: { type: 'string' },
    winner: { type: 'string' },
    'nonce-index': { type: 'string' },
    'db-wait': { type: 'string' },
  });
  const chain = await connect(rpcUrlFrom(values.url));
  const keys = await loadRoles(keysDirFrom(values['keys-dir']), [
    'fee-payer',
    'judge',
    'demo-a',
    'demo-b',
  ] as const);
  const S = keys['fee-payer'];
  const A = keys['demo-a'];
  const B = keys['demo-b'];
  const mint = mintFrom(values.mint);
  const stake = usdToMicro(values.stake ?? '1');
  const winner = values.winner ?? 'a';
  if (winner !== 'a' && winner !== 'b') throw new Error('--winner must be a or b');
  const nonceIndex = Number(values['nonce-index'] ?? NONCE_POOL_SIZE - 1);
  const dbWaitSecs = Number(values['db-wait'] ?? 120);
  if (!Number.isFinite(dbWaitSecs) || dbWaitSecs <= 0)
    throw new Error('--db-wait must be a positive number of seconds');

  console.log(`cluster ${chain.cluster} (${chain.label}), program ${ESCROW_PROGRAM_ADDRESS}`);
  console.log(`fee payer ${S.address} (${fmtSol(await lamportsOf(chain.rpc, S.address))})`);
  console.log(`party A   ${A.address}\nparty B   ${B.address}\njudge     ${keys.judge.address}\n`);

  // ---- preconditions -------------------------------------------------------------------------
  const [configPda] = await findConfigPda();
  const config = (await fetchConfig(chain.rpc, configPda, { commitment: 'confirmed' })).data;
  if (config.paused) throw new Error('Config is paused');
  if (!config.allowedMints.includes(mint)) {
    throw new Error(
      `mint ${mint} not in Config.allowed_mints [${config.allowedMints.join(', ')}] (pass --mint)`,
    );
  }
  if (config.judgeAuthority !== keys.judge.address) {
    throw new Error(
      `Config.judge_authority ${config.judgeAuthority} != judge key ${keys.judge.address}`,
    );
  }
  if (stake > config.maxStake)
    throw new Error(`--stake ${fmtUsd(stake)} > max_stake ${fmtUsd(config.maxStake)}`);

  const zeroSol = async (when: string) => {
    const [la, lb] = [
      await lamportsOf(chain.rpc, A.address),
      await lamportsOf(chain.rpc, B.address),
    ];
    console.log(`party lamports ${when}: A ${la}, B ${lb}`);
    if (la !== 0n || lb !== 0n) {
      throw new Error(`party wallets must hold 0 lamports ${when} (A ${la}, B ${lb}): BRIEF 5b`);
    }
  };
  await zeroSol('before');

  const aBefore = await ataBalance(chain.rpc, A.address, mint);
  const bBefore = await ataBalance(chain.rpc, B.address, mint);
  console.log(`USDC before: A ${fmtUsd(aBefore.amount)}, B ${fmtUsd(bBefore.amount)}`);
  if (aBefore.amount < stake || bBefore.amount < stake) {
    throw new Error(`each party needs >= ${fmtUsd(stake)} (run: npm run fund)`);
  }
  const sLamportsBefore = await lamportsOf(chain.rpc, S.address);

  let sql: Sql | null = null;
  let haveNonceTable = false;
  if (values['database-url']) {
    sql = openDb(values['database-url']);
    haveNonceTable = await tableExists(sql, 'nonce_pool');
  }

  try {
    const nonce = await readPoolNonce(chain.rpc, S.address, nonceIndex);
    if (!nonce) throw new Error(`nonce k=${nonceIndex} does not exist (run: npm run nonce-pool)`);
    if (sql && haveNonceTable) {
      const [row] = await sql<{ status: string }[]>`
        SELECT status::text AS status FROM nonce_pool WHERE seed_index = ${nonceIndex}`;
      if (row && row.status !== 'free') {
        throw new Error(
          `nonce_pool k=${nonceIndex} is ${row.status}; pick a free one with --nonce-index`,
        );
      }
    }
    console.log(`nonce k=${nonceIndex} ${nonce.account} value ${nonce.value}`);
    if (sql === null) {
      console.log(
        `  (the smoke advances this nonce; keep the server from leasing k=${nonceIndex} meanwhile)`,
      );
    }

    // ---- 1. atomic lock ------------------------------------------------------------------------
    const betUuid = randomUUID();
    const betId = uuidBytes(betUuid);
    const [betPda] = await findBetPda({ betId });
    const [vaultPda] = await findVaultPda({ betId });
    if ((await fetchMaybeBet(chain.rpc, betPda)).exists)
      throw new Error(`Bet PDA ${betPda} already used`);
    const termsHash = sha256(
      JSON.stringify({ kind: 'smoke', bet_id: betUuid, stake: stake.toString() }),
    );
    const now = await chainNow(chain.rpc);
    const acceptDeadline = now + 300n;
    console.log(`\nbet ${betUuid}\n  Bet PDA ${betPda}\n  vault   ${vaultPda}`);

    const createIx = await getCreateBetInstructionAsync({
      payer: S,
      partyA: A,
      mint,
      partyAToken: aBefore.ata,
      betId,
      partyB: B.address,
      stakeA: stake,
      stakeB: stake,
      termsHash,
      acceptDeadline,
    });
    const acceptIx = await getAcceptBetInstructionAsync({
      payer: S,
      partyB: B,
      bet: betPda,
      vault: vaultPda,
      mint,
      partyBToken: bBefore.ata,
      expectedTermsHash: termsHash,
      expectedStakeA: stake,
      expectedStakeB: stake,
      expectedPartyA: A.address,
    });
    const steps: Step[] = [];
    const lockBuilt = await buildSimulated(
      chain.rpc,
      S,
      [createIx, acceptIx],
      { kind: 'nonce', account: nonce.account, value: nonce.value, authority: S.address },
      { label: 'atomic_lock' },
    );
    const signers = Object.keys(lockBuilt.tx.signatures).sort();
    const want = [S.address, A.address, B.address].sort();
    if (signers.join() !== want.join()) {
      throw new Error(`lock signers [${signers.join(', ')}] != {fee payer, A, B}`);
    }
    steps.push(await land(chain, 'atomic_lock', lockBuilt));

    const locked = await fetchMaybeBet(chain.rpc, betPda, { commitment: 'confirmed' });
    if (!locked.exists || locked.data.status !== BetStatus.Locked)
      throw new Error('Bet is not Locked after the lock');
    const vaultAfterLock = await chain.rpc
      .getTokenAccountBalance(vaultPda, { commitment: 'confirmed' })
      .send();
    console.log(`  status Locked, vault ${fmtUsd(BigInt(vaultAfterLock.value.amount))}`);
    const nonceAfter = await readPoolNonce(chain.rpc, S.address, nonceIndex);
    if (!nonceAfter || nonceAfter.value === nonce.value)
      throw new Error('the lock did not advance its nonce');
    console.log(`  nonce k=${nonceIndex} advanced -> ${nonceAfter.value}`);
    if (sql && haveNonceTable) {
      await sql`UPDATE nonce_pool SET nonce_value = ${nonceAfter.value}, value_read_at = now(),
                  last_advanced_at = now(), uses = uses + 1
                WHERE seed_index = ${nonceIndex} AND status = 'free'`;
    }

    // ---- 2. resolve --------------------------------------------------------------------------
    const outcome = winner === 'a' ? Outcome.PartyA : Outcome.PartyB;
    const resolveIx = await getResolveInstructionAsync({
      payer: S,
      judgeAuthority: keys.judge,
      bet: betPda,
      outcome,
      evidenceHash: sha256(`smoke-evidence:${betUuid}`),
      rulingHash: sha256(`smoke-ruling:${betUuid}`),
    });
    steps.push(
      await land(
        chain,
        'resolve',
        await buildSimulated(
          chain.rpc,
          S,
          [resolveIx],
          { kind: 'blockhash' },
          { label: 'resolve' },
        ),
      ),
    );
    const resolved = await fetchMaybeBet(chain.rpc, betPda, { commitment: 'confirmed' });
    if (
      !resolved.exists ||
      resolved.data.status !== BetStatus.Resolved ||
      !isSome(resolved.data.outcome)
    ) {
      throw new Error('Bet is not Resolved');
    }
    const appealDeadline = resolved.data.appealDeadline;

    // ---- 3. finalize + close_bet after the appeal window ---------------------------------------
    process.stdout.write(
      `  waiting for the ${config.appealWindowSecs} s appeal window (chain clock >= ${appealDeadline})`,
    );
    for (;;) {
      const t = await chainNow(chain.rpc, 'processed');
      if (t >= appealDeadline) break;
      process.stdout.write('.');
      await sleep(1000);
    }
    process.stdout.write('\n');
    const finalizeIx = await getFinalizeInstructionAsync({
      payer: S,
      bet: betPda,
      vault: vaultPda,
      mint,
      partyAToken: aBefore.ata,
      partyBToken: bBefore.ata,
    });
    const closeIx = await getCloseBetInstructionAsync({
      payer: S,
      bet: betPda,
      vault: vaultPda,
      mint,
      partyAToken: aBefore.ata,
      rentPayer: S.address,
    });
    steps.push(
      await land(
        chain,
        'finalize+close_bet',
        await buildSimulated(
          chain.rpc,
          S,
          [finalizeIx, closeIx],
          { kind: 'blockhash' },
          { label: 'finalize+close_bet' },
        ),
      ),
    );

    // ---- postconditions ------------------------------------------------------------------------
    if ((await fetchMaybeBet(chain.rpc, betPda, { commitment: 'confirmed' })).exists)
      throw new Error('Bet not closed');
    const vaultInfo = await chain.rpc.getAccountInfo(vaultPda, { commitment: 'confirmed' }).send();
    if (vaultInfo.value) throw new Error('vault not closed');
    const aAfter = await ataBalance(chain.rpc, A.address, mint);
    const bAfter = await ataBalance(chain.rpc, B.address, mint);
    const [wantA, wantB] =
      winner === 'a'
        ? [aBefore.amount + stake, bBefore.amount - stake]
        : [aBefore.amount - stake, bBefore.amount + stake];
    console.log(
      `\nUSDC after: A ${fmtUsd(aAfter.amount)}, B ${fmtUsd(bAfter.amount)} (winner ${winner.toUpperCase()})`,
    );
    if (aAfter.amount !== wantA || bAfter.amount !== wantB) {
      throw new Error(`payout mismatch: want A ${fmtUsd(wantA)}, B ${fmtUsd(wantB)}`);
    }
    await zeroSol('after');
    const sLamportsAfter = await lamportsOf(chain.rpc, S.address);
    const fees = steps.reduce((s, st) => s + st.fee, 0n);
    console.log(
      `fee payer spent ${sLamportsBefore - sLamportsAfter} lamports = tx fees ${fees} (rent fronted and returned by close_bet)`,
    );
    if (sLamportsBefore - sLamportsAfter !== fees) {
      console.log('  note: fee-payer delta != fees (another tx from this key ran meanwhile?)');
    }

    // ---- events --------------------------------------------------------------------------------
    const got = steps.flatMap((s) => s.events.map((e) => `${s.name}:${e.name}`));
    const wantEvents = [
      'atomic_lock:BetCreated',
      'atomic_lock:BetAccepted',
      'resolve:BetResolved',
      'finalize+close_bet:BetFinalized',
      'finalize+close_bet:BetClosed',
    ];
    if (got.join() !== wantEvents.join())
      throw new Error(`events [${got.join(', ')}] != [${wantEvents.join(', ')}]`);

    // ---- summary -------------------------------------------------------------------------------
    console.log('\n=== smoke summary ===');
    console.log(`bet ${betUuid}  ${explorerAddress(chain, betPda)}`);
    console.log(
      `${'tx'.padEnd(19)} ${'send'.padStart(7)} ${'processed'.padStart(9)} ${'confirmed'.padStart(9)} ${'CU used'.padStart(8)} ${'CU lim'.padStart(7)} ${'bytes'.padStart(5)}  events`,
    );
    for (const s of steps) {
      console.log(
        `${s.name.padEnd(19)} ${fmtMs(s.landed.sendMs).padStart(7)} ${fmtMs(s.landed.processedMs).padStart(9)} ${fmtMs(s.landed.confirmedMs).padStart(9)} ${String(s.cu ?? '?').padStart(8)} ${String(s.built.cuLimit).padStart(7)} ${String(s.built.size).padStart(5)}  ${s.events.map((e) => `${e.name}@${e.outerIx}.${e.innerIx}`).join(', ')}`,
      );
    }
    for (const s of steps)
      console.log(`  ${s.name.padEnd(19)} ${explorerTx(chain, s.landed.signature)}`);
    console.log('both party wallets held 0 lamports before and after; 5/5 escrow events onchain');

    // ---- chain_events (Stream -> webhook) ------------------------------------------------------
    if (!sql) {
      console.log('\nchain_events check skipped (no --database-url)');
      return;
    }
    if (!(await tableExists(sql, 'chain_events'))) {
      throw new Error('chain_events table not found (run the packages/db migrations)');
    }
    const sigs: Signature[] = steps.map((s) => s.landed.signature);
    const wantKeys = steps.flatMap((s) =>
      s.events.map((e) => `${s.landed.signature}:${e.outerIx}:${e.innerIx}:${e.name}`),
    );
    const deadline = Date.now() + dbWaitSecs * 1000;
    process.stdout.write(`\nwaiting up to ${dbWaitSecs} s for 5 chain_events rows`);
    for (;;) {
      const rows = await sql<
        { signature: string; outer_ix: number; inner_ix: number; event_name: string }[]
      >`
        SELECT signature, outer_ix, inner_ix, event_name FROM chain_events WHERE signature IN ${sql(sigs)}`;
      const keysGot = rows.map((r) => `${r.signature}:${r.outer_ix}:${r.inner_ix}:${r.event_name}`);
      const missing = wantKeys.filter((k) => !keysGot.includes(k));
      const dupes = keysGot.length - new Set(keysGot).size;
      if (dupes > 0)
        throw new Error(`chain_events has ${dupes} duplicate row(s) for the smoke signatures`);
      if (missing.length === 0 && rows.length === wantKeys.length) {
        process.stdout.write('\n');
        console.log(`chain_events OK: ${rows.length} rows, each exactly once`);
        break;
      }
      if (Date.now() > deadline) {
        process.stdout.write('\n');
        throw new Error(
          `chain_events: ${rows.length}/5 rows after ${dbWaitSecs} s; missing ${missing.join(', ')}`,
        );
      }
      process.stdout.write('.');
      await sleep(2000);
    }
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }
});

async function land(chain: Chain, name: string, built: Built): Promise<Step> {
  const landed = await sendAndConfirm(chain.rpc, built.tx);
  const { events, computeUnits, fee } = await escrowEventsOf(chain.rpc, landed.signature);
  console.log(
    `\n${name}: ${landed.signature}\n  send ${fmtMs(landed.sendMs)} -> processed ${fmtMs(landed.processedMs)} -> confirmed ${fmtMs(landed.confirmedMs)}` +
      `\n  CU ${computeUnits ?? '?'} (simulated ${built.simulatedUnits}, limit ${built.cuLimit}), ${built.size} B, ` +
      `${Object.keys(built.tx.signatures).length} sigs, fee ${fee}\n  events ${events.map((e) => e.name).join(', ')}` +
      `\n  ${explorerTx(chain, landed.signature)}`,
  );
  return { name, built, landed, events, cu: computeUnits, fee };
}
