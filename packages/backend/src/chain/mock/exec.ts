/**
 * Mock chain transaction execution: applies every instruction of a parsed,
 * signature-checked message to a forked ledger. Any failure aborts the whole
 * transaction (atomic, like Solana). Verdict instructions go through
 * `engine.chainModel` (§13 "In-memory chain implementing §9").
 */
import {
  betPda,
  chainModel as defaultChainModel,
  parseEd25519PanelIxData,
  profilePda,
  trackBufferPda,
  vaultPda,
  verifyPanelSignatures,
  type ChainContext,
  type ChainModel,
  type EncodedGroth16Proof,
  type SlotHashEntry,
  type VerdictEvent,
} from '@verdict/engine';
import {
  associatedTokenAddress,
  ATA_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  decodeTokenIx,
  ED25519_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../programs.js';
import type { ParsedInstruction, ParsedMessage } from '../message.js';
import type { LedgerState } from './state.js';

export class TxError extends Error {
  constructor(
    readonly error: string,
    readonly instructionIndex: number | null = null,
  ) {
    super(instructionIndex === null ? error : `instruction ${instructionIndex}: ${error}`);
    this.name = 'TxError';
  }
}

export interface ExecEnv {
  programId: string;
  /** mock USDC mint and its mint authority (the fee payer) */
  mint: string;
  mintAuthority: string;
  nowS: bigint;
  slot: bigint;
  slotHashes: SlotHashEntry[];
  chainModel?: ChainModel;
  verifyGroth16?: (publicInputs: Uint8Array[], proof: EncodedGroth16Proof) => boolean;
}

/** Executes `msg` against `state` (mutated; pass a fork). Returns the emitted events in order. */
export function executeMessage(state: LedgerState, msg: ParsedMessage, env: ExecEnv): VerdictEvent[] {
  const events: VerdictEvent[] = [];
  const model = env.chainModel ?? defaultChainModel;
  let prev: ParsedInstruction | null = null;
  msg.instructions.forEach((ix, i) => {
    try {
      if (ix.programId === COMPUTE_BUDGET_PROGRAM_ID) {
        // compute limits are not modelled
      } else if (ix.programId === ED25519_PROGRAM_ID) {
        execEd25519(ix);
      } else if (ix.programId === ATA_PROGRAM_ID) {
        execAta(state, ix, env);
      } else if (ix.programId === TOKEN_PROGRAM_ID) {
        execToken(state, ix, env);
      } else if (ix.programId === env.programId) {
        events.push(...execVerdict(state, ix, prev, msg, env, model));
      } else {
        throw new TxError(`UnsupportedProgram ${ix.programId}`);
      }
    } catch (e) {
      if (e instanceof TxError) throw new TxError(e.error, i);
      throw e;
    }
    prev = ix;
  });
  return events;
}

function execEd25519(ix: ParsedInstruction): void {
  const parsed = parseEd25519PanelIxData(ix.data);
  if (!parsed || !verifyPanelSignatures(parsed)) throw new TxError('Ed25519SignatureVerificationFailed');
}

function execAta(state: LedgerState, ix: ParsedInstruction, env: ExecEnv): void {
  // CreateIdempotent (1) or Create (0 / empty data)
  const mode = ix.data.length === 0 ? 0 : ix.data[0]!;
  if (mode !== 0 && mode !== 1) throw new TxError('InvalidInstructionData');
  if (ix.keys.length < 6) throw new TxError('NotEnoughAccountKeys');
  const [payer, ata, owner, mint] = ix.keys;
  if (!payer!.isSigner) throw new TxError('MissingRequiredSignature');
  if (mint!.pubkey !== env.mint) throw new TxError('InvalidMint');
  if (associatedTokenAddress(owner!.pubkey, mint!.pubkey) !== ata!.pubkey) throw new TxError('InvalidSeeds');
  const existing = state.tokens.get(ata!.pubkey);
  if (existing) {
    if (mode === 0) throw new TxError('AccountAlreadyInUse');
    if (existing.owner !== owner!.pubkey) throw new TxError('IllegalOwner');
    return;
  }
  state.tokens.set(ata!.pubkey, { mint: mint!.pubkey, owner: owner!.pubkey, amount: 0n });
}

function execToken(state: LedgerState, ix: ParsedInstruction, env: ExecEnv): void {
  const d = decodeTokenIx(ix.data);
  if (!d) throw new TxError('InvalidInstructionData');
  if (d.kind === 'mint_to') {
    const [mint, dest, auth] = ix.keys;
    if (!mint || !dest || !auth) throw new TxError('NotEnoughAccountKeys');
    if (mint.pubkey !== env.mint) throw new TxError('InvalidMint');
    if (auth.pubkey !== env.mintAuthority || !auth.isSigner) throw new TxError('OwnerMismatch');
    const to = state.tokens.get(dest.pubkey);
    if (!to) throw new TxError('UninitializedAccount');
    to.amount += d.amount;
    return;
  }
  const checked = d.kind === 'transfer_checked';
  const src = ix.keys[0];
  const dst = ix.keys[checked ? 2 : 1];
  const owner = ix.keys[checked ? 3 : 2];
  if (!src || !dst || !owner) throw new TxError('NotEnoughAccountKeys');
  if (checked && (ix.keys[1]!.pubkey !== env.mint || d.decimals !== 6)) throw new TxError('MintDecimalsMismatch');
  transfer(state, src.pubkey, dst.pubkey, d.amount, owner.isSigner ? owner.pubkey : null);
}

function transfer(state: LedgerState, from: string, to: string, amount: bigint, authority: string | null): void {
  const a = state.tokens.get(from);
  const b = state.tokens.get(to);
  if (!a || !b) throw new TxError('UninitializedAccount');
  if (authority !== null && a.owner !== authority) throw new TxError('OwnerMismatch');
  if (a.mint !== b.mint) throw new TxError('MintMismatch');
  if (a.amount < amount) throw new TxError('InsufficientFunds');
  a.amount -= amount;
  b.amount += amount;
}

function execVerdict(
  state: LedgerState,
  ix: ParsedInstruction,
  prev: ParsedInstruction | null,
  msg: ParsedMessage,
  env: ExecEnv,
  model: ChainModel,
): VerdictEvent[] {
  if (!ix.verdict) throw new TxError(`InstructionDidNotDeserialize: ${ix.decodeError ?? 'unknown'}`);
  const { decoded, accounts, remaining } = ix.verdict;
  const signers = ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey);
  for (const s of signers) if (!msg.signers.includes(s)) throw new TxError('MissingRequiredSignature');

  const tokenOwners: Record<string, string> = {};
  for (const [k, t] of state.tokens) tokenOwners[k] = t.owner;

  const ctx: ChainContext = {
    now_s: env.nowS,
    slot: env.slot,
    slot_hashes: env.slotHashes,
    program_id: env.programId,
    prev_instruction: prev ? { program_id: prev.programId, data: prev.data } : null,
    token_owners: tokenOwners,
  };
  if (env.verifyGroth16) ctx.verifyGroth16 = env.verifyGroth16;

  // ---- profile-only instruction -------------------------------------------
  if (decoded.name === 'init_profile') {
    const wallet = accounts['wallet']!;
    const pda = profilePda(wallet, env.programId).address;
    if (accounts['profile'] !== pda) throw new TxError('ConstraintSeeds');
    ctx.profile = state.profiles.get(pda) ?? null;
    const r = model.apply(model.initialBet({ bump: 0, vault_bump: 0 }), chainIx(decoded, signers, accounts, remaining), ctx);
    if ('error' in r) throw new TxError(r.error);
    if (r.profile) {
      const bump = profilePda(wallet, env.programId).bump;
      state.profiles.set(pda, { ...r.profile, bump: ctx.profile?.bump ?? bump });
    }
    return r.events;
  }

  // ---- bet instructions -----------------------------------------------------
  const betKey = accounts['bet'];
  if (!betKey) throw new TxError('NotEnoughAccountKeys');
  let bet = state.bets.get(betKey);
  if (decoded.name === 'create_bet') {
    if (bet) throw new TxError('AccountAlreadyInUse');
    const creator = accounts['creator']!;
    const pda = betPda(creator, decoded.args.nonce, env.programId);
    if (pda.address !== betKey) throw new TxError('ConstraintSeeds');
    const vault = vaultPda(betKey, env.programId);
    if (accounts['vault'] !== vault.address) throw new TxError('ConstraintSeeds');
    if (state.tokens.has(vault.address)) throw new TxError('AccountAlreadyInUse');
    if (accounts['mint'] !== env.mint) throw new TxError('InvalidMint');
    bet = model.initialBet({ bump: pda.bump, vault_bump: vault.bump });
  } else if (!bet) {
    throw new TxError('AccountNotInitialized');
  }
  const vaultKey = vaultPda(betKey, env.programId).address;
  if (accounts['vault'] !== undefined && accounts['vault'] !== vaultKey) throw new TxError('ConstraintSeeds');
  const tbKey = trackBufferPda(betKey, env.programId);
  if (accounts['track_buffer'] !== undefined && accounts['track_buffer'] !== tbKey.address) {
    throw new TxError('ConstraintSeeds');
  }
  ctx.track_buffer = state.trackBuffers.get(tbKey.address) ?? null;
  if (decoded.name === 'verify_biometric_proof') {
    ctx.profile = state.profiles.get(accounts['profile']!) ?? null;
    if (!ctx.profile) throw new TxError('AccountNotInitialized');
  }
  const vaultAcct = state.tokens.get(vaultKey);
  if (vaultAcct) ctx.vault_amount = vaultAcct.amount;

  const r = model.apply(bet, chainIx(decoded, signers, accounts, remaining), ctx);
  if ('error' in r) throw new TxError(r.error);

  if (decoded.name === 'create_bet') {
    state.tokens.set(vaultKey, { mint: env.mint, owner: betKey, amount: 0n });
  }
  for (const t of r.transfers) transfer(state, t.from, t.to, t.amount, null);
  if (r.track_buffer !== undefined) {
    if (r.track_buffer === null) state.trackBuffers.delete(tbKey.address);
    else state.trackBuffers.set(tbKey.address, { ...r.track_buffer, header: { ...r.track_buffer.header, bump: tbKey.bump } });
  }
  for (const c of r.closed ?? []) {
    if (c.account === vaultKey) {
      const v = state.tokens.get(vaultKey);
      if (v && v.amount !== 0n) throw new TxError('NonNativeHasBalance');
      state.tokens.delete(vaultKey);
    } else if (c.account === tbKey.address) {
      state.trackBuffers.delete(tbKey.address);
    }
  }
  state.bets.set(betKey, r.bet);
  return r.events;
}

function chainIx(
  decoded: NonNullable<ParsedInstruction['verdict']>['decoded'],
  signers: string[],
  accounts: Record<string, string>,
  remaining: string[],
) {
  return {
    name: decoded.name,
    args: decoded.args,
    signers,
    accounts,
    remaining_accounts: remaining,
  } as Parameters<ChainModel['apply']>[1];
}
