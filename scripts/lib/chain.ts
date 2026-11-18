// RPC, cluster detection, Explorer links, transaction build/simulate/send/confirm with timings
// (FINDINGS §6 step 5: send -> processed -> confirmed), and small account readers.
//
// Safety rails (hard rules for these scripts):
//   - mainnet-beta is refused outright (detected by genesis hash, not by URL);
//   - an RPC URL is only ever printed as scheme://host, because QuickNode URLs embed a token;
//   - every RPC request is time-boxed and retried on 429 / 5xx / timeouts / socket errors, with
//     the server's transport (apps/server/src/chain/tx.ts withRpcRetry): the public devnet RPC
//     answers 429 under any real load, and a 429 on the confirm poll after a send made the crank /
//     smoke report "FAILED" for txs that had landed. Re-sending the same signed bytes is safe.
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getI64Decoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionSize,
  getU32Encoder,
  getU64Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Commitment,
  type Instruction,
  type Nonce,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type Transaction,
  type TransactionSigner,
} from '@solana/kit';
import { findAssociatedTokenPda, fetchMaybeToken } from '@solana-program/token';

import { TOKEN_PROGRAM_ID } from '@youre-on/shared/chain/constants';

import { createRetryingSolanaRpc } from '../../apps/server/src/chain/tx';

export type ChainRpc = Rpc<SolanaRpcApi>;

const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
export const BPF_LOADER_UPGRADEABLE = address('BPFLoaderUpgradeab1e11111111111111111111111');
export const SYSVAR_CLOCK = address('SysvarC1ock11111111111111111111111111111111');
export const TOKEN_PROGRAM = address(TOKEN_PROGRAM_ID);
/** Max serialized transaction size (PACKET_DATA_SIZE). */
export const TX_SIZE_LIMIT = 1232;

export type Chain = {
  rpc: ChainRpc;
  /** scheme://host only: safe to print. */
  label: string;
  cluster: 'devnet' | 'testnet' | 'localnet';
  /** Query string for explorer.solana.com links. */
  explorerQuery: string;
};

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const local = ['127.0.0.1', 'localhost', '0.0.0.0', '[::1]'].includes(u.hostname);
    return local
      ? `${u.protocol}//${u.host}`
      : `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? '/…' : ''}`;
  } catch {
    return '<unparseable url>';
  }
}

/** Connects, identifies the cluster by genesis hash and refuses mainnet. */
export async function connect(url: string): Promise<Chain> {
  const rpc = createRetryingSolanaRpc(url);
  const label = redactUrl(url);
  let genesis: string;
  try {
    genesis = await rpc.getGenesisHash().send();
  } catch (err) {
    throw new Error(`RPC ${label} unreachable: ${(err as Error).message}`);
  }
  if (genesis === GENESIS['mainnet-beta']) {
    throw new Error(`RPC ${label} is MAINNET-BETA: these scripts are devnet/local only`);
  }
  if (genesis === GENESIS.devnet)
    return { rpc, label, cluster: 'devnet', explorerQuery: '?cluster=devnet' };
  if (genesis === GENESIS.testnet)
    return { rpc, label, cluster: 'testnet', explorerQuery: '?cluster=testnet' };
  // Anything else is a local validator. Only a local URL is safe to embed in a link.
  const u = new URL(url);
  const local = ['127.0.0.1', 'localhost', '0.0.0.0'].includes(u.hostname);
  const explorerQuery = local
    ? `?cluster=custom&customUrl=${encodeURIComponent(`${u.protocol}//${u.host}`)}`
    : '?cluster=custom';
  return { rpc, label, cluster: 'localnet', explorerQuery };
}

export function explorerTx(chain: Chain, sig: string): string {
  return `https://explorer.solana.com/tx/${sig}${chain.explorerQuery}`;
}

export function explorerAddress(chain: Chain, addr: string): string {
  return `https://explorer.solana.com/address/${addr}${chain.explorerQuery}`;
}

/** The chain's `Clock.unix_timestamp` (offset 32 in the sysvar). */
export async function chainNow(
  rpc: ChainRpc,
  commitment: Commitment = 'confirmed',
): Promise<bigint> {
  const acc = await fetchEncodedAccount(rpc, SYSVAR_CLOCK, { commitment });
  if (!acc.exists) throw new Error('Clock sysvar missing');
  return getI64Decoder().decode(acc.data, 32);
}

