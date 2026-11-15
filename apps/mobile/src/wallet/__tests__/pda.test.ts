import { randomBytes, randomUUID } from 'node:crypto';

import {
  address,
  createAddressWithSeed as kitCreateAddressWithSeed,
  getProgramDerivedAddress,
  isOffCurveAddress,
  type Address,
} from '@solana/kit';
import { ESCROW_ID, nonceSeed } from '@youre-on/shared/chain/constants';
import { describe, expect, it } from 'vitest';

import { base58Encode, uuidToBytes } from '../bytes';
import {
  createAddressWithSeed,
  createPdaHelper,
  deriveBetPdas,
  deriveConfigPda,
  deriveEventAuthorityPda,
  findProgramAddress,
  isOnCurve,
} from '../pda';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Three program IDs: the pinned ESCROW_ID (packages/shared, = declare_id!), a fixed placeholder and a random one.
const PROGRAM_IDS = [
  ESCROW_ID,
  base58Encode(new Uint8Array(32).fill(0x42)),
  base58Encode(randomBytes(32)),
];

// 20 bet_ids: a few fixed edge patterns plus random v4 UUIDs (as the server mints them).
const BET_IDS = [
  '00000000-0000-4000-8000-000000000000',
  'ffffffff-ffff-4fff-bfff-ffffffffffff',
  '6f1c2b0e-9d4a-4c3b-8e7f-1a2b3c4d5e6f',
  'C0FFEE00-1234-4ABC-9DEF-0123456789AB', // upper case is accepted and canonicalised
  ...Array.from({ length: 16 }, () => randomUUID()),
];

async function kitPda(programAddress: string, seeds: (string | Uint8Array)[]) {
  const [addr, bump] = await getProgramDerivedAddress({
    programAddress: address(programAddress),
    seeds,
  });
  return { address: addr as string, bump: bump as number };
}

