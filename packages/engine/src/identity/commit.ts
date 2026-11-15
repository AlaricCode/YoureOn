/**
 * Biometric commitment (§8.4).
 *
 *   u_i  = q_i + 128                       (i = 0..191; 1..255)
 *   F_k  = Σ_{j=0..30} u_{31k+j} · 256^j    for k = 0..5
 *   F_6  = Σ_{j=0..5}  u_{186+j} · 256^j
 *   commit = Poseidon8(F_0, …, F_6, salt)  // circomlib Poseidon, t = 9
 *
 * `salt` = 31 random bytes interpreted little-endian; `commit` is stored as a
 * 32-byte big-endian integer.
 */
import { poseidon8 } from 'poseidon-lite/poseidon8';
import { BN254_R, CIRCUIT_DIM, EMB_OFFSET, PACK_BYTES_PER_FIELD, PACK_FIELDS, SALT_BYTES } from '../constants.js';
import { bigIntToBytesBE, bytesToBigIntBE, bytesToBigIntLE } from '../evidence/bytes.js';
import { padToCircuit } from './quantize.js';

/** Packs a quantized embedding (192, or 128 zero-padded) into 7 field elements. */
export function packEmbedding(q: Int8Array | number[]): bigint[] {
  const p = padToCircuit(q);
  const out: bigint[] = [];
  for (let k = 0; k < PACK_FIELDS; k++) {
    const start = k * PACK_BYTES_PER_FIELD;
    const end = Math.min(start + PACK_BYTES_PER_FIELD, CIRCUIT_DIM);
    let f = 0n;
    for (let i = end - 1; i >= start; i--) f = (f << 8n) | BigInt(p[i]! + EMB_OFFSET);
    out.push(f);
  }
  return out;
}

function checkSalt(salt: bigint): void {
  if (typeof salt !== 'bigint' || salt < 0n || salt >= 1n << BigInt(8 * SALT_BYTES)) {
    throw new RangeError(`salt must be a bigint in [0, 2^${8 * SALT_BYTES})`);
  }
}

/** Poseidon8(F_0..F_6, salt) as a field element (< r). */
export function poseidonCommit(q: Int8Array | number[], salt: bigint): bigint {
  checkSalt(salt);
  return poseidon8([...packEmbedding(q), salt]);
}

/** 31 bytes (little-endian) → salt. */
export function saltFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== SALT_BYTES) throw new RangeError(`salt must be ${SALT_BYTES} bytes`);
  return bytesToBigIntLE(bytes);
}

/** Commitment → 32-byte big-endian (Profile face_commit / voice_commit). */
export function commitmentToBytes(commit: bigint): Uint8Array {
  if (commit < 0n || commit >= BN254_R) throw new RangeError('commitment must be a field element');
  return bigIntToBytesBE(commit, 32);
}

/** 32-byte big-endian commitment → bigint (validated < r). */
export function commitmentFromBytes(b: Uint8Array): bigint {
  if (b.length !== 32) throw new RangeError('commitment must be 32 bytes');
  const v = bytesToBigIntBE(b);
  if (v >= BN254_R) throw new RangeError('commitment is not a field element');
  return v;
}
