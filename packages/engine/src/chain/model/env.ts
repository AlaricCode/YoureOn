/**
 * Shared machinery for the chain-model instruction handlers: errors, signer
 * and account checks, payout/close bookkeeping (§9.4 dust rule, §9.8).
 */
import { ED25519_PROGRAM_ID, MAX_PARTICIPANTS } from '../../constants.js';
import type {
  BetAccount,
  ChainClose,
  ChainContext,
  ChainInstruction,
  ChainTransfer,
  ErrorCode,
  ProfileAccount,
  Pubkey,
  TrackBufferAccount,
  VerdictEvent,
  VerdictEventMap,
  VerdictEventName,
} from '../../types.js';
import type { ChainHooks } from '../hooks.js';

/** Thrown by handlers; converted to `{ error }` by `apply`. */
export class ChainError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'ChainError';
  }
}

export function fail(code: ErrorCode): never {
  throw new ChainError(code);
}

export function check(cond: boolean, code: ErrorCode): asserts cond {
  if (!cond) throw new ChainError(code);
}

/** Options for {@link createChainModel}. */
export interface ChainModelOptions {
  /** Decoders / interpreter (default: the engine's own). */
  hooks?: Partial<ChainHooks>;
  /** Cargo feature `sp1` (§9.4 #8, #14). Default false ⇒ `Sp1Disabled`. */
  sp1?: boolean;
  /** SP1 proof verifier; omitted ⇒ accept (mock). */
  verifySp1?: (publicValues: Uint8Array, proof: Uint8Array) => boolean;
  /**
   * Emulate the Ed25519 precompile by verifying both panel signatures
   * (a failing precompile fails the whole transaction). Default true.
   */
  verifyEd25519Signatures?: boolean;
}

export interface ResolvedOptions {
  hooks: ChainHooks;
  sp1: boolean;
  verifySp1?: (publicValues: Uint8Array, proof: Uint8Array) => boolean;
  verifyEd25519Signatures: boolean;
  ed25519ProgramId: Pubkey;
}

export const ED25519_ID = ED25519_PROGRAM_ID;

/** Per-instruction mutable environment. */
export class Env {
  readonly events: VerdictEvent[] = [];
  readonly transfers: ChainTransfer[] = [];
  readonly closed: ChainClose[] = [];
  trackBuffer: TrackBufferAccount | null | undefined = undefined;
  profile: ProfileAccount | null | undefined = undefined;

  constructor(
    readonly ix: ChainInstruction,
    readonly ctx: ChainContext,
    readonly opts: ResolvedOptions,
  ) {}

  get now(): bigint {
    return this.ctx.now_s;
  }

  account(name: string): Pubkey {
    const k = (this.ix.accounts as Record<string, Pubkey | undefined>)[name];
    if (!k) throw new Error(`chain model: instruction ${this.ix.name} is missing account "${name}"`);
    return k;
  }

  optAccount(name: string): Pubkey | undefined {
    return (this.ix.accounts as Record<string, Pubkey | undefined>)[name];
  }

  get betKey(): Pubkey {
    return this.account('bet');
  }

  isSigner(k: Pubkey): boolean {
    return this.ix.signers.includes(k);
  }

  /** The named account must be present and have signed (`Unauthorized` otherwise). */
  signer(name: string): Pubkey {
    const k = this.optAccount(name);
    check(k !== undefined && this.isSigner(k), 'Unauthorized');
    return k;
  }

  emit<N extends VerdictEventName>(name: N, data: VerdictEventMap[N]): void {
    this.events.push({ name, data } as VerdictEvent);
  }

  transfer(from: Pubkey, to: Pubkey, amount: bigint): void {
    if (amount > 0n) this.transfers.push({ from, to, amount });
  }

  /** SPL token account `acct` must be owned by `owner` when owners are known. */
  checkTokenOwner(acct: Pubkey, owner: Pubkey): void {
    const owners = this.ctx.token_owners;
    if (!owners) return;
    check(owners[acct] === owner, 'BadTokenAccount');
  }

  /** The `oracle` account must be the Bet's oracle. */
  checkOracleAccount(bet: BetAccount): Pubkey {
    const k = this.optAccount('oracle');
    check(k === bet.oracle, 'Unauthorized');
    return k;
  }

  /** §9.4 payout accounts: one per participant, in order, each owned by that participant. */
  payoutAccounts(bet: BetAccount): Pubkey[] {
    const rem = this.ix.remaining_accounts ?? [];
    check(rem.length === bet.n_participants, 'BadTokenAccount');
    for (let i = 0; i < bet.n_participants; i++) this.checkTokenOwner(rem[i]!, bet.participants[i]!);
    return rem;
  }

  /** Closes the TrackBuffer if it exists and is non-empty, and the vault; rent → oracle. */
  closeAccounts(bet: BetAccount): void {
    const tb = this.ctx.track_buffer;
    const tbKey = this.optAccount('track_buffer');
    if (tb && tbKey && tb.header.payload_len > 0) {
      this.closed.push({ account: tbKey, rent_to: bet.oracle });
      this.trackBuffer = null;
    }
    this.closed.push({ account: this.account('vault'), rent_to: bet.oracle });
  }
}

/** Index of `k` among the Bet's participants, or -1. */
export function participantIndex(bet: BetAccount, k: Pubkey): number {
  for (let i = 0; i < bet.n_participants; i++) if (bet.participants[i] === k) return i;
  return -1;
}

export function pad8<T>(xs: readonly T[], fill: T): T[] {
  const out = xs.slice(0, MAX_PARTICIPANTS);
  while (out.length < 8) out.push(fill);
  return out;
}

export const isMarket = (bet: BetAccount): boolean => (bet.flags & 0x04) !== 0;
export const isAiJudged = (bet: BetAccount): boolean => (bet.flags & 0x02) !== 0;
export const allMask = (bet: BetAccount): number => (1 << bet.n_participants) - 1;