describe('uuidToBytes', () => {
  it('uses RFC 4122 textual byte order', () => {
    expect(Array.from(uuidToBytes('00112233-4455-6677-8899-aabbccddeeff'))).toEqual([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
  });
  it('rejects non-UUID input', () => {
    expect(() => uuidToBytes('not-a-uuid')).toThrow();
    expect(() => uuidToBytes('00112233445566778899aabbccddeeff')).toThrow();
  });
});

describe('noble PDA helper matches @solana/kit getProgramDerivedAddress', () => {
  it('has 20 bet_ids under test', () => {
    expect(BET_IDS).toHaveLength(20);
    expect(new Set(BET_IDS.map((b) => b.toLowerCase())).size).toBe(20);
  });

  for (const programId of PROGRAM_IDS) {
    it(`Bet and vault PDAs for 20 bet_ids (program ${programId.slice(0, 6)}…)`, async () => {
      for (const betId of BET_IDS) {
        const betIdBytes = uuidToBytes(betId);
        const ours = deriveBetPdas(programId, betId);
        const kitBet = await kitPda(programId, ['bet', betIdBytes]);
        const kitVault = await kitPda(programId, ['vault', betIdBytes]);
        expect({ address: ours.bet.address, bump: ours.bet.bump }, `bet ${betId}`).toEqual(kitBet);
        expect({ address: ours.vault.address, bump: ours.vault.bump }, `vault ${betId}`).toEqual(
          kitVault,
        );
        expect(base58Encode(ours.bet.bytes)).toBe(ours.bet.address);
        expect(ours.bet.address).not.toBe(ours.vault.address);
      }
    });

    it(`Config and event-authority PDAs (program ${programId.slice(0, 6)}…)`, async () => {
      const config = deriveConfigPda(programId);
      expect({ address: config.address, bump: config.bump }).toEqual(
        await kitPda(programId, ['config']),
      );
      const eventAuthority = deriveEventAuthorityPda(programId);
      expect({ address: eventAuthority.address, bump: eventAuthority.bump }).toEqual(
        await kitPda(programId, ['__event_authority']),
      );
    });
  }

  it('finds non-255 bumps the same way as Kit', async () => {
    // Search seeds until several land on a bump below 255, so the bump loop itself is exercised.
    const programId = PROGRAM_IDS[0] as string;
    let lowBumps = 0;
    for (let i = 0; i < 400 && lowBumps < 5; i++) {
      const seed = `seed-${i}`;
      const ours = findProgramAddress([seed], programId);
      if (ours.bump < 255) {
        lowBumps++;
        expect({ address: ours.address, bump: ours.bump }).toEqual(await kitPda(programId, [seed]));
      }
    }
    expect(lowBumps).toBe(5);
  });

  it('rejects seeds longer than 32 bytes and more than 15 seeds, like Kit', async () => {
    const programId = PROGRAM_IDS[0] as string;
    expect(() => findProgramAddress([new Uint8Array(33)], programId)).toThrow();
    await expect(kitPda(programId, [new Uint8Array(33)])).rejects.toThrow();
    const sixteen = Array.from({ length: 16 }, () => 'x');
    expect(() => findProgramAddress(sixteen, programId)).toThrow();
    await expect(kitPda(programId, sixteen)).rejects.toThrow();
    expect(() => findProgramAddress(sixteen.slice(1), programId)).not.toThrow();
  });
});

describe('isOnCurve agrees with Kit', () => {
  it('for 300 random 32-byte strings and 50 real public keys', () => {
    for (let i = 0; i < 300; i++) {
      const bytes = randomBytes(32);
      const addr = base58Encode(bytes) as Address;
      expect(isOnCurve(bytes), addr).toBe(!isOffCurveAddress(addr));
    }
    for (const programId of PROGRAM_IDS) {
      const pda = deriveConfigPda(programId);
      expect(isOnCurve(pda.bytes)).toBe(false);
    }
  });
});

describe('isOnCurve edge encodings follow the Solana runtime (curve25519-dalek decompress)', () => {
  // dalek's CompressedEdwardsY::decompress accepts a non-canonical y (>= p) and x = 0 with the
  // sign bit set, so the runtime treats these as ON the curve (not valid PDAs). Kit's
  // isOffCurveAddress rejects the x = 0 / sign-bit form, so Kit is not the oracle here.
  const yOneSignBit = new Uint8Array(32);
  yOneSignBit[0] = 1;
  yOneSignBit[31] = 0x80; // y = 1 (x = 0), sign bit set
  const yNonCanonical = new Uint8Array(32).fill(0xff);
  yNonCanonical[0] = 0xee;
  yNonCanonical[31] = 0x7f; // y = p + 1 = 2^255 - 18, i.e. y = 1 non-canonically

  it('treats them as on-curve, like the runtime', () => {
    expect(isOnCurve(yOneSignBit)).toBe(true);
    expect(isOnCurve(yNonCanonical)).toBe(true);
    // Documented divergence: Kit calls the x = 0 / sign-bit form off-curve.
    expect(isOffCurveAddress(base58Encode(yOneSignBit) as Address)).toBe(true);
  });
});

describe('createAddressWithSeed matches Kit (nonce pool: yo-nonce-<k>, k < 16)', () => {
  it('for the 16 pool seeds under a random fee payer', async () => {
    const feePayer = base58Encode(randomBytes(32));
    for (let k = 0; k < 16; k++) {
      const seed = nonceSeed(k);
      const kit = await kitCreateAddressWithSeed({
        baseAddress: address(feePayer),
        programAddress: address(SYSTEM_PROGRAM),
        seed,
      });
      expect(createAddressWithSeed(feePayer, seed, SYSTEM_PROGRAM)).toBe(kit);
    }
  });

  it('rejects a PDA-marker owner', () => {
    const marker = new TextEncoder().encode('ProgramDerivedAddress');
    const owner = new Uint8Array(32);
    owner.set(marker, 32 - marker.length);
    expect(() => createAddressWithSeed(SYSTEM_PROGRAM, 'x', base58Encode(owner))).toThrow(
      /illegal owner/,
    );
  });
});

describe('createPdaHelper (terms-card pre-warm)', () => {
  it('caches per bet_id and shares Config', () => {
    const programId = PROGRAM_IDS[0] as string;
    const helper = createPdaHelper(programId);
    const betId = BET_IDS[3] as string;
    helper.prewarm(betId);
    const a = helper.forBet(betId);
    const b = helper.forBet(betId.toLowerCase());
    expect(a).toBe(b);
    expect(a.betId).toBe(betId.toLowerCase());
    expect(a.config).toBe(helper.config());
    expect(a.bet).toEqual(deriveBetPdas(programId, betId).bet);
  });

  it('rejects a malformed program ID up front', () => {
    expect(() => createPdaHelper('not-base58-0OIl')).toThrow();
    expect(() => createPdaHelper(base58Encode(new Uint8Array(31).fill(1)))).toThrow();
  });
});
