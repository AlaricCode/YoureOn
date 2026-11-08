/**
 * PROVER=snarkjs: real Groth16 in-process (free, offline) using the circuit
 * artifacts under circuits/build (§8.6). snarkjs is loaded lazily so the
 * backend does not depend on it unless this mode is selected.
 * SP1_PROVER=network: costs money (spend guard).
 *
 * TODO(prover agent): add `snarkjs` as a dependency when enabling this mode,
 * and wire a verifier for the mock chain (ChainContext.verifyGroth16 is
 * synchronous, snarkjs.verify is async — pre-verify before submitting).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { encodeGroth16Proof, type EncodedGroth16Proof } from '@verdict/engine';
import { assertSpendAllowed } from '../../config/spend.js';
import type { Config } from '../../config/load.js';
import { findRepoRoot } from '../../config/dotenv.js';
import { NotImplementedError } from '../../errors.js';
import type { ProverProvider, Sp1Provider } from '../types.js';

export function circuitArtifacts(root: string = findRepoRoot()) {
  const build = join(root, 'circuits', 'build');
  return {
    build,
    wasm: join(build, 'biometric_match_js', 'biometric_match.wasm'),
    zkey: join(build, 'biometric_match_final.zkey'),
    vkey: join(build, 'verification_key.json'),
  };
}

interface SnarkjsModule {
  groth16: {
    fullProve(input: Record<string, unknown>, wasm: string, zkey: string): Promise<{ proof: unknown; publicSignals: string[] }>;
  };
}

export class SnarkjsProver implements ProverProvider {
  readonly name = 'snarkjs';
  private mod: SnarkjsModule | null = null;
  readonly paths = circuitArtifacts();

  constructor() {
    for (const p of [this.paths.wasm, this.paths.zkey]) {
      if (!existsSync(p)) throw new Error(`PROVER=snarkjs needs ${p} (run circuits/scripts/setup.sh)`);
    }
  }

  async proveBiometric(input: Record<string, unknown>): Promise<{ proof: EncodedGroth16Proof; publicSignals: string[] }> {
    if (!this.mod) {
      const name = 'snarkjs';
      try {
        this.mod = (await import(name)) as SnarkjsModule;
      } catch {
        throw new Error('PROVER=snarkjs: the snarkjs package is not installed');
      }
    }
    const { proof, publicSignals } = await this.mod.groth16.fullProve(input, this.paths.wasm, this.paths.zkey);
    return { proof: encodeGroth16Proof(proof as Parameters<typeof encodeGroth16Proof>[0]), publicSignals };
  }
}

export class NetworkSp1 implements Sp1Provider {
  readonly name = 'network';
  readonly enabled = true;
  constructor(cfg: Pick<Config, 'allowSpend'>) {
    assertSpendAllowed(cfg, 'SP1_PROVER=network');
  }
  async proveRun(): Promise<{ public_values: Uint8Array; proof: Uint8Array }> {
    throw new NotImplementedError('SP1_PROVER=network');
  }
}
