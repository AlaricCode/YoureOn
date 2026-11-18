// The permissionless crank (ESCROW §1.2, TM-L10, §9.2 CR1; TASKS D3-L2): if the server is gone,
// anyone with a funded key can push every escrow Bet whose deadline has passed to its exit, and
// return its rent to the stored rent payer. Shared by scripts/crank.ts (CLI) and the e2e fixture.
//
// Per Bet, from the chain clock (the instructions' own rules, §5.2 / §8.2):
//   Open      now >= accept_deadline           -> [timeout_refund, close_bet]
//   Locked    now >= resolve_deadline          -> [timeout_refund, close_bet]
//   Appealed  now >= appeal_resolve_deadline   -> [timeout_refund, close_bet]
//   Resolved  now >= appeal_deadline           -> [finalize, close_bet]
//   Settled / Refunded / Cancelled (a terminal ix landed without its close) -> [close_bet]
//   anything else                              -> not due yet (skipped)
// Payouts go only to the parties' ATAs for the bet's mint (the program enforces I1); a missing ATA
// is created idempotently, paid by the crank's payer. Rent always goes to `bet.rent_payer` (P8).
import {
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';

import {
  BET_DISCRIMINATOR,
  BetStatus,
  ESCROW_PROGRAM_ADDRESS,
  findVaultPda,
  getBetDecoder,
  getCloseBetInstructionAsync,
  getFinalizeInstructionAsync,
  getTimeoutRefundInstructionAsync,
  type Bet,
} from '@youre-on/shared/escrow-client';

import { buildSimulated, sendAndConfirm, type ChainRpc } from './chain';

export type CrankAction = 'timeout_refund' | 'finalize' | 'close_bet';

/** What the crank does for `bet` at chain time `now`, or null when nothing is due. */
export function crankActionFor(bet: Bet, now: bigint): CrankAction | null {
  switch (bet.status) {
    case BetStatus.Open:
      return now >= bet.acceptDeadline ? 'timeout_refund' : null;
    case BetStatus.Locked:
      return now >= bet.resolveDeadline ? 'timeout_refund' : null;
    case BetStatus.Appealed:
      return now >= bet.appealResolveDeadline ? 'timeout_refund' : null;
    case BetStatus.Resolved:
      return now >= bet.appealDeadline ? 'finalize' : null;
    case BetStatus.Settled:
    case BetStatus.Refunded:
    case BetStatus.Cancelled:
      return 'close_bet';
    default:
      return null;
  }
}

export type LiveBet = { address: Address; bet: Bet };

/** Every Bet account of the escrow (getProgramAccounts, memcmp on the 8-byte Bet discriminator). */
export async function fetchAllBets(rpc: ChainRpc): Promise<LiveBet[]> {
  const res = await rpc
    .getProgramAccounts(ESCROW_PROGRAM_ADDRESS, {
      commitment: 'confirmed',
      encoding: 'base64',
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: getBase58Decoder().decode(BET_DISCRIMINATOR) as Base58EncodedBytes,
            encoding: 'base58',
          },
        },
      ],
    })
    .send();
  const b64 = getBase64Encoder();
  return res.map((r) => ({
    address: r.pubkey,
    bet: getBetDecoder().decode(b64.encode(r.account.data[0])),
  }));
}

async function ownerOf(rpc: ChainRpc, addr: Address): Promise<Address | null> {
  const { value } = await rpc
    .getAccountInfo(addr, { commitment: 'confirmed', encoding: 'base64' })
    .send();
  return value ? value.owner : null;
}

async function tokenAmountOf(rpc: ChainRpc, addr: Address): Promise<bigint> {
  const r = await rpc.getTokenAccountBalance(addr, { commitment: 'confirmed' }).send();
  return BigInt(r.value.amount);
}

