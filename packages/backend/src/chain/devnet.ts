/**
 * SOLANA_MODE=devnet client (skeleton, free network). Same message bytes as
 * the mock chain (§12.1); accounts decoded with the engine's normative Borsh
 * decoders; the Anchor `Program` built from the committed IDL is exposed for
 * tooling. Nothing is sent unless SOLANA_MODE=devnet is configured (the
 * registry only constructs this class then).
 *
 * The rpc_ws event source lives in chain/rpcWs.ts (wired by
 * routes/chainEvents.ts). `submit()` also feeds the events of every confirmed
 * backend transaction to the `onEvents` listeners, so with
 * CHAIN_EVENTS_SOURCE=rpc_ws the same events can arrive twice (submit +
 * logsSubscribe). That is harmless: both paths index events per transaction
 * in log order and ChainEventHandler deduplicates on `eventKey(signature,
 * index)` (test/streams.test.ts, "handles a backend-submitted tx once").
 * Open items:
 *  - retries / priority fees / durable confirmation strategy.
 *  - re-read the Bet after every observed transaction (§9.5 lost-log rule).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  Message,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Commitment,
} from '@solana/web3.js';
import {
  decodeBetAccount,
  decodeEventTyped,
  decodeProfile,
  decodeTrackBufferHeader,
  profilePda,
  trackBufferPda,
  TRACK_BUFFER_HEADER_BYTES,
  type BetAccount,
  type ProfileAccount,
  type TrackBufferAccount,
  type VerdictEvent,
} from '@verdict/engine';
import type { KeyPair } from '../crypto/keys.js';
import { ApiError } from '../errors.js';
import { toBase58, toHex } from '../util/bytes.js';
import type { Clock } from '../util/clock.js';
import type { VerdictIdl } from './idl.js';
import { compileMessage, MAX_TX_BYTES, messageSigners, transactionSize, type BuildContext } from './message.js';
import {
  associatedTokenAddress,
  createAtaIdempotentIx,
  mintToIx,
  SLOT_HASHES_SYSVAR_ID,
  TOKEN_PROGRAM_ID,
  USDC_DECIMALS,
} from './programs.js';
import type {
  ChainClient,
  ChainEventEnvelope,
  ChainIx,
  PreparedTx,
  SendResult,
  SignatureEntry,
  SlotHash,
} from './types.js';

/** Conservative blockhash lifetime used for `expires_at_ms` (≈150 slots ≈ 60 s). */
export const DEVNET_BLOCKHASH_TTL_MS = 55_000;
const MINT_ACCOUNT_BYTES = 82;

export interface DevnetChainOptions {
  idl: VerdictIdl;
  programId: string;
  rpcUrl: string;
  wsUrl?: string;
  clock: Clock;
  feePayer: KeyPair;
  oracle: KeyPair;
  extraSigners?: KeyPair[];
  /** USDC_MINT; null ⇒ backend-created test mint persisted at `mintStatePath` (D-34) */
  mint: string | null;
  mintStatePath: string;
  commitment?: Commitment;
}

function toWeb3Keypair(k: KeyPair): Keypair {
  return Keypair.fromSecretKey(k.secretKey);
}

export class DevnetChain implements ChainClient {
  readonly mode = 'devnet' as const;
  readonly programId: string;
  readonly feePayer: string;
  readonly oracle: string;
  readonly connection: Connection;
  private mintAddress: string | null;
  private readonly signers = new Map<string, KeyPair>();
  private readonly listeners = new Set<(ev: ChainEventEnvelope[]) => void | Promise<void>>();
  private readonly buildCtx: BuildContext;
  private program: Program | null = null;

  constructor(private readonly opts: DevnetChainOptions) {
    this.programId = opts.programId;
    this.feePayer = opts.feePayer.publicKey;
    this.oracle = opts.oracle.publicKey;
    for (const k of [opts.feePayer, opts.oracle, ...(opts.extraSigners ?? [])]) this.signers.set(k.publicKey, k);
    this.connection = new Connection(opts.rpcUrl, {
      commitment: opts.commitment ?? 'confirmed',
      ...(opts.wsUrl ? { wsEndpoint: opts.wsUrl } : {}),
    });
    this.buildCtx = { idl: opts.idl, programId: opts.programId, feePayer: this.feePayer };
    this.mintAddress = opts.mint ?? readMintState(opts.mintStatePath);
  }

