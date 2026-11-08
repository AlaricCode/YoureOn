/**
 * Chain client interface shared by the mock chain (SOLANA_MODE=mock) and the
 * devnet client (SOLANA_MODE=devnet). Service code only talks to this.
 */
import type {
  BetAccount,
  InstructionAccountsMap,
  InstructionArgsMap,
  InstructionName,
  ProfileAccount,
  Pubkey,
  TrackBufferAccount,
  VerdictEvent,
} from '@verdict/engine';

/** A Verdict program instruction with named accounts (IDL order resolves positions). */
export interface VerdictIx<N extends InstructionName = InstructionName> {
  program: 'verdict';
  name: N;
  args: InstructionArgsMap[N];
  /**
   * Named accounts. Fixed-address accounts from the IDL (token_program,
   * system_program, sysvars) may be omitted; they are filled in.
   */
  accounts: Partial<Record<InstructionAccountsMap[N], Pubkey>>;
  /** §9.4 payout accounts (remaining accounts), participant order. */
  remaining?: Pubkey[];
}

export interface RawAccountMeta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

/** Any other instruction (SPL Token, ATA, ComputeBudget, Ed25519 precompile, System). */
export interface RawIx {
  program: 'raw';
  programId: Pubkey;
  keys: RawAccountMeta[];
  data: Uint8Array;
}

export type ChainIx = VerdictIx | RawIx;

/** An unsigned transaction message prepared for signing (§12.1). */
export interface PreparedTx {
  /** serialized legacy Solana message (the bytes users sign) */
  message: Uint8Array;
  /** required signers, in message order (index 0 = fee payer) */
  signers: Pubkey[];
  /** wall-clock ms after which the blockhash is no longer accepted */
  expiresAtMs: number;
  recentBlockhash: string;
}

export interface SignatureEntry {
  pubkey: Pubkey;
  signature: Uint8Array;
}

/** A chain event as delivered to the §12.5 handler. */
export interface ChainEventEnvelope {
  signature: string;
  slot: number;
  block_time: number | null;
  /** index of the event within the transaction */
  index: number;
  event: VerdictEvent;
}

export type SendResult =
  | { status: 'confirmed'; signature: string; slot: number; events: ChainEventEnvelope[] }
  | {
      status: 'failed';
      signature: string | null;
      /** §9.6 name, an SPL/runtime error name, or "BlockhashNotFound"/"SignatureVerificationFailed" */
      error: string;
      /** mapped §12.8 code */
      code: 'TX_FAILED' | 'TX_EXPIRED' | 'INSUFFICIENT_FUNDS';
    };

export interface SlotHash {
  slot: bigint;
  /** hex, 32 bytes */
  hash: string;
}

export interface ChainClient {
  readonly mode: 'mock' | 'devnet';
  readonly programId: Pubkey;
  /** USDC mint (mock: a fixed mock mint) */
  readonly mint: Pubkey;
  readonly feePayer: Pubkey;
  readonly oracle: Pubkey;

  /** Compiles instructions into a message with the backend fee payer. */
  prepare(ixs: ChainIx[]): Promise<PreparedTx>;
  /**
   * Adds backend signatures (fee payer, oracle, judges — whichever are
   * required and held) to the externally provided ones, verifies them, and
   * sends. Never throws for on-chain failures (returns status "failed").
   */
  submit(prepared: PreparedTx | Uint8Array, signatures: SignatureEntry[]): Promise<SendResult>;
  /** prepare + submit with backend keys only (oracle actions, keeper). */
  sendAsBackend(ixs: ChainIx[]): Promise<SendResult>;

  getBet(bet: Pubkey): Promise<BetAccount | null>;
  getProfile(wallet: Pubkey): Promise<ProfileAccount | null>;
  getTrackBuffer(bet: Pubkey): Promise<TrackBufferAccount | null>;
  /** USDC balance (base units) of the owner's associated token account. */
  getUsdcBalance(owner: Pubkey): Promise<bigint>;
  /** Mints/transfers demo USDC to the owner (mock: unlimited; devnet: test mint). */
  faucet(owner: Pubkey, amount: bigint): Promise<SendResult>;
  /** Newest SlotHashes entry (beacon source, §7.5). */
  latestSlotHash(): Promise<SlotHash>;
  currentSlot(): Promise<bigint>;
  /** Chain clock (unix seconds). */
  nowSeconds(): Promise<bigint>;

  /** In-process event subscription (mock chain; devnet rpc_ws feeds the same). */
  onEvents(listener: (events: ChainEventEnvelope[]) => void | Promise<void>): () => void;

  close(): Promise<void>;
}
