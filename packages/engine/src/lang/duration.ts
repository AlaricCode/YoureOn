/**
 * Durations (§0.4, §2.5.1, §2.8, §2.9).
 *
 * Source: `[0-9]{1,5}(\.[0-9]{1,3})?s` or `[0-9]{1,7}ms`.
 * Conversion: `frames = ceil(ms * FPS / 1000)` (integer arithmetic only).
 */
import { FPS } from '../constants.js';

/** A full duration string (the DUR token, anchored). */
export const DURATION_RE = /^(?:([0-9]{1,5})(?:\.([0-9]{1,3}))?s|([0-9]{1,7})ms)$/;

/** Duration text → milliseconds. Throws on malformed text. */
export function durationToMs(text: string): number {
  const m = DURATION_RE.exec(text);
  if (!m) throw new Error(`malformed duration ${JSON.stringify(text)}`);
  if (m[3] !== undefined) return Number(m[3]);
  const whole = Number(m[1]);
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(3, '0'));
  return whole * 1000 + frac;
}

/** `ceil(ms * FPS / 1000)`. */
export function msToFrames(ms: number): number {
  const num = ms * FPS;
  return Math.trunc((num + 999) / 1000);
}

/** Duration text → frames. */
export function durationToFrames(text: string): number {
  return msToFrames(durationToMs(text));
}

/** Canonical YAML duration (§2.9): `{frames/10}s`, one decimal if needed. */
export function framesToYamlDuration(frames: number): string {
  const whole = Math.trunc(frames / FPS);
  const tenth = frames % FPS;
  return tenth === 0 ? `${whole}s` : `${whole}.${tenth}s`;
}

/**
 * Read-back duration (§2.8): `"{n}s"` (one decimal if `frames % 10 ≠ 0`),
 * or `"{m}m {s}s"` / `"{m}m"` for whole seconds ≥ 60.
 */
export function framesToReadback(frames: number): string {
  const tenth = frames % FPS;
  const secs = Math.trunc(frames / FPS);
  if (tenth !== 0) return `${secs}.${tenth}s`;
  if (secs >= 60) {
    const m = Math.trunc(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  return `${secs}s`;
}