  get mint(): string {
    if (!this.mintAddress) throw new ApiError('INTERNAL', 'devnet: no USDC mint yet (startup init failed?); set USDC_MINT or fund the fee payer', 503);
    return this.mintAddress;
  }

  /** Anchor Program over the committed IDL (tooling; engine decoders stay normative). */
  anchorProgram(): Program {
    if (!this.program) {
      const provider = new AnchorProvider(this.connection, new Wallet(toWeb3Keypair(this.opts.feePayer)), {
        commitment: this.opts.commitment ?? 'confirmed',
      });
      this.program = new Program({ ...(this.opts.idl as unknown as Idl), address: this.programId }, provider);
    }
    return this.program;
  }

  async prepare(ixs: ChainIx[]): Promise<PreparedTx> {
    const { blockhash } = await this.connection.getLatestBlockhash();
    const msg = compileMessage(ixs, this.buildCtx, blockhash);
    const bytes = new Uint8Array(msg.serialize());
    const signers = messageSigners(msg);
    if (transactionSize(bytes, signers.length) > MAX_TX_BYTES) {
      throw new Error(`transaction too large: ${transactionSize(bytes, signers.length)} > ${MAX_TX_BYTES} bytes`);
    }
    return { message: bytes, signers, recentBlockhash: blockhash, expiresAtMs: this.opts.clock.nowMs() + DEVNET_BLOCKHASH_TTL_MS };
  }

  async sendAsBackend(ixs: ChainIx[]): Promise<SendResult> {
    return this.submit(await this.prepare(ixs), []);
  }

  async submit(prepared: PreparedTx | Uint8Array, signatures: SignatureEntry[]): Promise<SendResult> {
    const bytes = prepared instanceof Uint8Array ? prepared : prepared.message;
    const message = Message.from(Buffer.from(bytes));
    const required = messageSigners(message);
    const sigs = required.map((pk) => {
      const given = signatures.find((s) => s.pubkey === pk);
      if (given) return { signature: Buffer.from(given.signature), publicKey: new PublicKey(pk) };
      const kp = this.signers.get(pk);
      if (!kp) return null;
      return { signature: Buffer.from(kp.sign(bytes)), publicKey: new PublicKey(pk) };
    });
    if (sigs.some((s) => s === null)) {
      return { status: 'failed', signature: null, error: 'MissingSignature', code: 'TX_FAILED' };
    }
    const tx = Transaction.populate(message, sigs.map((s) => toBase58(s!.signature)));
    let signature: string | null = null;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      const conf = await this.connection.confirmTransaction(signature, this.opts.commitment ?? 'confirmed');
      if (conf.value.err) {
        const error = txErrorName(conf.value.err, this.idlErrors);
        return { status: 'failed', signature, error, code: error === 'InsufficientFunds' ? 'INSUFFICIENT_FUNDS' : 'TX_FAILED', raw: JSON.stringify(conf.value.err) };
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // Already landed (a retry, a restart, another instance): ask the cluster instead of failing.
      if (/already (been )?processed/i.test(msg)) {
        const sig = toBase58(tx.signature ?? new Uint8Array(64));
        const st = (await this.connection.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
        if (st && !st.err) {
          signature = sig;
          return this.confirmed(sig);
        }
      }
      const logs = await sendErrorLogs(e, this.connection);
      const error = programErrorName(msg, logs, this.idlErrors);
      return {
        status: 'failed',
        signature,
        error,
        code: error === 'BlockhashNotFound' ? 'TX_EXPIRED' : error === 'InsufficientFunds' ? 'INSUFFICIENT_FUNDS' : 'TX_FAILED',
        raw: msg,
        ...(logs ? { logs } : {}),
      };
    }
    return this.confirmed(signature);
  }

  private get idlErrors(): IdlErrors {
    return this.opts.idl.errors ?? [];
  }

  private async confirmed(signature: string): Promise<SendResult> {
    const events = await this.fetchEvents(signature);
    if (events.length > 0) for (const l of this.listeners) await l(events);
    const slot = events[0]?.slot ?? Number(await this.connection.getSlot());
    return { status: 'confirmed', signature, slot, events };
  }

  /** Decodes `Program data:` log lines of a confirmed transaction into events. */
  async fetchEvents(signature: string): Promise<ChainEventEnvelope[]> {
    const tx = await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx?.meta?.logMessages) return [];
    return parseProgramLogs(tx.meta.logMessages, this.programId).map((event, index) => ({
      signature,
      slot: tx.slot,
      block_time: tx.blockTime ?? null,
      index,
      event,
    }));
  }

