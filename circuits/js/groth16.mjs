// snarkjs Groth16 wrappers + groth16-solana byte encodings (CONTRACTS.md §8.6).
import { readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { WASM_PATH, ZKEY_PATH, VK_PATH } from "./paths.mjs";
import { bigIntToBytes32BE } from "./biometric.mjs";

/** BN254 base-field modulus (curve coordinates). */
export const BN254_Q =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** Full Groth16 proof from a circuit input object. Throws if the witness is unsatisfiable. */
export async function prove(input, { wasm = WASM_PATH, zkey = ZKEY_PATH } = {}) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  return { proof, publicSignals };
}

export function loadVerificationKey(path = VK_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function verify(publicSignals, proof, vk = loadVerificationKey()) {
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

/**
 * groth16-solana encoding: proof_a = x ‖ (q - y) (negated), proof_b = x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0,
 * proof_c = x ‖ y; all 32-byte big-endian.
 */
export function encodeGroth16Proof(proof) {
  const fe = (s) => bigIntToBytes32BE(BigInt(s));
  const cat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  };
  const ay = BigInt(proof.pi_a[1]);
  const a = cat(fe(proof.pi_a[0]), fe((BN254_Q - ay) % BN254_Q));
  const b = cat(fe(proof.pi_b[0][1]), fe(proof.pi_b[0][0]), fe(proof.pi_b[1][1]), fe(proof.pi_b[1][0]));
  const c = cat(fe(proof.pi_c[0]), fe(proof.pi_c[1]));
  return { a, b, c };
}

/** Public signals -> 8 × 32-byte big-endian inputs. */
export function encodePublicInputs(publicSignals) {
  return publicSignals.map((s) => bigIntToBytes32BE(BigInt(s)));
}

/** snarkjs keeps worker threads alive; call when done in CLIs/tests. */
export async function terminate() {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
}
