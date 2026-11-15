/**
 * DSP helpers for the beacon decoder (§7.5): PCM conversion, resampling,
 * Goertzel tone power and block-wise demodulated tone sums.
 * Non-consensus; floats allowed.
 */

export type PcmInput = Int16Array | Float32Array | Float64Array | number[];

/** PCM16 (or float in [-1,1] for float arrays) → Float64Array in [-1, 1]. */
export function toFloat(pcm: PcmInput): Float64Array {
  const out = new Float64Array(pcm.length);
  if (pcm instanceof Int16Array) {
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  } else if (Array.isArray(pcm)) {
    // number[] is interpreted as PCM16 sample values
    for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 32768;
  } else {
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]!;
  }
  return out;
}

/**
 * Resamples `x` from `from` Hz to `to` Hz with linear interpolation. When
 * downsampling, a moving-average prefilter of width ⌈from/to⌉ limits aliasing.
 */
export function resample(x: Float64Array, from: number, to: number): Float64Array {
  if (from === to) return x;
  let src = x;
  if (to < from) {
    const w = Math.ceil(from / to);
    if (w > 1) {
      src = new Float64Array(x.length);
      let acc = 0;
      for (let i = 0; i < x.length; i++) {
        acc += x[i]!;
        if (i >= w) acc -= x[i - w]!;
        src[i] = acc / Math.min(i + 1, w);
      }
      // compensate the (w-1)/2 sample group delay of the causal filter
      const shift = (w - 1) / 2;
      const outLen = Math.floor((x.length * to) / from);
      const out = new Float64Array(outLen);
      for (let i = 0; i < outLen; i++) out[i] = interp(src, (i * from) / to + shift);
      return out;
    }
  }
  const outLen = Math.floor((x.length * to) / from);
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = interp(src, (i * from) / to);
  return out;
}

function interp(x: Float64Array, t: number): number {
  const i = Math.floor(t);
  if (i < 0) return x[0] ?? 0;
  if (i >= x.length - 1) return x[x.length - 1] ?? 0;
  const f = t - i;
  return x[i]! * (1 - f) + x[i + 1]! * f;
}

/** Goertzel power of angular frequency `omega` (rad/sample) over x[start, start+len). */
export function goertzelPower(x: Float64Array, start: number, len: number, omega: number): number {
  const c = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  const end = start + len;
  for (let n = start; n < end; n++) {
    const s0 = x[n]! + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/**
 * Complex demodulated sums per block and tone: for block b = [bnd[b], bnd[b+1])
 * and tone k, Σ x[n]·e^{-iω_k n} with absolute phase, so that consecutive
 * blocks can be summed into any block-aligned window (|X|² = DFT power).
 * Returns re/im arrays laid out [b * nTones + k].
 */
export function blockSums(
  x: Float64Array,
  bnd: number[],
  omegas: number[],
): { re: Float64Array; im: Float64Array } {
  const nb = bnd.length - 1;
  const nt = omegas.length;
  const re = new Float64Array(nb * nt);
  const im = new Float64Array(nb * nt);
  for (let k = 0; k < nt; k++) {
    const w = omegas[k]!;
    const cr = Math.cos(w);
    const ci = -Math.sin(w);
    for (let b = 0; b < nb; b++) {
      const n0 = bnd[b]!;
      const n1 = bnd[b + 1]!;
      // exact phasor at block start, then rotate (≤ a few hundred steps)
      let pr = Math.cos(w * n0);
      let pi = -Math.sin(w * n0);
      let sr = 0;
      let si = 0;
      for (let n = n0; n < n1; n++) {
        const v = x[n]!;
        sr += v * pr;
        si += v * pi;
        const t = pr * cr - pi * ci;
        pi = pr * ci + pi * cr;
        pr = t;
      }
      re[b * nt + k] = sr;
      im[b * nt + k] = si;
    }
  }
  return { re, im };
}
