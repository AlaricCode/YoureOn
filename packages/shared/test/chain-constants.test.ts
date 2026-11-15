// Cross-stream contract: the signing-policy pins in packages/shared agree with programs/escrow
// (declare_id!, Anchor.toml, the generated IDL and the Rust seed constants).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { address, createAddressWithSeed, getProgramDerivedAddress, isAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import {
  BET_SEED,
  CONFIG_SEED,
  ESCROW_ID,
  EVENT_AUTHORITY_SEED,
  NONCE_SEED_PREFIX,
  nonceSeed,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT_DEVNET,
  VAULT_SEED,
} from '../src/chain/constants';
import { NONCE_POOL_SIZE, NONCE_SEED_MAX } from '../src/constants';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(repo(p), 'utf8');

const LIB_RS = read('programs/escrow/programs/escrow/src/lib.rs');
const CONSTANTS_RS = read('programs/escrow/programs/escrow/src/constants.rs');
const ANCHOR_TOML = read('programs/escrow/Anchor.toml');
const IDL = JSON.parse(read('packages/shared/idl/escrow.json')) as {
  address: string;
  constants?: { name: string; type: unknown; value: string }[];
};

function rustSeed(name: string): string {
  const m = CONSTANTS_RS.match(new RegExp(`pub const ${name}: &\\[u8\\] = b"([^"]*)";`));
  if (!m?.[1]) throw new Error(`${name} not found in constants.rs`);
  return m[1];
}

describe('ESCROW_ID matches programs/escrow', () => {
  it('equals declare_id!, both Anchor.toml clusters and the IDL address', () => {
    expect(isAddress(ESCROW_ID)).toBe(true);
    expect(LIB_RS).toContain(`declare_id!("${ESCROW_ID}");`);
    const toml = [...ANCHOR_TOML.matchAll(/^escrow = "([^"]+)"$/gm)].map((m) => m[1]);
    expect(toml.length).toBeGreaterThanOrEqual(2);
    expect(new Set(toml)).toEqual(new Set([ESCROW_ID]));
    expect(IDL.address).toBe(ESCROW_ID);
  });
});

describe('PDA seeds match the Rust constants (ESCROW §2)', () => {
  it('config / bet / vault', () => {
    expect(rustSeed('CONFIG_SEED')).toBe(CONFIG_SEED);
    expect(rustSeed('BET_SEED')).toBe(BET_SEED);
    expect(rustSeed('VAULT_SEED')).toBe(VAULT_SEED);
  });
  it('the IDL exports the same seed constants', () => {
    // Anchor IDL renders a #[constant] &[u8] as "[b1, b2, ...]".
    const bytes = (s: string) => `[${Array.from(new TextEncoder().encode(s)).join(', ')}]`;
    const idlConst = (n: string) => IDL.constants?.find((c) => c.name === n)?.value;
    expect(idlConst('CONFIG_SEED')).toBe(bytes(CONFIG_SEED));
    expect(idlConst('BET_SEED')).toBe(bytes(BET_SEED));
    expect(idlConst('VAULT_SEED')).toBe(bytes(VAULT_SEED));
  });
  it('the PDAs derive under ESCROW_ID with @solana/kit', async () => {
    const program = address(ESCROW_ID);
    for (const seed of [CONFIG_SEED, EVENT_AUTHORITY_SEED]) {
      const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: [seed] });
      expect(isAddress(pda)).toBe(true);
    }
  });
});

describe('nonce pool seeds (ESCROW §5.0.1, DATA-MODEL §5.20)', () => {
  it('yo-nonce-<k> for k < NONCE_SEED_MAX, with the pool inside the range', () => {
    expect(NONCE_SEED_PREFIX).toBe('yo-nonce-');
    expect(NONCE_POOL_SIZE).toBeLessThanOrEqual(NONCE_SEED_MAX);
    expect(nonceSeed(0)).toBe('yo-nonce-0');
    expect(nonceSeed(15)).toBe('yo-nonce-15');
    expect(() => nonceSeed(16)).toThrow(RangeError);
    expect(() => nonceSeed(-1)).toThrow(RangeError);
    expect(() => nonceSeed(1.5)).toThrow(RangeError);
  });
  it('every seed fits createWithSeed (≤ 32 bytes) and derives an address', async () => {
    const base = address(SYSTEM_PROGRAM_ID); // stand-in base: the real fee payer is PENDING
    for (let k = 0; k < NONCE_SEED_MAX; k++) {
      const a = await createAddressWithSeed({
        baseAddress: base,
        programAddress: address(SYSTEM_PROGRAM_ID),
        seed: nonceSeed(k),
      });
      expect(isAddress(a)).toBe(true);
    }
  });
});

describe('mint pins', () => {
  it('devnet USDC and the token program are valid addresses', () => {
    expect(isAddress(USDC_MINT_DEVNET)).toBe(true);
    expect(isAddress(TOKEN_PROGRAM_ID)).toBe(true);
  });
});
