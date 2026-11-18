// Server-side builders for an escrow Bet's exits (ESCROW §5.2): the instructions of
// [ATA creates, timeout_refund | finalize | cancel_open_bet, close_bet] (or a lone close_bet) for
// one Bet, paid by the fee payer, plus what the exit will pay. The server port of
// scripts/lib/crank.ts over the injectable ChainClient (so LiteSVM tests run it), used by the
// timeout-refund and orphan sweeps (src/payout/refund.ts). Which exit is due comes from the
// shared table (packages/shared/src/chain/exits.ts).
//
// Payouts go only to the parties' ATAs for the bet's mint (the program enforces I1); a missing ATA
// is created idempotently by the fee payer, and only for a side that receives something. Rent
// always goes to bet.rent_payer (P8).
import { getBase58Decoder, type Address, type Instruction, type KeyPairSigner } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import { BET_RENT_PAYER_OFFSET, exitPayout, type ExitAction } from '@youre-on/shared/chain/exits';
import {
  BET_DISCRIMINATOR,
  findVaultPda,
  getBetDecoder,
  getCancelOpenBetInstructionAsync,
  getCloseBetInstructionAsync,
  getFinalizeInstructionAsync,
  getTimeoutRefundInstructionAsync,
  type Bet,
} from '@youre-on/shared/escrow-client';
import { bytesToBetId } from '@youre-on/shared/primitives';
import { tokenAmount, type ChainRuntime } from './tx';

/** An exit the server may send: the shared table's, plus the judge-signed cancel of an Open bet. */
export type ServerExit = ExitAction | 'cancel_open_bet';

export interface ExitPlan {
  action: ServerExit;
  betPda: Address;
  bet: Bet;
  /** The vault's balance when planned (the payout basis V). */
  vaultAmount: bigint;
  /** What the exit pays (null for a lone close_bet). */
  payout: { to_a: bigint; to_b: bigint } | null;
  ixs: Instruction[];
  /** Signers besides the fee payer (cancel_open_bet: the judge key). */
  signers: KeyPairSigner[];
}

/** One live escrow Bet: its PDA, its decoded account and its offchain bet_id. */
export interface LiveBet {
  address: Address;
  bet: Bet;
  betId: string;
}

/**
 * Every Bet account of our program whose rent payer is our fee payer (memcmp on the Bet
 * discriminator and on rent_payer), or null when the client cannot list program accounts.
 */
export async function listOurBets(rt: ChainRuntime): Promise<LiveBet[] | null> {
  if (!rt.client.programAccounts) return null;
  const rows = await rt.client.programAccounts(rt.programId, [
    { offset: 0, bytes: getBase58Decoder().decode(BET_DISCRIMINATOR) },
    { offset: BET_RENT_PAYER_OFFSET, bytes: rt.keys.feePayer.address },
  ]);
  const out: LiveBet[] = [];
  for (const r of rows) {
    if (r.account.owner !== rt.programId) continue;
    try {
      const bet = getBetDecoder().decode(r.account.data);
      if (bet.rentPayer !== rt.keys.feePayer.address) continue;
      out.push({ address: r.address, bet, betId: bytesToBetId(new Uint8Array(bet.betId)) });
    } catch {
      // not a Bet (a layout we do not know): never act on it
    }
  }
  return out;
}

/** The instructions + expected payout of `action` for the live Bet at `betPda`. */
export async function planExit(
  rt: ChainRuntime,
  betPda: Address,
  bet: Bet,
  action: ServerExit,
): Promise<ExitPlan> {
  const fp = rt.keys.feePayer;
  const mintAcc = await rt.client.getAccount(bet.mint);
  if (!mintAcc) throw new Error(`mint ${bet.mint} of bet ${betPda} does not exist`);
  const tokenProgram = mintAcc.owner;
  const [vault] = await findVaultPda({ betId: bet.betId });
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint: bet.mint, tokenProgram }))[0];
  const [aTok, bTok] = [await ata(bet.partyA), await ata(bet.partyB)];
  const vaultAmount = (await tokenAmount(rt.client, vault)) ?? 0n;
  const payout = exitPayout(bet, action, vaultAmount);
  const signers: KeyPairSigner[] = [];

  const ixs: Instruction[] = [];
  const createIfMissing = async (owner: Address, tok: Address) => {
    if (await rt.client.getAccount(tok)) return;
    ixs.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: fp,
        owner,
        mint: bet.mint,
        tokenProgram,
      }),
    );
  };
  // A side that receives 0 may be omitted (ESCROW §5.2 payout set); never pay its ATA rent.
  const payA = payout ? payout.to_a > 0n : false;
  const payB = payout ? payout.to_b > 0n : false;
  if (payA) await createIfMissing(bet.partyA, aTok);
  if (payB) await createIfMissing(bet.partyB, bTok);
  const accounts = {
    payer: fp,
    bet: betPda,
    vault,
    mint: bet.mint,
    ...(payA ? { partyAToken: aTok } : {}),
    ...(payB ? { partyBToken: bTok } : {}),
    tokenProgram,
  };
  if (action === 'timeout_refund') ixs.push(await getTimeoutRefundInstructionAsync(accounts));
  if (action === 'finalize') ixs.push(await getFinalizeInstructionAsync(accounts));
  if (action === 'cancel_open_bet') {
    const judge = rt.keys.judge;
    if (!judge || judge.address !== bet.judgeAuthority)
      throw new Error(`cancel_open_bet: our judge key is not bet ${betPda}'s judge_authority`);
    signers.push(judge);
    ixs.push(await getCancelOpenBetInstructionAsync({ ...accounts, canceller: judge }));
  }
  // close_bet needs party_a_token only for a residual (donated after settlement); after an
  // exit ix in this same tx the vault is empty.
  const residual = action === 'close_bet' ? vaultAmount : 0n;
  if (residual > 0n) await createIfMissing(bet.partyA, aTok);
  ixs.push(
    await getCloseBetInstructionAsync({
      payer: fp,
      bet: betPda,
      vault,
      mint: bet.mint,
      ...(residual > 0n ? { partyAToken: aTok } : {}),
      rentPayer: bet.rentPayer,
      tokenProgram,
    }),
  );
  return { action, betPda, bet, vaultAmount, payout, ixs, signers };
}
