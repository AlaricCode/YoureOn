/**
 * Biometric ZK proof encoding (§8.6): public inputs (8 × 32-byte big-endian,
 * snarkjs `public.json` order), circuit witness input, and the
 * groth16-solana proof encoding.
 */
import { BIOMETRIC_PUBLIC_INPUTS, BN254_P, BN254_R, CIRCUIT_DIM, MAX_PARTICIPANTS } from '../constants.js';
import type {
  BiometricProverInput,
  BiometricPublicInputArgs,
  EncodedGroth16Proof,
  EnrollmentSecret,
  SnarkjsProof,
} from '../types.js';
import { bigIntToBytesBE, bytesToBigIntBE, expectLen, pubkeyBytes } from '../evidence/bytes.js';
import { poseidonCommit } from './commit.js';
import { circuitMatch } from './match.js';
import { padToCircuit } from './quantize.js';

/** `0x00 ‖ x[1..32]` as a big-endian integer (bet_field / evidence_field). */
export function truncatedField(x: Uint8Array): bigint {
  expectLen(x, 32, 'field source');
  const b = Uint8Array.from(x);
  b[0] = 0;
  return bytesToBigIntBE(b);
}

/** The 8 public signals as field elements, in circuit order. */
export function biometricPublicSignals(args: BiometricPublicInputArgs): bigint[] {
  const commitment = bytesToBigIntBE(expectLen(args.commitment, 32, 'commitment'));
  if (commitment >= BN254_R) throw new RangeError('commitment is not a field element');
  if (!Number.isInteger(args.participant_idx) || args.participant_idx < 0 || args.participant_idx >= MAX_PARTICIPANTS) {
    throw new RangeError('participant_idx must be 0..7');
  }
  if (!Number.isInteger(args.frame) || args.frame < 0 || args.frame > 0xffffffff) throw new RangeError('frame must be a u32');
  if (args.modality !== 0 && args.modality !== 1) throw new RangeError('modality must be 0 or 1');
  if (!Number.isInteger(args.tau_bps) || args.tau_bps < 0 || args.tau_bps >= 1 << 14) {
    throw new RangeError('tau_bps must fit in 14 bits');
  }
  return [
    commitment,
    truncatedField(pubkeyBytes(args.bet, 'bet')),
    truncatedField(args.evidence_root),
    BigInt(args.participant_idx),
    BigInt(args.frame),
    BigInt(args.modality),
    BigInt(args.tau_bps),
    1n,
  ];
}

/** Public inputs for groth16-solana: 8 × 32-byte big-endian. */
export function biometricPublicInputs(args: BiometricPublicInputArgs): Uint8Array[] {
  const s = biometricPublicSignals(args);
  if (s.length !== BIOMETRIC_PUBLIC_INPUTS) throw new Error('internal: public input count');
  return s.map((v) => bigIntToBytesBE(v, 32));
}

/** Signed value → field element decimal string (negatives as r − |x|). */
function signedField(v: number): string {
  return (v < 0 ? BN254_R - BigInt(-v) : BigInt(v)).toString();
}

/**
 * Full `BiometricMatch(192)` input (public + private) for snarkjs. Throws if
 * the enrolled secret does not open `args.commitment`, or if
 * `circuitMatch(enrolled, observed, tau)` fails (no valid proof exists).
 */
export function biometricWitness(
  args: BiometricPublicInputArgs,
  enrolled: EnrollmentSecret,
  observed: Int8Array | number[],
): BiometricProverInput {
  const pub = biometricPublicSignals(args);
  const e = padToCircuit(enrolled.q);
  const o = padToCircuit(observed);
  if (poseidonCommit(e, enrolled.salt) !== pub[0]) throw new Error('enrollment secret does not open the commitment');
  if (!circuitMatch(e, o, args.tau_bps)) throw new Error('circuitMatch fails: no proof can be produced');
  const enr: string[] = [];
  const obs: string[] = [];
  for (let i = 0; i < CIRCUIT_DIM; i++) {
    enr.push(signedField(e[i]!));
    obs.push(signedField(o[i]!));
  }
  return {
    commitment: pub[0]!.toString(),
    bet_field: pub[1]!.toString(),
    evidence_field: pub[2]!.toString(),
    participant_idx: pub[3]!.toString(),
    frame: pub[4]!.toString(),
    modality: pub[5]!.toString(),
    tau_bps: pub[6]!.toString(),
    result: '1',
    enrolled: enr,
    salt: enrolled.salt.toString(),
    observed: obs,
  };
}

function fq(s: string | undefined, what: string): bigint {
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) throw new RangeError(`${what} must be a decimal string`);
  const v = BigInt(s);
  if (v >= BN254_P) throw new RangeError(`${what} is not a base-field element`);
  return v;
}

function expectAffine(z: string | undefined, what: string, one: boolean): void {
  if (z === undefined) return;
  if (one ? z !== '1' : z !== '0') throw new RangeError(`${what} must be affine (z = ${one ? '1' : '[1, 0]'})`);
}

/**
 * snarkjs proof → groth16-solana bytes: a = x ‖ (p − y) (y negated), 64 B;
 * b = x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0, 128 B; c = x ‖ y, 64 B; all big-endian.
 */
export function encodeGroth16Proof(proof: SnarkjsProof): EncodedGroth16Proof {
  const pa = proof.pi_a;
  const pb = proof.pi_b;
  const pc = proof.pi_c;
  if (!Array.isArray(pa) || pa.length < 2 || !Array.isArray(pc) || pc.length < 2 || !Array.isArray(pb) || pb.length < 2) {
    throw new RangeError('malformed snarkjs proof');
  }
  expectAffine(pa[2], 'pi_a', true);
  expectAffine(pc[2], 'pi_c', true);
  if (pb[2] !== undefined) {
    expectAffine(pb[2][0], 'pi_b', true);
    expectAffine(pb[2][1], 'pi_b', false);
  }
  const ax = fq(pa[0], 'pi_a.x');
  const ay = fq(pa[1], 'pi_a.y');
  const a = new Uint8Array(64);
  a.set(bigIntToBytesBE(ax, 32), 0);
  a.set(bigIntToBytesBE((BN254_P - ay) % BN254_P, 32), 32);

  const bx = pb[0];
  const by = pb[1];
  if (!Array.isArray(bx) || bx.length !== 2 || !Array.isArray(by) || by.length !== 2) {
    throw new RangeError('malformed pi_b');
  }
  const b = new Uint8Array(128);
  b.set(bigIntToBytesBE(fq(bx[1], 'pi_b.x.c1'), 32), 0);
  b.set(bigIntToBytesBE(fq(bx[0], 'pi_b.x.c0'), 32), 32);
  b.set(bigIntToBytesBE(fq(by[1], 'pi_b.y.c1'), 32), 64);
  b.set(bigIntToBytesBE(fq(by[0], 'pi_b.y.c0'), 32), 96);

  const c = new Uint8Array(64);
  c.set(bigIntToBytesBE(fq(pc[0], 'pi_c.x'), 32), 0);
  c.set(bigIntToBytesBE(fq(pc[1], 'pi_c.y'), 32), 32);
  return { a, b, c };
}
