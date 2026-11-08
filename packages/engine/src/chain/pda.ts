/**
 * §9.1 PDA derivation (Solana `find_program_address`).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { SEED_BET, SEED_PROFILE, SEED_TRACKS, SEED_VAULT } from '../constants.js';
import type { Pubkey } from '../types.js';
import { ascii, BorshWriter, pubkeyBytes, pubkeyString, sha256 } from './bytes.js';

function isOnCurve(b: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(b);
    return true;
  } catch {
    return false;
  }
}

/** `create_program_address`: null if the hash lands on the curve. */
export function createProgramAddress(seeds: Uint8Array[], programId: Pubkey): Pubkey | null {
  if (seeds.length > 16 || seeds.some((s) => s.length > 32)) throw new Error('invalid PDA seeds');
  const h = sha256(...seeds, pubkeyBytes(programId), ascii('ProgramDerivedAddress'));
  return isOnCurve(h) ? null : pubkeyString(h);
}

/** `find_program_address`: highest bump (255 → 0) giving an off-curve address. */
export function findProgramAddress(seeds: Uint8Array[], programId: Pubkey): { address: Pubkey; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const a = createProgramAddress([...seeds, new Uint8Array([bump])], programId);
    if (a) return { address: a, bump };
  }
  throw new Error('no viable PDA bump');
}

export const profilePda = (wallet: Pubkey, programId: Pubkey) =>
  findProgramAddress([ascii(SEED_PROFILE), pubkeyBytes(wallet)], programId);

export const betPda = (creator: Pubkey, nonce: bigint, programId: Pubkey) =>
  findProgramAddress([ascii(SEED_BET), pubkeyBytes(creator), new BorshWriter(8).u64(nonce).toBytes()], programId);

export const vaultPda = (bet: Pubkey, programId: Pubkey) =>
  findProgramAddress([ascii(SEED_VAULT), pubkeyBytes(bet)], programId);

export const trackBufferPda = (bet: Pubkey, programId: Pubkey) =>
  findProgramAddress([ascii(SEED_TRACKS), pubkeyBytes(bet)], programId);
