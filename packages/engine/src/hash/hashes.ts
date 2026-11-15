/**
 * §4.2 hashes that do not depend on the binary encoders.
 *
 * Digests that the rest of the engine stores as JSON (`json_hash`, `scene_hash`,
 * `market_hash`, `model_hash`, `bio_hash`, `terms_hash`) are returned as
 * lowercase hex (§0.2). Byte-level building blocks (`acceptSigMessage`,
 * `acceptanceAudioHash`, its leaves) return `Uint8Array` as specified in §14.
 */
import { MARKET_HASH_PREFIX, MAX_PARTICIPANTS, MIN_PARTICIPANTS, TAG_ACCEPT, TAG_ACCEPT_SIG, TAG_TERMS } from '../constants.js';
import type { BioCheck, Calibration, Hex32, ModelSpec, Program, Pubkey } from '../types.js';
import { type Bytes32Input, bytesToHex, concatBytes, pubkeyToBytes, toBytes32, utf8 } from './bytes.js';
import { canonicalJsonHash } from './canonicalJson.js';
import { sha256 } from './sha256.js';

/**
 * `json_hash = sha256(utf8(canonicalJson(program)))` (§4.2).
 * `p` MUST already be canonical (`canonicalize(p, ctx)`, §2.7); this function
 * does not re-canonicalize (that needs the compile context).
 */
export function jsonHashBytes(p: Program): Uint8Array {
  return canonicalJsonHash(p);
}

/** `json_hash` as lowercase hex. */
export function jsonHash(p: Program): Hex32 {
  return bytesToHex(jsonHashBytes(p));
}

/** `scene_hash = sha256(utf8(canonicalJson(calibration.scene)))` (§4.2). */
export function sceneHashBytes(c: Calibration): Uint8Array {
  return canonicalJsonHash(c.scene);
}

/** `scene_hash` as lowercase hex. */
export function sceneHash(c: Calibration): Hex32 {
  return bytesToHex(sceneHashBytes(c));
}

/** `market_hash = sha256(utf8("gemini:" + event_id + ":" + contract_id))` (§4.2). */
export function marketHashBytes(eventId: string, contractId: string): Uint8Array {
  if (typeof eventId !== 'string' || typeof contractId !== 'string') {
    throw new TypeError('marketHash: event_id and contract_id must be strings');
  }
  return sha256(utf8(MARKET_HASH_PREFIX + eventId + ':' + contractId));
}

/** `market_hash` as lowercase hex. */
export function marketHash(eventId: string, contractId: string): Hex32 {
  return bytesToHex(marketHashBytes(eventId, contractId));
}

/**
 * `model_hash = sha256(utf8(canonicalJson({image, weights_sha256, prompts, settings})))` (§4.2).
 * Only those four keys are hashed; extra keys on `spec` are ignored.
 */
export function modelHash(spec: ModelSpec): Hex32 {
  return bytesToHex(
    canonicalJsonHash({
      image: spec.image,
      weights_sha256: spec.weights_sha256,
      prompts: spec.prompts,
      settings: spec.settings,
    }),
  );
}

function u8(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError(`${what} must be a u8`);
  return n;
}

/** Borsh bytes of one BioCheck: `participant u8 ‖ modality u8 ‖ frame u32 LE` (6 bytes, §9.3). */
export function encodeBioCheck(b: BioCheck): Uint8Array {
  const out = new Uint8Array(6);
  out[0] = u8(b.participant, 'BioCheck.participant');
  out[1] = u8(b.modality, 'BioCheck.modality');
  if (!Number.isInteger(b.frame) || b.frame < 0 || b.frame > 0xffffffff) {
    throw new RangeError('BioCheck.frame must be a u32');
  }
  new DataView(out.buffer).setUint32(2, b.frame, true);
  return out;
}

/** `bio_hash = sha256(u8 n_bio ‖ bio[0..n_bio])` (§4.2), lowercase hex. `bio` holds exactly the n_bio used entries. */
export function bioHash(bio: readonly BioCheck[]): Hex32 {
  const n = u8(bio.length, 'n_bio');
  return bytesToHex(sha256(concatBytes(Uint8Array.of(n), ...bio.map(encodeBioCheck))));
}

/**
 * Message signed with `accept_sig` (§4.2):
 * `"VERDICT/ACCEPT-SIG/v1" ‖ program_hash[32] ‖ sha256(wav)[32]`.
 */
export function acceptSigMessage(programHash: Bytes32Input, wav: Uint8Array): Uint8Array {
  return concatBytes(utf8(TAG_ACCEPT_SIG), toBytes32(programHash, 'program_hash'), sha256(wav));
}

/** `h_0 = sha256(creator dictation WAV)`, or 32 zero bytes when the bet was typed (`wav` null/undefined). */
export function acceptanceCreatorLeaf(wav: Uint8Array | null | undefined): Uint8Array {
  return wav == null ? new Uint8Array(32) : sha256(wav);
}

/** `h_i = sha256(sha256(wav_i) ‖ accept_sig_i[64])` for i ≥ 1. */
export function acceptanceLeaf(wav: Uint8Array, acceptSig: Uint8Array): Uint8Array {
  if (acceptSig.length !== 64) throw new TypeError('accept_sig must be 64 bytes');
  return sha256(concatBytes(sha256(wav), acceptSig));
}

/**
 * `acceptance_audio_hash = sha256("VERDICT/ACCEPT/v1" ‖ u8 P ‖ h_0 ‖ … ‖ h_{P-1})` for rules/ai_judged (§4.2).
 * `h` are the per-participant leaves (see `acceptanceCreatorLeaf`, `acceptanceLeaf`).
 * Market bets use 32 zero bytes instead (not computed here).
 */
export function acceptanceAudioHash(h: readonly Uint8Array[]): Uint8Array {
  if (h.length < MIN_PARTICIPANTS || h.length > MAX_PARTICIPANTS) {
    throw new RangeError(`acceptanceAudioHash: need ${MIN_PARTICIPANTS}..${MAX_PARTICIPANTS} leaves`);
  }
  const leaves = h.map((x, i) => toBytes32(x, `h[${i}]`));
  return sha256(concatBytes(utf8(TAG_ACCEPT), Uint8Array.of(h.length), ...leaves));
}

/**
 * `terms_hash = sha256("VERDICT/TERMS/v1" ‖ oracle[32] ‖ judges[0..3][32] ‖ acceptance_audio_hash[32])` (§4.2),
 * lowercase hex.
 */
export function termsHash(
  oracle: Pubkey | Uint8Array,
  judges: readonly (Pubkey | Uint8Array)[],
  acceptanceAudioHashValue: Bytes32Input,
): Hex32 {
  if (judges.length !== 3) throw new RangeError('termsHash: exactly 3 judges required');
  return bytesToHex(
    sha256(
      concatBytes(
        utf8(TAG_TERMS),
        pubkeyToBytes(oracle),
        ...judges.map((j) => pubkeyToBytes(j)),
        toBytes32(acceptanceAudioHashValue, 'acceptance_audio_hash'),
      ),
    ),
  );
}
