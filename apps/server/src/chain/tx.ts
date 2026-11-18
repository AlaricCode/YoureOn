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
  getTransactionDecoder,
  getTransactionEncoder,
  isSolanaError,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Address,
  type Base58EncodedBytes,
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
   * getProgramAccounts with memcmp filters (base58 bytes), at `confirmed`. Optional: the orphan
   * escrow sweep (src/payout/refund.ts) skips itself when the client cannot list accounts.
   */
  programAccounts?(
    program: Address,
    filters: readonly MemcmpFilter[],
  ): Promise<Array<{ address: Address; account: RawAccount }>>;
  /** p50 / p95 / errors over the last N calls (GET /v1/demo/health); absent on bare fakes. */
  rpcStats?(): RpcStatsSnapshot;
}

/** A getProgramAccounts memcmp filter: `bytes` is base58. */
export interface MemcmpFilter {
  offset: number;
  bytes: string;
}

/** The RPC rejected the tx at preflight (nothing landed, no fee). */
export class PreflightError extends Error {
  /** The recent blockhash of the rejected tx, when the caller knows it (BlockhashNotFound retries). */
  blockhash?: string;
  constructor(
    message: string,
    readonly err: unknown,
    readonly logs: readonly string[],
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

/**
 * The preflight saw a recent blockhash its node does not know (a lagging or load-balanced RPC
 * node). Nothing landed, so rebuilding on a fresh blockhash is safe.
 */
export function isBlockhashNotFound(err: unknown): boolean {
  return err instanceof PreflightError && jsonSafe(err.err).includes('BlockhashNotFound');
}

/**
 * A send was rejected at preflight at the tx level, and the follow-up signature lookup failed:
 * it may be our own earlier attempt that landed. Not a PreflightError on purpose: callers treat
 * it as transport trouble and let the status poll decide.
 */
export class SendFateUnknownError extends Error {
  constructor(
    readonly signature: string,
    readonly rejection: PreflightError,
    cause: unknown,
  ) {
    super(`send of ${signature}: ${rejection.message}; status lookup failed`, { cause });
    this.name = 'SendFateUnknownError';
  }
}

/** `{InstructionError: [...]}`: an instruction failed (the program or a token check refused). */
export function isInstructionError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { InstructionError?: unknown }).InstructionError !== undefined
  );
}

/** How long send() waits before its second signature lookup after a tx-level rejection. */
export const SEND_RECHECK_MS = 400;

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

/** The tx id (first signature) of base64 wire bytes. */
export function signatureOfWire(wire: Base64EncodedWireTransaction): Signature {
  return getSignatureFromTransaction(
    getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
  );
}

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

/** One RPC attempt took longer than its per-attempt budget (the transport aborted it). */
export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly ms: number,
    options?: { cause?: unknown },
  ) {
    super(`RPC ${method} timed out after ${ms} ms`, options);
    this.name = 'RpcTimeoutError';
  }
}

/** Node / undici socket-level failures: the request may not have reached the RPC at all. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** A fetch-level network failure (`TypeError: fetch failed` with a socket code in its cause chain). */
export function isNetworkError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
    if (cur instanceof TypeError && cur.message === 'fetch failed') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Worth retrying: rate limits (devnet public RPC, QuickNode plan caps), 408 / 5xx, a per-attempt
 * timeout, or a socket-level failure. JSON-RPC errors (a preflight rejection, a bad param) come
 * back as HTTP 200 and never reach this check, so they are never retried.
 */
export function isRetriableRpcError(e: unknown): boolean {
  if (e instanceof RpcTimeoutError) return true;
  if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = e.context.statusCode;
    return status === 429 || status === 408 || status >= 500;
  }
  return isNetworkError(e);
}

/** Per-attempt RPC timeout (a hung socket must not stall a sweep or a confirm loop). */
export const RPC_ATTEMPT_TIMEOUT_MS = 10_000;
/** Total time one logical RPC request may take, retries and backoff included. */
export const RPC_REQUEST_BUDGET_MS = 25_000;
/** A retry is not started with less than this left of the budget. */
const MIN_ATTEMPT_MS = 500;

