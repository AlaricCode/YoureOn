/**
 * Canonical JSON and hashes (§4), byte helpers and CRC-16 (§7.5).
 *
 * `programHash` and `calibrationHash` need the binary encoders and live in
 * `../encode` (re-exported from the package root).
 */
export {
  bytesToHex,
  hexToBytes,
  isHex32,
  toBytes32,
  concatBytes,
  bytesEqual,
  utf8,
  pubkeyToBytes,
  bytesToPubkey,
  zero32,
  ZERO_HASH_HEX,
} from './bytes.js';
export type { Bytes32Input } from './bytes.js';
export { sha256, sha256Concat, sha256Hex } from './sha256.js';
export { crc16CcittFalse, crc16CcittFalseBytes } from './crc16.js';
export {
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonHash,
  canonicalJsonHashHex,
  CanonicalJsonError,
} from './canonicalJson.js';
export {
  jsonHash,
  jsonHashBytes,
  sceneHash,
  sceneHashBytes,
  marketHash,
  marketHashBytes,
  modelHash,
  encodeBioCheck,
  bioHash,
  acceptSigMessage,
  acceptanceCreatorLeaf,
  acceptanceLeaf,
  acceptanceAudioHash,
  termsHash,
} from './hashes.js';
