// TS client suite (ESCROW §9.1, §10.3 step 5): the Codama-generated @solana/kit client against the
// built escrow.so on npm litesvm. Proves the client encodes create_bet / accept_bet / resolve /
// finalize / close_bet, decodes Config, Bet and every event they emit, and that fee-payer-only SOL
// works: the server key S pays every fee and all rent, the device keys A and B and the judge key
// hold 0 lamports from start to finish (§5.0).
//
//   cd programs/escrow && anchor build        # produces target/deploy/escrow.so
//   npm run test:escrow -w packages/shared    # skips with a message when the .so is absent
import {
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  none,
  some,
  type Address,
  type Instruction,
} from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { BET_SEED, CONFIG_SEED, ESCROW_ID, VAULT_SEED } from '../../src/chain/constants';
import {
  BetStatus,
  decodeBet,
  decodeConfig,
  ESCROW_ERROR__TERMS_HASH_MISMATCH,
  ESCROW_PROGRAM_ADDRESS,
  EscrowEvent,
  EscrowInstruction,
  findBetPda,
  findEventAuthorityPda,
  findVaultPda,
  getAcceptBetInstructionAsync,
  getCloseBetInstructionAsync,
  getCreateBetInstructionAsync,
  getEscrowErrorMessage,
  getFinalizeInstructionAsync,
  getResolveInstructionAsync,
  identifyEscrowInstruction,
  Outcome,
  parseAcceptBetInstruction,
  parseBetAcceptedEvent,
  parseBetClosedEvent,
  parseBetCreatedEvent,
  parseBetFinalizedEvent,
  parseBetResolvedEvent,
  parseConfigInitializedEvent,
  parseCreateBetInstruction,
} from '@youre-on/shared/escrow-client';
import {
  betId,
  buildNonceTx,
  buildTx,
  createPoolNonce,
  customError,
  demoConfigArgs,
  escrowEvents,
  expectOk,
  FUNDED,
  HAVE_SO,
  hash32,
  lamportsOf,
  newEnv,
  now,
  readNonce,
  setComputeUnitLimit,
  setNow,
  SIG_FEE,
  submit,
  TOKEN_ACCOUNT_SIZE,
  tokenAmount,
  USDC,
  type Env,
  type Sent,
} from './harness';

// Without the .so the suite is skipped; test/escrow/global-setup.ts prints why (or fails in CI).

const STAKE_A = 5n * USDC;
const STAKE_B = 7n * USDC;
const TERMS_HASH = hash32(0x7e);

/** The atomic-lock pair (ESCROW §5.0.1 ix 3 + 4), built with the generated client. */
async function lockIxs(
  env: Env,
  id: Uint8Array,
  over: { expectedTermsHash?: Uint8Array } = {},
): Promise<Instruction[]> {
  const create = await getCreateBetInstructionAsync({
    payer: env.s,
    partyA: env.a,
    mint: env.mint,
    partyAToken: env.aToken,
    betId: id,
    partyB: env.b.address,
    stakeA: STAKE_A,
    stakeB: STAKE_B,
    termsHash: TERMS_HASH,
    acceptDeadline: now(env.svm) + 300n,
  });
  const [bet] = await findBetPda({ betId: id });
  const [vault] = await findVaultPda({ betId: id });
  const accept = await getAcceptBetInstructionAsync({
    payer: env.s,
    partyB: env.b,
    bet,
    vault,
    mint: env.mint,
    partyBToken: env.bToken,
    expectedTermsHash: over.expectedTermsHash ?? TERMS_HASH,
    expectedStakeA: STAKE_A,
    expectedStakeB: STAKE_B,
    expectedPartyA: env.a.address,
  });
  return [setComputeUnitLimit(200_000), create, accept];
}

function bet(env: Env, addr: Address) {
  const acc = env.svm.getAccount(addr);
  if (!acc.exists) throw new Error(`bet ${addr} missing`);
  return decodeBet(acc).data;
}

function expectUnfunded(env: Env): void {
  for (const k of [env.a, env.b, env.judge, env.appeal]) {
    expect(lamportsOf(env.svm, k.address)).toBe(0n);
  }
}

function eventKinds(sent: Sent): [number, EscrowEvent][] {
  return escrowEvents(sent).map((e) => [e.outer, e.kind]);
}

