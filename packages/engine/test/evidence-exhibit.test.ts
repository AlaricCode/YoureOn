import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  chainGenesis,
  chunkHash,
  evidenceHeadProof,
  evidenceRoot,
  emptyWitnessHead,
  recomputeLinks,
  verifyExhibitChainProof,
} from '../src/evidence/index.js';
import { bytesToHex, sha256 } from '../src/hash/index.js';
import type { ChainLink, ExhibitChainProof, WitnessHead } from '../src/types.js';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const BET = key(9);
const BEACON = { bet: BET, beacon_slot: 1234n, beacon_hash: new Uint8Array(32).fill(7) };
const WITNESSES = [
  { witness_key: key(1), kind: 0 as const },
  { witness_key: key(2), kind: 1 as const },
  { witness_key: key(3), kind: 1 as const },
];

/** A witness chain of `n` 5 s chunks. */
function chain(w: number, n: number): { links: ChainLink[]; hashes: Uint8Array[] } {
  const { witness_key, kind } = WITNESSES[w]!;
  let prev = chainGenesis({ ...BEACON, witness_key, kind });
  const links: ChainLink[] = [];
  const hashes: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const body = sha256(new TextEncoder().encode(`w${w} chunk ${i}`));
    const l = { index: i, kind, start_ms: i * 5000, duration_ms: 5000, body_sha256: bytesToHex(body) };
    prev = chunkHash({ prev, index: i, kind, start_ms: l.start_ms, duration_ms: l.duration_ms, body_sha256: body });
    links.push(l);
    hashes.push(prev);
  }
  return { links, hashes };
}

describe('exhibit chain proofs (§10.1)', () => {
  const cam = chain(0, 6);
  const mic = chain(1, 4);
  const heads: WitnessHead[] = [
    { witness_key: WITNESSES[0]!.witness_key, index: 5, hash: cam.hashes[5]! },
    { witness_key: WITNESSES[1]!.witness_key, index: 3, hash: mic.hashes[3]! },
    emptyWitnessHead({ ...BEACON, ...WITNESSES[2]! }), // a witness that never uploaded
  ];
  const root = evidenceRoot(heads);
  const ctx = { witness_key: WITNESSES[0]!.witness_key, evidence_root: root, genesis: BEACON, n_witnesses: 3 };

  function proof(from: number, w = 0): ExhibitChainProof {
    const c = w === 0 ? cam : mic;
    const links = c.links.slice(from).map((l) => ({ ...l }));
    if (from > 0) links[0]!.prev = bytesToHex(c.hashes[from - 1]!);
    return { witness: w === 0 ? 'cam1' : 'mic1', from_index: from, links, head_proof: evidenceHeadProof(heads, w) };
  }

  it('verifies from genesis and from a middle chunk', () => {
    const r0 = verifyExhibitChainProof(proof(0), ctx);
    expect(r0).toMatchObject({ ok: true, head_index: 5, head_hash: bytesToHex(cam.hashes[5]!) });
    expect(verifyExhibitChainProof(proof(3), ctx)).toMatchObject({ ok: true, head_index: 5 });
    expect(verifyExhibitChainProof(proof(2, 1), { ...ctx, witness_key: WITNESSES[1]!.witness_key })).toMatchObject({ ok: true, head_index: 3 });
  });

  it('rejects a tampered body, a wrong prev, missing links, a wrong witness or root', () => {
    const p = proof(3);
    p.links[1]!.body_sha256 = '00'.repeat(32);
    expect(verifyExhibitChainProof(p, ctx).ok).toBe(false);
    const q = proof(3);
    q.links[0]!.prev = bytesToHex(cam.hashes[1]!);
    expect(verifyExhibitChainProof(q, ctx)).toEqual({ ok: false, reason: 'leaf_w does not match head_proof.leaf' });
    const short = proof(3);
    short.links.pop(); // stops before the committed head
    expect(verifyExhibitChainProof(short, ctx).ok).toBe(false);
    const gap = proof(2);
    gap.links.splice(1, 1);
    expect(verifyExhibitChainProof(gap, ctx).ok).toBe(false);
    expect(verifyExhibitChainProof(proof(3), { ...ctx, witness_key: WITNESSES[1]!.witness_key }).ok).toBe(false);
    expect(verifyExhibitChainProof(proof(3), { ...ctx, evidence_root: '11'.repeat(32) })).toEqual({
      ok: false,
      reason: 'head_proof does not verify against evidence_root',
    });
    const noPrev = proof(3);
    delete noPrev.links[0]!.prev;
    expect(verifyExhibitChainProof(noPrev, ctx).ok).toBe(false);
    expect(verifyExhibitChainProof(proof(0), { ...ctx, genesis: undefined }).ok).toBe(false);
    expect(verifyExhibitChainProof(proof(0), { ...ctx, genesis: { ...BEACON, beacon_slot: 1235n } }).ok).toBe(false);
  });

  it('a proof for another leaf index fails the shape check', () => {
    const p = proof(0);
    p.head_proof = evidenceHeadProof(heads, 1);
    expect(verifyExhibitChainProof(p, ctx).ok).toBe(false);
  });

  it('recomputeLinks returns every intermediate c_i', () => {
    const r = recomputeLinks(0, cam.links, chainGenesis({ ...BEACON, ...WITNESSES[0]! }));
    expect(r.ok && r.hashes.map(bytesToHex)).toEqual(cam.hashes.map(bytesToHex));
  });
});
