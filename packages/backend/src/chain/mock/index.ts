/**
 * SOLANA_MODE=mock (§13): an in-memory chain implementing §9 with the
 * engine's chainModel.
 *  - Deterministic slots: slot = MOCK_BASE_SLOT + floor((now − genesis) / 400 ms);
 *    slot hash = sha256("mock-slot" ‖ u64 LE slot); blockhash = base58(slot hash).
 *  - Mints unlimited mock USDC (faucet; mint authority = fee payer).
 *  - Verifies the ed25519 signatures of every required signer over the exact
 *    message bytes (§12.1), and the §9.7 Ed25519 precompile layout.
 *  - Groth16: a verifier may be injected (PROVER=snarkjs wiring); otherwise accepts.
 *  - Events are delivered in-process to `onEvents` listeners (§12.5 mock: no HMAC).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MOCK_SLOT_TAG,
  profilePda,
  sha256,
  trackBufferPda,
  type BetAccount,
  type ChainModel,
  type EncodedGroth16Proof,
  type ProfileAccount,
  type SlotHashEntry,
  type TrackBufferAccount,
} from '@verdict/engine';
import type { KeyPair } from '../../crypto/keys.js';
import { verifyEd25519 } from '../../crypto/keys.js';
import { bytesEqual, concat, fromBase58, toBase58, toHex, utf8 } from '../../util/bytes.js';
import type { Clock } from '../../util/clock.js';
import type { VerdictIdl } from '../idl.js';
import { compileMessage, MAX_TX_BYTES, messageSigners, parseMessage, transactionSize, type BuildContext } from '../message.js';
import { associatedTokenAddress } from '../programs.js';
import type {
  ChainClient,
  ChainEventEnvelope,
  ChainIx,
  PreparedTx,
  SendResult,
  SignatureEntry,
  SlotHash,
} from '../types.js';
import { executeMessage, TxError } from './exec.js';
import { emptyState, forkState, restoreState, snapshotState, type LedgerSnapshot, type LedgerState } from './state.js';

export const MOCK_SLOT_MS = 400;
export const MOCK_BASE_SLOT = 1_000_000n;
/** Blockhash lifetime (Solana: 150 slots). */
export const BLOCKHASH_VALID_SLOTS = 150n;
const SLOT_HASHES_MAX = 512;

/** Deterministic mock slot hash: sha256("mock-slot" ‖ u64 LE slot) (§13). */
export function mockSlotHash(slot: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, slot, true);
  return sha256(concat(utf8(MOCK_SLOT_TAG), b));
}

/** Fixed mock USDC mint address (used when USDC_MINT is unset). */
export const MOCK_USDC_MINT = toBase58(sha256(utf8('verdict/mock-usdc-mint')));

export interface MockChainOptions {
  idl: VerdictIdl;
  programId: string;
  clock: Clock;
  feePayer: KeyPair;
  oracle: KeyPair;
  /** other backend-held signers (judges) */
  extraSigners?: KeyPair[];
  mint?: string;
  /** persist the ledger to this JSON file after every transaction */
  persistPath?: string | null;
  chainModel?: ChainModel;
  verifyGroth16?: (publicInputs: Uint8Array[], proof: EncodedGroth16Proof) => boolean;
  /** error sink for listener failures */
  onListenerError?: (e: unknown) => void;
}

export class MockChain implements ChainClient {
  readonly mode = 'mock' as const;
  readonly programId: string;
  readonly mint: string;
  readonly feePayer: string;
  readonly oracle: string;

  private state: LedgerState;
  private readonly genesisMs: number;
  private readonly signersByKey = new Map<string, KeyPair>();
  private readonly listeners = new Set<(ev: ChainEventEnvelope[]) => void | Promise<void>>();
  private delivery: Promise<void> = Promise.resolve();
  private readonly buildCtx: BuildContext;
  /** signature → result, for idempotent resubmission */
  private readonly sent = new Map<string, SendResult>();
  private txCounter = 0;

  constructor(private readonly opts: MockChainOptions) {
    this.programId = opts.programId;
    this.mint = opts.mint ?? MOCK_USDC_MINT;
    this.feePayer = opts.feePayer.publicKey;
    this.oracle = opts.oracle.publicKey;
    for (const k of [opts.feePayer, opts.oracle, ...(opts.extraSigners ?? [])]) this.signersByKey.set(k.publicKey, k);
    this.buildCtx = { idl: opts.idl, programId: opts.programId, feePayer: this.feePayer };

    const persisted = opts.persistPath && existsSync(opts.persistPath)
      ? (JSON.parse(readFileSync(opts.persistPath, 'utf8')) as LedgerSnapshot)
      : null;
    if (persisted) {
      this.state = restoreState(persisted);
      this.genesisMs = persisted.genesis_ms;
    } else {
      this.state = emptyState();
      this.genesisMs = opts.clock.nowMs();
    }
  }

