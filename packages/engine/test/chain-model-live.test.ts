import { describe, expect, it } from 'vitest';
import { START_WINDOW_S } from '../src/constants.js';
import { sha256, toHex, utf8, ZERO_HASH } from '../src/chain/bytes.js';
import { genesisHash, headsRoot } from '../src/chain/hashes.js';
import { ALICE, BET, BOB, ORACLE, STRANGER, WITNESS, World } from './chain-helpers.js';

const W2 = [
  { key: WITNESS[0].pk, kind: 0 as const },
  { key: WITNESS[1].pk, kind: 1 as const },
];
const h = (s: string) => toHex(sha256(utf8(s)));

function started(): World {
  return new World().create().fundAll().start();
}

describe('chain model: start', () => {
  it('stores the beacon, witnesses, G_w head hashes and the initial root', () => {
    const w = new World().create().fundAll();
    const slot = w.slot - 1n;
    const r = w.ok('start', { beacon_slot: slot, witnesses: W2 }, [ALICE.pk], { authority: ALICE.pk });
    const bh = h('slot' + slot);
    const g0 = toHex(genesisHash(BET, WITNESS[0].pk, 0, slot, bh));
    const g1 = toHex(genesisHash(BET, WITNESS[1].pk, 1, slot, bh));
    expect(r.bet).toMatchObject({ state: 2, beacon_slot: slot, beacon_hash: bh, n_witnesses: 2, started_at: w.now });
    expect(r.bet.witness_kinds).toEqual([0, 1, 255, 255, 255, 255, 255, 255]);
    expect(r.bet.witness_heads).toEqual(Array(8).fill(0xffffffff));
    expect(r.bet.witness_head_hashes).toEqual([g0, g1, ...Array(6).fill(ZERO_HASH)]);
    const root = toHex(
      headsRoot([
        { key: WITNESS[0].pk, index: 0xffffffff, hash: g0 },
        { key: WITNESS[1].pk, index: 0xffffffff, hash: g1 },
      ]),
    );
    expect(r.bet.evidence_root).toBe(root);
    expect(r.events).toEqual([
      { name: 'BetStarted', data: { bet: BET, beacon_slot: slot, beacon_hash: bh, started_at: w.now, n_witnesses: 2 } },
    ]);
  });

  it('beacon age boundary: 150 slots ok, 151 BeaconTooOld; unknown slot', () => {
    const w = new World().create().fundAll();
    w.err('BeaconTooOld', 'start', { beacon_slot: w.slot - 151n, witnesses: [] }, [ORACLE.pk], { authority: ORACLE.pk });
    w.err('BeaconSlotNotFound', 'start', { beacon_slot: w.slot - 2n, witnesses: [] }, [ORACLE.pk], {
      authority: ORACLE.pk,
    });
    w.err('BeaconSlotNotFound', 'start', { beacon_slot: w.slot + 1n, witnesses: [] }, [ORACLE.pk], {
      authority: ORACLE.pk,
    });
    w.ok('start', { beacon_slot: w.slot - 150n, witnesses: [] }, [ORACLE.pk], { authority: ORACLE.pk });
    expect(w.bet.evidence_root).toBe(ZERO_HASH);
  });

  it('start window boundary and authority', () => {
    const w = new World().create().fundAll();
    const a = { beacon_slot: w.slot, witnesses: [] };
    w.err('Unauthorized', 'start', a, [BOB.pk], { authority: BOB.pk });
    w.now = w.bet.funded_at + BigInt(START_WINDOW_S) + 1n;
    w.err('DeadlinePassed', 'start', a, [ORACLE.pk], { authority: ORACLE.pk });
    w.now -= 1n;
    w.ok('start', a, [ORACLE.pk], { authority: ORACLE.pk });
  });

  it('witness list validation', () => {
    const w = new World().create().fundAll();
    const nine = Array.from({ length: 9 }, (_, i) => ({ key: toHex(new Uint8Array([i])) && STRANGER.pk, kind: 0 as const }));
    const s = { authority: ORACLE.pk };
    w.err('TooManyWitnesses', 'start', { beacon_slot: w.slot, witnesses: nine }, [ORACLE.pk], s);
    w.err('TooManyWitnesses', 'start', { beacon_slot: w.slot, witnesses: [W2[0], W2[0]] }, [ORACLE.pk], s);
    w.err(
      'TooManyWitnesses',
      'start',
      { beacon_slot: w.slot, witnesses: [{ key: WITNESS[0].pk, kind: 3 as never }] },
      [ORACLE.pk],
      s,
    );
  });

  it('market: beacon_slot 0 and no witnesses', () => {
    const w = new World({ flags: 4, stakes: [700_000n, 300_000n] }).create().fundAll();
    const s = { authority: ORACLE.pk };
    w.err('BeaconSlotNotFound', 'start', { beacon_slot: w.slot, witnesses: [] }, [ORACLE.pk], s);
    w.err('TooManyWitnesses', 'start', { beacon_slot: 0n, witnesses: W2 }, [ORACLE.pk], s);
    w.ok('start', { beacon_slot: 0n, witnesses: [] }, [ORACLE.pk], s);
    expect(w.bet.beacon_hash).toBe(ZERO_HASH);
  });
});