export async function lamportsOf(rpc: ChainRpc, who: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(who, { commitment: 'confirmed' }).send();
  return value;
}

export async function ataOf(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM });
  return ata;
}

/** The token amount in `owner`'s ATA for `mint` (0 when the ATA does not exist). */
export async function ataBalance(
  rpc: ChainRpc,
  owner: Address,
  mint: Address,
): Promise<{ ata: Address; exists: boolean; amount: bigint }> {
  const ata = await ataOf(owner, mint);
  const acc = await fetchMaybeToken(rpc, ata, { commitment: 'confirmed' });
  return { ata, exists: acc.exists, amount: acc.exists ? acc.data.amount : 0n };
}

export async function programDataAddress(programId: Address): Promise<Address> {
  const [pd] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [getAddressEncoder().encode(programId)],
  });
  return pd;
}

/**
 * The upgradeable program's ProgramData upgrade authority (`None` = immutable), or throws when
 * the program is not deployed under the upgradeable loader.
 */
export async function upgradeAuthorityOf(
  rpc: ChainRpc,
  programId: Address,
): Promise<{ programData: Address; authority: Address | null }> {
  const prog = await fetchEncodedAccount(rpc, programId, { commitment: 'confirmed' });
  if (!prog.exists) throw new Error(`program ${programId} is not deployed on this cluster`);
  if (prog.programAddress !== BPF_LOADER_UPGRADEABLE) {
    throw new Error(`program ${programId} is not owned by the upgradeable loader`);
  }
  const programData = await programDataAddress(programId);
  const pd = await fetchEncodedAccount(rpc, programData, { commitment: 'confirmed' });
  if (!pd.exists) throw new Error(`ProgramData ${programData} missing`);
  // UpgradeableLoaderState::ProgramData = tag u32 (3) | slot u64 | Option<Pubkey> (1 + 32) | ELF
  if (pd.data[0] !== 3) throw new Error(`unexpected ProgramData tag ${pd.data[0]}`);
  if (pd.data[12] !== 1) return { programData, authority: null };
  return { programData, authority: getAddressDecoder().decode(pd.data, 13) };
}

// ---------------------------------------------------------------------------------------------
// Transactions

export function setComputeUnitLimit(units: number): Instruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    data: new Uint8Array([2, ...getU32Encoder().encode(units)]),
  };
}

export function setComputeUnitPrice(microLamports: bigint): Instruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    data: new Uint8Array([3, ...getU64Encoder().encode(microLamports)]),
  };
}

export type Lifetime =
  { kind: 'blockhash' } | { kind: 'nonce'; account: Address; value: string; authority: Address };

/** Ceiling of simulated units × 1.3, and at least simulated + 10k (ESCROW §10.1). */
export function cuWithMargin(simulated: bigint): number {
  const u = Number(simulated);
  return Math.min(1_400_000, Math.max(Math.ceil(u * 1.3), u + 10_000));
}

async function compile(
  rpc: ChainRpc,
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
  lifetime: Lifetime,
  cuLimit: number,
  cuPrice: bigint | undefined,
): Promise<Transaction> {
  const budget = [setComputeUnitLimit(cuLimit), ...(cuPrice ? [setComputeUnitPrice(cuPrice)] : [])];
  const base = pipe(createTransactionMessage({ version: 0 }), (m) =>
    setTransactionMessageFeePayerSigner(feePayer, m),
  );
  if (lifetime.kind === 'nonce') {
    // kit prepends System AdvanceNonceAccount as ix 0 (ESCROW §5.0.1).
    const msg = pipe(
      setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: lifetime.value as Nonce,
          nonceAccountAddress: lifetime.account,
          nonceAuthorityAddress: lifetime.authority,
        },
        base,
      ),
      (m) => appendTransactionMessageInstructions([...budget, ...ixs], m),
    );
    return signTransactionMessageWithSigners(msg);
  }
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: latest.blockhash as Blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      base,
    ),
    (m) => appendTransactionMessageInstructions([...budget, ...ixs], m),
  );
  return signTransactionMessageWithSigners(msg);
}

export type Built = { tx: Transaction; simulatedUnits: bigint; cuLimit: number; size: number };

