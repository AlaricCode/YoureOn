// Program-derived addresses computed with noble + @noble/hashes only. Kit's getProgramDerivedAddress
// throws SUBTLE_CRYPTO__DIGEST_UNIMPLEMENTED on Hermes, so the phone re-derives the
// Bet / vault / Config PDAs for the device signing policy with this helper (ESCROW §5.0.2). Tests
// cross-check it against @solana/kit in Node.
//
// Seeds match ESCROW §2 exactly: Config ["config"], Bet ["bet", bet_id(16)], vault ["vault", bet_id(16)],
// with bet_id = the UUID's 16 bytes in RFC 4122 order.
import {
  BET_SEED,
  CONFIG_SEED,
  EVENT_AUTHORITY_SEED,
  VAULT_SEED,
} from '@youre-on/shared/chain/constants';

import { addressToBytes, base58Encode, bytesEqual, concatBytes, utf8, uuidToBytes } from './bytes';
import { ed, prewarmSigner, sha256 } from './noble';

// The seeds are the shared signing-policy pins, which packages/shared tests against programs/escrow.
export { BET_SEED, CONFIG_SEED, EVENT_AUTHORITY_SEED, VAULT_SEED };

/** Solana runtime limits (solana-pubkey MAX_SEEDS / MAX_SEED_LEN). MAX_SEEDS counts the bump. */
export const MAX_SEEDS = 16;
export const MAX_SEED_LEN = 32;
const PDA_MARKER = utf8('ProgramDerivedAddress');

export type Seed = Uint8Array | string;

export type Pda = {
  /** base58 address */
  readonly address: string;
  readonly bytes: Uint8Array;
  readonly bump: number;
};

export type BetPdas = {
  readonly betId: string;
  readonly betIdBytes: Uint8Array;
  readonly bet: Pda;
  readonly vault: Pda;
  readonly config: Pda;
};

function seedBytes(seed: Seed): Uint8Array {
  const bytes = typeof seed === 'string' ? utf8(seed) : seed;
  if (bytes.length > MAX_SEED_LEN) throw new Error(`pda: seed longer than ${MAX_SEED_LEN} bytes`);
  return bytes;
}

/**
 * True if 32 bytes decode to a point on the Ed25519 curve. Uses ZIP-215 decoding (any y < 2^255,
 * x = 0 with the sign bit set allowed), which is how curve25519-dalek's `decompress` behaves in the
 * Solana runtime. A PDA must be off the curve.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

/** Solana `create_program_address`: sha256(seeds || programId || "ProgramDerivedAddress"), off-curve only. */
export function createProgramAddress(
  seeds: readonly Seed[],
  programAddress: string,
): Uint8Array | null {
  if (seeds.length > MAX_SEEDS) throw new Error(`pda: more than ${MAX_SEEDS} seeds`);
  const program = addressToBytes(programAddress);
  const hash = sha256(concatBytes(...seeds.map(seedBytes), program, PDA_MARKER));
  return isOnCurve(hash) ? null : hash;
}

/** Solana `find_program_address`: the first off-curve address for bump 255 down to 0. */
export function findProgramAddress(seeds: readonly Seed[], programAddress: string): Pda {
  if (seeds.length > MAX_SEEDS - 1)
    throw new Error(`pda: more than ${MAX_SEEDS - 1} seeds plus the bump`);
  const fixed = seeds.map(seedBytes);
  for (let bump = 255; bump >= 0; bump--) {
    const bytes = createProgramAddress([...fixed, Uint8Array.of(bump)], programAddress);
    if (bytes) return { address: base58Encode(bytes), bytes, bump };
  }
  throw new Error('pda: no viable bump seed');
}

/**
 * System `create_with_seed`: sha256(base || seed || owner). The device policy uses it to check that a
 * lock's nonce account is in the server pool, createWithSeed(pinned fee payer, "yo-nonce-<k>", System)
 * (ESCROW §5.0.1-§5.0.2). Rejects an owner that ends with the PDA marker, as the runtime does.
 */
export function createAddressWithSeed(
  baseAddress: string,
  seed: string,
  ownerAddress: string,
): string {
  const owner = addressToBytes(ownerAddress);
  if (bytesEqual(owner.subarray(owner.length - PDA_MARKER.length), PDA_MARKER)) {
    throw new Error('createWithSeed: illegal owner');
  }
  const hash = sha256(concatBytes(addressToBytes(baseAddress), seedBytes(seed), owner));
  return base58Encode(hash);
}

export function deriveConfigPda(programAddress: string): Pda {
  return findProgramAddress([CONFIG_SEED], programAddress);
}

export function deriveEventAuthorityPda(programAddress: string): Pda {
  return findProgramAddress([EVENT_AUTHORITY_SEED], programAddress);
}

export function deriveBetPdas(programAddress: string, betId: string): BetPdas {
  const betIdBytes = uuidToBytes(betId);
  return {
    betId: betId.toLowerCase(),
    betIdBytes,
    bet: findProgramAddress([BET_SEED, betIdBytes], programAddress),
    vault: findProgramAddress([VAULT_SEED, betIdBytes], programAddress),
    config: deriveConfigPda(programAddress),
  };
}

export type PdaHelper = {
  readonly programAddress: string;
  config(): Pda;
  /** Bet + vault + Config for a bet_id, cached after the first call. */
  forBet(betId: string): BetPdas;
  /**
   * Call when the terms card mounts (ESCROW §5.0.2, TASKS D0-M3): derives and caches the bet's PDAs
   * and warms noble's signing tables, so the device policy and the post-Face-ID signature are warm.
   * Synchronous (~7 ms per bet+vault pair warm on Hermes, more cold); schedule it off the first frame.
   */
  prewarm(betId?: string): void;
};

const CACHE_LIMIT = 32;

export function createPdaHelper(programAddress: string): PdaHelper {
  addressToBytes(programAddress); // fail fast on a bad program ID
  let config: Pda | undefined;
  const cache = new Map<string, BetPdas>();

  const getConfig = (): Pda => (config ??= deriveConfigPda(programAddress));

  const forBet = (betId: string): BetPdas => {
    const key = betId.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const betIdBytes = uuidToBytes(key);
    const pdas: BetPdas = {
      betId: key,
      betIdBytes,
      bet: findProgramAddress([BET_SEED, betIdBytes], programAddress),
      vault: findProgramAddress([VAULT_SEED, betIdBytes], programAddress),
      config: getConfig(),
    };
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, pdas);
    return pdas;
  };

  return {
    programAddress,
    config: getConfig,
    forBet,
    prewarm(betId?: string) {
      prewarmSigner();
      getConfig();
      if (betId !== undefined) forBet(betId);
    },
  };
}
