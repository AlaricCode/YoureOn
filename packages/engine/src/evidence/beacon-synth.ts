/**
 * 16-FSK beacon synthesis (§7.5). Floats are allowed here (not consensus).
 *
 * For symbol j and sample n within the symbol (0 ≤ n < N, N = 2400 at 48 kHz):
 *   s = 0.25 · env(n) · sin(2π · f_k · n / sampleRate),   f_k = 2000 + 250·k
 *   PCM16 = round(32767 · s)
 * env: linear ramp over R = 240 samples (at 48 kHz) at each edge, mirror-symmetric:
 *   env(n) = n/R for n < R, (N−1−n)/R for n ≥ N−R, else 1   (see CONTRACTS-ERRATA, App note)
 * Phase resets each symbol. Rounding is half away from zero.
 */
import {
  BEACON_AMPLITUDE,
  BEACON_RAMP_SAMPLES,
  BEACON_SAMPLE_RATE,
  BEACON_SYMBOL_MS,
  BEACON_SYMBOL_SAMPLES,
  BEACON_TONE_BASE_HZ,
  BEACON_TONE_STEP_HZ,
} from '../constants.js';
import { validTone } from './beacon-payload.js';

export function toneHz(k: number): number {
  return BEACON_TONE_BASE_HZ + BEACON_TONE_STEP_HZ * k;
}

/** Samples per 50 ms symbol at `sampleRate` (2400 at 48 kHz). */
export function symbolSamples(sampleRate: number): number {
  if (sampleRate === BEACON_SAMPLE_RATE) return BEACON_SYMBOL_SAMPLES;
  return Math.round((sampleRate * BEACON_SYMBOL_MS) / 1000);
}

/** Ramp length at each symbol edge (240 at 48 kHz, i.e. 5 ms). */
export function rampSamples(sampleRate: number): number {
  if (sampleRate === BEACON_SAMPLE_RATE) return BEACON_RAMP_SAMPLES;
  return Math.max(1, Math.round((sampleRate * BEACON_RAMP_SAMPLES) / BEACON_SAMPLE_RATE));
}

function roundHalfAway(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

/** Synthesizes the beacon tones as PCM16 mono. Normative at 48 kHz. */
export function synthBeacon(symbols: number[], sampleRate: number = BEACON_SAMPLE_RATE): Int16Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new RangeError(`unsupported sample rate ${sampleRate}`);
  }
  for (const k of symbols) if (!validTone(k)) throw new RangeError(`invalid tone index ${k}`);
  const N = symbolSamples(sampleRate);
  const R = rampSamples(sampleRate);
  const out = new Int16Array(N * symbols.length);
  for (let j = 0; j < symbols.length; j++) {
    const f = toneHz(symbols[j]!);
    const base = j * N;
    for (let n = 0; n < N; n++) {
      const env = n < R ? n / R : N - 1 - n < R ? (N - 1 - n) / R : 1;
      // same evaluation order as the app (bit-identical PCM at 48 kHz)
      const s = BEACON_AMPLITUDE * env * Math.sin((2 * Math.PI * f * n) / sampleRate);
      out[base + n] = roundHalfAway(32767 * s);
    }
  }
  return out;
}