/**
 * Builds `[SetComputeUnitLimit, (SetComputeUnitPrice), ...ixs]` (after AdvanceNonce for a nonce
 * lifetime), simulates it with `sigVerify: false`, then rebuilds with the CU limit from the result
 * and signs with every signer attached to the instructions and the fee payer.
 */
export async function buildSimulated(
  rpc: ChainRpc,
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
  lifetime: Lifetime,
  opts: { cuPrice?: bigint; label?: string } = {},
): Promise<Built> {
  const probe = await compile(rpc, feePayer, ixs, lifetime, 1_400_000, opts.cuPrice);
  const sim = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(probe), {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: lifetime.kind === 'blockhash',
      commitment: 'processed',
    })
    .send();
  if (sim.value.err) {
    const err = new Error(
      `simulation of ${opts.label ?? 'tx'} failed: ${JSON.stringify(sim.value.err, bigintJson)}`,
    ) as Error & { context: { logs: readonly string[] } };
    err.context = { logs: sim.value.logs ?? [] };
    throw err;
  }
  const simulatedUnits = sim.value.unitsConsumed ?? 200_000n;
  const cuLimit = cuWithMargin(simulatedUnits);
  const tx = await compile(rpc, feePayer, ixs, lifetime, cuLimit, opts.cuPrice);
  const size = getTransactionSize(tx);
  if (size > TX_SIZE_LIMIT)
    throw new Error(`${opts.label ?? 'tx'} is ${size} B > ${TX_SIZE_LIMIT}`);
  return { tx, simulatedUnits, cuLimit, size };
}

export type Landed = {
  signature: Signature;
  /** ms from just before sendTransaction until it returned. */
  sendMs: number;
  /** ms from just before send until first seen at processed (or higher). */
  processedMs: number;
  /** ms from just before send until confirmed. */
  confirmedMs: number;
};

/**
 * Sends with preflight ON (`preflightCommitment: 'processed'`; never skipPreflight on the first
 * send, ESCROW §5.0), then polls getSignatureStatuses until confirmed. While it is unseen, the SAME
 * wire bytes (same signature, so at most one can land) are re-broadcast every `resendMs` with
 * preflight off: they already passed preflight, and a fresh validator or a loaded devnet drops
 * packets (ESCROW §5.0.1 step 6: "a transient send error re-sends the same bytes"). Stops at an
 * onchain error, blockhash expiry (block height > lastValidBlockHeight) or `timeoutMs`.
 */
export async function sendAndConfirm(
  rpc: ChainRpc,
  tx: Transaction,
  opts: { pollMs?: number; resendMs?: number; timeoutMs?: number } = {},
): Promise<Landed> {
  const pollMs = opts.pollMs ?? 50;
  const resendMs = opts.resendMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const signature = getSignatureFromTransaction(tx);
  const wire = getBase64EncodedWireTransaction(tx);
  const lastValid = (tx as { lifetimeConstraint?: { lastValidBlockHeight?: bigint } })
    .lifetimeConstraint?.lastValidBlockHeight;
  const t0 = performance.now();
  await rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'processed', maxRetries: 0n })
    .send();
  const sendMs = performance.now() - t0;
  let processedMs: number | undefined;
  let lastSend = performance.now();
  let resends = 0;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    const elapsed = performance.now() - t0;
    if (st) {
      if (st.err) {
        throw new Error(`tx ${signature} failed onchain: ${JSON.stringify(st.err, bigintJson)}`);
      }
      processedMs ??= elapsed;
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
        if (resends > 0)
          console.log(`  (landed after ${resends} re-broadcast(s) of the same bytes)`);
        return { signature, sendMs, processedMs, confirmedMs: elapsed };
      }
    } else if (performance.now() - lastSend >= resendMs) {
      if (lastValid !== undefined) {
        const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
        if (height > lastValid) throw new Error(`tx ${signature} expired (blockhash) unconfirmed`);
      }
      lastSend = performance.now();
      resends++;
      await rpc
        .sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n })
        .send()
        .catch(() => {}); // a resend error changes nothing: the status poll decides
    }
    if (elapsed > timeoutMs) throw new Error(`tx ${signature} not confirmed after ${timeoutMs} ms`);
    await sleep(pollMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function bigintJson(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

export function fmtMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}

/** Decodes a base58 string (getTransaction `json` encoding) into bytes. */
export function base58Bytes(s: string): Uint8Array {
  return Uint8Array.from(getBase58Encoder().encode(s));
}
