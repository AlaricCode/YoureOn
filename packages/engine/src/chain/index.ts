/**
 * Chain model (§9): Borsh accounts/instructions/events, chainModel, panel
 * Ed25519 data, PDAs, settlement math.
 */
export {
  encodeBetAccount,
  decodeBetAccount,
  encodeBetBody,
  encodeProfile,
  decodeProfile,
  encodeTrackBufferHeader,
  decodeTrackBufferHeader,
  zeroBet,
  cloneBet,
  BET_DISCRIMINATOR,
  PROFILE_DISCRIMINATOR,
  TRACK_BUFFER_DISCRIMINATOR,
} from './accounts.js';
export { encodeInstruction, decodeInstruction, INSTRUCTION_DISCRIMINATORS } from './instructions.js';
export type { DecodedInstruction } from './instructions.js';
export {
  encodeEvent,
  decodeEvent,
  decodeEventTyped,
  eventToJson,
  eventLogLine,
  parseEventLogLine,
  EVENT_DISCRIMINATORS,
} from './events.js';
export {
  ed25519PanelIxData,
  parseEd25519PanelIxData,
  verifyPanelSignatures,
  checkPanelInstruction,
} from './ed25519.js';
export type { ParsedPanelIx } from './ed25519.js';
export { createProgramAddress, findProgramAddress, profilePda, betPda, vaultPda, trackBufferPda } from './pda.js';
export { chainModel, createChainModel, ChainError } from './model/index.js';
export type { ChainModelOptions } from './model/index.js';
export type { ChainHooks } from './hooks.js';
export { defaultChainHooks } from './hooks.js';
export { findSlotHash } from './model/live.js';
export { payloadParts, publicInputs as biometricPublicInputsOnchain } from './model/tracks.js';
export { disputeBond, sideMask, refundCondition } from './model/resolve.js';
export { accountedAmount } from './model/payout.js';
// §9.8 settlement math lives in src/settle.ts; re-exported here so the engine entry point exposes it.
export { payouts } from '../settle.js';
export type { SettleBet } from '../settle.js';
