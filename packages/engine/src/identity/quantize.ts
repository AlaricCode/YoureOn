/**
 * Embedding quantization (§8.2).
 *
 *   q_i = clamp(roundHalfAwayFromZero(x_i · EMB_SCALE), -127, 127)
 *
 * on the L2-normalized float vector. Enrollment template =
 * quantize(normalize(mean of the 3–5 frame / 3 phrase embeddings)).
 * Face vectors are zero-padded to CIRCUIT_DIM = 192 wherever they enter a
 * commitment or proof.
 */
import { CIRCUIT_DIM, EMB_CLAMP, EMB_SCALE } from '../constants.js';

export type FloatVector = Float32Array | Float64Array | number[];

/** Tolerance under which an input is treated as already unit-length (not re-normalized). */
const UNIT_TOLERANCE = 1e-6;

export function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

/** L2-normalizes a float vector (a zero vector stays zero). */
export function normalizeEmbedding(v: FloatVector): Float64Array {
  let ss = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (!Number.isFinite(x)) throw new RangeError('embedding contains a non-finite value');
    ss += x * x;
  }
  const out = new Float64Array(v.length);
  if (ss === 0) return out;
  const n = Math.sqrt(ss);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/**
 * Quantizes an embedding to i8 (§8.2). Inputs within 1e-6 of unit length are
 * quantized as given (so an already-normalized vector is not perturbed);
 * others are L2-normalized first.
 */
export function quantizeEmbedding(f32: FloatVector): Int8Array {
  let ss = 0;
  for (let i = 0; i < f32.length; i++) {
    const x = f32[i]!;
    if (!Number.isFinite(x)) throw new RangeError('embedding contains a non-finite value');
    ss += x * x;
  }
  const v: FloatVector = Math.abs(Math.sqrt(ss) - 1) <= UNIT_TOLERANCE || ss === 0 ? f32 : normalizeEmbedding(f32);
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const q = roundHalfAwayFromZero(v[i]! * EMB_SCALE);
    out[i] = Math.max(-EMB_CLAMP, Math.min(EMB_CLAMP, q));
  }
  return out;
}

/** Enrollment template: quantize(normalize(mean of samples)). */
export function enrollmentTemplate(samples: FloatVector[]): Int8Array {
  if (samples.length === 0) throw new RangeError('enrollment needs at least one sample');
  const dim = samples[0]!.length;
  const mean = new Float64Array(dim);
  for (const s of samples) {
    if (s.length !== dim) throw new RangeError('enrollment samples differ in dimension');
    for (let i = 0; i < dim; i++) mean[i]! += s[i]!;
  }
  for (let i = 0; i < dim; i++) mean[i]! /= samples.length;
  return quantizeEmbedding(normalizeEmbedding(mean));
}

/** Zero-pads (face 128 → 192) a quantized vector to CIRCUIT_DIM; validates the i8 range. */
export function padToCircuit(q: Int8Array | number[]): Int8Array {
  if (q.length > CIRCUIT_DIM) throw new RangeError(`embedding longer than ${CIRCUIT_DIM}`);
  const out = new Int8Array(CIRCUIT_DIM);
  for (let i = 0; i < q.length; i++) {
    const v = q[i]!;
    if (!Number.isInteger(v) || v < -EMB_CLAMP || v > EMB_CLAMP) {
      throw new RangeError(`quantized value out of range at ${i}: ${v}`);
    }
    out[i] = v;
  }
  return out;
}
