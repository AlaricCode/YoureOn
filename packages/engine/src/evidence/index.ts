/**
 * Evidence integrity (§7): hash chains, Merkle trees, rolling roots,
 * freshness beacon (16-FSK) and the advisory audio cross-check.
 */
export { chainGenesis, chunkHash, chunkSigMessage, verifyChunkSig, verifyChain } from './chain.js';
export type { ChunkRecord, ChainIssue, ChainVerification } from './chain.js';
export { merkleRoot, merkleProof, verifyMerkleProof, merkleNode, merkleProofSides } from './merkle.js';
export { evidenceLeaf, evidenceRoot, evidenceHeadProof, emptyWitnessHead, checkHeadUpdate } from './roots.js';
export type { HeadUpdateResult } from './roots.js';
export { verifyExhibitChainProof, recomputeLinks } from './exhibit.js';
export type { ExhibitProofContext, ExhibitProofResult } from './exhibit.js';
export { encodeBeaconPayload, decodeBeaconPayload, beaconSymbols, symbolsToPayload } from './beacon-payload.js';
export { synthBeacon, toneHz } from './beacon-synth.js';
export { decodeBeacon } from './beacon-decode.js';
export type { DecodeBeaconOptions } from './beacon-decode.js';
export type { PcmInput } from './dsp.js';
export {
  audioCrossCheck,
  isImpactTag,
  scribeToSessionTime,
  beaconOffsetMs,
  AUDIO_TOLERANCE_MS,
  AUDIO_CHECK_EVENTS,
  AUDIO_DISAGREE_EVENTS,
} from './audio.js';
export type { DecisiveEvent, AudioEventCheck, AudioCrossCheckResult } from './audio.js';