  // ---- clock / slots ---------------------------------------------------------

  private slotAt(ms: number): bigint {
    const d = Math.max(0, ms - this.genesisMs);
    return MOCK_BASE_SLOT + BigInt(Math.floor(d / MOCK_SLOT_MS));
  }

  private slotNow(): bigint {
    return this.slotAt(this.opts.clock.nowMs());
  }

  private slotStartMs(slot: bigint): number {
    return this.genesisMs + Number(slot - MOCK_BASE_SLOT) * MOCK_SLOT_MS;
  }

  /** SlotHashes sysvar: previous slots, newest first, ≤ 512 entries. */
  slotHashes(): SlotHashEntry[] {
    const cur = this.slotNow();
    const out: SlotHashEntry[] = [];
    for (let s = cur - 1n; s >= 1n && out.length < SLOT_HASHES_MAX; s--) {
      out.push({ slot: s, hash: toHex(mockSlotHash(s)) });
    }
    return out;
  }

  async currentSlot(): Promise<bigint> {
    return this.slotNow();
  }

  async nowSeconds(): Promise<bigint> {
    return BigInt(Math.floor(this.opts.clock.nowMs() / 1000));
  }

  async latestSlotHash(): Promise<SlotHash> {
    // The newest SlotHashes entry is the previous slot (the current one has no hash yet).
    // Slots before genesis exist conceptually (deterministic hashes), so history is never empty.
    const slot = this.slotNow() - 1n;
    return { slot, hash: toHex(mockSlotHash(slot)) };
  }

  private blockhashSlot(blockhash: string): bigint | null {
    let raw: Uint8Array;
    try {
      raw = fromBase58(blockhash);
    } catch {
      return null;
    }
    const cur = this.slotNow();
    for (let s = cur; s >= 1n && cur - s <= BLOCKHASH_VALID_SLOTS; s--) {
      if (bytesEqual(mockSlotHash(s), raw)) return s;
    }
    return null;
  }

  // ---- transactions ------------------------------------------------------------

  async prepare(ixs: ChainIx[]): Promise<PreparedTx> {
    const slot = this.slotNow();
    const blockhash = toBase58(mockSlotHash(slot));
    const msg = compileMessage(ixs, this.buildCtx, blockhash);
    const bytes = new Uint8Array(msg.serialize());
    const signers = messageSigners(msg);
    if (transactionSize(bytes, signers.length) > MAX_TX_BYTES) {
      throw new Error(`transaction too large: ${transactionSize(bytes, signers.length)} > ${MAX_TX_BYTES} bytes`);
    }
    return {
      message: bytes,
      signers,
      recentBlockhash: blockhash,
      expiresAtMs: this.slotStartMs(slot + BLOCKHASH_VALID_SLOTS + 1n),
    };
  }

  async sendAsBackend(ixs: ChainIx[]): Promise<SendResult> {
    return this.submit(await this.prepare(ixs), []);
  }