  async getBet(bet: string): Promise<BetAccount | null> {
    const info = await this.connection.getAccountInfo(new PublicKey(bet));
    return info ? decodeBetAccount(new Uint8Array(info.data)) : null;
  }

  async getProfile(wallet: string): Promise<ProfileAccount | null> {
    const info = await this.connection.getAccountInfo(new PublicKey(profilePda(wallet, this.programId).address));
    return info ? decodeProfile(new Uint8Array(info.data)) : null;
  }

  async getTrackBuffer(bet: string): Promise<TrackBufferAccount | null> {
    const info = await this.connection.getAccountInfo(new PublicKey(trackBufferPda(bet, this.programId).address));
    if (!info || info.data.length < 8 + TRACK_BUFFER_HEADER_BYTES) return null;
    const data = new Uint8Array(info.data);
    const header = decodeTrackBufferHeader(data.subarray(8, 8 + TRACK_BUFFER_HEADER_BYTES));
    const off = 8 + TRACK_BUFFER_HEADER_BYTES;
    return { header, payload: data.slice(off, off + header.payload_len) };
  }

  async getUsdcBalance(owner: string): Promise<bigint> {
    try {
      const r = await this.connection.getTokenAccountBalance(new PublicKey(associatedTokenAddress(owner, this.mint)));
      return BigInt(r.value.amount);
    } catch {
      return 0n;
    }
  }

  /** Demo drip from the backend test mint (mint authority = fee payer, D-34). */
  async faucet(owner: string, amount: bigint): Promise<SendResult> {
    await this.ensureTestMint();
    return this.sendAsBackend([
      createAtaIdempotentIx(this.feePayer, owner, this.mint),
      mintToIx(this.mint, associatedTokenAddress(owner, this.mint), this.feePayer, amount),
    ]);
  }

  /** Startup hook (main/buildApp onReady): create the test mint before any route reads `mint`. */
  async init(): Promise<void> {
    if (!this.mintAddress) await this.ensureTestMint();
  }

  /**
   * Creates the backend test mint once (SystemProgram.createAccount +
   * InitializeMint2, authority = fee payer) and persists its address. Needs
   * devnet SOL on the fee payer (free airdrop).
   */
  async ensureTestMint(): Promise<string> {
    if (this.mintAddress) return this.mintAddress;
    const mint = Keypair.generate();
    const lamports = await this.connection.getMinimumBalanceForRentExemption(MINT_ACCOUNT_BYTES);
    const init = new Uint8Array(1 + 1 + 32 + 1);
    init[0] = 20; // InitializeMint2
    init[1] = USDC_DECIMALS;
    init.set(new PublicKey(this.feePayer).toBytes(), 2);
    init[34] = 0; // no freeze authority
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: new PublicKey(this.feePayer),
        newAccountPubkey: mint.publicKey,
        lamports,
        space: MINT_ACCOUNT_BYTES,
        programId: new PublicKey(TOKEN_PROGRAM_ID),
      }),
      new TransactionInstruction({
        programId: new PublicKey(TOKEN_PROGRAM_ID),
        keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
        data: Buffer.from(init),
      }),
    );
    tx.feePayer = new PublicKey(this.feePayer);
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    tx.sign(toWeb3Keypair(this.opts.feePayer), mint);
    const sig = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(sig, 'confirmed');
    this.mintAddress = mint.publicKey.toBase58();
    writeMintState(this.opts.mintStatePath, this.mintAddress);
    return this.mintAddress;
  }

  /** Newest SlotHashes entry, read raw from the sysvar (§9.1 layout: u64 len, then (u64 slot, [u8;32] hash)…). */
  async latestSlotHash(): Promise<SlotHash> {
    const info = await this.connection.getAccountInfo(new PublicKey(SLOT_HASHES_SYSVAR_ID));
    if (!info || info.data.length < 48) throw new Error('devnet: SlotHashes sysvar unavailable');
    const dv = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
    const slot = dv.getBigUint64(8, true);
    return { slot, hash: toHex(new Uint8Array(info.data.subarray(16, 48))) };
  }

  async currentSlot(): Promise<bigint> {
    return BigInt(await this.connection.getSlot());
  }

  async nowSeconds(): Promise<bigint> {
    const slot = await this.connection.getSlot();
    const t = await this.connection.getBlockTime(slot);
    return BigInt(t ?? Math.floor(this.opts.clock.nowMs() / 1000));
  }

  onEvents(listener: (events: ChainEventEnvelope[]) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}

