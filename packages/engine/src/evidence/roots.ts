/**
 * Rolling evidence roots (§7.4).
 *
 *   head_w = (index_w, hash_w)   index_w = 0xFFFFFFFF and hash_w = G_w if witness w has no chunks yet
 *   leaf_w = sha256(0x00 ‖ witness_key[32] ‖ u32 index_w ‖ hash_w[32])
 *   root   = merkle([leaf_0 … leaf_{n-1}])   // witness order
 */
import {
  EVIDENCE_MAX_GAP_S,
  HEAD_INDEX_NONE,
  MAX_CHUNKS_PER_COMMIT,
  MAX_WITNESSES,
  MERKLE_LEAF_PREFIX,
} from '../constants.js';
import type { ChainGenesisArgs, WitnessHead } from '../types.js';
import { bytesEqual, concatBytes, expectLen, pubkeyBytes, sha256Bytes, u32le, u8 } from './bytes.js';
import { chainGenesis } from './chain.js';
import { merkleProof, merkleRoot } from './merkle.js';
import type { MerkleProof } from '../types.js';

/** `leaf_w` of one witness head. */
export function evidenceLeaf(head: WitnessHead): Uint8Array {
  return sha256Bytes(
    concatBytes(
      u8(MERKLE_LEAF_PREFIX),
      pubkeyBytes(head.witness_key, 'witness_key'),
      u32le(head.index),
      expectLen(head.hash, 32, 'head hash'),
    ),
  );
}

/** Evidence root over witness heads in witness order (§7.4). */
export function evidenceRoot(heads: WitnessHead[]): Uint8Array {
  if (heads.length > MAX_WITNESSES) throw new RangeError(`at most ${MAX_WITNESSES} witnesses`);
  return merkleRoot(heads.map(evidenceLeaf));
}

/** Inclusion proof of witness `w`'s leaf in the evidence root (Exhibit `head_proof`, §10.1). */
export function evidenceHeadProof(heads: WitnessHead[], w: number): MerkleProof {
  return merkleProof(heads.map(evidenceLeaf), w);
}

/** The head of a witness with no chunks yet: `(0xFFFFFFFF, G_w)`. */
export function emptyWitnessHead(args: ChainGenesisArgs): WitnessHead {
  return { witness_key: args.witness_key, index: HEAD_INDEX_NONE, hash: chainGenesis(args) };
}

/** Index ordering with 0xFFFFFFFF treated as −1 (§7.4). */
function ord(index: number): number {
  return index === HEAD_INDEX_NONE ? -1 : index;
}

export type HeadUpdateResult =
  | { ok: true; gap_mask: number }
  | { ok: false; error: 'EvidenceHeads' | 'EvidenceRegress' };

/**
 * The §7.4 per-witness checks for a `commit_evidence` / oracle `end` head update
 * (advisory mirror of the onchain program; the chain model is authoritative).
 *
 * - exactly one new head per stored head;
 * - new index ≥ old index (0xFFFFFFFF as −1), equal index ⇒ equal hash, else `EvidenceRegress`;
 * - an index jump > MAX_CHUNKS_PER_COMMIT sets the witness's bit in the gap mask;
 * - `secondsSincePrevCommit > EVIDENCE_MAX_GAP_S` sets all witness bits.
 *
 * Returns the gap bits to OR into the stored `gap_mask`.
 */
export function checkHeadUpdate(
  oldHeads: { index: number; hash: Uint8Array }[],
  newHeads: { index: number; hash: Uint8Array }[],
  secondsSincePrevCommit: number,
): HeadUpdateResult {
  if (newHeads.length !== oldHeads.length) return { ok: false, error: 'EvidenceHeads' };
  let mask = 0;
  for (let w = 0; w < oldHeads.length; w++) {
    const o = oldHeads[w]!;
    const n = newHeads[w]!;
    if (!Number.isInteger(n.index) || n.index < 0 || n.index > HEAD_INDEX_NONE) {
      return { ok: false, error: 'EvidenceHeads' };
    }
    const oi = ord(o.index);
    const ni = ord(n.index);
    if (ni < oi) return { ok: false, error: 'EvidenceRegress' };
    if (ni === oi && !bytesEqual(o.hash, n.hash)) return { ok: false, error: 'EvidenceRegress' };
    if (ni - oi > MAX_CHUNKS_PER_COMMIT) mask |= 1 << w;
  }
  if (secondsSincePrevCommit > EVIDENCE_MAX_GAP_S) mask |= (1 << oldHeads.length) - 1;
  return { ok: true, gap_mask: mask };
}