  async submit(prepared: PreparedTx | Uint8Array, signatures: SignatureEntry[]): Promise<SendResult> {
    const message = prepared instanceof Uint8Array ? prepared : prepared.message;
    let parsed;
    try {
      parsed = parseMessage(message, this.opts.idl, this.programId);
    } catch (e) {
      return { status: 'failed', signature: null, error: `InvalidMessage: ${(e as Error).message}`, code: 'TX_FAILED' };
    }

    // Collect one signature per required signer: given ones, else backend-held keys.
    const sigs: Uint8Array[] = [];
    for (const signer of parsed.signers) {
      const given = signatures.find((s) => s.pubkey === signer);
      if (given) {
        sigs.push(given.signature);
        continue;
      }
      const kp = this.signersByKey.get(signer);
      if (!kp) {
        return { status: 'failed', signature: null, error: `MissingSignature ${signer}`, code: 'TX_FAILED' };
      }
      sigs.push(kp.sign(message));
    }
    for (let i = 0; i < parsed.signers.length; i++) {
      if (!verifyEd25519(sigs[i]!, message, parsed.signers[i]!)) {
        return { status: 'failed', signature: null, error: 'SignatureVerificationFailed', code: 'TX_FAILED' };
      }
    }
    const signature = toBase58(sigs[0]!);
    const done = this.sent.get(signature);
    if (done) return done;

    const slot = this.blockhashSlot(parsed.recentBlockhash);
    if (slot === null) return { status: 'failed', signature, error: 'BlockhashNotFound', code: 'TX_EXPIRED' };

    const nowMs = this.opts.clock.nowMs();
    const curSlot = this.slotNow();
    const fork = forkState(this.state);
    let events;
    try {
      events = executeMessage(fork, parsed, {
        programId: this.programId,
        mint: this.mint,
        mintAuthority: this.feePayer,
        nowS: BigInt(Math.floor(nowMs / 1000)),
        slot: curSlot,
        slotHashes: this.slotHashes(),
        ...(this.opts.chainModel ? { chainModel: this.opts.chainModel } : {}),
        ...(this.opts.verifyGroth16 ? { verifyGroth16: this.opts.verifyGroth16 } : {}),
      });
    } catch (e) {
      if (!(e instanceof TxError)) throw e;
      const result: SendResult = {
        status: 'failed',
        signature,
        error: e.error,
        code: e.error === 'InsufficientFunds' ? 'INSUFFICIENT_FUNDS' : 'TX_FAILED',
      };
      return result;
    }
    this.state = fork;
    this.persist();
    this.txCounter++;
    const envelopes: ChainEventEnvelope[] = events.map((event, index) => ({
      signature,
      slot: Number(curSlot),
      block_time: Math.floor(nowMs / 1000),
      index,
      event,
    }));
    const result: SendResult = { status: 'confirmed', signature, slot: Number(curSlot), events: envelopes };
    this.sent.set(signature, result);
    if (envelopes.length > 0) this.deliver(envelopes);
    return result;
  }

  // ---- events ------------------------------------------------------------------

  onEvents(listener: (events: ChainEventEnvelope[]) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events are delivered serially, after the sending call has returned. */
  private deliver(envelopes: ChainEventEnvelope[]): void {
    this.delivery = this.delivery.then(async () => {
      await new Promise<void>((r) => setImmediate(r));
      for (const l of [...this.listeners]) {
        try {
          await l(envelopes);
        } catch (e) {
          this.opts.onListenerError?.(e);
        }
      }
    });
  }

  /** Resolves once every event emitted so far has been delivered (tests, demo). */
  async flushEvents(): Promise<void> {
    let last: Promise<void> | null = null;
    while (last !== this.delivery) {
      last = this.delivery;
      await last;
    }
  }

  // ---- reads -------------------------------------------------------------------

  async getBet(bet: string): Promise<BetAccount | null> {
    return this.state.bets.get(bet) ?? null;
  }

  async getProfile(wallet: string): Promise<ProfileAccount | null> {
    return this.state.profiles.get(profilePda(wallet, this.programId).address) ?? null;
  }

  async getTrackBuffer(bet: string): Promise<TrackBufferAccount | null> {
    return this.state.trackBuffers.get(trackBufferPda(bet, this.programId).address) ?? null;
  }

  async getUsdcBalance(owner: string): Promise<bigint> {
    return this.state.tokens.get(associatedTokenAddress(owner, this.mint))?.amount ?? 0n;
  }

  /** Raw token balance of any token account (vaults, ATAs). */
  tokenBalance(account: string): bigint | null {
    return this.state.tokens.get(account)?.amount ?? null;
  }

  tokenAccountExists(account: string): boolean {
    return this.state.tokens.has(account);
  }

  /** Mints mock USDC into the owner's ATA (created if missing). Unlimited. */
  async faucet(owner: string, amount: bigint): Promise<SendResult> {
    if (amount <= 0n) return { status: 'failed', signature: null, error: 'InvalidAmount', code: 'TX_FAILED' };
    const ata = associatedTokenAddress(owner, this.mint);
    const fork = forkState(this.state);
    const acct = fork.tokens.get(ata) ?? { mint: this.mint, owner, amount: 0n };
    acct.amount += amount;
    fork.tokens.set(ata, acct);
    this.state = fork;
    this.persist();
    const signature = toBase58(sha256(concat(utf8('mock-faucet'), fromBase58(owner), utf8(`${this.txCounter++}:${amount}`))));
    return { status: 'confirmed', signature, slot: Number(this.slotNow()), events: [] };
  }

  private persist(): void {
    const p = this.opts.persistPath;
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshotState(this.state, this.genesisMs)), { mode: 0o600 });
    renameSync(tmp, p);
  }

  async close(): Promise<void> {
    await this.flushEvents();
  }
}
