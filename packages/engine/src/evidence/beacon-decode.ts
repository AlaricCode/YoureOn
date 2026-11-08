/**
 * 16-FSK beacon decoder (§7.5).
 *
 * 1. Resample into 16–48 kHz.
 * 2. Slide a 50 ms, 16-tone Goertzel bank in 5 ms steps (computed from 5 ms
 *    block-wise demodulated sums, so the scan is O(16·n)).
 * 3. Rank preamble alignments by the energy of the expected preamble tones
 *    (normalized by the energy of all 16 tones, so loud broadband noise does not
 *    win); try the best few.
 * 4. For each symbol take the argmax tone over its middle 40 ms; verify the CRC.
 * 5. Refine the alignment to the sample using the energy of all 42 decoded
 *    tones over full 50 ms windows; t0 = start + 42 symbols.
 */
import {
  BEACON_DECODE_MAX_RATE,
  BEACON_DECODE_MIDDLE_MS,
  BEACON_DECODE_MIN_RATE,
  BEACON_DECODE_STEP_MS,
  BEACON_PREAMBLE,
  BEACON_SYMBOL_MS,
  BEACON_SYMBOLS,
  BEACON_TONES,
} from '../constants.js';
import type { DecodedBeacon } from '../types.js';
import { decodeBeaconPayload, symbolsToPayload } from './beacon-payload.js';
import { toneHz } from './beacon-synth.js';
import { blockSums, goertzelPower, resample, toFloat, type PcmInput } from './dsp.js';

/** Lowest input rate that can carry the top tone (5750 Hz) at all. */
const MIN_INPUT_RATE = 11500;
/** Minimum normalized preamble score (fraction of tone-bank energy in expected tones). */
const MIN_PREAMBLE_SCORE = 0.25;
/** Alignment candidates tried (distinct by ≥ 25 ms). */
const MAX_CANDIDATES = 8;
const CANDIDATE_SEPARATION_STEPS = 5;

export interface DecodeBeaconOptions {
  /** Max candidates to try (default 8). */
  maxCandidates?: number;
}

/** Decodes the beacon from mono PCM; null if none decodes with a valid CRC. */
export function decodeBeacon(
  pcm: PcmInput,
  sampleRate: number,
  opts: DecodeBeaconOptions = {},
): DecodedBeacon | null {
  if (!Number.isFinite(sampleRate) || sampleRate < MIN_INPUT_RATE) return null;
  let rate = sampleRate;
  let x = toFloat(pcm);
  if (sampleRate > BEACON_DECODE_MAX_RATE) rate = BEACON_DECODE_MAX_RATE;
  else if (sampleRate < BEACON_DECODE_MIN_RATE) rate = BEACON_DECODE_MIN_RATE;
  if (rate !== sampleRate) x = resample(x, sampleRate, rate);

  const Ls = (rate * BEACON_SYMBOL_MS) / 1000; // symbol length (float samples)
  const L = Math.round(Ls);
  const step = (rate * BEACON_DECODE_STEP_MS) / 1000;
  const blocksPerSymbol = Math.round(BEACON_SYMBOL_MS / BEACON_DECODE_STEP_MS); // 10
  const total = BEACON_SYMBOLS * Ls;
  if (x.length < total) return null;

  const omegas: number[] = [];
  for (let k = 0; k < BEACON_TONES; k++) omegas.push((2 * Math.PI * toneHz(k)) / rate);

  // ---- coarse scan --------------------------------------------------------
  const bnd: number[] = [];
  for (let b = 0; Math.round(b * step) <= x.length; b++) bnd.push(Math.round(b * step));
  const nb = bnd.length - 1;
  const { re, im } = blockSums(x, bnd, omegas);
  const nt = BEACON_TONES;
  const nWin = nb - blocksPerSymbol + 1;
  if (nWin <= 0) return null;
  // E[s*nt + k] = power of tone k over blocks s .. s+9
  const E = new Float64Array(nWin * nt);
  for (let k = 0; k < nt; k++) {
    let ar = 0;
    let ai = 0;
    for (let b = 0; b < nb; b++) {
      ar += re[b * nt + k]!;
      ai += im[b * nt + k]!;
      if (b >= blocksPerSymbol) {
        ar -= re[(b - blocksPerSymbol) * nt + k]!;
        ai -= im[(b - blocksPerSymbol) * nt + k]!;
      }
      const s = b - blocksPerSymbol + 1;
      if (s >= 0) E[s * nt + k] = ar * ar + ai * ai;
    }
  }
  const pre = BEACON_PREAMBLE.length;
  const scores: { s: number; score: number }[] = [];
  for (let s = 0; s + (pre - 1) * blocksPerSymbol < nWin; s++) {
    const p = bnd[s]!;
    if (p + total - (rate * 5) / 1000 > x.length + 0.5) break; // payload middles must fit
    let num = 0;
    let den = 1e-12;
    for (let j = 0; j < pre; j++) {
      const w = s + j * blocksPerSymbol;
      num += E[w * nt + BEACON_PREAMBLE[j]!]!;
      for (let k = 0; k < nt; k++) den += E[w * nt + k]!;
    }
    const score = num / den;
    if (score >= MIN_PREAMBLE_SCORE) scores.push({ s, score });
  }
  scores.sort((a, b) => b.score - a.score || a.s - b.s);
  const chosen: number[] = [];
  const maxC = opts.maxCandidates ?? MAX_CANDIDATES;
  for (const c of scores) {
    if (chosen.length >= maxC) break;
    if (chosen.some((s) => Math.abs(s - c.s) < CANDIDATE_SEPARATION_STEPS)) continue;
    chosen.push(c.s);
  }

  // ---- decode candidates --------------------------------------------------
  const mid = Math.round((rate * BEACON_DECODE_MIDDLE_MS) / 1000);
  const margin = (Ls - mid) / 2; // 5 ms
  for (const s of chosen) {
    const p0 = bnd[s]!;
    for (const d of [0, -step / 2, step / 2]) {
      const start = p0 + d;
      const symbols = demodulate(x, start, Ls, margin, mid, omegas);
      if (symbols === null) continue;
      const payload = symbolsToPayload(symbols);
      if (payload === null) continue;
      const parsed = decodeBeaconPayload(payload);
      if (parsed === null) continue;
      const refined = refine(x, start, Ls, L, step, symbols, omegas);
      const t0Work = refined + total;
      const t0Sample = Math.round((t0Work * sampleRate) / rate);
      return { slot: parsed.slot, hashPrefix: parsed.hashPrefix, t0Sample };
    }
  }
  return null;
}