describe('chain model: commit_evidence', () => {
  it('advances heads and the root; checks seq and regressions', () => {
    const w = started();
    const g = w.bet.witness_head_hashes;
    const heads1 = [
      { index: 0, hash: h('c0') },
      { index: 0xffffffff, hash: g[1]! },
    ];
    w.err('EvidenceSeq', 'commit_evidence', { seq: 2, heads: heads1 }, [ORACLE.pk]);
    w.err('EvidenceHeads', 'commit_evidence', { seq: 1, heads: heads1.slice(0, 1) }, [ORACLE.pk]);
    w.err('Unauthorized', 'commit_evidence', { seq: 1, heads: heads1 }, [ALICE.pk], { oracle: ALICE.pk });
    // none-index with a hash other than G_w
    w.err('EvidenceRegress', 'commit_evidence', { seq: 1, heads: [heads1[0]!, { index: 0xffffffff, hash: h('x') }] }, [
      ORACLE.pk,
    ]);
    const r = w.ok('commit_evidence', { seq: 1, heads: heads1 }, [ORACLE.pk]);
    const root = toHex(
      headsRoot([
        { key: WITNESS[0].pk, index: 0, hash: h('c0') },
        { key: WITNESS[1].pk, index: 0xffffffff, hash: g[1]! },
      ]),
    );
    expect(r.bet.evidence_root).toBe(root);
    expect(r.bet.evidence_seq).toBe(1);
    expect(r.bet.gap_mask).toBe(0);
    expect(r.events[0]).toEqual({
      name: 'EvidenceCommitted',
      data: { bet: BET, seq: 1, root, gap_mask: 0, is_final: false },
    });
    // regress: witness 0 back to none
    w.err('EvidenceRegress', 'commit_evidence', { seq: 2, heads: [{ index: 0xffffffff, hash: g[0]! }, heads1[1]!] }, [
      ORACLE.pk,
    ]);
    // equal index, different hash
    w.err('EvidenceRegress', 'commit_evidence', { seq: 2, heads: [{ index: 0, hash: h('other') }, heads1[1]!] }, [
      ORACLE.pk,
    ]);
    // equal index & hash is fine
    w.ok('commit_evidence', { seq: 2, heads: heads1 }, [ORACLE.pk]);
  });

  it('gap bits: a jump > 24 chunks sets the witness bit; > 90 s sets all bits', () => {
    const w = started();
    const g = w.bet.witness_head_hashes;
    // from none (-1) to 23 is a jump of 24: no bit
    w.ok('commit_evidence', { seq: 1, heads: [{ index: 23, hash: h('a') }, { index: 0xffffffff, hash: g[1]! }] }, [ORACLE.pk]);
    expect(w.bet.gap_mask).toBe(0);
    // 23 → 48 is 25: bit 0
    w.ok('commit_evidence', { seq: 2, heads: [{ index: 48, hash: h('b') }, { index: 24, hash: h('c') }] }, [ORACLE.pk]);
    expect(w.bet.gap_mask).toBe(0b11);
    const w2 = started();
    w2.now += 90n;
    w2.ok('commit_evidence', { seq: 1, heads: [{ index: 0, hash: h('a') }, { index: 0, hash: h('b') }] }, [ORACLE.pk]);
    expect(w2.bet.gap_mask).toBe(0);
    w2.now += 91n;
    w2.ok('commit_evidence', { seq: 2, heads: [{ index: 1, hash: h('a1') }, { index: 1, hash: h('b1') }] }, [ORACLE.pk]);
    expect(w2.bet.gap_mask).toBe(0b11);
  });
});

describe('chain model: end', () => {
  it('oracle with heads finalises the root', () => {
    const w = started();
    const r = w.ok('end', { seq: 1, heads: [{ index: 3, hash: h('a') }, { index: 2, hash: h('b') }] }, [ORACLE.pk], {
      authority: ORACLE.pk,
    });
    expect(r.bet.state).toBe(3);
    expect(r.bet.ended_at).toBe(w.now);
    expect(r.events.map((e) => e.name)).toEqual(['EvidenceCommitted', 'BetEnded']);
    expect(r.events[0]!.data).toMatchObject({ seq: 1, is_final: true, root: r.bet.evidence_root });
    expect(r.events[1]!.data).toEqual({ bet: BET, evidence_root: r.bet.evidence_root, ended_at: w.now });
  });

  it('participants may end anytime with empty heads; strangers only after the time limit', () => {
    const w = started();
    const root = w.bet.evidence_root;
    w.err('EvidenceHeads', 'end', { seq: 1, heads: [{ index: 0, hash: h('a') }, { index: 0, hash: h('b') }] }, [BOB.pk], {
      authority: BOB.pk,
    });
    w.err('DeadlineNotReached', 'end', { seq: 0, heads: [] }, [STRANGER.pk], { authority: STRANGER.pk });
    w.now = w.bet.started_at + 59n;
    w.err('DeadlineNotReached', 'end', { seq: 0, heads: [] }, [STRANGER.pk], { authority: STRANGER.pk });
    w.now += 1n;
    w.ok('end', { seq: 0, heads: [] }, [STRANGER.pk], { authority: STRANGER.pk });
    expect(w.bet.evidence_root).toBe(root);
    const w2 = started();
    w2.ok('end', { seq: 0, heads: [] }, [BOB.pk], { authority: BOB.pk });
    w2.err('InvalidState', 'end', { seq: 0, heads: [] }, [BOB.pk], { authority: BOB.pk });
  });

  it('market: oracle only, empty heads', () => {
    const w = new World({ flags: 4, stakes: [700_000n, 300_000n] }).create().fundAll().start();
    w.err('Unauthorized', 'end', { seq: 0, heads: [] }, [ALICE.pk], { authority: ALICE.pk });
    w.ok('end', { seq: 0, heads: [] }, [ORACLE.pk], { authority: ORACLE.pk });
  });
});
