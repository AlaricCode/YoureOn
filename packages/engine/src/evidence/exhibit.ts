/**
 * Exhibit chain proofs (§10.1): tie an exhibit's footage to the final
 * `evidence_root`.
 *
 * Verification recomputes `c_from … c_head` from `links` (starting from
 * `c_{from-1}`, carried as the first link's `prev`, or `G_w` when
 * `from_index = 0`), checks `leaf_w` (§7.4) against `head_proof.leaf`, then
 * checks `head_proof` against the evidence root.
 */
import { HEAD_INDEX_NONE } from '../constants.js';
import type { ChainGenesisArgs, ChainLink, ExhibitChainProof, Hex32, Pubkey } from '../types.js';
import { bytesEqual, fromHex, toHex } from './bytes.js';
import { chainGenesis, chunkHash } from './chain.js';
import { verifyMerkleProof } from './merkle.js';
import { evidenceLeaf } from './roots.js';

export interface ExhibitProofContext {
  /** the witness's ed25519 key (base58), from `Bet.witnesses[w]` */
  witness_key: Pubkey;
  /** the final `Bet.evidence_root` (hex or 32 bytes) */
  evidence_root: Hex32 | Uint8Array;
  /** genesis inputs (needed when `from_index = 0`); the witness kind comes from the links */
  genesis?: Omit<ChainGenesisArgs, 'witness_key' | 'kind'>;
  /** number of witnesses (leaves); when given, the proof's shape is checked too */
  n_witnesses?: number;
}

export type ExhibitProofResult =
  | { ok: true; head_index: number; head_hash: Hex32; chunk_hashes: Hex32[] }
  | { ok: false; reason: string };

function fail(reason: string): ExhibitProofResult {
  return { ok: false, reason };
}

/** Recompute the chain `c_from … c_head` from `links`. */
export function recomputeLinks(
  fromIndex: number,
  links: readonly ChainLink[],
  prev: Uint8Array,
): { ok: true; hashes: Uint8Array[] } | { ok: false; reason: string } {
  if (links.length === 0) return { ok: false, reason: 'no links' };
  const hashes: Uint8Array[] = [];
  let c = prev;
  for (let i = 0; i < links.length; i++) {
    const l = links[i]!;
    if (l.index !== fromIndex + i) return { ok: false, reason: `link ${i}: index ${l.index}, expected ${fromIndex + i}` };
    if (l.kind !== links[0]!.kind) return { ok: false, reason: `link ${i}: kind changes within one witness chain` };
    if (i > 0 && l.prev !== undefined) return { ok: false, reason: `link ${i}: only the first link may carry prev` };
    try {
      c = chunkHash({
        prev: c,
        index: l.index,
        kind: l.kind as 0 | 1 | 2,
        start_ms: l.start_ms,
        duration_ms: l.duration_ms,
        body_sha256: fromHex(l.body_sha256, 32, 'body_sha256'),
      });
    } catch (e) {
      return { ok: false, reason: `link ${i}: ${(e as Error).message}` };
    }
    hashes.push(c);
  }
  return { ok: true, hashes };
}

/** Verify one `chain_proofs` entry of an exhibit (§10.1). */
export function verifyExhibitChainProof(proof: ExhibitChainProof, ctx: ExhibitProofContext): ExhibitProofResult {
  const { from_index, links } = proof;
  if (!Number.isInteger(from_index) || from_index < 0 || from_index >= HEAD_INDEX_NONE) return fail('bad from_index');
  if (links.length === 0) return fail('no links');
  let prev: Uint8Array;
  try {
    if (from_index === 0) {
      if (links[0]!.prev !== undefined) return fail('from_index 0 starts at G_w; the first link must not carry prev');
      if (!ctx.genesis) return fail('genesis inputs are required when from_index = 0');
      prev = chainGenesis({ ...ctx.genesis, witness_key: ctx.witness_key, kind: links[0]!.kind as 0 | 1 | 2 });
    } else {
      if (links[0]!.prev === undefined) return fail('the first link must carry prev = c_{from-1}');
      prev = fromHex(links[0]!.prev, 32, 'prev');
    }
  } catch (e) {
    return fail((e as Error).message);
  }
  const chain = recomputeLinks(from_index, links, prev);
  if (!chain.ok) return fail(chain.reason);
  const headIndex = from_index + links.length - 1;
  const headHash = chain.hashes.at(-1)!;
  let leaf: Uint8Array;
  try {
    leaf = evidenceLeaf({ witness_key: ctx.witness_key, index: headIndex, hash: headHash });
  } catch (e) {
    return fail((e as Error).message);
  }
  let claimed: Uint8Array;
  try {
    claimed = fromHex(proof.head_proof.leaf, 32, 'head_proof.leaf');
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!bytesEqual(leaf, claimed)) return fail('leaf_w does not match head_proof.leaf');
  if (!verifyMerkleProof(proof.head_proof, ctx.evidence_root, ctx.n_witnesses)) return fail('head_proof does not verify against evidence_root');
  return { ok: true, head_index: headIndex, head_hash: toHex(headHash), chunk_hashes: chain.hashes.map(toHex) };
}
