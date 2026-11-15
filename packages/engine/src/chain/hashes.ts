/**
 * Hashes the onchain program computes itself (§4.2 terms_hash / bio_hash,
 * §7.2 G_w, §7.3 Merkle, §7.4 evidence leaves and roots).
 */
import { BN254_R, HEAD_INDEX_NONE } from '../constants.js';
import type { BioCheck, Hex32, Pubkey } from '../types.js';
import { ascii, BorshWriter, concatBytes, hash32, pubkeyBytes, sha256 } from './bytes.js';

/** BN254 scalar field modulus r (§8.4: commitments must be < r). */
export { BN254_R };

/** No-chunks witness head index (§7.4). */
export const HEAD_NONE = HEAD_INDEX_NONE;

export function u32le(v: number): Uint8Array {
  return new BorshWriter(4).u32(v).toBytes();
}

/** §7.2 `G_w = sha256("VERDICT/CHAIN/v1" ‖ bet ‖ witness_key ‖ u8 kind ‖ u64 beacon_slot ‖ beacon_hash)`. */
export function genesisHash(
  bet: Pubkey,
  witnessKey: Pubkey,
  kind: number,
  beaconSlot: bigint,
  beaconHash: Hex32 | Uint8Array,
): Uint8Array {
  const w = new BorshWriter(128)
    .raw(ascii('VERDICT/CHAIN/v1'))
    .pubkey(bet)
    .pubkey(witnessKey)
    .u8(kind)
    .u64(beaconSlot)
    .hash(beaconHash);
  return sha256(w.toBytes());
}

/** §7.4 `leaf_w = sha256(0x00 ‖ witness_key ‖ u32 index ‖ hash)`. */
export function headLeaf(witnessKey: Pubkey, index: number, hash: Hex32 | Uint8Array): Uint8Array {
  return sha256(new Uint8Array([0]), pubkeyBytes(witnessKey), u32le(index), hash32(hash));
}

/** §7.3 Merkle root: pairs hashed with 0x01 prefix; an odd last node is carried up. */
export function merkle(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves.slice();
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha256(new Uint8Array([1]), level[i]!, level[i + 1]!));
      else next.push(level[i]!);
    }
    level = next;
  }
  return level[0]!;
}

/** §7.4 root over witness heads, in witness order. */
export function headsRoot(heads: { key: Pubkey; index: number; hash: Hex32 | Uint8Array }[]): Uint8Array {
  return merkle(heads.map((h) => headLeaf(h.key, h.index, h.hash)));
}

/** §4.2 terms_hash. */
export function termsHashOf(oracle: Pubkey, judges: Pubkey[], acceptanceAudioHash: Hex32 | Uint8Array): Uint8Array {
  if (judges.length !== 3) throw new Error('terms_hash: exactly 3 judges');
  return sha256(
    ascii('VERDICT/TERMS/v1'),
    pubkeyBytes(oracle),
    pubkeyBytes(judges[0]!),
    pubkeyBytes(judges[1]!),
    pubkeyBytes(judges[2]!),
    hash32(acceptanceAudioHash),
  );
}

/** Borsh bytes of one BioCheck (6 bytes). */
export function bioCheckBytes(b: BioCheck): Uint8Array {
  return new BorshWriter(6).u8(b.participant).u8(b.modality).u32(b.frame).toBytes();
}

/** §4.2 `bio_hash = sha256(u8 n_bio ‖ bio[0..n_bio])`. */
export function bioHashOf(bio: BioCheck[]): Uint8Array {
  return sha256(new Uint8Array([bio.length]), concatBytes(...bio.map(bioCheckBytes)));
}

/** Big-endian unsigned integer of a byte string. */
export function beToBigInt(b: Uint8Array): bigint {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
}

/** 32-byte big-endian encoding. */
export function bigIntToBe32(x: bigint): Uint8Array {
  if (x < 0n || x >= 1n << 256n) throw new Error('value does not fit 32 bytes');
  const out = new Uint8Array(32);
  let y = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(y & 0xffn);
    y >>= 8n;
  }
  return out;
}
