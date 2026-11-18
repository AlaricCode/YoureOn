// Server-side Solana plumbing for the money path (beats 2-4): keys, an injectable chain client,
// build -> simulate -> rebuild with a CU margin, send with preflight ON and confirm by polling
// getSignatureStatuses (~400 ms; signatureSubscribe is cut), and small account readers.
// Ported from scripts/lib/chain.ts + scripts/lib/nonce.ts (the deploy/smoke scripts), with the
// RPC behind `ChainClient` so tests run the same code against LiteSVM or a fake.
//
// Safety rails:
//   - rpcChainClient refuses mainnet-beta (genesis hash) before the first write;
//   - an RPC URL is only ever logged as scheme://host (QuickNode URLs embed a token);
//   - secret keys are parsed here and never logged.
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createAddressWithSeed,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getI64Decoder,
  getSignatureFromTransaction,
  getTransactionEncoder,
  isSolanaError,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type RpcTransport,
  type Signature,
  type SolanaRpcApi,
  type Transaction,
} from '@solana/kit';
import { getAdvanceNonceAccountInstruction, getNonceDecoder } from '@solana-program/system';
import { findAssociatedTokenPda, getTokenDecoder } from '@solana-program/token';
import {
  ESCROW_ID,
  FEE_PAYER_PUBKEY,
  nonceSeed,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT_DEVNET,
} from '@youre-on/shared/chain/constants';
import { cuLimitIx, cuPriceIx, MAX_TX_BYTES } from '@youre-on/shared/chain/lock-tx';
import type { Env } from '../env';
import type { RpcTransaction } from './streams';

export const SYSTEM = address(SYSTEM_PROGRAM_ID);
export const TOKEN_PROGRAM = address(TOKEN_PROGRAM_ID);
const SYSVAR_CLOCK = address('SysvarC1ock11111111111111111111111111111111');

const GENESIS_MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const GENESIS_DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// ---------------------------------------------------------------------------------------------
// The chain client (the only thing that talks to an RPC)

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface SigStatus {
  /** Onchain error (an InstructionError object), or null on success. */
  err: unknown;
  confirmationStatus: Commitment | null;
  slot: bigint | null;
}

export interface Simulated {
  err: unknown;
  unitsConsumed: bigint | null;
  logs: readonly string[];
}

export interface RawAccount {
  owner: Address;
  lamports: bigint;
  data: Uint8Array;
}

/** What the lifecycle needs from an RPC; `rpcChainClient` is the real one, tests use LiteSVM. */
export interface ChainClient {
  /** scheme://host only (safe to log). */
  readonly label: string;
  /** Throws on mainnet-beta. Called once before the first write. */
  assertSafeCluster(): Promise<'devnet' | 'localnet'>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  /** sigVerify off; `replaceRecentBlockhash` only for blockhash-lifetime txs. */
  simulate(wire: Base64EncodedWireTransaction, replaceRecentBlockhash: boolean): Promise<Simulated>;
  /** preflight ON unless skipPreflight (re-broadcasts only). Throws PreflightError on rejection. */
  send(wire: Base64EncodedWireTransaction, skipPreflight: boolean): Promise<void>;
  /**
   * getSignatureStatuses. `searchHistory` adds searchTransactionHistory: true (sweeps after a
   * restart: the default lookup only sees the recent status cache, so an older landed tx is null).
   */
  signatureStatus(sig: string, o?: { searchHistory?: boolean }): Promise<SigStatus | null>;
  blockHeight(): Promise<bigint>;
  getAccount(addr: Address): Promise<RawAccount | null>;
  /** Sum of every token account of `owner` for `mint` (API-CONTRACT §2.14). */
  tokenBalanceByOwner(owner: Address, mint: Address): Promise<bigint>;
  lamports(addr: Address): Promise<bigint>;
  /**
   * getTransaction(sig, confirmed, json, maxSupportedTransactionVersion 1), normalized; null when
   * not found (yet). Optional: the Stream-gap reconciler (chain/reconciler.ts) skips without it.
   */
  transaction?(sig: string): Promise<RpcTransaction | null>;
}

