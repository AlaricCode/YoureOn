/**
 * Mock provers. PROVER=mock returns an all-zero Groth16 proof (the mock chain
 * accepts it when no verifier is configured, §13); SP1_PROVER=off|mock.
 *
 * The SP1 path (D-9) is dropped for this build (CONTRACTS-ERRATA [sp1-dropped]):
 * nothing routes to SP1, oversized runs go to the panel (reason 13), and every
 * SP1 provider reports `enabled = false` and refuses to prove.
 */
import type { EncodedGroth16Proof } from '@verdict/engine';
import { NotImplementedError } from '../../errors.js';
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
  /** SP1 path not implemented (D-9): treated as off. */
  readonly enabled = false;
  async proveRun(): Promise<never> {
    throw new NotImplementedError(SP1_NOT_IMPLEMENTED);
  }
}

/** Message for every SP1 prover entry point (errata [sp1-dropped]). */
export const SP1_NOT_IMPLEMENTED = 'SP1 path not implemented (D-9); oversized runs go to the panel';