describe.skipIf(!HAVE_SO)('escrow TS client (Codama + @solana/kit on LiteSVM)', () => {
  it('PDA helpers and the program address match the pinned constants (ESCROW §2)', async () => {
    expect(ESCROW_PROGRAM_ADDRESS).toBe(ESCROW_ID);
    const id = betId(1);
    const utf8 = getUtf8Encoder();
    const pda = (seeds: Uint8Array[]) =>
      getProgramDerivedAddress({ programAddress: ESCROW_PROGRAM_ADDRESS, seeds });
    expect((await findBetPda({ betId: id }))[0]).toBe(
      (await pda([utf8.encode(BET_SEED) as Uint8Array, id]))[0],
    );
    expect((await findVaultPda({ betId: id }))[0]).toBe(
      (await pda([utf8.encode(VAULT_SEED) as Uint8Array, id]))[0],
    );
    expect((await findEventAuthorityPda())[0]).toBe(
      (await pda([utf8.encode('__event_authority') as Uint8Array]))[0],
    );
    const env = await newEnv({ initConfig: false });
    expect(env.config).toBe((await pda([utf8.encode(CONFIG_SEED) as Uint8Array]))[0]);
  });

  let env: Env & { init?: Sent };
  beforeAll(async () => {
    if (HAVE_SO) env = await newEnv();
  });

  it('initialize_config: InitConfigArgs encode; Config and ConfigInitialized decode', () => {
    const acc = env.svm.getAccount(env.config);
    expect(acc.exists).toBe(true);
    if (!acc.exists) return;
    const config = decodeConfig(acc).data;
    const want = demoConfigArgs(env);
    expect(config).toMatchObject({ ...want, admin: env.admin.address, paused: false });

    const evs = escrowEvents(env.init!);
    expect(evs.map((e) => e.kind)).toEqual([EscrowEvent.ConfigInitialized]);
    expect(parseConfigInitializedEvent(evs[0]!.data)).toMatchObject({
      admin: env.admin.address,
      judgeAuthority: env.judge.address,
      appealAuthority: env.appeal.address,
      maxStake: want.maxStake,
      allowedMints: [env.mint],
    });
  });

  it('atomic lock on a pool nonce: one tx, 3 signatures, S pays fees + all rent, A and B 0 SOL', async () => {
    const id = betId(2);
    const [betAddr] = await findBetPda({ betId: id });
    const [vaultAddr] = await findVaultPda({ betId: id });
    const nonce = await createPoolNonce(env, 0);

    const sBefore = lamportsOf(env.svm, env.s.address);
    expectUnfunded(env);
    const tx = await buildNonceTx(env.s, nonce, await lockIxs(env, id));

    // Signers are exactly {S, A, B} with S first (the fee payer).
    expect(Object.keys(tx.signatures).sort()).toEqual(
      [env.s.address, env.a.address, env.b.address].sort(),
    );
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(compiled.staticAccounts[0]).toBe(env.s.address);
    expect(compiled.header.numSignerAccounts).toBe(3);

    // The wire bytes decode back into the generated instruction types, args intact.
    const ixs = decompileTransactionMessage(compiled).instructions;
    expect(ixs).toHaveLength(4); // AdvanceNonce, SetComputeUnitLimit, create_bet, accept_bet
    const [, , createIx, acceptIx] = ixs as unknown as Parameters<
      typeof parseCreateBetInstruction
    >[0][];
    expect(identifyEscrowInstruction(createIx!)).toBe(EscrowInstruction.CreateBet);
    expect(identifyEscrowInstruction(acceptIx!)).toBe(EscrowInstruction.AcceptBet);
    const create = parseCreateBetInstruction(createIx!);
    expect(create.data).toMatchObject({
      betId: id,
      partyB: env.b.address,
      stakeA: STAKE_A,
      stakeB: STAKE_B,
      termsHash: TERMS_HASH,
    });
    expect(create.accounts.partyA.address).toBe(env.a.address);
    expect(create.accounts.bet.address).toBe(betAddr);
    const accept = parseAcceptBetInstruction(acceptIx!);
    expect(accept.data).toMatchObject({
      expectedTermsHash: TERMS_HASH,
      expectedStakeA: STAKE_A,
      expectedStakeB: STAKE_B,
      expectedPartyA: env.a.address,
    });
    expect(accept.accounts.partyB.address).toBe(env.b.address);

    const sent = expectOk(submit(env.svm, tx));

    // Sponsorship: S paid 3 signatures + Bet and vault rent; nobody else spent a lamport.
    // Bet holds an Option<Outcome>, so the client has no fixed getBetSize(): use the allocated length.
    const betAcc = env.svm.getAccount(betAddr);
    const betLen = BigInt(betAcc.exists ? betAcc.data.length : 0);
    const rent =
      env.svm.minimumBalanceForRentExemption(betLen) +
      env.svm.minimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
    expect(lamportsOf(env.svm, betAddr) + lamportsOf(env.svm, vaultAddr)).toBe(rent);
    expect(sBefore - lamportsOf(env.svm, env.s.address)).toBe(3n * SIG_FEE + rent);
    expectUnfunded(env);
    expect(readNonce(env.svm, nonce.account)).not.toBe(nonce.value); // nonce advanced

    // Bet + vault decode.
    const b = bet(env, betAddr);
    expect(b).toMatchObject({
      betId: id,
      partyA: env.a.address,
      partyB: env.b.address,
      mint: env.mint,
      rentPayer: env.s.address,
      judgeAuthority: env.judge.address,
      appealAuthority: env.appeal.address,
      stakeA: STAKE_A,
      stakeB: STAKE_B,
      termsHash: TERMS_HASH,
      status: BetStatus.Locked,
      outcome: none(),
      createdAt: now(env.svm),
      lockedAt: now(env.svm),
    });
    expect(tokenAmount(env.svm, vaultAddr)).toBe(STAKE_A + STAKE_B);
    expect(tokenAmount(env.svm, env.aToken)).toBe(FUNDED - STAKE_A);
    expect(tokenAmount(env.svm, env.bToken)).toBe(FUNDED - STAKE_B);

    // BetCreated (outer ix 2) then BetAccepted (outer ix 3) under one signature.
    expect(eventKinds(sent)).toEqual([
      [2, EscrowEvent.BetCreated],
      [3, EscrowEvent.BetAccepted],
    ]);
    const [created, accepted] = escrowEvents(sent);
    expect(parseBetCreatedEvent(created!.data)).toMatchObject({
      betId: id,
      partyA: env.a.address,
      partyB: env.b.address,
      stakeA: STAKE_A,
      stakeB: STAKE_B,
      termsHash: TERMS_HASH,
    });
    expect(parseBetAcceptedEvent(accepted!.data)).toMatchObject({ betId: id });
  });

  it('resolve (judge key, 0 SOL) then [finalize, close_bet]: winner paid, rent back to S', async () => {
    const id = betId(3);
    const [betAddr] = await findBetPda({ betId: id });
    const [vaultAddr] = await findVaultPda({ betId: id });
    expectOk(submit(env.svm, await buildTx(env.svm, env.s, await lockIxs(env, id))));

    // resolve: signed by the judge key; S is the fee payer.
    const evidenceHash = hash32(0xe1);
    const rulingHash = hash32(0x91);
    const sBeforeResolve = lamportsOf(env.svm, env.s.address);
    const resolved = expectOk(
      submit(
        env.svm,
        await buildTx(env.svm, env.s, [
          await getResolveInstructionAsync({
            payer: env.s,
            judgeAuthority: env.judge,
            bet: betAddr,
            outcome: Outcome.PartyA,
            evidenceHash,
            rulingHash,
          }),
        ]),
      ),
    );
    expect(sBeforeResolve - lamportsOf(env.svm, env.s.address)).toBe(2n * SIG_FEE);
    expectUnfunded(env);
    const r = bet(env, betAddr);
    expect(r).toMatchObject({
      status: BetStatus.Resolved,
      outcome: some(Outcome.PartyA),
      evidenceHash,
      rulingHash,
      resolvedAt: now(env.svm),
      appealDeadline: now(env.svm) + 10n,
    });
    expect(eventKinds(resolved)).toEqual([[0, EscrowEvent.BetResolved]]);
    expect(parseBetResolvedEvent(escrowEvents(resolved)[0]!.data)).toMatchObject({
      betId: id,
      outcome: Outcome.PartyA,
      evidenceHash,
      rulingHash,
    });

    // After the appeal window: [finalize, close_bet] in one tx, payer S only.
    setNow(env.svm, r.appealDeadline);
    const pot = STAKE_A + STAKE_B;
    const aBefore = tokenAmount(env.svm, env.aToken);
    const bBefore = tokenAmount(env.svm, env.bToken);
    const sBefore = lamportsOf(env.svm, env.s.address);
    const rentReturned = lamportsOf(env.svm, betAddr) + lamportsOf(env.svm, vaultAddr);
    const finalized = expectOk(
      submit(
        env.svm,
        await buildTx(env.svm, env.s, [
          await getFinalizeInstructionAsync({
            payer: env.s,
            bet: betAddr,
            vault: vaultAddr,
            mint: env.mint,
            partyAToken: env.aToken,
            partyBToken: env.bToken,
          }),
          // party_a_token omitted (Option<...> = None): the vault is empty after the payout.
          await getCloseBetInstructionAsync({
            payer: env.s,
            bet: betAddr,
            vault: vaultAddr,
            mint: env.mint,
            rentPayer: env.s.address,
          }),
        ]),
      ),
    );

    expect(tokenAmount(env.svm, env.aToken) - aBefore).toBe(pot);
    expect(tokenAmount(env.svm, env.bToken)).toBe(bBefore);
    expect(env.svm.getAccount(betAddr).exists).toBe(false);
    expect(env.svm.getAccount(vaultAddr).exists).toBe(false);
    // S paid one signature and got every lamport of Bet + vault rent back.
    expect(lamportsOf(env.svm, env.s.address) - sBefore).toBe(rentReturned - SIG_FEE);
    expectUnfunded(env);

    expect(eventKinds(finalized)).toEqual([
      [0, EscrowEvent.BetFinalized],
      [1, EscrowEvent.BetClosed],
    ]);
    const [fin, closed] = escrowEvents(finalized);
    expect(parseBetFinalizedEvent(fin!.data)).toMatchObject({
      betId: id,
      outcome: Outcome.PartyA,
      toA: pot,
      toB: 0n,
      caller: env.s.address,
    });
    expect(parseBetClosedEvent(closed!.data)).toMatchObject({
      betId: id,
      finalStatus: BetStatus.Settled,
      rentPayer: env.s.address,
      rentReturned,
      residualToA: 0n,
    });
  });

  it('a lock whose accept_bet disagrees fails atomically with the generated error code', async () => {
    const id = betId(4);
    const [betAddr] = await findBetPda({ betId: id });
    const aBefore = tokenAmount(env.svm, env.aToken);
    const bBefore = tokenAmount(env.svm, env.bToken);
    const r = submit(
      env.svm,
      await buildTx(env.svm, env.s, await lockIxs(env, id, { expectedTermsHash: hash32(0x01) })),
    );
    expect('failed' in r).toBe(true);
    if (!('failed' in r)) return;
    expect(customError(r.failed)).toEqual({ index: 2, code: ESCROW_ERROR__TERMS_HASH_MISMATCH });
    expect(getEscrowErrorMessage(ESCROW_ERROR__TERMS_HASH_MISMATCH)).toMatch(/terms/i);
    // Nothing moved: no Bet, A's stake still in A's account.
    expect(env.svm.getAccount(betAddr).exists).toBe(false);
    expect(tokenAmount(env.svm, env.aToken)).toBe(aBefore);
    expect(tokenAmount(env.svm, env.bToken)).toBe(bBefore);
    expectUnfunded(env);
  });

  it('a device key cannot pay: the same lock with A as fee payer is rejected, nothing moves', async () => {
    const id = betId(5);
    const [betAddr] = await findBetPda({ betId: id });
    const aBefore = tokenAmount(env.svm, env.aToken);
    const sBefore = lamportsOf(env.svm, env.s.address);
    const r = submit(env.svm, await buildTx(env.svm, env.a, await lockIxs(env, id)));
    expect('failed' in r).toBe(true);
    if (!('failed' in r)) return;
    // A has never held a lamport, so the runtime refuses the fee payer before any ix runs.
    expect(customError(r.failed)).toBeNull();
    expect(r.failed.toString()).toMatch(/AccountNotFound|InsufficientFundsForFee/);
    expect(env.svm.getAccount(betAddr).exists).toBe(false);
    expect(tokenAmount(env.svm, env.aToken)).toBe(aBefore);
    expect(lamportsOf(env.svm, env.s.address)).toBe(sBefore);
    expectUnfunded(env);
  });
});
