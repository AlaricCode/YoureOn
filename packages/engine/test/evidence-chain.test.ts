import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  chainGenesis,
  checkHeadUpdate,
  chunkHash,
  chunkSigMessage,
  emptyWitnessHead,
  evidenceHeadProof,
  evidenceLeaf,
  evidenceRoot,
  merkleNode,
  merkleProof,
  merkleProofSides,
  merkleRoot,
  verifyChain,
  verifyChunkSig,
  verifyMerkleProof,
  type ChunkRecord,
} from '../src/evidence/index.js';
import type { WitnessHead } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const h = (s: string) => sha256(enc(s));

const SK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PK = ed25519.getPublicKey(SK);
const WITNESS = bs58.encode(PK);
const BET = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
const BEACON_HASH = h('beacon');

describe('chainGenesis / chunkHash (§7.2)', () => {
  it('G_w matches a hand-built preimage', () => {
    const slot = 0x0102030405060708n;
    const g = chainGenesis({ bet: BET, witness_key: WITNESS, kind: 1, beacon_slot: slot, beacon_hash: BEACON_HASH });
    const pre = cat(
      enc('VERDICT/CHAIN/v1'),
      bs58.decode(BET),
      PK,
      Uint8Array.of(1),
      Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1),
      BEACON_HASH,
    );
    expect(pre.length).toBe(16 + 32 + 32 + 1 + 8 + 32);
    expect(bytesToHex(g)).toBe(bytesToHex(sha256(pre)));
  });

  it('c_i matches a hand-built preimage, including negative i64 start_ms', () => {
    const prev = h('prev');
    const body = h('body');
    const c = chunkHash({ prev, index: 0x01020304, kind: 0, start_ms: -2, duration_ms: 5000, body_sha256: body });
    const pre = cat(
      enc('VERDICT/CHUNK/v1'),
      prev,
      Uint8Array.of(4, 3, 2, 1),
      Uint8Array.of(0),
      Uint8Array.of(0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
      Uint8Array.of(0x88, 0x13, 0, 0),
      body,
    );
    expect(bytesToHex(c)).toBe(bytesToHex(sha256(pre)));
  });

  it('chunkSigMessage = tag ‖ c and signatures verify', () => {
    const c = h('c');
    const m = chunkSigMessage(c);
    expect(bytesToHex(m)).toBe(bytesToHex(cat(enc('VERDICT/CHUNK-SIG/v1'), c)));
    const sig = ed25519.sign(m, SK);
    expect(verifyChunkSig(WITNESS, c, sig)).toBe(true);
    expect(verifyChunkSig(PK, c, sig)).toBe(true);
    expect(verifyChunkSig(WITNESS, h('other'), sig)).toBe(false);
    expect(verifyChunkSig(WITNESS, c, sig.subarray(0, 63))).toBe(false);
    expect(verifyChunkSig('notbase58!', c, sig)).toBe(false);
  });

  it('rejects malformed arguments', () => {
    const base = { prev: h('p'), index: 0, kind: 0 as const, start_ms: 0, duration_ms: 1, body_sha256: h('b') };
    expect(() => chunkHash({ ...base, prev: new Uint8Array(31) })).toThrow();
    expect(() => chunkHash({ ...base, index: -1 })).toThrow();
    expect(() => chunkHash({ ...base, index: 2 ** 32 })).toThrow();
    expect(() => chunkHash({ ...base, duration_ms: 1.5 })).toThrow();
    expect(() => chunkHash({ ...base, kind: 3 as never })).toThrow();
    expect(() =>
      chainGenesis({ bet: BET, witness_key: 'abc', kind: 0, beacon_slot: 1n, beacon_hash: BEACON_HASH }),
    ).toThrow();
    expect(() =>
      chainGenesis({ bet: BET, witness_key: WITNESS, kind: 0, beacon_slot: -1n, beacon_hash: BEACON_HASH }),
    ).toThrow();
  });
});

function buildChain(n: number, starts?: number[]): { g: Uint8Array; records: ChunkRecord[] } {
  const g = chainGenesis({ bet: BET, witness_key: WITNESS, kind: 0, beacon_slot: 7n, beacon_hash: BEACON_HASH });
  const records: ChunkRecord[] = [];
  let prev = g;
  for (let i = 0; i < n; i++) {
    const start_ms = starts ? starts[i]! : i * 5000;
    const body_sha256 = h(`body${i}`);
    const c = chunkHash({ prev, index: i, kind: 0, start_ms, duration_ms: 5000, body_sha256 });
    records.push({
      index: i,
      kind: 0,
      start_ms,
      duration_ms: 5000,
      body_sha256,
      chunk_hash: c,
      prev_hash: prev,
      sig: ed25519.sign(chunkSigMessage(c), SK),
    });
    prev = c;
  }
  return { g, records };
}

