/**
 * Public evaluation entry points (§3.1, §14):
 * - `evaluate(programBin, calibrationBin, trackBin | marketBin, verified, opts?)`
 * - `evaluateProgram(p, c, buffer, verified)` = encode* + evaluate (§0.4)
 * - `evaluateSession(p, c, session, verified)` = single full segment, maxCost ∞
 *
 * Decode errors (`MalformedProgram`, `MalformedCalibration`, `MalformedTracks`)
 * are thrown by the decoders as `EngineError` (§3.1 step 1).
 */
import type {
  Calibration,
  Checkpoint,
  EvalOptions,
  EvalResult,
  MarketBinEntry,
  Program,
  QFrame,
  SessionTracks,
  TrackBufferData,
  TrackTableEntry,
} from '../types.js';
import { FPS, TAIL_FRAMES } from '../constants.js';
import {
  decodeCalibration,
  decodeMarketBin,
  decodeProgram,
  decodeTrackBin,
  encodeCalibration,
  encodeMarketBin,
  encodeProgram,
  encodeTrackBin,
} from '../encode/index.js';
import { evaluateDecoded } from './core.js';
import { EvalInvariantError } from './math.js';

const KIND_MARKET = 2;

/**
 * Evaluate binaries (§3.1). `tracksBin` is a track_bin for rules / ai_judged
 * programs and a market_bin for market programs.
 */
export function evaluate(
  programBin: Uint8Array,
  calibrationBin: Uint8Array,
  tracksBin: Uint8Array,
  verified: readonly Checkpoint[],
  opts?: EvalOptions,
): EvalResult {
  const p = decodeProgram(programBin);
  const c = decodeCalibration(calibrationBin, p);
  const third: TrackBufferData | MarketBinEntry[] =
    p.kind === KIND_MARKET ? decodeMarketBin(tracksBin) : decodeTrackBin(tracksBin, p);
  return evaluateDecoded(p, c, third, verified, opts);
}

/** `evaluateProgram` = `encodeProgram` + `encodeCalibration` + `encodeTrackBin`/`encodeMarketBin` + `evaluate`. */
export function evaluateProgram(
  p: Program,
  c: Calibration | null,
  buffer: TrackBufferData | readonly MarketBinEntry[],
  verified: readonly Checkpoint[],
  opts?: EvalOptions,
): EvalResult {
  const programBin = encodeProgram(p);
  const calibrationBin = encodeCalibration(c, p);
  const tracksBin = Array.isArray(buffer)
    ? encodeMarketBin(buffer as MarketBinEntry[])
    : encodeTrackBin(buffer as TrackBufferData);
  return evaluate(programBin, calibrationBin, tracksBin, verified, opts);
}

/**
 * Build the single-segment buffer of a full session: tracks for the program's
 * tracked entities (§5.4 [D-43]), frames `[0, min(n_frames, LIMIT + TAIL_FRAMES))`.
 */
export function sessionBuffer(
  trackedEntities: readonly number[],
  timeLimitS: number,
  session: SessionTracks,
): TrackBufferData {
  const tracks: TrackTableEntry[] = [];
  const cols: (QFrame | null)[][] = [];
  for (const ei of trackedEntities) {
    const st = session.tracks.find((t) => t.entity_idx === ei);
    tracks.push({ entity_idx: ei, participant_idx: st?.participant_idx ?? null, ref_h: st?.ref_h ?? 0 });
    cols.push(st?.frames ?? []);
  }
  const n = Math.min(session.n_frames, timeLimitS * FPS + TAIL_FRAMES);
  const frames: (QFrame | null)[][] = [];
  for (let f = 0; f < n; f++) frames.push(cols.map((col) => col[f] ?? null));
  return {
    flags: session.flags,
    model_hash: session.model_hash,
    tracks,
    segments: n > 0 ? [{ frame_start: 0, frames }] : [],
  };
}

/**
 * Evaluate a full session as one segment with `maxCost = ∞` (§14, §6.5 step 1).
 * Program and calibration go through their binary encodings; the session
 * buffer is passed decoded because a full session may exceed the on-chain
 * frame cap (`MAX_EVAL_FRAMES`) that `decodeTrackBin` enforces.
 */
export function evaluateSession(
  p: Program,
  c: Calibration | null,
  session: SessionTracks,
  verified: readonly Checkpoint[],
): EvalResult {
  const dp = decodeProgram(encodeProgram(p));
  if (dp.kind === KIND_MARKET) throw new EvalInvariantError('evaluateSession does not apply to market programs');
  const dc = decodeCalibration(encodeCalibration(c, p), dp);
  const buffer = sessionBuffer(dp.tracked_entities, dp.time_limit_s, session);
  return evaluateDecoded(dp, dc, buffer, verified, { maxCost: Infinity });
}