/** The RPC rejected the tx at preflight (nothing landed, no fee). */
export class PreflightError extends Error {
  constructor(
    message: string,
    readonly err: unknown,
    readonly logs: readonly string[],
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

/** The tx landed and failed onchain, or never confirmed. */
export class TxFailedError extends Error {
  constructor(
    message: string,
    readonly signature: string,
    readonly err: unknown,
    readonly kind: 'onchain' | 'expired' | 'timeout',
  ) {
    super(message);
    this.name = 'TxFailedError';
  }
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? '/…' : ''}`;
  } catch {
    return '<unparseable url>';
  }
}

const jsonSafe = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

/** Pulls `logs` / the simulation error out of a kit SolanaError (preflight failure). */
function preflightDetails(e: unknown): { err: unknown; logs: string[] } | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const ctx = (cur as { context?: { logs?: unknown; err?: unknown; __code?: number } }).context;
    if (ctx && (Array.isArray(ctx.logs) || ctx.err !== undefined))
      return { err: ctx.err ?? null, logs: Array.isArray(ctx.logs) ? (ctx.logs as string[]) : [] };
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** HTTP statuses worth retrying: rate limits (devnet public RPC, QuickNode plan caps) and 5xx. */
export function isRetriableRpcError(e: unknown): boolean {
  if (!isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return false;
  const status = e.context.statusCode;
  return status === 429 || status >= 500;
}

export interface RetryOptions {
  /** Total tries per request (default 6: about 0.25 + 0.5 + 1 + 2 + 4 s of backoff). */
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wraps an RPC transport so a 429 / 5xx is retried with exponential backoff and jitter. Safe for
 * every call the server makes: reads are idempotent, and sendTransaction re-sends the same signed
 * bytes (same signature), so a retry can never double-spend.
 */
export function withRpcRetry(inner: RpcTransport, o: RetryOptions = {}): RpcTransport {
  const attempts = o.attempts ?? 6;
  const baseMs = o.baseMs ?? 250;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return (async (config: Parameters<RpcTransport>[0]) => {
    for (let i = 0; ; i++) {
      try {
        return await inner(config);
      } catch (e) {
        if (i >= attempts - 1 || !isRetriableRpcError(e)) throw e;
        await sleep(baseMs * 2 ** i + Math.floor(Math.random() * baseMs));
      }
    }
  }) as RpcTransport;
}

/** createSolanaRpc with the retrying transport. */
export function createRetryingSolanaRpc(url: string, o?: RetryOptions): Rpc<SolanaRpcApi> {
  return createSolanaRpcFromTransport(withRpcRetry(createDefaultRpcTransport({ url }), o));
}

/** The real client over a kit RPC (QuickNode devnet in production, a local validator in e2e). */
export function rpcChainClient(
  url: string,
  rpc: Rpc<SolanaRpcApi> = createRetryingSolanaRpc(url),
): ChainClient {
  let cluster: Promise<'devnet' | 'localnet'> | null = null;
  return {
    label: redactUrl(url),
    assertSafeCluster() {
      cluster ??= rpc
        .getGenesisHash()
        .send()
        .then((g) => {
          if (g === GENESIS_MAINNET) throw new Error(`RPC ${redactUrl(url)} is MAINNET-BETA`);
          return g === GENESIS_DEVNET ? 'devnet' : 'localnet';
        });
      cluster.catch(() => (cluster = null));
      return cluster;
    },
    async latestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async simulate(wire, replaceRecentBlockhash) {
      const { value } = await rpc
        .simulateTransaction(wire, {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash,
          commitment: 'processed',
        })
        .send();
      return { err: value.err, unitsConsumed: value.unitsConsumed ?? null, logs: value.logs ?? [] };
    },
    async send(wire, skipPreflight) {
      try {
        await rpc
          .sendTransaction(
            wire,
            skipPreflight
              ? { encoding: 'base64', skipPreflight: true, maxRetries: 0n }
              : { encoding: 'base64', preflightCommitment: 'processed', maxRetries: 0n },
          )
          .send();
      } catch (e) {
        const d = preflightDetails(e);
        if (d) throw new PreflightError(`preflight rejected: ${jsonSafe(d.err)}`, d.err, d.logs);
        throw e;
      }
    },
    async signatureStatus(sig, o) {
      const { value } = await rpc
        .getSignatureStatuses(
          [sig as Signature],
          o?.searchHistory ? { searchTransactionHistory: true } : undefined,
        )
        .send();
      const st = value[0];
      return st ? { err: st.err, confirmationStatus: st.confirmationStatus, slot: st.slot } : null;
    },
    async blockHeight() {
      return rpc.getBlockHeight({ commitment: 'confirmed' }).send();
    },
    async getAccount(addr) {
      const { value } = await rpc
        .getAccountInfo(addr, { commitment: 'confirmed', encoding: 'base64' })
        .send();
      if (!value) return null;
      return {
        owner: value.owner,
        lamports: value.lamports,
        data: new Uint8Array(getBase64Encoder().encode(value.data[0])),
      };
    },
    async tokenBalanceByOwner(owner, mint) {
      const { value } = await rpc
        .getTokenAccountsByOwner(
          owner,
          { mint },
          { commitment: 'confirmed', encoding: 'jsonParsed' },
        )
        .send();
      let sum = 0n;
      for (const a of value) {
        const amount = (
          a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }
        ).parsed?.info?.tokenAmount?.amount;
        if (amount) sum += BigInt(amount);
      }
      return sum;
    },
    async lamports(addr) {
      const { value } = await rpc.getBalance(addr, { commitment: 'confirmed' }).send();
      return value;
    },
    async transaction(sig) {
      // Devnet carries v1 transactions: version 0 would fail with -32015 (DATA-MODEL §8.3).
      const tx = await rpc
        .getTransaction(sig as Signature, {
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 1,
        })
        .send();
      if (!tx || !tx.meta) return null;
      const loaded = tx.meta.loadedAddresses;
      return {
        signature: sig,
        slot: Number(tx.slot),
        blockTime: tx.blockTime === null ? null : Number(tx.blockTime),
        err: tx.meta.err,
        accountKeys: [
          ...tx.transaction.message.accountKeys,
          ...(loaded?.writable ?? []),
          ...(loaded?.readonly ?? []),
        ],
        innerInstructions: (tx.meta.innerInstructions ?? []).map((g) => ({
          index: Number(g.index),
          instructions: g.instructions.map((ix) => ({
            programIdIndex: Number(ix.programIdIndex),
            accounts: ix.accounts.map(Number),
            data: ix.data,
          })),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Keys

/** base58 (64-byte secret‖pubkey, or a 32-byte seed) or solana-keygen JSON `[64 bytes]`. */
export async function parseSecretKey(raw: string, name = 'secret key'): Promise<KeyPairSigner> {
  const s = raw.trim();
  let bytes: Uint8Array;
  if (s.startsWith('[')) {
    const parsed: unknown = JSON.parse(s);
    if (!Array.isArray(parsed) || !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
      throw new Error(`${name}: not a JSON byte array`);
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    bytes = new Uint8Array(getBase58Encoder().encode(s));
  }
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(`${name}: expected 32 or 64 bytes, got ${bytes.length}`);
}

export interface ServerKeys {
  /** Fee payer = rent payer = durable-nonce authority. Required for any send. */
  feePayer: KeyPairSigner;
  judge: KeyPairSigner | null;
  appeal: KeyPairSigner | null;
  treasury: KeyPairSigner | null;
  /** Custodial demo parties (LOCK_SIGNER=server, cp1-drive). The phones import the same seeds (D-A). */
  demoA: KeyPairSigner | null;
  demoB: KeyPairSigner | null;
}

/** Loads the server keypairs from env; null when FEE_PAYER_SECRET_KEY is unset (chain disabled). */
export async function loadServerKeys(env: Env): Promise<ServerKeys | null> {
  if (!env.FEE_PAYER_SECRET_KEY) return null;
  const opt = (v: string | undefined, n: string) =>
    v ? parseSecretKey(v, n) : Promise.resolve(null);
  return {
    feePayer: await parseSecretKey(env.FEE_PAYER_SECRET_KEY, 'FEE_PAYER_SECRET_KEY'),
    judge: await opt(env.JUDGE_AUTHORITY_SECRET_KEY, 'JUDGE_AUTHORITY_SECRET_KEY'),
    appeal: await opt(env.APPEAL_AUTHORITY_SECRET_KEY, 'APPEAL_AUTHORITY_SECRET_KEY'),
    treasury: await opt(env.TREASURY_SECRET_KEY, 'TREASURY_SECRET_KEY'),
    demoA: await opt(env.DEMO_A_SECRET_KEY, 'DEMO_A_SECRET_KEY'),
    demoB: await opt(env.DEMO_B_SECRET_KEY, 'DEMO_B_SECRET_KEY'),
  };
}

// ---------------------------------------------------------------------------------------------
// The runtime the lock / payout services use

export interface ChainRuntime {
  client: ChainClient;
  keys: ServerKeys;
  mint: Address;
  programId: Address;
  /** 'devnet' in production; 'localnet' for a local validator / LiteSVM. */
  cluster: 'devnet' | 'localnet';
  /**
   * The fee payer equals the pinned FEE_PAYER_PUBKEY (packages/shared). When false the phones'
   * device policy refuses every lock (LOCK_SIGNER=phones); custodial / local runs still work.
   */
  feePayerPinned?: boolean;
}

/** From env; null when the RPC or the fee payer is not configured (chain features answer 503-ish). */
export async function chainRuntimeFromEnv(env: Env): Promise<ChainRuntime | null> {
  if (!env.SOLANA_DEVNET_RPC) return null;
  const keys = await loadServerKeys(env);
  if (!keys) return null;
  return {
    client: rpcChainClient(env.SOLANA_DEVNET_RPC),
    keys,
    mint: address(env.USDC_MINT ?? USDC_MINT_DEVNET),
    programId: address(ESCROW_ID),
    cluster: env.SOLANA_CLUSTER ?? 'devnet',
    feePayerPinned: keys.feePayer.address === FEE_PAYER_PUBKEY,
  };
}

// ---------------------------------------------------------------------------------------------
// Transactions

/** Ceiling of simulated units × 1.3, and at least simulated + 10k (ESCROW §10.1). */
export function cuWithMargin(simulated: bigint): number {
  const u = Number(simulated);
  return Math.min(1_400_000, Math.max(Math.ceil(u * 1.3), u + 10_000));
}

export const wireOf = (tx: Transaction): Base64EncodedWireTransaction =>
  getBase64EncodedWireTransaction(tx);
export const messageB64 = (tx: Transaction): string =>
  Buffer.from(tx.messageBytes).toString('base64');
export const wireSize = (tx: Transaction): number => getTransactionEncoder().encode(tx).length;

/** `{InstructionError: [ix, {Custom: n}]}` -> n (also through a kit error), else null. */
export function customErrorCode(err: unknown): number | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (Array.isArray(ie)) {
    const inner = ie[1] as { Custom?: number | bigint } | null;
    if (inner && inner.Custom !== undefined) return Number(inner.Custom);
  }
  return null;
}

export class SimulationError extends Error {
  constructor(
    readonly label: string,
    readonly err: unknown,
    readonly logs: readonly string[],
  ) {
    super(`simulation of ${label} failed: ${jsonSafe(err)}`);
    this.name = 'SimulationError';
  }
}

export interface Built {
  /** Compiled; signed only by `signers` passed to buildBlockhashTx (fee payer etc.). */
  tx: Transaction;
  simulatedUnits: bigint;
  cuLimit: number;
  lastValidBlockHeight: bigint | null;
  /** The recent blockhash the message carries (blockhash lifetimes). */
  blockhash: string | null;
}

function compileBlockhash(
  feePayer: Address,
  lifetime: { blockhash: string; lastValidBlockHeight: bigint },
  ixs: readonly Instruction[],
): Transaction {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: lifetime.blockhash as Blockhash,
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return compileTransaction(msg);
}

/**
 * `[SetComputeUnitLimit, (SetComputeUnitPrice), ...ixs]` on a recent blockhash: compile with the
 * max limit, simulate (sigVerify off), recompile on the SAME blockhash with the margin, then
 * partially sign with `signers` (others, e.g. a phone, sign the same bytes later).
 */
export async function buildBlockhashTx(
  client: ChainClient,
  feePayer: Address,
  ixs: readonly Instruction[],
  opts: { signers?: readonly KeyPairSigner[]; label: string; cuPrice?: bigint },
): Promise<Built> {
  const lifetime = await client.latestBlockhash();
  const budget = (cu: number) => [
    cuLimitIx(cu),
    ...(opts.cuPrice ? [cuPriceIx(opts.cuPrice)] : []),
  ];
  const probe = compileBlockhash(feePayer, lifetime, [...budget(1_400_000), ...ixs]);
  const sim = await client.simulate(wireOf(probe), true);
  if (sim.err) throw new SimulationError(opts.label, sim.err, sim.logs);
  const simulatedUnits = sim.unitsConsumed ?? 200_000n;
  const cuLimit = cuWithMargin(simulatedUnits);
  let tx = compileBlockhash(feePayer, lifetime, [...budget(cuLimit), ...ixs]);
  if (wireSize(tx) > MAX_TX_BYTES)
    throw new Error(`${opts.label} is ${wireSize(tx)} B > ${MAX_TX_BYTES}`);
  if (opts.signers?.length)
    tx = await partiallySignTransaction(
      opts.signers.map((s) => s.keyPair),
      tx,
    );
  return {
    tx,
    simulatedUnits,
    cuLimit,
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
    blockhash: lifetime.blockhash,
  };
}

/** Adds signatures over the stored bytes (never rebuilds). */
export function cosignTx(tx: Transaction, signers: readonly KeyPairSigner[]): Promise<Transaction> {
  return partiallySignTransaction(
    signers.map((s) => s.keyPair),
    tx,
  );
}

export interface Landed {
  signature: string;
  processedAt: number;
  confirmedAt: number;
  slot: bigint | null;
}

export interface SendOptions {
  /** Status poll interval. Default 400 ms. */
  pollMs?: number;
  /** Re-broadcast the same bytes (preflight off) while unseen. Default 2 s. */
  resendMs?: number;
  /** Give up. Default 30 s. */
  timeoutMs?: number;
  /** Blockhash txs: give up once the chain passes this height. */
  lastValidBlockHeight?: bigint | null;
  /** First seen at `processed` (the payout animation, SCHEMAS §9.2). */
  onProcessed?: (atMs: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sends once with preflight ON (a PreflightError means nothing landed), then polls
 * getSignatureStatuses every `pollMs` until confirmed. While unseen, re-broadcasts the same wire
 * bytes (same signature: at most one can land). Throws TxFailedError on an onchain error,
 * blockhash expiry or timeout.
 */
export async function sendAndConfirm(
  client: ChainClient,
  tx: Transaction,
  o: SendOptions = {},
): Promise<Landed> {
  await client.send(wireOf(tx), false);
  return confirmSent(client, tx, o);
}

/** The poll half of sendAndConfirm, for a tx already sent once with preflight (or recovered). */
export async function confirmSent(
  client: ChainClient,
  tx: Transaction,
  o: SendOptions = {},
): Promise<Landed> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? realSleep;
  const pollMs = o.pollMs ?? 400;
  const resendMs = o.resendMs ?? 2_000;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const signature = getSignatureFromTransaction(tx);
  const wire = wireOf(tx);
  const t0 = now();
  let processedAt: number | null = null;
  let lastSend = now();
  for (;;) {
    const st = await client.signatureStatus(signature);
    if (st) {
      if (st.err)
        throw new TxFailedError(
          `tx ${signature} failed onchain: ${jsonSafe(st.err)}`,
          signature,
          st.err,
          'onchain',
        );
      if (processedAt === null) {
        processedAt = now();
        o.onProcessed?.(processedAt);
      }
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')
        return { signature, processedAt, confirmedAt: now(), slot: st.slot };
    } else if (now() - lastSend >= resendMs) {
      if (o.lastValidBlockHeight != null && (await client.blockHeight()) > o.lastValidBlockHeight)
        throw new TxFailedError(`tx ${signature} expired unconfirmed`, signature, null, 'expired');
      lastSend = now();
      await client.send(wire, true).catch(() => {}); // the status poll decides
    }
    if (now() - t0 > timeoutMs)
      throw new TxFailedError(
        `tx ${signature} not confirmed after ${timeoutMs} ms`,
        signature,
        null,
        'timeout',
      );
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Readers

/** Nonce-pool account k = createWithSeed(fee payer, "yo-nonce-<k>", System) (ESCROW §5.0.1). */
export function poolAddress(feePayer: Address, k: number): Promise<Address> {
  return createAddressWithSeed({
    baseAddress: feePayer,
    seed: nonceSeed(k),
    programAddress: SYSTEM,
  });
}

/** The stored nonce value + authority of a System nonce account, or null. */
export async function readNonce(
  client: ChainClient,
  account: Address,
): Promise<{ value: string; authority: Address } | null> {
  const acc = await client.getAccount(account);
  if (!acc || acc.owner !== SYSTEM) return null;
  try {
    const n = getNonceDecoder().decode(acc.data);
    return { value: n.blockhash, authority: n.authority };
  } catch {
    return null;
  }
}

/** A fee-payer-only `[CU, AdvanceNonceAccount]` on a recent blockhash (the lock revoke). */
export async function buildNonceAdvance(rt: ChainRuntime, account: Address): Promise<Built> {
  const fp = rt.keys.feePayer;
  return buildBlockhashTx(
    rt.client,
    fp.address,
    [getAdvanceNonceAccountInstruction({ nonceAccount: account, nonceAuthority: fp })],
    { signers: [fp], label: 'nonce_advance' },
  );
}

export async function ataOf(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM });
  return ata;
}

/** SPL token account amount, or null when it does not exist. */
export async function tokenAmount(client: ChainClient, account: Address): Promise<bigint | null> {
  const acc = await client.getAccount(account);
  if (!acc) return null;
  return getTokenDecoder().decode(acc.data).amount;
}

/** The chain's Clock.unix_timestamp (offset 32 in the sysvar). */
export async function chainNow(client: ChainClient): Promise<bigint> {
  const acc = await client.getAccount(SYSVAR_CLOCK);
  if (!acc) throw new Error('Clock sysvar missing');
  return getI64Decoder().decode(acc.data, 32);
}
