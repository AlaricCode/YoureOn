import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { perceptionLeaf, perceptionRoot, perceptionRootBytes, simulate } from '../src/perception/index.js';
import { merkleRoot } from '../src/evidence/merkle.js';
import type { QFrame, SessionTracks } from '../src/types.js';
import { cupTower, cupTowerCalibration } from './perception-fixtures.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const rec: QFrame = { x0: 0x0102, y0: 0x0304, x1: 0x0506, y1: 0x0708, conf: 90, fill: 11, id_conf: 66, pose: 5 };

function session(n: number, frames: (QFrame | null)[][]): SessionTracks {
  return {
    fps: 10,
    n_frames: n,
    model_hash: '00'.repeat(32),
    flags: 0,
    tracks: frames.map((f, i) => ({ entity: `e${i}`, entity_idx: i, participant_idx: null, ref_h: 0, frames: f })),
  };
}

describe('perception root (§6.4)', () => {
  it('leaf = sha256(0x00 ‖ u32 f ‖ records…), absent = 12 zero bytes, little-endian fields', () => {
    const s = session(2, [[rec, null], [null, rec]]);
    const expected0 = Uint8Array.from([0x00, 0, 0, 0, 0, 0x02, 0x01, 0x04, 0x03, 0x06, 0x05, 0x08, 0x07, 90, 11, 66, 5, ...new Array(12).fill(0)]);
    expect(hex(perceptionLeaf(s, 0))).toBe(hex(sha256(expected0)));
    const expected1 = Uint8Array.from([0x00, 1, 0, 0, 0, ...new Array(12).fill(0), 0x02, 0x01, 0x04, 0x03, 0x06, 0x05, 0x08, 0x07, 90, 11, 66, 5]);
    expect(hex(perceptionLeaf(s, 1))).toBe(hex(sha256(expected1)));
  });

  it('root = §7.3 Merkle over every session frame', () => {
    for (const n of [1, 2, 3, 5]) {
      const s = session(n, [Array.from({ length: n }, (_, f) => (f % 2 ? rec : null))]);
      const leaves = Array.from({ length: n }, (_, f) => perceptionLeaf(s, f));
      expect(perceptionRoot(s)).toBe(hex(merkleRoot(leaves)));
    }
    const one = session(1, [[rec]]);
    expect(perceptionRoot(one)).toBe(hex(perceptionLeaf(one, 0)));
  });

  it('empty session ⇒ 32 zero bytes', () => {
    expect(perceptionRoot(session(0, [[]]))).toBe('00'.repeat(32));
  });

  it('covers unreferenced entities too (all SessionTracks.tracks)', () => {
    const p = cupTower();
    const { a } = simulate(p, cupTowerCalibration, 'pass', 1);
    const fanMoved: SessionTracks = { ...a, tracks: a.tracks.map((t) => (t.entity === 'fan' ? { ...t, frames: t.frames.map((r) => (r ? { ...r, x0: r.x0 + 1 } : r)) } : t)) };
    expect(perceptionRoot(fanMoved)).not.toBe(perceptionRoot(a));
    expect(perceptionRootBytes(a)).toHaveLength(32);
    expect(perceptionRoot(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
