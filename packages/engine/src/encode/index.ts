/**
 * Binary encodings (§5): program_bin, calibration_bin, track_bin, market_bin,
 * TrackBuffer payload, plus program_hash / calibration_hash (§4.2).
 */
export { EngineError, isEngineError } from './errors.js';
export { ByteReader, ByteWriter } from './io.js';
export { encodeExpr, encodeCond, decodeExpr, decodeCond, decodeRefByte } from './expr.js';
export type { DecodedExprInfo, DecodedCondInfo } from './expr.js';
export { encodeProgram, decodeProgram, decodeProgramDetail, readProgram, programHash } from './program.js';
export type { DecodedProgramDetail, DecodedLegExprs } from './program.js';
export { encodeCalibration, decodeCalibration, readCalibration, calibrationHash } from './calibration.js';
export type { CalibrationProgramView } from './calibration.js';
export { encodeTrackBin, decodeTrackBin, readTrackBin, recordError } from './tracks.js';
export type { TrackProgramView } from './tracks.js';
export { encodeMarketBin, decodeMarketBin, readMarketBin } from './market.js';
export { buildPayload, splitPayload } from './payload.js';
export type { SplitPayload } from './payload.js';
