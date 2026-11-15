import { describe, expect, it } from 'vitest';
import { payouts, type SettleBet } from '../src/settle.js';
import { ALICE, BOB, CAROL, key } from './chain-helpers.js';

const Z = '11111111111111111111111111111111';
const D = key(4).pk;

function bet(stakes: bigint[], over: Partial<SettleBet> = {}): SettleBet {
  const parts = [ALICE.pk, BOB.pk, CAROL.pk, D, key(5).pk, key(6).pk, key(7).pk, key(8).pk].slice(0, stakes.length);
  return {
    n_participants: stakes.length,
    participants: [...parts, ...Array(8 - parts.length).fill(Z)],
    stakes: [...stakes, ...Array(8 - stakes.length).fill(0n)],
    funded_mask: (1 << stakes.length) - 1,
    dispute_bond: 0n,
    disputer: Z,
    ...over,
  };
}

describe('payouts (§9.8)', () => {
  it('winner takes the pot', () => {
    expect(payouts(bet([1_000_000n, 1_000_000n]), 0b01, false)).toEqual({
      pot: 2_000_000n,
      payouts: [2_000_000n, 0n],
      bond_refund: 0n,
    });
  });

  it('pro-rata split with remainder to the lowest-index winner', () => {
    // pot 10, winners stakes 3,3,? — use market-style unequal stakes
    const r = payouts(bet([10_001n, 10_001n, 10_001n]), 0b011, false);
    // pot 30003, SW 20002 → floor(30003*10001/20002) = 15001 each, rem 1 → index 0
    expect(r.payouts).toEqual([15_002n, 15_001n, 0n]);
    expect(r.payouts.reduce((a, b) => a + b, 0n)).toBe(r.pot);
    const r2 = payouts(bet([700_000n, 300_000n, 333_333n]), 0b110, false);
    // pot 1333333, SW 633333 → p1 = floor(1333333*300000/633333) = 631579, p2 = floor(1333333*333333/633333) = 701753
    expect(r2.payouts[1]).toBe((1_333_333n * 300_000n) / 633_333n + (1_333_333n - (1_333_333n * 300_000n) / 633_333n - (1_333_333n * 333_333n) / 633_333n));
    expect(r2.payouts[2]).toBe((1_333_333n * 333_333n) / 633_333n);
    expect(r2.payouts.reduce((a, b) => a + b, 0n)).toBe(1_333_333n);
  });

  it('bond upheld joins the pot; not upheld is returned to the disputer', () => {
    const b = bet([1_000_000n, 1_000_000n], { dispute_bond: 200_000n, disputer: BOB.pk });
    expect(payouts(b, 0b01, true)).toEqual({ pot: 2_200_000n, payouts: [2_200_000n, 0n], bond_refund: 0n });
    expect(payouts(b, 0b10, false)).toEqual({ pot: 2_000_000n, payouts: [0n, 2_200_000n], bond_refund: 200_000n });
    expect(payouts(b, 0b01, false)).toEqual({ pot: 2_000_000n, payouts: [2_000_000n, 200_000n], bond_refund: 200_000n });
  });

  it('refund (winnerMask 0) returns funded stakes and any bond', () => {
    const b = bet([1_000_000n, 2_000_000n, 3_000_000n], { funded_mask: 0b101, dispute_bond: 100_000n, disputer: CAROL.pk });
    expect(payouts(b, 0, false)).toEqual({ pot: 4_100_000n, payouts: [1_000_000n, 0n, 3_100_000n], bond_refund: 100_000n });
    expect(payouts(bet([5n, 5n], { funded_mask: 0 }), 0, false)).toEqual({ pot: 0n, payouts: [0n, 0n], bond_refund: 0n });
  });

  it('handles maximum stakes without precision loss (pot·stake ≈ 8·10^24)', () => {
    const max = 1_000_000_000_000n;
    const stakes = Array(8).fill(max) as bigint[];
    stakes[7] = max - 1n;
    const r = payouts(bet(stakes, { dispute_bond: 200_000_000_000n, disputer: key(8).pk }), 0b0111_1111, true);
    expect(r.pot).toBe(8n * max - 1n + 200_000_000_000n);
    expect(r.payouts.reduce((a, b) => a + b, 0n)).toBe(r.pot);
    expect(r.payouts[7]).toBe(0n);
    const each = (r.pot * max) / (7n * max);
    expect(r.payouts.slice(1, 7)).toEqual(Array(6).fill(each));
    expect(r.payouts[0]).toBe(r.pot - 6n * each);
  });

  it('validates inputs', () => {
    expect(() => payouts(bet([1n, 1n]), 0b100, false)).toThrow();
    expect(() => payouts(bet([1n, 1n], { dispute_bond: 5n, disputer: CAROL.pk }), 1, false)).toThrow(/disputer/);
    expect(() => payouts(bet([0n, 1n]), 0b01, false)).toThrow(/zero/);
  });
});
