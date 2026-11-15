import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon8 } from 'poseidon-lite/poseidon8';
import {
  biometricPublicInputs,
  biometricPublicSignals,
  biometricWitness,
  commitmentFromBytes,
  commitmentToBytes,
  encodeGroth16Proof,
  packEmbedding,
  poseidonCommit,
  saltFromBytes,
} from '../src/identity/index.js';
import { BN254_P, BN254_R } from '../src/constants.js';
import type { BiometricPublicInputArgs } from '../src/types.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const beHex = (v: bigint) => v.toString(16).padStart(64, '0');

describe('poseidon-lite sanity (circomlib vectors)', () => {
  it('poseidon2([1, 2]) matches circomlib', () => {
    expect(poseidon2([1n, 2n])).toBe(7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  });
});

describe('packEmbedding (§8.4)', () => {
  it('u_i = q_i + 128 packed little-endian, 31 bytes per field, last field 6 bytes', () => {
    const q = Array.from({ length: 192 }, (_, i) => ((i * 7) % 255) - 127);
    const F = packEmbedding(q);
    expect(F.length).toBe(7);
    for (let k = 0; k < 7; k++) {
      const n = k < 6 ? 31 : 6;
      let expected = 0n;
      for (let j = 0; j < n; j++) expected += BigInt(q[31 * k + j]! + 128) * 256n ** BigInt(j);
      expect(F[k]).toBe(expected);
    }
    expect(F[6]! < 1n << 48n).toBe(true);
    for (const f of F) expect(f < BN254_R).toBe(true);
  });
  it('extremes: all −127 → bytes 0x01; all 127 → 0xFF', () => {
    const lo = packEmbedding(new Array(192).fill(-127));
    expect(lo[0]).toBe(BigInt('0x' + '01'.repeat(31)));
    expect(lo[6]).toBe(BigInt('0x' + '01'.repeat(6)));
    const hi = packEmbedding(new Array(192).fill(127));
    expect(hi[0]).toBe(BigInt('0x' + 'ff'.repeat(31)));
  });
  it('128-d face is zero-padded (u = 128 for i ≥ 128)', () => {
    const face = new Int8Array(128).fill(1);
    const F = packEmbedding(face);
    expect(F).toEqual(packEmbedding([...Array.from(face), ...new Array(64).fill(0)]));
    // field 4 covers bytes 124..154: 4 bytes of 129 then 27 bytes of 128
    let expected = 0n;
    for (let j = 0; j < 31; j++) expected += BigInt(124 + j < 128 ? 129 : 128) * 256n ** BigInt(j);
    expect(F[4]).toBe(expected);
  });
});

describe('poseidonCommit (§8.4)', () => {
  const q = Array.from({ length: 192 }, (_, i) => (i % 2 ? 1 : -1) * (i % 128));
  const saltBytes = Uint8Array.from({ length: 31 }, (_, i) => i + 1);
  const salt = saltFromBytes(saltBytes);

  it('salt is little-endian', () => {
    expect(salt & 0xffn).toBe(1n);
    expect(salt >> 240n).toBe(31n);
    expect(() => saltFromBytes(new Uint8Array(32))).toThrow();
  });
  it('= Poseidon8(F_0..F_6, salt), < r, round-trips 32-byte BE', () => {
    const c = poseidonCommit(q, salt);
    expect(c).toBe(poseidon8([...packEmbedding(q), salt]));
    expect(c < BN254_R).toBe(true);
    const b = commitmentToBytes(c);
    expect(b.length).toBe(32);
    expect(hex(b)).toBe(beHex(c));
    expect(commitmentFromBytes(b)).toBe(c);
    expect(poseidonCommit(q, salt + 1n)).not.toBe(c);
  });
  it('rejects out-of-range salt and commitments', () => {
    expect(() => poseidonCommit(q, 1n << 248n)).toThrow();
    expect(() => poseidonCommit(q, -1n)).toThrow();
    expect(() => commitmentToBytes(BN254_R)).toThrow();
    expect(() => commitmentFromBytes(new Uint8Array(32).fill(0xff))).toThrow();
  });
});

describe('biometricPublicInputs (§8.6)', () => {
  const betBytes = Uint8Array.from({ length: 32 }, (_, i) => 0xf0 + (i % 16));
  const root = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
  const commit = poseidonCommit(new Array(192).fill(3), 12345n);
  const args: BiometricPublicInputArgs = {
    commitment: commitmentToBytes(commit),
    bet: bs58.encode(betBytes),
    evidence_root: root,
    participant_idx: 1,
    frame: 41,
    modality: 0,
    tau_bps: 5500,
  };

  it('8 × 32-byte BE in public.json order; bet/evidence first byte zeroed', () => {
    const pi = biometricPublicInputs(args);
    expect(pi.length).toBe(8);
    for (const x of pi) expect(x.length).toBe(32);
    expect(hex(pi[0]!)).toBe(beHex(commit));
    expect(pi[1]![0]).toBe(0);
    expect(hex(pi[1]!.subarray(1))).toBe(hex(betBytes.subarray(1)));
    expect(pi[2]![0]).toBe(0);
    expect(hex(pi[2]!.subarray(1))).toBe(hex(root.subarray(1)));
    expect(pi[3]![31]).toBe(1);
    expect(pi[4]![31]).toBe(41);
    expect(pi[5]![31]).toBe(0);
    expect(hex(pi[6]!)).toBe(beHex(5500n));
    expect(hex(pi[7]!)).toBe(beHex(1n));
    expect(root[0]).toBe(0xa0); // input not mutated
  });
  it('validates ranges', () => {
    expect(() => biometricPublicInputs({ ...args, participant_idx: 8 })).toThrow();
    expect(() => biometricPublicInputs({ ...args, tau_bps: 16384 })).toThrow();
    expect(biometricPublicSignals({ ...args, tau_bps: 16383 })[6]).toBe(16383n);
    expect(() => biometricPublicInputs({ ...args, modality: 2 as never })).toThrow();
    expect(() => biometricPublicInputs({ ...args, frame: -1 })).toThrow();
    expect(() => biometricPublicInputs({ ...args, commitment: new Uint8Array(32).fill(0xff) })).toThrow();
    expect(() => biometricPublicInputs({ ...args, evidence_root: new Uint8Array(31) })).toThrow();
  });
});

describe('biometricWitness', () => {
  const enrolledQ = Int8Array.from({ length: 192 }, (_, i) => (i < 128 ? ((i * 13) % 200) - 100 : 0));
  const salt = 987654321n;
  const commitment = commitmentToBytes(poseidonCommit(enrolledQ, salt));
  const args: BiometricPublicInputArgs = {
    commitment,
    bet: bs58.encode(new Uint8Array(32).fill(7)),
    evidence_root: new Uint8Array(32).fill(9),
    participant_idx: 0,
    frame: 100,
    modality: 0,
    tau_bps: 5500,
  };
  it('produces a full circuit input with negatives as r − |x|', () => {
    const observed = Int8Array.from(enrolledQ, (v, i) => (i % 10 === 0 ? 0 : v));
    const w = biometricWitness(args, { q: enrolledQ, salt }, observed);
    expect(w.enrolled.length).toBe(192);
    expect(w.observed.length).toBe(192);
    expect(w.result).toBe('1');
    expect(w.salt).toBe('987654321');
    const negIdx = Array.from(enrolledQ).findIndex((v) => v < 0);
    expect(BigInt(w.enrolled[negIdx]!)).toBe(BN254_R - BigInt(-enrolledQ[negIdx]!));
    expect(w.commitment).toBe(commitmentFromBytes(commitment).toString());
    expect(w.tau_bps).toBe('5500');
  });
  it('accepts a 128-d face secret (zero-padded)', () => {
    const face128 = enrolledQ.subarray(0, 128);
    expect(() => biometricWitness(args, { q: face128, salt }, face128)).not.toThrow();
  });
  it('rejects a wrong salt or a non-matching observation', () => {
    expect(() => biometricWitness(args, { q: enrolledQ, salt: salt + 1n }, enrolledQ)).toThrow(/open/);
    const opposite = Int8Array.from(enrolledQ, (v) => -v);
    expect(() => biometricWitness(args, { q: enrolledQ, salt }, opposite)).toThrow(/circuitMatch/);
  });
});

describe('encodeGroth16Proof (§8.6)', () => {
  const proof = {
    pi_a: ['11', '22', '1'],
    pi_b: [
      ['101', '102'],
      ['103', '104'],
      ['1', '0'],
    ],
    pi_c: ['33', '44', '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
  it('a = x ‖ (p − y); b = x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0; c = x ‖ y', () => {
    const { a, b, c } = encodeGroth16Proof(proof);
    expect(a.length).toBe(64);
    expect(b.length).toBe(128);
    expect(c.length).toBe(64);
    expect(hex(a)).toBe(beHex(11n) + beHex(BN254_P - 22n));
    expect(hex(b)).toBe(beHex(102n) + beHex(101n) + beHex(104n) + beHex(103n));
    expect(hex(c)).toBe(beHex(33n) + beHex(44n));
  });
  it('y = 0 stays 0 when negated; rejects non-affine / out-of-field / malformed', () => {
    expect(hex(encodeGroth16Proof({ ...proof, pi_a: ['1', '0', '1'] }).a.subarray(32))).toBe('0'.repeat(64));
    expect(() => encodeGroth16Proof({ ...proof, pi_a: ['1', '2', '3'] })).toThrow();
    expect(() => encodeGroth16Proof({ ...proof, pi_c: [BN254_P.toString(), '1', '1'] })).toThrow();
    expect(() => encodeGroth16Proof({ ...proof, pi_b: [['1'], ['2', '3']] })).toThrow();
    expect(() => encodeGroth16Proof({ ...proof, pi_a: ['0x1', '2', '1'] })).toThrow();
  });
});