/**
 * Extracts Verdict events from transaction logs: only `Program data:` lines
 * emitted while the Verdict program is the innermost invoked program.
 */
export function parseProgramLogs(logs: string[], programId: string): VerdictEvent[] {
  const stack: string[] = [];
  const out: VerdictEvent[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program (\S+) (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    const data = /^Program data: ([A-Za-z0-9+/=]+)\s*$/.exec(line);
    if (data && stack[stack.length - 1] === programId) {
      try {
        out.push(decodeEventTyped(data[1]!));
      } catch {
        /* not a Verdict event (or truncated) */
      }
    }
  }
  return out;
}

type IdlErrors = { code: number; name: string }[];

const RUNTIME_NAMES: [RegExp, string][] = [
  [/blockhash not found|block height exceeded|expired/i, 'BlockhashNotFound'],
  [/insufficient funds|insufficient lamports/i, 'InsufficientFunds'],
  [/signature verification fail|invalid signature|missing signature/i, 'SignatureVerificationFailed'],
];

/** §9.6 name of an Anchor/custom program error code (6000 + contract order), else `Custom(n)`. */
export function customErrorName(code: number, idlErrors: IdlErrors): string {
  return idlErrors.find((e) => e.code === code)?.name ?? `Custom(${code})`;
}

/**
 * Error name of a failed send: the Anchor `Error Code: X` log line, else a
 * `custom program error: 0x…` code mapped through the IDL, else a fixed
 * runtime name (BlockhashNotFound, InsufficientFunds,
 * SignatureVerificationFailed), else `TransactionFailed`.
 */
export function programErrorName(message: string, logs: string[] | null, idlErrors: IdlErrors): string {
  const all = [message, ...(logs ?? [])];
  for (const l of all) {
    const m = /Error Code: (\w+)/.exec(l);
    if (m) return m[1]!;
  }
  const hexMatch = all.map((l) => /custom program error: 0x([0-9a-f]+)/i.exec(l)).find(Boolean);
  const code = hexMatch ? parseInt(hexMatch[1]!, 16) : null;
  if (code !== null && code >= 6000) return customErrorName(code, idlErrors);
  // SPL / runtime failures (e.g. SPL Token 0x1 "insufficient funds") keep a fixed name.
  for (const [re, name] of RUNTIME_NAMES) if (all.some((l) => re.test(l))) return name;
  if (code !== null) return `Custom(${code})`;
  return 'TransactionFailed';
}

/** Name of a confirmed transaction's `err` (`{InstructionError:[i,{Custom:n}]}`, `"InsufficientFundsForFee"`, …). */
export function txErrorName(err: unknown, idlErrors: IdlErrors): string {
  if (typeof err === 'string') return /InsufficientFunds/.test(err) ? 'InsufficientFunds' : err;
  if (err && typeof err === 'object') {
    const ie = (err as { InstructionError?: [number, unknown] }).InstructionError;
    if (ie) {
      const inner = ie[1];
      if (inner && typeof inner === 'object' && 'Custom' in inner) return customErrorName(Number((inner as { Custom: number }).Custom), idlErrors);
      if (typeof inner === 'string') return inner;
      if (inner && typeof inner === 'object') return Object.keys(inner)[0] ?? 'InstructionError';
    }
    return Object.keys(err)[0] ?? 'TransactionFailed';
  }
  return 'TransactionFailed';
}

/** Program logs of a web3.js SendTransactionError (simulation failure), or null. */
async function sendErrorLogs(e: unknown, connection: Connection): Promise<string[] | null> {
  const x = e as { logs?: unknown; getLogs?: (c: Connection) => Promise<string[]> } | null;
  if (x && Array.isArray(x.logs)) return x.logs as string[];
  if (x && typeof x.getLogs === 'function') {
    try {
      return await x.getLogs(connection);
    } catch {
      return null;
    }
  }
  return null;
}

function readMintState(path: string): string | null {
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, 'utf8')) as { mint?: string };
  return j.mint ?? null;
}

function writeMintState(path: string, mint: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mint }), { mode: 0o600 });
}
