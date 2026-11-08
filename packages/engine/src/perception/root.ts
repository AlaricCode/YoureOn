/**
 * §6.4 perception root:
 *   leaf_f = sha256(0x00 ‖ u32 f ‖ rec(track_0,f) ‖ … ‖ rec(track_{T'-1},f))
 * for every session frame f = 0..n_frames-1, over all SessionTracks.tracks in
 * entity order (absent = 12 zero bytes), reduced with the §7.3 Merkle tree.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { MERKLE_LEAF_PREFIX, TRACK_RECORD_BYTES } from '../constants.js';
import { merkleRoot } from '../evidence/merkle.js';
import type { Hex32, QFrame, SessionTracks } from '../types.js';

/** 12-byte §5.4 record (absent ⇒ zeros). */
export function writeRecord(out: Uint8Array, off: number, r: QFrame | null | undefined): void {
  if (!r || r.conf === 0) {
    out.fill(0, off, off + TRACK_RECORD_BYTES);
    return;
  }
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint16(off, r.x0, true);
  dv.setUint16(off + 2, r.y0, true);
  dv.setUint16(off + 4, r.x1, true);
  dv.setUint16(off + 6, r.y1, true);
  out[off + 8] = r.conf;
  out[off + 9] = r.fill;
  out[off + 10] = r.id_conf;
  out[off + 11] = r.pose;
}

/** `leaf_f` of §6.4. */
export function perceptionLeaf(session: SessionTracks, f: number): Uint8Array {
  const T = session.tracks.length;
  const buf = new Uint8Array(1 + 4 + TRACK_RECORD_BYTES * T);
  buf[0] = MERKLE_LEAF_PREFIX;
  new DataView(buf.buffer).setUint32(1, f >>> 0, true);
  session.tracks.forEach((t, j) => writeRecord(buf, 5 + TRACK_RECORD_BYTES * j, t.frames[f] ?? null));
  return sha256(buf);
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Perception root as raw bytes. */
export function perceptionRootBytes(session: SessionTracks): Uint8Array {
  const leaves: Uint8Array[] = [];
  for (let f = 0; f < session.n_frames; f++) leaves.push(perceptionLeaf(session, f));
  return merkleRoot(leaves);
}

/** Perception root as lowercase hex (§0.2). */
export function perceptionRoot(session: SessionTracks): Hex32 {
  return toHex(perceptionRootBytes(session));
}
