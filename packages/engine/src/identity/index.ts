/**
 * Identity (§8): embedding quantization, closed-set match, Poseidon commitment,
 * timeline fusion, person binding, prover input and Groth16 encoding.
 */
export { quantizeEmbedding, normalizeEmbedding, enrollmentTemplate, padToCircuit } from './quantize.js';
export type { FloatVector } from './quantize.js';
export { cosineBps, closedSetMatch, circuitMatch, matchFromScores, dotStats, modalityThresholds } from './match.js';
export type { QVector } from './match.js';
export { packEmbedding, poseidonCommit, saltFromBytes, commitmentToBytes, commitmentFromBytes } from './commit.js';
export { fuseTimeline, fuseTimelineTrace, observationWeight, strictArgmax } from './fusion.js';
export type { FusionTrace } from './fusion.js';
export { bindPersons, referencedEntities } from './bind.js';
export { proverInput, proofTau } from './prover.js';
export type { SegmentedIdObservation, ProverInputOptions } from './prover.js';
export {
  biometricPublicInputs,
  biometricPublicSignals,
  biometricWitness,
  encodeGroth16Proof,
  truncatedField,
} from './groth16.js';

