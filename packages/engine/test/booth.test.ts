import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { judgeCommit, judgeCommitHex, matchReveals, panelMessage, panelQuorum, verifyReveal } from '../src/booth/index.js';
import { ascii, BorshWriter, concatBytes, pubkeyBytes, toHex, utf8 } from '../src/chain/bytes.js';
import type { JudgeReveal } from '../src/types.js';
import { BET, PROGRAM_ID } from './chain-helpers.js';

const nonce = new Uint8Array(32).fill(9);

describe('judgeCommit (§10.4)', () => {
  it('hashes the documented preimage', () => {
    const c = judgeCommit({ bet: BET, judge: 2, outcome: 1, confidence_bps: 8200, rationale: 'Ball went in ✓', nonce });
    const pre = concatBytes(
      ascii('VERDICT/JUDGE-COMMIT/v1'),
      pubkeyBytes(BET),
      new Uint8Array([2, 1]),
      new Uint8Array([8200 & 255, 8200 >> 8]),
      sha256(utf8('Ball went in ✓')),
      nonce,
    );
    expect(pre.length).toBe(23 + 32 + 4 + 64);
    expect(c).toEqual(sha256(pre));
    expect(judgeCommitHex({ bet: BET, judge: 2, outcome: 1, confidence_bps: 8200, rationale: 'Ball went in ✓', nonce })).toBe(toHex(c));
  });
  it('validates inputs', () => {
    expect(() => judgeCommit({ bet: BET, judge: 3, outcome: 1, confidence_bps: 1, rationale: '', nonce })).toThrow();
    expect(() => judgeCommit({ bet: BET, judge: 0, outcome: 3 as never, confidence_bps: 1, rationale: '', nonce })).toThrow();
    expect(() => judgeCommit({ bet: BET, judge: 0, outcome: 1, confidence_bps: 10001, rationale: '', nonce })).toThrow();
    expect(() => judgeCommit({ bet: BET, judge: 0, outcome: 1, confidence_bps: 1, rationale: '', nonce: nonce.subarray(1) })).toThrow();
  });
  it('verifyReveal / matchReveals discard mismatching reveals', () => {
    const r: JudgeReveal = { judge: 0, outcome: 2, confidence_bps: 7000, rationale: 'no', nonce: toHex(nonce) };
    const commit = judgeCommitHex({ ...r, bet: BET, nonce });
    expect(verifyReveal(BET, r, commit)).toBe(true);
    expect(verifyReveal(BET, { ...r, outcome: 1 }, commit)).toBe(false);
    expect(verifyReveal(BET, { ...r, nonce: 'zz' }, commit)).toBe(false);
    const r1 = { ...r, judge: 1 };
    expect(matchReveals(BET, [{ judge: 0, commit }, { judge: 1, commit }], [r, r1])).toEqual([r]);
  });
});

describe('panelMessage (§9.7)', () => {
  it('is 145 bytes in the documented order', () => {
    const m = panelMessage(PROGRAM_ID, BET, 2, 'aa'.repeat(32), 'bb'.repeat(32));
    expect(m.length).toBe(145);
    const expected = new BorshWriter()
      .raw(ascii('VERDICT/PANEL/v1'))
      .pubkey(PROGRAM_ID)
      .pubkey(BET)
      .u8(2)
      .hash('aa'.repeat(32))
      .hash('bb'.repeat(32))
      .toBytes();
    expect(m).toEqual(expected);
    expect(() => panelMessage(PROGRAM_ID, BET, 3, 'aa'.repeat(32), 'bb'.repeat(32))).toThrow();
  });
});

const rv = (judge: number, outcome: 0 | 1 | 2, confidence_bps: number): JudgeReveal => ({
  judge,
  outcome,
  confidence_bps,
  rationale: '',
  nonce: '00'.repeat(32),
});

describe('panelQuorum (§10.5)', () => {
  it('two confident votes win; signers are the two lowest voters', () => {
    expect(panelQuorum([rv(0, 1, 8000), rv(1, 2, 9000), rv(2, 1, 6000)])).toEqual({
      outcome: 1,
      votes: [0, 2, 1],
      signers: [0, 2],
    });
    expect(panelQuorum([rv(2, 2, 6000), rv(1, 2, 6000), rv(0, 2, 6000)])).toEqual({
      outcome: 2,
      votes: [0, 0, 3],
      signers: [0, 1],
    });
  });
  it('confidence floor 6000 is inclusive', () => {
    expect(panelQuorum([rv(0, 1, 5999), rv(1, 1, 6000), rv(2, 1, 6000)]).signers).toEqual([1, 2]);
    expect(panelQuorum([rv(0, 1, 5999), rv(1, 1, 6000), rv(2, 2, 9000)])).toEqual({
      outcome: 0,
      votes: [0, 1, 1],
      signers: [0, 1],
    });
  });
  it('no contest by default, including with absent judges', () => {
    expect(panelQuorum([])).toEqual({ outcome: 0, votes: [0, 0, 0], signers: [0, 1] });
    expect(panelQuorum([rv(2, 2, 9000)])).toEqual({ outcome: 0, votes: [0, 0, 1], signers: [0, 1] });
  });
  it('explicit no-contest votes are signed by their voters', () => {
    expect(panelQuorum([rv(1, 0, 9000), rv(2, 0, 9000), rv(0, 1, 9000)])).toEqual({
      outcome: 0,
      votes: [2, 1, 0],
      signers: [1, 2],
    });
  });
  it('ignores duplicates and invalid judges', () => {
    expect(panelQuorum([rv(0, 1, 9000), rv(0, 1, 9000), rv(3, 1, 9000)]).outcome).toBe(0);
  });
});
