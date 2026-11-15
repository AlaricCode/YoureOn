/**
 * Closed-set matching and the circuit predicate (§8.3).
 *
 *   dot = Σ e_i·o_i, ne = Σ e_i², no = Σ o_i²
 *   cos_bps = 0 if dot ≤ 0 or ne = 0 or no = 0 else floor(dot·10000 / isqrt(ne·no))
 *   matched iff cos1 ≥ τ_m and cos1 − cos2 ≥ δ_m
 *   circuitMatch(e,o,τ) := dot > 0 && dot²·10^8 ≥ τ²·ne·no   (bigint)
 */
import { DELTA_FACE_BPS, DELTA_VOICE_BPS, EMB_CLAMP, TAU_FACE_BPS, TAU_VOICE_BPS } from '../constants.js';
import type { ClosedSetMatch, MatchCandidate, Modality } from '../types.js';
import { isqrtBig } from './math.js';

export type QVector = Int8Array | number[];

export function modalityThresholds(modality: Modality): { tau: number; delta: number } {
  if (modality === 'face') return { tau: TAU_FACE_BPS, delta: DELTA_FACE_BPS };
  if (modality === 'voice') return { tau: TAU_VOICE_BPS, delta: DELTA_VOICE_BPS };
  throw new RangeError(`unknown modality ${String(modality)}`);
}

/**
 * Integer dot products. Vectors of different length are zero-extended (a
 * 128-d face vector equals its 192-d zero-padded form).
 * Bounds: |dot|, ne, no ≤ 192·127² < 2^22, so plain numbers are exact.
 */
export function dotStats(e: QVector, o: QVector): { dot: number; ne: number; no: number } {
  const n = Math.max(e.length, o.length);
  let dot = 0;
  let ne = 0;
  let no = 0;
  for (let i = 0; i < n; i++) {
    const a = i < e.length ? e[i]! : 0;
    const b = i < o.length ? o[i]! : 0;
    if (!Number.isInteger(a) || !Number.isInteger(b) || Math.abs(a) > EMB_CLAMP || Math.abs(b) > EMB_CLAMP) {
      throw new RangeError(`quantized value out of range at ${i}`);
    }
    dot += a * b;
    ne += a * a;
    no += b * b;
  }
  return { dot, ne, no };
}

export function cosineBps(e: QVector, o: QVector): number {
  const { dot, ne, no } = dotStats(e, o);
  if (dot <= 0 || ne === 0 || no === 0) return 0;
  return Number((BigInt(dot) * 10000n) / isqrtBig(BigInt(ne) * BigInt(no)));
}

export function circuitMatch(e: QVector, o: QVector, tau: number): boolean {
  if (!Number.isInteger(tau) || tau < 0) throw new RangeError(`tau must be a non-negative integer, got ${tau}`);
  const { dot, ne, no } = dotStats(e, o);
  if (dot <= 0) return false;
  const d = BigInt(dot);
  const t = BigInt(tau);
  return d * d * 100_000_000n >= t * t * BigInt(ne) * BigInt(no);
}

/** Best/second-best decision from per-candidate scores (ties → lower candidate index). */
export function matchFromScores(
  scores: { candidate: number; cos_bps: number }[],
  modality: Modality,
): { matched: boolean; best: number | null; cos1: number; cos2: number } {
  const { tau, delta } = modalityThresholds(modality);
  let best: { candidate: number; cos_bps: number } | null = null;
  for (const s of scores) {
    if (best === null || s.cos_bps > best.cos_bps || (s.cos_bps === best.cos_bps && s.candidate < best.candidate)) {
      best = s;
    }
  }
  if (best === null) return { matched: false, best: null, cos1: 0, cos2: 0 };
  let cos2 = 0;
  let seen = false;
  for (const s of scores) {
    if (s === best) continue;
    if (!seen || s.cos_bps > cos2) cos2 = s.cos_bps;
    seen = true;
  }
  if (!seen) cos2 = 0;
  const cos1 = best.cos_bps;
  return { matched: cos1 >= tau && cos1 - cos2 >= delta, best: best.candidate, cos1, cos2 };
}

/** Closed-set match of observation `o` against enrolled `candidates` (§8.3). */
export function closedSetMatch(o: QVector, candidates: MatchCandidate[], modality: Modality): ClosedSetMatch {
  const scores = candidates.map((c) => ({ candidate: c.candidate, cos_bps: cosineBps(c.template, o) }));
  const m = matchFromScores(scores, modality);
  return { matched: m.matched, best: m.best, cos1: m.cos1, cos2: m.cos2, scores };
}
