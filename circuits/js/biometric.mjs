// Off-circuit reference for the Verdict biometric circuit (CONTRACTS.md §8.2–§8.4, §8.6).
// Mirrors what the engine computes with poseidon-lite, so tests can cross-check the circuit.

import { poseidon8 } from "poseidon-lite";

export const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const CIRCUIT_DIM = 192;
export const FACE_DIM = 128;
export const VOICE_DIM = 192;
export const MODALITY_FACE = 0;
export const MODALITY_VOICE = 1;

/** Validates an i8 embedding in [-127, 127] and zero-pads it to CIRCUIT_DIM (§8.2). */
export function padEmbedding(q) {
  const arr = Array.from(q, (v) => Number(v));
  if (arr.length > CIRCUIT_DIM) throw new Error(`embedding longer than ${CIRCUIT_DIM}`);
  for (const v of arr) {
    if (!Number.isInteger(v) || v < -127 || v > 127) throw new Error(`embedding value out of range: ${v}`);
  }
  while (arr.length < CIRCUIT_DIM) arr.push(0);
  return arr;
}

/** Signed integer -> field element (negatives as r - |x|). */
export function toField(x) {
  const b = BigInt(x);
  return ((b % BN254_R) + BN254_R) % BN254_R;
}

/** Little-endian bytes -> bigint. */
export function leBytesToBigInt(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/** Big-endian bytes -> bigint. */
export function beBytesToBigInt(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** bigint -> 32-byte big-endian Uint8Array. */
export function bigIntToBytes32BE(v) {
  if (v < 0n || v >= 1n << 256n) throw new Error("value does not fit 32 bytes");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Salt (31 bytes little-endian, or a bigint < 2^248) -> field element. */
export function saltToField(salt) {
  if (typeof salt === "bigint") {
    if (salt < 0n || salt >= 1n << 248n) throw new Error("salt must be < 2^248");
    return salt;
  }
  if (salt.length !== 31) throw new Error("salt must be 31 bytes");
  return leBytesToBigInt(salt);
}

/** §8.4 packing: u_i = q_i + 128; F_k = Σ_j u_{31k+j}·256^j (7 field elements for 192 dims). */
export function packEmbedding(q) {
  const padded = padEmbedding(q);
  const u = padded.map((v) => v + 128);
  const fields = [];
  for (let k = 0; k * 31 < CIRCUIT_DIM; k++) {
    fields.push(leBytesToBigInt(u.slice(31 * k, Math.min(31 * k + 31, CIRCUIT_DIM))));
  }
  return fields;
}

/** §8.4 commitment = Poseidon8(F_0..F_6, salt), as a bigint field element. */
export function computeCommitment(q, salt) {
  return poseidon8([...packEmbedding(q), saltToField(salt)]);
}

/** Commitment as the 32-byte big-endian value stored in `Profile`. */
export function commitmentBytes(q, salt) {
  return bigIntToBytes32BE(computeCommitment(q, salt));
}

/** §8.6 bet_field / evidence_field: big-endian integer of 0x00 ‖ bytes[1..32]. */
export function maskedField(bytes32) {
  if (bytes32.length !== 32) throw new Error("expected 32 bytes");
  const b = Uint8Array.from(bytes32);
  b[0] = 0;
  return beBytesToBigInt(b);
}

/** §8.3 dot, ne, no as bigints. */
export function dotStats(e, o) {
  const a = padEmbedding(e);
  const b = padEmbedding(o);
  let dot = 0n;
  let ne = 0n;
  let no = 0n;
  for (let i = 0; i < CIRCUIT_DIM; i++) {
    dot += BigInt(a[i] * b[i]);
    ne += BigInt(a[i] * a[i]);
    no += BigInt(b[i] * b[i]);
  }
  return { dot, ne, no };
}

/** §8.3 circuitMatch(e, o, τ) := dot > 0 && dot²·10^8 >= τ²·ne·no. */
export function circuitMatch(e, o, tauBps) {
  const { dot, ne, no } = dotStats(e, o);
  const t = BigInt(tauBps);
  return dot > 0n && dot * dot * 100000000n >= t * t * ne * no;
}

/**
 * Builds the snarkjs witness input object (all values as decimal strings).
 * `result` defaults to circuitMatch(...) ? 1 : 0, which is the only satisfiable value.
 */
export function buildCircuitInput({
  enrolled,
  salt,
  observed,
  betPubkey,
  evidenceRoot,
  participantIdx,
  frame,
  modality,
  tauBps,
  result,
  commitment,
}) {
  if (!Number.isInteger(participantIdx) || participantIdx < 0 || participantIdx > 7) {
    throw new Error("participantIdx must be 0..7");
  }
  if (modality !== MODALITY_FACE && modality !== MODALITY_VOICE) throw new Error("modality must be 0|1");
  if (!Number.isInteger(tauBps) || tauBps < 0 || tauBps >= 1 << 14) throw new Error("tauBps out of range");
  if (!Number.isInteger(frame) || frame < 0) throw new Error("frame must be a non-negative integer");
  const e = padEmbedding(enrolled);
  const o = padEmbedding(observed);
  const com = commitment ?? computeCommitment(e, salt);
  const res = result ?? (circuitMatch(e, o, tauBps) ? 1 : 0);
  return {
    commitment: com.toString(),
    bet_field: maskedField(betPubkey).toString(),
    evidence_field: maskedField(evidenceRoot).toString(),
    participant_idx: String(participantIdx),
    frame: String(frame),
    modality: String(modality),
    tau_bps: String(tauBps),
    result: String(res),
    enrolled: e.map((v) => toField(v).toString()),
    salt: saltToField(salt).toString(),
    observed: o.map((v) => toField(v).toString()),
  };
}

/** The 8 public signals in contract order, as decimal strings (matches snarkjs public.json). */
export const PUBLIC_SIGNAL_ORDER = [
  "commitment",
  "bet_field",
  "evidence_field",
  "participant_idx",
  "frame",
  "modality",
  "tau_bps",
  "result",
];

export function expectedPublicSignals(input) {
  return PUBLIC_SIGNAL_ORDER.map((k) => input[k]);
}