describe('verifyChain', () => {
  it('accepts a valid signed chain', () => {
    const { g, records } = buildChain(4);
    const v = verifyChain(g, 0, records, WITNESS);
    expect(v.ok).toBe(true);
    expect(v.valid_prefix).toBe(4);
    expect(v.head.index).toBe(3);
    expect(bytesToHex(v.head.hash)).toBe(bytesToHex(records[3]!.chunk_hash));
    expect(v.gaps_ms).toEqual([]);
    expect(v.gap).toBe(false);
  });
  it('empty chain head is (0xFFFFFFFF, G_w)', () => {
    const { g } = buildChain(0);
    const v = verifyChain(g, 0, []);
    expect(v.ok).toBe(true);
    expect(v.head.index).toBe(0xffffffff);
    expect(v.head.hash).toBe(g);
  });
  it('detects a tampered body hash and truncates the valid prefix', () => {
    const { g, records } = buildChain(4);
    records[2] = { ...records[2]!, body_sha256: h('evil') };
    const v = verifyChain(g, 0, records);
    expect(v.ok).toBe(false);
    expect(v.valid_prefix).toBe(2);
    expect(v.issues.some((i) => i.index === 2 && i.kind === 'hash')).toBe(true);
  });
  it('detects bad signatures, broken links, index gaps', () => {
    const { g, records } = buildChain(3);
    const bad = records.map((r) => ({ ...r }));
    bad[1]!.sig = new Uint8Array(64);
    expect(verifyChain(g, 0, bad, WITNESS).issues).toContainEqual({ index: 1, kind: 'sig' });
    const skip = [records[0]!, records[2]!];
    const v = verifyChain(g, 0, skip);
    expect(v.issues.some((i) => i.kind === 'index')).toBe(true);
    expect(v.valid_prefix).toBe(1);
    const link = records.map((r) => ({ ...r }));
    link[1]!.prev_hash = h('x');
    expect(verifyChain(g, 0, link).issues).toContainEqual({ index: 1, kind: 'prev' });
  });
  it('reports tolerated gaps (≤ 500 ms) and flags larger ones; boundary at exactly 500', () => {
    const { g, records } = buildChain(4, [0, 5500, 11001, 16002]);
    const v = verifyChain(g, 0, records);
    expect(v.gaps_ms).toEqual([500, 1]);
    expect(v.gap).toBe(true);
    expect(v.ok).toBe(true);
  });
  it('flags overlapping chunks and a non-zero first start', () => {
    const { g, records } = buildChain(2, [10, 4000]);
    const v = verifyChain(g, 0, records);
    expect(v.issues).toContainEqual({ index: 0, kind: 'start' });
    expect(v.issues).toContainEqual({ index: 1, kind: 'overlap' });
  });
});

describe('merkle (§7.3)', () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => h(`leaf${i}`));

  it('empty = 32 zero bytes, single = leaf', () => {
    expect(bytesToHex(merkleRoot([]))).toBe('0'.repeat(64));
    const [l] = leaves(1);
    expect(bytesToHex(merkleRoot([l!]))).toBe(bytesToHex(l!));
  });
  it('node = sha256(0x01 ‖ l ‖ r); odd last node is carried up', () => {
    const [a, b, c] = leaves(3) as [Uint8Array, Uint8Array, Uint8Array];
    expect(bytesToHex(merkleNode(a, b))).toBe(bytesToHex(sha256(cat(Uint8Array.of(1), a, b))));
    expect(bytesToHex(merkleRoot([a, b, c]))).toBe(bytesToHex(merkleNode(merkleNode(a, b), c)));
    const l5 = leaves(5);
    const expected = merkleNode(merkleNode(merkleNode(l5[0]!, l5[1]!), merkleNode(l5[2]!, l5[3]!)), l5[4]!);
    expect(bytesToHex(merkleRoot(l5))).toBe(bytesToHex(expected));
  });
  it('proofs verify for every leaf of trees with 1..17 leaves; carried levels have no sibling', () => {
    for (let n = 1; n <= 17; n++) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      for (let i = 0; i < n; i++) {
        const p = merkleProof(ls, i);
        expect(p.index).toBe(i);
        expect(p.siblings.map((s) => s.side)).toEqual(merkleProofSides(n, i));
        expect(verifyMerkleProof(p, root)).toBe(true);
        expect(verifyMerkleProof(p, bytesToHex(root), n)).toBe(true);
      }
    }
    const p = merkleProof(leaves(5), 4);
    expect(p.siblings.length).toBe(1);
    expect(p.siblings[0]!.side).toBe('L');
  });
  it('rejects tampered proofs and wrong positions', () => {
    const ls = leaves(6);
    const root = merkleRoot(ls);
    const p = merkleProof(ls, 2);
    expect(verifyMerkleProof({ ...p, leaf: bytesToHex(h('x')) }, root)).toBe(false);
    const flipped = { ...p, siblings: p.siblings.map((s, i) => (i === 0 ? { ...s, side: 'L' as const } : s)) };
    expect(verifyMerkleProof(flipped, root)).toBe(false);
    expect(verifyMerkleProof({ ...p, index: 3 }, root, 6)).toBe(false);
    expect(verifyMerkleProof({ ...p, index: 6 }, root, 6)).toBe(false);
    expect(verifyMerkleProof({ ...p, leaf: 'zz' }, root)).toBe(false);
    expect(() => merkleProof(ls, 6)).toThrow();
    expect(() => merkleRoot([new Uint8Array(31)])).toThrow();
  });
});

