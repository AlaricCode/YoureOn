/**
 * SOLANA_MODE=devnet client (skeleton, free network). Same message bytes as
 * the mock chain (§12.1); accounts decoded with the engine's normative Borsh
 * decoders; the Anchor `Program` built from the committed IDL is exposed for
 * tooling. Nothing is sent unless SOLANA_MODE=devnet is configured (the
 * registry only constructs this class then).
 *
 * TODO(chain/keeper agents):
 *  - rpc_ws event source: `connection.onLogs(programId)` → handler (§12.5);
 *    wire in chain/events.ts `startRpcWsSource`.
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
    if (!this.mintAddress) throw new Error('devnet: no USDC mint yet; call ensureTestMint() or set USDC_MINT');
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
      if (conf.value.err) return { status: 'failed', signature, error: JSON.stringify(conf.value.err), code: 'TX_FAILED' };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const expired = /blockhash not found|block height exceeded|expired/i.test(msg);
      const insufficient = /insufficient funds/i.test(msg);
      return {
        status: 'failed',
        signature,
        error: msg,
        code: expired ? 'TX_EXPIRED' : insufficient ? 'INSUFFICIENT_FUNDS' : 'TX_FAILED',
      };
    }
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

function readMintState(path: string): string | null {
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, 'utf8')) as { mint?: string };
  return j.mint ?? null;
}

function writeMintState(path: string, mint: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mint }), { mode: 0o600 });
}