/** Argmax tone over the middle 40 ms of each of the 42 symbols starting at `start`. */
function demodulate(
  x: Float64Array,
  start: number,
  Ls: number,
  margin: number,
  mid: number,
  omegas: number[],
): number[] | null {
  const out: number[] = [];
  for (let j = 0; j < BEACON_SYMBOLS; j++) {
    const a = Math.round(start + j * Ls + margin);
    if (a < 0 || a + mid > x.length) return null;
    let best = -1;
    let bestP = -1;
    for (let k = 0; k < omegas.length; k++) {
      const pw = goertzelPower(x, a, mid, omegas[k]!);
      if (pw > bestP) {
        bestP = pw;
        best = k;
      }
    }
    out.push(best);
  }
  return out;
}

/** Total energy of the decoded tones over full 50 ms windows at alignment `start`. */
function alignedEnergy(x: Float64Array, start: number, Ls: number, L: number, symbols: number[], omegas: number[]): number {
  let e = 0;
  for (let j = 0; j < symbols.length; j++) {
    const a = Math.round(start + j * Ls);
    if (a < 0 || a + L > x.length) return -1;
    e += goertzelPower(x, a, L, omegas[symbols[j]!]!);
  }
  return e;
}

/** Sample-level alignment refinement around `start` (±1 coarse step). */
function refine(
  x: Float64Array,
  start: number,
  Ls: number,
  L: number,
  step: number,
  symbols: number[],
  omegas: number[],
): number {
  let best = start;
  let bestE = alignedEnergy(x, start, Ls, L, symbols, omegas);
  const coarse = Math.max(1, Math.round(step / 10)); // 0.5 ms grid
  for (let d = -Math.ceil(step); d <= Math.ceil(step); d += coarse) {
    const e = alignedEnergy(x, start + d, Ls, L, symbols, omegas);
    if (e > bestE) {
      bestE = e;
      best = start + d;
    }
  }
  const center = best;
  for (let d = -coarse; d <= coarse; d++) {
    const e = alignedEnergy(x, center + d, Ls, L, symbols, omegas);
    if (e > bestE) {
      bestE = e;
      best = center + d;
    }
  }
  return best;
}
