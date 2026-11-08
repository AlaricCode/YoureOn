/**
 * Perception post-processing (§6): quantizeSession, crossCheck,
 * perceptionRoot, extractDecisiveWindows, and the mock provider `simulate` (§13).
 *
 * Non-consensus but deterministic: no clocks, no randomness (seeded PRNG only).
 */
export { quantizeSession, quantizePersonTracks, refHeight } from './quantize.js';
export { crossCheck, sealSession, phoneAgreementBps, trackAgreementBps } from './crosscheck.js';
export type { PhoneDetections } from './crosscheck.js';
export { perceptionRoot, perceptionRootBytes, perceptionLeaf } from './root.js';
export { extractDecisiveWindows } from './windows.js';
export type { ExtractAttempt, FrameWindow } from './windows.js';
export { simulate, MOCK_MODEL_HASH } from './simulate/index.js';
export { simulatePipeline, runPerceptionPipeline, windowUnavailableBuffer } from './pipeline.js';
export type { PipelineResult } from './pipeline.js';
