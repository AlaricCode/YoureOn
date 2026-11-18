// The atomic-lock message (ESCROW §5.0.1) as the server's LockService (apps/server/src/lock)
// stores it, built with the Codama client: `[AdvanceNonceAccount, SetComputeUnitLimit,
// (SetComputeUnitPrice), create_bet, accept_bet]` on a durable nonce, fee payer = nonce
// authority = S. Compiled ONCE into the stored message bytes; each party then signs those exact
// bytes separately (`cosign`), the way the two phones and the server do. No LiteSVM import: the
// escrow and local-validator test suites and the server share this file. The parties may be
// no-op signers (`createNoopSigner(pubkey)`): compiling only needs their addresses.
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  getU32Encoder,
  getU64Encoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingDurableNonce,
  address,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
  type TransactionSigner,
} from '@solana/kit';

import {
  findBetPda,
  findVaultPda,
  getAcceptBetInstructionAsync,
  getCreateBetInstructionAsync,
} from './generated/index';

const COMPUTE_BUDGET = address('ComputeBudget111111111111111111111111111111');

/** Packet limit (ESCROW §10.1). */
export const MAX_TX_BYTES = 1232;

/** `SetComputeUnitLimit` (ComputeBudget ix 2, u32 LE). */
export function cuLimitIx(units: number): Instruction {
  return {
    programAddress: COMPUTE_BUDGET,
    data: new Uint8Array([2, ...getU32Encoder().encode(units)]),
  };
}

/** `SetComputeUnitPrice` (ComputeBudget ix 3, u64 LE micro-lamports per CU). */
export function cuPriceIx(microLamports: bigint): Instruction {
  return {
    programAddress: COMPUTE_BUDGET,
    data: new Uint8Array([3, ...getU64Encoder().encode(microLamports)]),
  };
}

/** Priority fee in lamports: ceil(limit × price / 1e6) (Agave fee rule). */
export function priorityFee(cuLimit: number, microLamports: bigint): bigint {
  return (BigInt(cuLimit) * microLamports + 999_999n) / 1_000_000n;
}

export type LockParties = {
  s: TransactionSigner;
  a: TransactionSigner;
  b: TransactionSigner;
  mint: Address;
  aToken: Address;
  bToken: Address;
};

export type LockArgs = {
  betId: Uint8Array;
  stakeA: bigint;
  stakeB: bigint;
  termsHash: Uint8Array;
  acceptDeadline: bigint;
  /** Default 200,000. */
  cuLimit?: number;
  /** Omitted when undefined (the optional ix 2). */
  cuPrice?: bigint;
  /** Overrides for accept_bet's expected_* args (N3). */
  accept?: Partial<{
    expectedTermsHash: Uint8Array;
    expectedStakeA: bigint;
    expectedStakeB: bigint;
    expectedPartyA: Address;
  }>;
  /** `[…, accept_bet, create_bet]` (N4). */
  reversed?: boolean;
};

/** ixs 1..4 of the lock (kit prepends AdvanceNonceAccount as ix 0). */
export async function lockBody(p: LockParties, args: LockArgs): Promise<Instruction[]> {
  const create = await getCreateBetInstructionAsync({
    payer: p.s,
    partyA: p.a,
    mint: p.mint,
    partyAToken: p.aToken,
    betId: args.betId,
    partyB: p.b.address,
    stakeA: args.stakeA,
    stakeB: args.stakeB,
    termsHash: args.termsHash,
    acceptDeadline: args.acceptDeadline,
  });
  const [bet] = await findBetPda({ betId: args.betId });
  const [vault] = await findVaultPda({ betId: args.betId });
  const accept = await getAcceptBetInstructionAsync({
    payer: p.s,
    partyB: p.b,
    bet,
    vault,
    mint: p.mint,
    partyBToken: p.bToken,
    expectedTermsHash: args.accept?.expectedTermsHash ?? args.termsHash,
    expectedStakeA: args.accept?.expectedStakeA ?? args.stakeA,
    expectedStakeB: args.accept?.expectedStakeB ?? args.stakeB,
    expectedPartyA: args.accept?.expectedPartyA ?? p.a.address,
  });
  const budget = [cuLimitIx(args.cuLimit ?? 200_000)];
  if (args.cuPrice !== undefined) budget.push(cuPriceIx(args.cuPrice));
  return [...budget, ...(args.reversed ? [accept, create] : [create, accept])];
}

export type NonceRef = { account: Address; value: string };

/** The stored, unsigned lock bytes (LockService step 4). */
export function compileLock(
  feePayer: Address,
  nonce: NonceRef,
  ixs: readonly Instruction[],
): Transaction {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: nonce.value as Parameters<
            typeof setTransactionMessageLifetimeUsingDurableNonce
          >[0]['nonce'],
          nonceAccountAddress: nonce.account,
          nonceAuthorityAddress: feePayer,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return compileTransaction(msg);
}

/** Add signatures over the stored bytes (never rebuilds the message). */
export async function cosign(tx: Transaction, ...signers: KeyPairSigner[]): Promise<Transaction> {
  return partiallySignTransaction(
    signers.map((s) => s.keyPair),
    tx,
  );
}

/** Serialized wire size in bytes (N12). */
export function wireSize(tx: Transaction): number {
  return getTransactionEncoder().encode(tx).length;
}
