/**
 * TrackBuffer payload (§5.6): `program_bin ‖ calibration_bin ‖ (track_bin | market_bin)`,
 * at most MAX_BUFFER_PAYLOAD bytes. SP1-only payloads omit the third part.
 */
import { KIND_CODE, MAX_BUFFER_PAYLOAD } from '../constants.js';
import { concatBytes } from '../hash/bytes.js';
import type { DecodedCalibration, MarketBinEntry, PayloadParts, TrackBufferData } from '../types.js';
import { readCalibration } from './calibration.js';
import { EngineError } from './errors.js';
import { readMarketBin } from './market.js';
import { type DecodedProgramDetail, readProgram } from './program.js';
import { readTrackBin } from './tracks.js';

/** Concatenate the payload parts; throws `EngineError("BufferTooLarge")` above MAX_BUFFER_PAYLOAD. */
export function buildPayload(programBin: Uint8Array, calibrationBin: Uint8Array, trackBin?: Uint8Array): Uint8Array {
  const parts = trackBin === undefined ? [programBin, calibrationBin] : [programBin, calibrationBin, trackBin];
  const payload = concatBytes(...parts);
  if (payload.length > MAX_BUFFER_PAYLOAD) {
    throw new EngineError('BufferTooLarge', `payload ${payload.length} bytes > ${MAX_BUFFER_PAYLOAD}`);
  }
  return payload;
}

/** A payload split into its parts, each decoded and validated. */
export interface SplitPayload extends PayloadParts {
  program: DecodedProgramDetail;
  calibration: DecodedCalibration;
  /** decoded track_bin (rules / ai_judged), null if absent or market */
  tracks: TrackBufferData | null;
  /** decoded market_bin (market), null otherwise */
  market: MarketBinEntry[] | null;
}

/**
 * Split and decode a payload (§5.6). The program and calibration lengths are
 * self-delimiting; whatever follows is the track_bin (or market_bin for
 * market programs). An empty third part means an SP1-only payload.
 * Throws `BufferTooLarge` or the decoders' `Malformed*` errors.
 */
export function splitPayload(payload: Uint8Array): SplitPayload {
  if (payload.length > MAX_BUFFER_PAYLOAD) {
    throw new EngineError('BufferTooLarge', `payload ${payload.length} bytes > ${MAX_BUFFER_PAYLOAD}`);
  }
  const { end: progEnd, ...program } = readProgram(payload, 0);
  const { calibration, end: calEnd } = readCalibration(payload, program.program, progEnd);
  const program_bin = payload.slice(0, progEnd);
  const calibration_bin = payload.slice(progEnd, calEnd);
  if (calEnd === payload.length) {
    return { program_bin, calibration_bin, program, calibration, tracks: null, market: null };
  }
  const tracks_bin = payload.slice(calEnd);
  if (program.program.kind === KIND_CODE.market) {
    return { program_bin, calibration_bin, tracks_bin, program, calibration, tracks: null, market: readMarketBin(tracks_bin) };
  }
  return {
    program_bin,
    calibration_bin,
    tracks_bin,
    program,
    calibration,
    tracks: readTrackBin(tracks_bin, program.program),
    market: null,
  };
}