export interface RetryOptions {
  /** Total tries per request (default 6: about 0.25 + 0.5 + 1 + 2 + 4 s of backoff). */
  attempts?: number;
  baseMs?: number;
  /** Per-attempt timeout (default RPC_ATTEMPT_TIMEOUT_MS); 0 disables it. */
  timeoutMs?: number;
  /** No new attempt starts once this much time has passed (default RPC_REQUEST_BUDGET_MS). */
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Records every logical request (method, total ms, ok) for GET /v1/demo/health. */
  stats?: RpcStats;
}

/** The JSON-RPC method of a transport payload ('?' when the payload has none, e.g. a batch). */
function methodOf(payload: unknown): string {
  const m = (payload as { method?: unknown } | null)?.method;
  return typeof m === 'string' ? m : '?';
}

/** One attempt with a timeout signal merged into the caller's (an abort by the caller wins). */
async function attemptWithTimeout(
  inner: RpcTransport,
  config: Parameters<RpcTransport>[0],
  timeoutMs: number,
) {
  if (timeoutMs <= 0) return inner(config);
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = config.signal ? AbortSignal.any([config.signal, timer]) : timer;
  try {
    return await inner({ ...config, signal });
  } catch (e) {
    if (timer.aborted && !config.signal?.aborted)
      throw new RpcTimeoutError(methodOf(config.payload), timeoutMs, { cause: e });
    throw e;
  }
}

/**
 * Wraps an RPC transport so each attempt has a timeout and a retriable failure (429 / 408 / 5xx,
 * timeout, socket error) is retried with exponential backoff and jitter, within a total budget.
 * Safe for every call the server makes: reads are idempotent, and sendTransaction re-sends the
 * same signed bytes (same signature), so a retry can never double-spend.
 */
export function withRpcRetry(inner: RpcTransport, o: RetryOptions = {}): RpcTransport {
  const attempts = o.attempts ?? 6;
  const baseMs = o.baseMs ?? 250;
  const timeoutMs = o.timeoutMs ?? RPC_ATTEMPT_TIMEOUT_MS;
  const budgetMs = o.budgetMs ?? RPC_REQUEST_BUDGET_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  return (async (config: Parameters<RpcTransport>[0]) => {
    const t0 = now();
    const method = methodOf(config.payload);
    for (let i = 0; ; i++) {
      try {
        // The last attempt gets only what is left of the budget, so a request never runs past
        // budgetMs (+ scheduling noise) however its attempts time out.
        const left = budgetMs - (now() - t0);
        const attemptMs = timeoutMs > 0 ? Math.max(1, Math.min(timeoutMs, left)) : timeoutMs;
        const res = await attemptWithTimeout(inner, config, attemptMs);
        o.stats?.record({ method, ms: now() - t0, ok: true, attempts: i + 1, at: now() });
        return res;
      } catch (e) {
        const backoff = baseMs * 2 ** i + Math.floor(Math.random() * baseMs);
        // Give up unless the backoff AND a meaningful attempt still fit in the budget.
        const giveUp =
          i >= attempts - 1 ||
          !isRetriableRpcError(e) ||
          config.signal?.aborted ||
          now() - t0 + backoff + MIN_ATTEMPT_MS > budgetMs;
        if (giveUp) {
          o.stats?.record({
            method,
            ms: now() - t0,
            ok: false,
            attempts: i + 1,
            at: now(),
            error: rpcErrorText(e),
          });
          throw e;
        }
        await sleep(backoff);
      }
    }
  }) as RpcTransport;
}

/** A short, token-free description of an RPC failure (never the URL). */
export function rpcErrorText(e: unknown): string {
  if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR))
    return `HTTP ${e.context.statusCode}`;
  if (e instanceof RpcTimeoutError) return e.message;
  if (isNetworkError(e)) {
    for (let cur: unknown = e, d = 0; cur && d < 5; d++) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === 'string') return `network ${code}`;
      cur = (cur as { cause?: unknown }).cause;
    }
    return 'network error';
  }
  return String((e as Error)?.message ?? e)
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 120);
}

// ---------------------------------------------------------------------------------------------
// RPC call statistics (GET /v1/demo/health: p50 / p95 over the last N calls)

export interface RpcCallSample {
  method: string;
  /** Total wall time of the logical request, retries and backoff included. */
  ms: number;
  ok: boolean;
  attempts: number;
  /** ms epoch when it finished. */
  at: number;
  error?: string;
}

