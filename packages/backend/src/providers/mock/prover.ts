/**
 * Mock provers. PROVER=mock returns an all-zero Groth16 proof (the mock chain
 * accepts it when no verifier is configured, §13); SP1_PROVER=off|mock.
 */
import type { EncodedGroth16Proof } from '@verdict/engine';
import type { ProverProvider, Sp1Provider } from '../types.js';

export class MockProver implements ProverProvider {
  readonly name = 'mock';
  async proveBiometric(): Promise<{ proof: EncodedGroth16Proof; publicSignals: string[] }> {
    return { proof: { a: new Uint8Array(64), b: new Uint8Array(128), c: new Uint8Array(64) }, publicSignals: [] };
  }
}

export class OffSp1 implements Sp1Provider {
  readonly name = 'off';
  readonly enabled = false;
  async proveRun(): Promise<never> {
    throw new Error('SP1_PROVER=off');
  }
}

export class MockSp1 implements Sp1Provider {
  readonly name = 'mock';
  readonly enabled = true;
  // TODO(chain agent): build public values per §9.4 #14 from the bet + engine evaluation.
  async proveRun(input: { bet: string; payload: Uint8Array }): Promise<{ public_values: Uint8Array; proof: Uint8Array }> {
    void input;
    return { public_values: new Uint8Array(0), proof: new Uint8Array(0) };
  }
}