/** The instructions for one due Bet (ATA creates, the exit ix if any, then close_bet). */
export async function crankInstructions(
  rpc: ChainRpc,
  payer: TransactionSigner,
  live: LiveBet,
  action: CrankAction,
): Promise<Instruction[]> {
  const { bet } = live;
  const tokenProgram = await ownerOf(rpc, bet.mint);
  if (!tokenProgram) throw new Error(`mint ${bet.mint} of bet ${live.address} does not exist`);
  const [vault] = await findVaultPda({ betId: bet.betId });
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint: bet.mint, tokenProgram }))[0];
  const [aTok, bTok] = [await ata(bet.partyA), await ata(bet.partyB)];
  // B is paid only by finalize / a Locked or Appealed refund; a residual on close goes to A only.
  const payB = action !== 'close_bet' && bet.status !== BetStatus.Open;
  const ixs: Instruction[] = [];
  for (const [owner, tok] of [
    [bet.partyA, aTok],
    ...(payB ? ([[bet.partyB, bTok]] as const) : []),
  ] as const) {
    if ((await ownerOf(rpc, tok)) === null) {
      ixs.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer,
          owner,
          mint: bet.mint,
          tokenProgram,
        }),
      );
    }
  }
  const payout = {
    payer,
    bet: live.address,
    vault,
    mint: bet.mint,
    partyAToken: aTok,
    ...(payB ? { partyBToken: bTok } : {}),
    tokenProgram,
  };
  if (action === 'timeout_refund') ixs.push(await getTimeoutRefundInstructionAsync(payout));
  if (action === 'finalize') ixs.push(await getFinalizeInstructionAsync(payout));
  // close_bet needs party_a_token only for a residual; after an exit ix in this tx the vault is 0.
  const residual = action === 'close_bet' ? await tokenAmountOf(rpc, vault) : 0n;
  ixs.push(
    await getCloseBetInstructionAsync({
      payer,
      bet: live.address,
      vault,
      mint: bet.mint,
      ...(residual > 0n ? { partyAToken: aTok } : {}),
      rentPayer: bet.rentPayer,
      tokenProgram,
    }),
  );
  return ixs;
}

export type CrankResult = {
  address: Address;
  status: BetStatus;
  action: CrankAction | null;
  signature?: string;
  error?: string;
};

/**
 * One pass over every Bet: sends one tx per due Bet (simulated first, preflight on). A failure on
 * one Bet is recorded and the pass continues. `dryRun` only plans.
 */
export async function crankOnce(
  rpc: ChainRpc,
  payer: TransactionSigner,
  now: bigint,
  opts: {
    dryRun?: boolean;
    log?: (line: string) => void;
    /** Only these Bet PDAs (base58). Empty/undefined = every bet. */
    only?: ReadonlySet<string>;
    /** Never these Bet PDAs, e.g. bets a live server still owns. */
    skip?: ReadonlySet<string>;
  } = {},
): Promise<CrankResult[]> {
  const log = opts.log ?? (() => {});
  const out: CrankResult[] = [];
  for (const live of await fetchAllBets(rpc)) {
    if (opts.only?.size && !opts.only.has(live.address)) continue;
    if (opts.skip?.has(live.address)) continue;
    const action = crankActionFor(live.bet, now);
    const base = { address: live.address, status: live.bet.status, action };
    if (!action || opts.dryRun) {
      out.push(base);
      continue;
    }
    try {
      const ixs = await crankInstructions(rpc, payer, live, action);
      const label = `${action === 'close_bet' ? '' : `${action}+`}close_bet ${live.address}`;
      const built = await buildSimulated(rpc, payer, ixs, { kind: 'blockhash' }, { label });
      const landed = await sendAndConfirm(rpc, built.tx);
      log(`  ${label}: ${landed.signature}`);
      out.push({ ...base, signature: landed.signature });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ${action} ${live.address} FAILED: ${msg}`);
      out.push({ ...base, error: msg });
    }
  }
  return out;
}
