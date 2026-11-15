/**
 * Merkle tree (§7.3), used for evidence roots, perception roots and receipts.
 *
 *   merkle([])   = 32 zero bytes
 *   merkle([x])  = x
 *   pair (l, r) → sha256(0x01 ‖ l ‖ r); an odd last node is carried up unchanged
 *
 * Leaves are already hashes (callers hash with a 0x00 prefix).
 */
import { MERKLE_NODE_PREFIX } from '../constants.js';
import type { MerkleProof, MerkleSibling } from '../types.js';
import { bytesEqual, expectLen, fromHex, sha256Bytes, toHex } from './bytes.js';

export function merkleNode(l: Uint8Array, r: Uint8Array): Uint8Array {
  const buf = new Uint8Array(65);
  buf[0] = MERKLE_NODE_PREFIX;
  buf.set(l, 1);
  buf.set(r, 33);
  return sha256Bytes(buf);
}

function checkLeaves(leaves: Uint8Array[]): void {
  for (let i = 0; i < leaves.length; i++) expectLen(leaves[i]!, 32, `leaf ${i}`);
}

function reduceLevel(level: Uint8Array[]): Uint8Array[] {
  const next: Uint8Array[] = [];
  for (let i = 0; i + 1 < level.length; i += 2) next.push(merkleNode(level[i]!, level[i + 1]!));
  if (level.length % 2 === 1) next.push(level[level.length - 1]!);
  return next;
}

/** Root of 32-byte leaves (§7.3). Returns a fresh array (never aliases a leaf). */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  checkLeaves(leaves);
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) level = reduceLevel(level);
  return Uint8Array.from(level[0]!);
}

/** Inclusion proof for leaf `i` (§7.3 JSON shape). Carried-up levels contribute no sibling. */
export function merkleProof(leaves: Uint8Array[], i: number): MerkleProof {
  checkLeaves(leaves);
  if (!Number.isInteger(i) || i < 0 || i >= leaves.length) {
    throw new RangeError(`leaf index ${i} out of range 0..${leaves.length - 1}`);
  }
  const siblings: MerkleSibling[] = [];
  let level = leaves;
  let pos = i;
  while (level.length > 1) {
    const isRight = pos % 2 === 1;
    if (isRight) {
      siblings.push({ hash: toHex(level[pos - 1]!), side: 'L' });
    } else if (pos + 1 < level.length) {
      siblings.push({ hash: toHex(level[pos + 1]!), side: 'R' });
    } // else: odd last node, carried up
    level = reduceLevel(level);
    pos = Math.floor(pos / 2);
  }
  return { leaf: toHex(leaves[i]!), index: i, siblings };
}

/**
 * Expected sibling sides for leaf `index` in a tree of `nLeaves` leaves
 * (carried-up levels omitted).
 */
export function merkleProofSides(nLeaves: number, index: number): ('L' | 'R')[] {
  const sides: ('L' | 'R')[] = [];
  let n = nLeaves;
  let pos = index;
  while (n > 1) {
    if (pos % 2 === 1) sides.push('L');
    else if (pos + 1 < n) sides.push('R');
    n = Math.ceil(n / 2);
    pos = Math.floor(pos / 2);
  }
  return sides;
}

/**
 * Verifies an inclusion proof against `root` (32 bytes or hex). When
 * `nLeaves` is given, the sibling sides are also checked against `index`, so a
 * proof cannot be replayed for another position. Never throws on malformed input.
 */
export function verifyMerkleProof(proof: MerkleProof, root: Uint8Array | string, nLeaves?: number): boolean {
  try {
    const r = typeof root === 'string' ? fromHex(root, 32, 'root') : expectLen(root, 32, 'root');
    let h = fromHex(proof.leaf, 32, 'leaf');
    if (nLeaves !== undefined) {
      if (!Number.isInteger(proof.index) || proof.index < 0 || proof.index >= nLeaves) return false;
      const sides = merkleProofSides(nLeaves, proof.index);
      if (sides.length !== proof.siblings.length) return false;
      for (let k = 0; k < sides.length; k++) if (sides[k] !== proof.siblings[k]!.side) return false;
    }
    for (const s of proof.siblings) {
      const sib = fromHex(s.hash, 32, 'sibling');
      if (s.side === 'L') h = merkleNode(sib, h);
      else if (s.side === 'R') h = merkleNode(h, sib);
      else return false;
    }
    return bytesEqual(h, r);
  } catch {
    return false;
  }
}
