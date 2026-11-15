/**
 * PROVER=snarkjs: real Groth16 (offline, circuits/build artifacts), locally
 * verified, and a synchronous mock-chain verifier that accepts exactly the
 * proofs it produced. Skipped when the circuit artifacts are absent.
 */
import { existsSync } from 'node:fs';
import bs58 from 'bs58';
import { afterAll, describe, expect, it } from 'vitest';
import {
  biometricPublicInputs,
  biometricWitness,
  commitmentToBytes,
  poseidonCommit,
  type BiometricPublicInputArgs,
} from '@verdict/engine';
import { circuitArtifacts, SnarkjsProver } from '../src/providers/real/provers.js';

const paths = circuitArtifacts();
const have = [paths.wasm, paths.zkey, paths.vkey].every((p) => existsSync(p));

describe.skipIf(!have)('SnarkjsProver', () => {
  const prover = new SnarkjsProver();
  afterAll(async () => {
    await prover.close();
  });

  it('proves, pre-verifies against the vkey, and backs the mock-chain verifier', async () => {
    const q = Int8Array.from({ length: 128 }, (_, i) => ((i * 13) % 200) - 100);
    const salt = 424242n;
    const args: BiometricPublicInputArgs = {
      commitment: commitmentToBytes(poseidonCommit(q, salt)),
      bet: bs58.encode(new Uint8Array(32).fill(7)),
      evidence_root: new Uint8Array(32).fill(9),
      participant_idx: 1,
      frame: 120,
      modality: 0,
      tau_bps: 5500,
    };
    const { proof } = await prover.proveBiometric(biometricWitness(args, { q, salt }, q) as unknown as Record<string, unknown>);
    const inputs = biometricPublicInputs(args);
    expect(prover.verifier(inputs, proof)).toBe(true);
    // A different frame (the public inputs the chain would compute) is rejected, as onchain.
    expect(prover.verifier(biometricPublicInputs({ ...args, frame: 121 }), proof)).toBe(false);
    const bad = { ...proof, c: Uint8Array.from(proof.c, (b, i) => (i === 0 ? b ^ 1 : b)) };
    expect(prover.verifier(inputs, bad)).toBe(false);
  }, 120_000);
});
