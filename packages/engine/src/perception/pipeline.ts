/**
 * The offchain perception pipeline of §1 for one bet, end to end and pure:
 *   perception ×2 → crossCheck → seal host A → (identity proofs) →
 *   extractDecisiveWindows → track_bin → evaluate.
 *
 * Used with `simulate` as the mock perception provider (§13); the backend runs
 * the same steps with real hosts. "Verified" checkpoints are the full-session
 * checkpoints, as if every identity proof succeeded (failing identity still
 * surfaces through `id_conf`, §3.8).
 */
import { TRACK_FLAG_WINDOW_UNAVAILABLE } from '../constants.js';
import { encodeCalibration, encodeProgram, encodeTrackBin } from '../encode/index.js';
import { evaluate } from '../eval/index.js';
import type {
  Calibration,
  Checkpoint,
  CrossCheckResult,
  EvalResult,
  MockScenario,
  Program,
  SessionTracks,
  SimulateResult,
  TrackBufferData,
} from '../types.js';
import { crossCheck, crossCheckEval, sealSession } from './crosscheck.js';
import { trackedEntityIndices } from './program-info.js';
import { simulate } from './simulate/index.js';
import { extractDecisiveWindows } from './windows.js';

export interface PipelineResult {
  sim: SimulateResult;
  cross: CrossCheckResult;
  sealed: SessionTracks;
  verified: Checkpoint[];
  /** decisive-window buffer, or the bit3 (`window_unavailable`) buffer when extraction failed */
  buffer: TrackBufferData;
  window_unavailable: boolean;
  track_bin: Uint8Array;
  result: EvalResult;
}

/** track_bin with `T` tracks, `S = 0` and flags bit3 (§6.5 step 3 fallback). */
export function windowUnavailableBuffer(p: Program, sealed: SessionTracks): TrackBufferData {
  return {
    flags: sealed.flags | TRACK_FLAG_WINDOW_UNAVAILABLE,
    model_hash: sealed.model_hash,
    tracks: trackedEntityIndices(p).map((ei) => {
      const st = sealed.tracks.find((t) => t.entity_idx === ei);
      return { entity_idx: ei, participant_idx: st?.participant_idx ?? null, ref_h: st?.ref_h ?? 0 };
    }),
    segments: [],
  };
}

/** Run the pipeline on already-perceived host sessions. */
export function runPerceptionPipeline(sim: SimulateResult, p: Program, c: Calibration | null): PipelineResult {
  const cross = crossCheck(sim.a, sim.b, p, c);
  const sealed = sealSession(sim.a, cross);
  const verified = crossCheckEval(p, c, sealed).checkpoints;
  const extracted = extractDecisiveWindows(p, c, sealed, verified);
  const buffer = extracted ?? windowUnavailableBuffer(p, sealed);
  const programBin = encodeProgram(p);
  const calibrationBin = encodeCalibration(c, p);
  const track_bin = encodeTrackBin(buffer);
  const result = evaluate(programBin, calibrationBin, track_bin, verified);
  return { sim, cross, sealed, verified, buffer, window_unavailable: extracted === null, track_bin, result };
}

/** `simulate` + `runPerceptionPipeline`. */
export function simulatePipeline(p: Program, c: Calibration | null, scenario: MockScenario, seed: number): PipelineResult {
  return runPerceptionPipeline(simulate(p, c, scenario, seed), p, c);
}
