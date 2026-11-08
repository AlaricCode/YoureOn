// Deterministic test embeddings (seeded PRNG + §8.2 quantization).

/** mulberry32 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(r) {
  const u = Math.max(r(), 1e-12);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randomUnit(dim, r) {
  const x = Array.from({ length: dim }, () => gaussian(r));
  const n = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
  return x.map((v) => v / n);
}

/** §8.2: q_i = clamp(roundHalfAwayFromZero(x_i·512), -127, 127) on the L2-normalized vector. */
export function quantize(x) {
  const n = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
  return x.map((v) => {
    const s = (v / n) * 512;
    const r = Math.sign(s) * Math.floor(Math.abs(s) + 0.5);
    return Math.max(-127, Math.min(127, r));
  });
}

/** A vector at roughly cosine `cos` from `base` (both unit). */
export function perturb(base, cos, r) {
  const noise = randomUnit(base.length, r);
  const dot = noise.reduce((s, v, i) => s + v * base[i], 0);
  const orth = noise.map((v, i) => v - dot * base[i]);
  const on = Math.sqrt(orth.reduce((s, v) => s + v * v, 0));
  const sin = Math.sqrt(1 - cos * cos);
  return base.map((b, i) => cos * b + (sin * orth[i]) / on);
}

export function bytes(n, r) {
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
}
