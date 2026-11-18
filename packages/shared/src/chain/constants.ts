// Signing-policy pins (TASKS §3.1 K-08, ESCROW §2 / §5.0.1-§5.0.2). Committed constants, never env
// vars: the phone's device policy checks every lock against these, and the server's PROGRAM_ID /
// USDC_MINT env must agree with them (apps/server env.ts). test/chain-constants.test.ts pins them
// to programs/escrow (declare_id!, Anchor.toml, the IDL address and the seed constants).
//
// Dependency-free on purpose (only ../constants): apps/mobile imports this file on Hermes.
import { NONCE_SEED_MAX } from '../constants';

/** Escrow program ID = `declare_id!` in programs/escrow (keypair: target/deploy/escrow-keypair.json). */
export const ESCROW_ID = 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp';

/** Circle devnet USDC: classic SPL Token, 6 decimals, freeze authority set (ESCROW §2, DATA-MODEL §3.1). */
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** Classic SPL Token program, the devnet USDC mint's owner. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** System program, the owner of every nonce-pool account. */
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/**
 * Server fee payer = durable-nonce authority (SETUP-CHECKLIST KP3), made by `npm run keys`
 * (2026-11-15). Phones re-derive the nonce pool from it, so rotating it needs a new app build.
 */
export const FEE_PAYER_PUBKEY: string | null = 'ADEMopwqe6cVs9cEyMSbK1pGsJgnyBc3zkC3Wsqf9pQ8';

/** PDA seeds (ESCROW §2), UTF-8. Bet and vault append the 16 RFC 4122 bytes of bet_id. */
export const CONFIG_SEED = 'config';
export const BET_SEED = 'bet';
export const VAULT_SEED = 'vault';
/** Anchor event-cpi authority PDA `["__event_authority"]` under ESCROW_ID. */
export const EVENT_AUTHORITY_SEED = '__event_authority';

/** Nonce-pool seed prefix: address k = createWithSeed(fee payer, `yo-nonce-${k}`, System) (ESCROW §5.0.1). */
export const NONCE_SEED_PREFIX = 'yo-nonce-';

/** The seed string for nonce-pool index k, 0 <= k < NONCE_SEED_MAX (DATA-MODEL §5.20 CHECK 0..15). */
export function nonceSeed(k: number): string {
  if (!Number.isInteger(k) || k < 0 || k >= NONCE_SEED_MAX) {
    throw new RangeError(`nonce seed index must be an integer in [0, ${NONCE_SEED_MAX})`);
  }
  return `${NONCE_SEED_PREFIX}${k}`;
}