export interface RpcStatsSnapshot {
  /** Samples in the window (at most `size`). */
  calls: number;
  /** Every request since boot. */
  total: number;
  errors: number;
  /** Requests that needed more than one attempt (in the window). */
  retried: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  last_error: { at: string; method: string; error: string } | null;
  /** The slowest methods in the window, by p95. */
  by_method: Array<{ method: string; calls: number; errors: number; p95_ms: number }>;
}

/** Nearest-rank percentile of an ascending array (p in [0, 1]). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1]!;
}

/** A ring buffer of the last `size` RPC requests. */
export class RpcStats {
  private readonly ring: RpcCallSample[] = [];
  private next = 0;
  private totalCalls = 0;
  private lastError: RpcCallSample | null = null;
  constructor(readonly size = 200) {}

  record(s: RpcCallSample): void {
    this.totalCalls++;
    if (!s.ok) this.lastError = s;
    if (this.ring.length < this.size) this.ring.push(s);
    else this.ring[this.next] = s;
    this.next = (this.next + 1) % this.size;
  }

  snapshot(): RpcStatsSnapshot {
    const ms = this.ring.map((s) => s.ms).sort((a, b) => a - b);
    const per = new Map<string, { ms: number[]; errors: number }>();
    for (const s of this.ring) {
      const m = per.get(s.method) ?? { ms: [], errors: 0 };
      m.ms.push(s.ms);
      if (!s.ok) m.errors++;
      per.set(s.method, m);
    }
    const by_method = [...per.entries()]
      .map(([method, m]) => ({
        method,
        calls: m.ms.length,
        errors: m.errors,
        p95_ms: Math.round(
          percentile(
            [...m.ms].sort((a, b) => a - b),
            0.95,
          ) ?? 0,
        ),
      }))
      .sort((a, b) => b.p95_ms - a.p95_ms)
      .slice(0, 6);
    const round = (v: number | null) => (v === null ? null : Math.round(v));
    return {
      calls: this.ring.length,
      total: this.totalCalls,
      errors: this.ring.filter((s) => !s.ok).length,
      retried: this.ring.filter((s) => s.attempts > 1).length,
      p50_ms: round(percentile(ms, 0.5)),
      p95_ms: round(percentile(ms, 0.95)),
      max_ms: round(ms.at(-1) ?? null),
      last_error: this.lastError
        ? {
            at: new Date(this.lastError.at).toISOString(),
            method: this.lastError.method,
            error: this.lastError.error ?? 'error',
          }
        : null,
      by_method,
    };
  }
}

/** createSolanaRpc with the retrying transport. */
export function createRetryingSolanaRpc(url: string, o?: RetryOptions): Rpc<SolanaRpcApi> {
  return createSolanaRpcFromTransport(withRpcRetry(createDefaultRpcTransport({ url }), o));
}

/**
 * Wraps a ChainClient so every call is timed into `stats` (any client: the RPC one, LiteSVM in
 * tests). The RPC client records at the transport instead (per JSON-RPC method), so
 * chainRuntimeFromEnv does not double-wrap it.
 */
export function instrumentChainClient(
  client: ChainClient,
  stats: RpcStats,
  now: () => number = Date.now,
): ChainClient {
  const timed =
    <A extends unknown[], R>(method: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const t0 = now();
      try {
        const r = await fn(...a);
        stats.record({ method, ms: now() - t0, ok: true, attempts: 1, at: now() });
        return r;
      } catch (e) {
        // A preflight rejection is an answer, not an RPC failure.
        const ok = e instanceof PreflightError;
        stats.record({
          method,
          ms: now() - t0,
          ok,
          attempts: 1,
          at: now(),
          ...(ok ? {} : { error: rpcErrorText(e) }),
        });
        throw e;
      }
    };
  const c = client;
  return {
    ...c,
    label: c.label,
    assertSafeCluster: timed('getGenesisHash', () => c.assertSafeCluster()),
    latestBlockhash: timed('getLatestBlockhash', () => c.latestBlockhash()),
    simulate: timed('simulateTransaction', (w: Base64EncodedWireTransaction, r: boolean) =>
      c.simulate(w, r),
    ),
    send: timed('sendTransaction', (w: Base64EncodedWireTransaction, s: boolean) => c.send(w, s)),
    signatureStatus: timed('getSignatureStatuses', (sig: string, o?: { searchHistory?: boolean }) =>
      c.signatureStatus(sig, o),
    ),
    blockHeight: timed('getBlockHeight', () => c.blockHeight()),
    getAccount: timed('getAccountInfo', (a: Address) => c.getAccount(a)),
    tokenBalanceByOwner: timed('getTokenAccountsByOwner', (o: Address, m: Address) =>
      c.tokenBalanceByOwner(o, m),
    ),
    lamports: timed('getBalance', (a: Address) => c.lamports(a)),
    ...(c.programAccounts
      ? {
          programAccounts: timed('getProgramAccounts', (p: Address, f: readonly MemcmpFilter[]) =>
            c.programAccounts!(p, f),
          ),
        }
      : {}),
    rpcStats: () => stats.snapshot(),
  };
}