describe('rolling evidence roots (§7.4)', () => {
  const keys = [1, 2, 3].map((s) => bs58.encode(ed25519.getPublicKey(Uint8Array.from({ length: 32 }, () => s))));

  it('leaf_w = sha256(0x00 ‖ key ‖ u32 index ‖ hash)', () => {
    const head: WitnessHead = { witness_key: keys[0]!, index: 5, hash: h('c5') };
    const pre = cat(Uint8Array.of(0), bs58.decode(keys[0]!), Uint8Array.of(5, 0, 0, 0), h('c5'));
    expect(bytesToHex(evidenceLeaf(head))).toBe(bytesToHex(sha256(pre)));
  });
  it('empty heads use (0xFFFFFFFF, G_w) and the root is the Merkle root in witness order', () => {
    const heads = keys.map((k, i) =>
      emptyWitnessHead({ bet: BET, witness_key: k, kind: (i === 0 ? 0 : 1) as 0 | 1, beacon_slot: 9n, beacon_hash: BEACON_HASH }),
    );
    expect(heads[0]!.index).toBe(0xffffffff);
    const leafBytes = heads.map(evidenceLeaf);
    expect(Array.from(leafBytes[0]!.subarray(0, 0))).toEqual([]);
    expect(bytesToHex(evidenceRoot(heads))).toBe(bytesToHex(merkleRoot(leafBytes)));
    expect(bytesToHex(evidenceRoot([]))).toBe('0'.repeat(64));
    const proof = evidenceHeadProof(heads, 1);
    expect(verifyMerkleProof(proof, evidenceRoot(heads), 3)).toBe(true);
    const pre = cat(Uint8Array.of(0), bs58.decode(keys[0]!), Uint8Array.of(0xff, 0xff, 0xff, 0xff), heads[0]!.hash);
    expect(bytesToHex(leafBytes[0]!)).toBe(bytesToHex(sha256(pre)));
  });
  it('rejects more than 8 witnesses', () => {
    const head: WitnessHead = { witness_key: keys[0]!, index: 0, hash: h('x') };
    expect(() => evidenceRoot(Array(9).fill(head))).toThrow();
  });
});

describe('checkHeadUpdate (§7.4 onchain checks mirror)', () => {
  const A = h('a');
  const B = h('b');
  const NONE = 0xffffffff;
  it('accepts progress and equal heads; 0xFFFFFFFF counts as −1', () => {
    expect(checkHeadUpdate([{ index: NONE, hash: A }], [{ index: 0, hash: B }], 30)).toEqual({ ok: true, gap_mask: 0 });
    expect(checkHeadUpdate([{ index: 3, hash: A }], [{ index: 3, hash: A }], 30)).toEqual({ ok: true, gap_mask: 0 });
  });
  it('rejects regressions and equal-index hash changes', () => {
    expect(checkHeadUpdate([{ index: 3, hash: A }], [{ index: 2, hash: A }], 30)).toEqual({ ok: false, error: 'EvidenceRegress' });
    expect(checkHeadUpdate([{ index: 3, hash: A }], [{ index: 3, hash: B }], 30)).toEqual({ ok: false, error: 'EvidenceRegress' });
    expect(checkHeadUpdate([{ index: 0, hash: A }], [{ index: NONE, hash: A }], 30)).toEqual({ ok: false, error: 'EvidenceRegress' });
    expect(checkHeadUpdate([{ index: 0, hash: A }], [], 30)).toEqual({ ok: false, error: 'EvidenceHeads' });
  });
  it('jump > 24 sets the witness bit (24 does not); > 90 s sets all bits (90 does not)', () => {
    const old = [
      { index: NONE, hash: A },
      { index: 10, hash: A },
    ];
    expect(checkHeadUpdate(old, [{ index: 23, hash: B }, { index: 34, hash: B }], 90)).toEqual({ ok: true, gap_mask: 0 });
    expect(checkHeadUpdate(old, [{ index: 24, hash: B }, { index: 35, hash: B }], 90)).toEqual({ ok: true, gap_mask: 0b11 });
    expect(checkHeadUpdate(old, [{ index: 0, hash: B }, { index: 10, hash: A }], 91)).toEqual({ ok: true, gap_mask: 0b11 });
  });
});
