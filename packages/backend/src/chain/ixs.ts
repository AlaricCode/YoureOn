/**
 * Typed builders for every §9.4 instruction with PDAs and fixed accounts
 * resolved, so service code only supplies the actors and args. Account names
 * follow the IDL (normative order is applied by message.ts).
 */
import {
  betPda,
  INSTRUCTIONS_SYSVAR_ID,
  profilePda,
  SLOT_HASHES_SYSVAR_ID,
  trackBufferPda,
  vaultPda,
  type InstructionArgsMap,
  type Pubkey,
} from '@verdict/engine';
import { verdictIx } from './message.js';
import { associatedTokenAddress, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from './programs.js';
import type { VerdictIx } from './types.js';

export interface IxEnv {
  programId: Pubkey;
  mint: Pubkey;
  feePayer: Pubkey;
  oracle: Pubkey;
}

export function betAddresses(env: IxEnv, bet: Pubkey) {
  return {
    bet,
    vault: vaultPda(bet, env.programId).address,
    trackBuffer: trackBufferPda(bet, env.programId).address,
  };
}

/** Bet PDA for (creator, nonce). */
export function betAddress(env: IxEnv, creator: Pubkey, nonce: bigint): Pubkey {
  return betPda(creator, nonce, env.programId).address;
}

/** Payout accounts (§9.4): participants' ATAs in participant order. */
export function payoutAccounts(env: IxEnv, participants: Pubkey[]): Pubkey[] {
  return participants.map((p) => associatedTokenAddress(p, env.mint));
}

export function initProfileIx(env: IxEnv, wallet: Pubkey, args: InstructionArgsMap['init_profile']): VerdictIx<'init_profile'> {
  return verdictIx('init_profile', args, {
    payer: env.feePayer,
    wallet,
    profile: profilePda(wallet, env.programId).address,
    system_program: SYSTEM_PROGRAM_ID,
  });
}

export function createBetIx(env: IxEnv, creator: Pubkey, args: InstructionArgsMap['create_bet']): VerdictIx<'create_bet'> {
  const bet = betAddress(env, creator, args.nonce);
  return verdictIx('create_bet', args, {
    payer: env.feePayer,
    creator,
    oracle: env.oracle,
    bet,
    vault: vaultPda(bet, env.programId).address,
    mint: env.mint,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SYSTEM_PROGRAM_ID,
  });
}

export function fundIx(env: IxEnv, bet: Pubkey, participant: Pubkey, args: InstructionArgsMap['fund']): VerdictIx<'fund'> {
  return verdictIx('fund', args, {
    participant,
    bet,
    vault: vaultPda(bet, env.programId).address,
    participant_token: associatedTokenAddress(participant, env.mint),
    token_program: TOKEN_PROGRAM_ID,
  });
}

export function cancelIx(env: IxEnv, bet: Pubkey, creator: Pubkey, participants: Pubkey[]): VerdictIx<'cancel'> {
  const a = betAddresses(env, bet);
  return verdictIx(
    'cancel',
    {},
    { creator, bet, vault: a.vault, oracle: env.oracle, track_buffer: a.trackBuffer, token_program: TOKEN_PROGRAM_ID },
    payoutAccounts(env, participants),
  );
}

export function startIx(env: IxEnv, bet: Pubkey, authority: Pubkey, args: InstructionArgsMap['start']): VerdictIx<'start'> {
  return verdictIx('start', args, { authority, bet, slot_hashes: SLOT_HASHES_SYSVAR_ID });
}

export function commitEvidenceIx(env: IxEnv, bet: Pubkey, args: InstructionArgsMap['commit_evidence']): VerdictIx<'commit_evidence'> {
  return verdictIx('commit_evidence', args, { oracle: env.oracle, bet });
}

export function endIx(_env: IxEnv, bet: Pubkey, authority: Pubkey, args: InstructionArgsMap['end']): VerdictIx<'end'> {
  return verdictIx('end', args, { authority, bet });
}

export function postTracksIx(env: IxEnv, bet: Pubkey, args: InstructionArgsMap['post_tracks']): VerdictIx<'post_tracks'> {
  return verdictIx('post_tracks', args, {
    payer: env.feePayer,
    oracle: env.oracle,
    bet,
    track_buffer: trackBufferPda(bet, env.programId).address,
    system_program: SYSTEM_PROGRAM_ID,
  });
}

export function runRulesIx(env: IxEnv, bet: Pubkey): VerdictIx<'run_rules'> {
  return verdictIx('run_rules', {}, { oracle: env.oracle, bet, track_buffer: trackBufferPda(bet, env.programId).address });
}

export function consentIx(
  env: IxEnv,
  bet: Pubkey,
  authority: Pubkey,
  participants: Pubkey[],
  args: InstructionArgsMap['consent'],
): VerdictIx<'consent'> {
  const a = betAddresses(env, bet);
  return verdictIx(
    'consent',
    args,
    { authority, bet, vault: a.vault, oracle: env.oracle, track_buffer: a.trackBuffer, token_program: TOKEN_PROGRAM_ID },
    payoutAccounts(env, participants),
  );
}

export function disputeIx(env: IxEnv, bet: Pubkey, disputer: Pubkey, args: InstructionArgsMap['dispute']): VerdictIx<'dispute'> {
  return verdictIx('dispute', args, {
    disputer,
    bet,
    vault: vaultPda(bet, env.programId).address,
    disputer_token: associatedTokenAddress(disputer, env.mint),
    token_program: TOKEN_PROGRAM_ID,
  });
}

/** settle_panel; the caller must put the §9.7 Ed25519 instruction immediately before it. */
export function settlePanelIx(
  env: IxEnv,
  bet: Pubkey,
  participants: Pubkey[],
  args: InstructionArgsMap['settle_panel'],
): VerdictIx<'settle_panel'> {
  const a = betAddresses(env, bet);
  return verdictIx(
    'settle_panel',
    args,
    {
      bet,
      vault: a.vault,
      oracle: env.oracle,
      track_buffer: a.trackBuffer,
      token_program: TOKEN_PROGRAM_ID,
      instructions: INSTRUCTIONS_SYSVAR_ID,
    },
    payoutAccounts(env, participants),
  );
}

export function verifyBiometricProofIx(
  env: IxEnv,
  bet: Pubkey,
  wallet: Pubkey,
  args: InstructionArgsMap['verify_biometric_proof'],
): VerdictIx<'verify_biometric_proof'> {
  return verdictIx('verify_biometric_proof', args, {
    oracle: env.oracle,
    bet,
    profile: profilePda(wallet, env.programId).address,
  });
}

export function verifySp1RunIx(env: IxEnv, bet: Pubkey, args: InstructionArgsMap['verify_sp1_run']): VerdictIx<'verify_sp1_run'> {
  return verdictIx('verify_sp1_run', args, { oracle: env.oracle, bet });
}

export function refundIx(env: IxEnv, bet: Pubkey, participants: Pubkey[]): VerdictIx<'refund'> {
  const a = betAddresses(env, bet);
  return verdictIx(
    'refund',
    {},
    { bet, vault: a.vault, oracle: env.oracle, track_buffer: a.trackBuffer, token_program: TOKEN_PROGRAM_ID },
    payoutAccounts(env, participants),
  );
}