/** The real client over a kit RPC (QuickNode devnet in production, a local validator in e2e). */
export function rpcChainClient(
  url: string,
  rpc?: Rpc<SolanaRpcApi>,
  stats: RpcStats = new RpcStats(),
): ChainClient {
  rpc ??= createRetryingSolanaRpc(url, { stats });
  const kit = rpc;
  let cluster: Promise<'devnet' | 'localnet'> | null = null;
  return {
    label: redactUrl(url),
    rpcStats: () => stats.snapshot(),
    async programAccounts(program, filters) {
      const res = await kit
        .getProgramAccounts(program, {
          commitment: 'confirmed',
          encoding: 'base64',
          filters: filters.map((f) => ({
            memcmp: {
              offset: BigInt(f.offset),
              bytes: f.bytes as Base58EncodedBytes,
              encoding: 'base58' as const,
            },
          })),
        })
        .send();
      return res.map((r) => ({
        address: r.pubkey,
        account: {
          owner: r.account.owner,
          lamports: r.account.lamports,
          data: new Uint8Array(getBase64Encoder().encode(r.account.data[0])),
        },
      }));
    },
    assertSafeCluster() {
      cluster ??= kit
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
      const { value } = await kit.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async simulate(wire, replaceRecentBlockhash) {
      const { value } = await kit
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
        await kit
          .sendTransaction(
            wire,
            skipPreflight
              ? { encoding: 'base64', skipPreflight: true, maxRetries: 0n }
              : { encoding: 'base64', preflightCommitment: 'processed', maxRetries: 0n },
          )
          .send();
      } catch (e) {
        const d = preflightDetails(e);
        if (!d) throw e;
        const rejection = new PreflightError(
          `preflight rejected: ${jsonSafe(d.err)}`,
          d.err,
          d.logs,
        );
        // An instruction failed in simulation: the program refused THIS tx (a doomed lock, a
        // closed window). A duplicate of our own landed tx never gets that far: the age and
        // status-cache checks run before any instruction.
        if (isInstructionError(d.err)) throw rejection;
        // The transport re-sends a send whose first try timed out after the node got it; the
        // re-simulation then fails at the tx level (AlreadyProcessed; BlockhashNotFound for a
        // durable nonce the landed lock advanced itself). Callers read PreflightError as "nothing
        // landed" (the lock would be cancelled and its nonce revoked), so: AlreadyProcessed is
        // ours by definition; anything else, ask the chain (twice, a node may lag). A known
        // signature returns normally and the caller's status poll takes over; a failed lookup
        // is an unknown fate, never a rejection.
        if (jsonSafe(d.err).includes('AlreadyProcessed')) return;
        const sig = signatureOfWire(wire);
        for (let i = 0; i < 2; i++) {
          let st: unknown;
          try {
            const { value } = await kit
              .getSignatureStatuses([sig], { searchTransactionHistory: true })
              .send();
            st = value[0] ?? null;
          } catch (lookupErr) {
            throw new SendFateUnknownError(sig, rejection, lookupErr);
          }
          if (st) return;
          if (i === 0) await new Promise((r) => setTimeout(r, SEND_RECHECK_MS));
        }
        throw rejection;
      }
    },
    async signatureStatus(sig, o) {
      const { value } = await kit
        .getSignatureStatuses(
          [sig as Signature],
          o?.searchHistory ? { searchTransactionHistory: true } : undefined,
        )
        .send();
      const st = value[0];
      return st ? { err: st.err, confirmationStatus: st.confirmationStatus, slot: st.slot } : null;
    },
    async blockHeight() {
      return kit.getBlockHeight({ commitment: 'confirmed' }).send();
    },
    async getAccount(addr) {
      const { value } = await kit
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
      const { value } = await kit
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
      const { value } = await kit.getBalance(addr, { commitment: 'confirmed' }).send();
      return value;
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
  opts: {
    signers?: readonly KeyPairSigner[];
    label: string;
    cuPrice?: bigint;
    /**
     * A blockhash not to use (the one a node just rejected): wait for a newer one, so a rebuild
     * never produces the very same bytes and signature.
     */
    avoidBlockhash?: string;
  },
): Promise<Built> {
  let lifetime = await client.latestBlockhash();
  for (let i = 0; opts.avoidBlockhash && lifetime.blockhash === opts.avoidBlockhash; i++) {
    if (i >= 10) throw new Error(`${opts.label}: no blockhash newer than the rejected one`);
    await new Promise((r) => setTimeout(r, 400));
    lifetime = await client.latestBlockhash();
  }
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
  let pollErrors = 0;
  let lastPollError: string | null = null;
  for (;;) {
    // A failed status poll is "unknown", never a tx failure: keep polling until the timeout
    // (the transport already retried; the tx may well land meanwhile).
    let st: SigStatus | null = null;
    let polled = true;
    try {
      st = await client.signatureStatus(signature);
    } catch (e) {
      polled = false;
      pollErrors++;
      lastPollError = rpcErrorText(e);
    }
    if (polled && st) {
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
      // Unseen, or the status RPC is failing: keep re-broadcasting (the send path may work while
      // the status path 429s). Expiry is only ever declared from a successful poll.
      if (polled && o.lastValidBlockHeight != null) {
        const height = await client.blockHeight().catch(() => null);
        // The status poll ran before the height read: ask once more, so a tx that landed in
        // the last valid block is never reported dead (a caller may rebuild a dead tx).
        if (
          height !== null &&
          height > o.lastValidBlockHeight &&
          (await client.signatureStatus(signature).catch(() => undefined)) === null
        )
          throw new TxFailedError(
            `tx ${signature} expired unconfirmed`,
            signature,
            null,
            'expired',
          );
      }
      lastSend = now();
      await client.send(wire, true).catch(() => {}); // the status poll decides
    }
    if (now() - t0 > timeoutMs)
      throw new TxFailedError(
        `tx ${signature} not confirmed after ${timeoutMs} ms` +
          (pollErrors ? ` (${pollErrors} status poll error(s), last: ${lastPollError})` : ''),
        signature,
        null,
        'timeout',
      );
    await sleep(pollMs);
  }
}

/**
 * What became of a sent tx, from the chain alone. The one rule for rebuilding a money tx: only a
 * 'failed' or 'dead' one may be replaced; a 'pending' one may still land.
 *   landed   seen at confirmed / finalized without error
 *   failed   seen with an onchain error
 *   dead     unseen, the chain is past its lastValidBlockHeight (no lvbh: sent > maxAgeMs ago),
 *            and a second status read, made after the height read, is still empty (a tx that
 *            landed in the last valid block shows up there)
 *   pending  everything else (processed only, or unseen with a still-valid blockhash)
 */
export type TxFate = 'landed' | 'failed' | 'dead' | 'pending';

export async function txFate(
  client: ChainClient,
  signature: string,
  lastValidBlockHeight: bigint | null,
  o: { sentAtMs?: number | null; nowMs?: number; maxAgeMs?: number } = {},
): Promise<{ fate: TxFate; status: SigStatus | null }> {
  const look = () => client.signatureStatus(signature, { searchHistory: true });
  const st = await look();
  if (st?.err) return { fate: 'failed', status: st };
  if (st)
    return {
      fate:
        st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized'
          ? 'landed'
          : 'pending',
      status: st,
    };
  let past: boolean;
  if (lastValidBlockHeight != null) past = (await client.blockHeight()) > lastValidBlockHeight;
  else {
    const nowMs = o.nowMs ?? Date.now();
    past = o.sentAtMs == null || nowMs - o.sentAtMs > (o.maxAgeMs ?? 10 * 60_000);
  }
  if (!past) return { fate: 'pending', status: null };
  const again = await look();
  if (!again) return { fate: 'dead', status: null };
  return txFate(client, signature, lastValidBlockHeight, o); // it showed up: classify that
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
