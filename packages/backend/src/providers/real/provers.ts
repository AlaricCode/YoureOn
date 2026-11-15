/**
 * PROVER=snarkjs: real Groth16 in-process (free, offline) using the circuit
 * artifacts under circuits/build (§8.6). snarkjs is a backend dependency
 * (pinned to the circuits/ version) but is imported lazily, on the first
 * proof, so other modes never load it.
 *
 * Every proof is checked locally with `groth16.verify` against
 * verification_key.json before it is returned (a public-input mismatch fails
 * here, not as an onchain BadProof). Verified (public inputs, proof) pairs are
 * cached and exposed as the synchronous `verifier` the mock chain uses, so in
 * SOLANA_MODE=mock + PROVER=snarkjs the chain accepts exactly the proofs that
 * verified (CONTRACTS-ERRATA backend-7).
 *
 * snarkjs keeps bn128 worker threads alive: `close()` terminates them (app
 * shutdown; one-shot scripts/tests must call it).
 *
 * SP1_PROVER=network: costs money (spend guard).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeGroth16Proof, type EncodedGroth16Proof } from '@verdict/engine';
import { assertSpendAllowed } from '../../config/spend.js';
import type { Config } from '../../config/load.js';
import { findRepoRoot } from '../../config/dotenv.js';
import { NotImplementedError } from '../../errors.js';
import type { ProverProvider, Sp1Provider } from '../types.js';
import { SP1_NOT_IMPLEMENTED } from '../mock/prover.js';

export function circuitArtifacts(root: string = findRepoRoot()) {
  const build = join(root, 'circuits', 'build');
  return {
    build,
    wasm: join(build, 'biometric_match_js', 'biometric_match.wasm'),
    zkey: join(build, 'biometric_match_final.zkey'),
    vkey: join(build, 'verification_key.json'),
  };
}

type SnarkjsModule = typeof import('snarkjs');

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** Public signal (decimal string) → 32-byte big-endian field element (the chain's public-input form). */
export function publicSignalBytes(s: string): Uint8Array {
  let v = BigInt(s);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const proofKey = (publicInputs: Uint8Array[], p: EncodedGroth16Proof): string =>
  [...publicInputs.map(hex), hex(p.a), hex(p.b), hex(p.c)].join('|');

export class SnarkjsProver implements ProverProvider {
  readonly name = 'snarkjs';
  private mod: SnarkjsModule | null = null;
  private vkey: unknown = null;
  private readonly verified = new Set<string>();
  readonly paths: ReturnType<typeof circuitArtifacts>;

  constructor(paths = circuitArtifacts()) {
    this.paths = paths;
  }

  /** Mock-chain verifier: accepts exactly the (public inputs, proof) pairs this prover verified. */
  readonly verifier = (publicInputs: Uint8Array[], proof: EncodedGroth16Proof): boolean => this.verified.has(proofKey(publicInputs, proof));

  private async load(): Promise<SnarkjsModule> {
    if (this.mod) return this.mod;
    for (const p of [this.paths.wasm, this.paths.zkey, this.paths.vkey]) {
      if (!existsSync(p)) throw new Error(`PROVER=snarkjs needs ${p} (run circuits/scripts/setup.sh)`);
    }
    try {
      this.mod = await import('snarkjs');
    } catch (e) {
      throw new Error(`PROVER=snarkjs: cannot load snarkjs (${(e as Error).message}); run npm install`);
    }
    this.vkey = JSON.parse(readFileSync(this.paths.vkey, 'utf8'));
    return this.mod;
  }

  async proveBiometric(input: Record<string, unknown>): Promise<{ proof: EncodedGroth16Proof; publicSignals: string[] }> {
    const mod = await this.load();
    const { proof, publicSignals } = await mod.groth16.fullProve(input, this.paths.wasm, this.paths.zkey);
    if (!(await mod.groth16.verify(this.vkey, publicSignals, proof))) {
      throw new Error('snarkjs: proof does not verify against verification_key.json');
    }
    const encoded = encodeGroth16Proof(proof as Parameters<typeof encodeGroth16Proof>[0]);
    this.verified.add(proofKey(publicSignals.map(publicSignalBytes), encoded));
    return { proof: encoded, publicSignals };
  }

  /** Terminates snarkjs's bn128 worker threads (no-op if never loaded). */
  async close(): Promise<void> {
    const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
    if (curve) {
      await curve.terminate();
      delete (globalThis as { curve_bn128?: unknown }).curve_bn128;
    }
  }
}

export class NetworkSp1 implements Sp1Provider {
  readonly name = 'network';
  /** SP1 path not implemented (D-9, errata [sp1-dropped]): treated as off. */
  readonly enabled = false;
  constructor(cfg: Pick<Config, 'allowSpend'>) {
    assertSpendAllowed(cfg, 'SP1_PROVER=network');
  }
  async proveRun(): Promise<never> {
    throw new NotImplementedError(SP1_NOT_IMPLEMENTED);
  }
}
