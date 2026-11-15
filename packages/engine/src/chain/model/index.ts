/**
 * Pure TS model of the Verdict onchain program (§9.4): applies one
 * instruction to a Bet and returns the new Bet, events and token transfers,
 * or the §9.6 error. Instructions are atomic: on error nothing changes.
 */
import type {
  BetAccount,
  ChainApplyResult,
  ChainContext,
  ChainInstruction,
  ChainModel,
  InitialBetArgs,
  InstructionArgsMap,
} from '../../types.js';
import { cloneBet, zeroBet } from '../accounts.js';
import { defaultChainHooks } from '../hooks.js';
import { ChainError, type ChainModelOptions, ED25519_ID, Env, type ResolvedOptions } from './env.js';
import { commitEvidence, end, start } from './live.js';
import { consent, dispute, refund, settlePanel } from './resolve.js';
import { cancel, createBet, fund, initProfile } from './setup.js';
import { postTracks, runRules, verifyBiometricProof, verifySp1Run } from './tracks.js';

export type { ChainModelOptions } from './env.js';
export { ChainError } from './env.js';

function dispatch(bet: BetAccount, env: Env): void {
  const ix = env.ix;
  const args = ix.args as InstructionArgsMap[typeof ix.name];
  switch (ix.name) {
    case 'init_profile':
      return initProfile(bet, env, args as InstructionArgsMap['init_profile']);
    case 'create_bet':
      return createBet(bet, env, args as InstructionArgsMap['create_bet']);
    case 'fund':
      return fund(bet, env, args as InstructionArgsMap['fund']);
    case 'cancel':
      return cancel(bet, env);
    case 'start':
      return start(bet, env, args as InstructionArgsMap['start']);
    case 'commit_evidence':
      return commitEvidence(bet, env, args as InstructionArgsMap['commit_evidence']);
    case 'end':
      return end(bet, env, args as InstructionArgsMap['end']);
    case 'post_tracks':
      return postTracks(bet, env, args as InstructionArgsMap['post_tracks']);
    case 'run_rules':
      return runRules(bet, env);
    case 'consent':
      return consent(bet, env, args as InstructionArgsMap['consent']);
    case 'dispute':
      return dispute(bet, env, args as InstructionArgsMap['dispute']);
    case 'settle_panel':
      return settlePanel(bet, env, args as InstructionArgsMap['settle_panel']);
    case 'verify_biometric_proof':
      return verifyBiometricProof(bet, env, args as InstructionArgsMap['verify_biometric_proof']);
    case 'verify_sp1_run':
      return verifySp1Run(bet, env, args as InstructionArgsMap['verify_sp1_run']);
    case 'refund':
      return refund(bet, env);
    default:
      throw new Error(`chain model: unknown instruction ${String((ix as { name: unknown }).name)}`);
  }
}

/** Creates a chain model with injectable decoders / interpreter and features. */
export function createChainModel(options: ChainModelOptions = {}): ChainModel {
  const opts: ResolvedOptions = {
    hooks: { ...defaultChainHooks, ...options.hooks },
    sp1: options.sp1 ?? false,
    verifySp1: options.verifySp1,
    verifyEd25519Signatures: options.verifyEd25519Signatures ?? true,
    ed25519ProgramId: ED25519_ID,
  };
  return {
    initialBet(args: InitialBetArgs): BetAccount {
      return zeroBet(args.bump, args.vault_bump);
    },
    apply(bet: BetAccount, ix: ChainInstruction, ctx: ChainContext): ChainApplyResult {
      const next = cloneBet(bet);
      const env = new Env(ix, ctx, opts);
      try {
        dispatch(next, env);
      } catch (e) {
        if (e instanceof ChainError) return { error: e.code };
        throw e;
      }
      const out: ChainApplyResult = { bet: next, events: env.events, transfers: env.transfers };
      if (env.trackBuffer !== undefined) out.track_buffer = env.trackBuffer;
      if (env.profile !== undefined) out.profile = env.profile;
      if (env.closed.length > 0) out.closed = env.closed;
      return out;
    },
  };
}

/** Default chain model (§14): engine decoders/interpreter, `sp1` off. */
export const chainModel: ChainModel = createChainModel();
