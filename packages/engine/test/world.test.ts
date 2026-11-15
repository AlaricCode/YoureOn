import { describe, expect, it } from 'vitest';
import { clampProb, parlayProb, sideProb, stakeSplit, WorldMathError } from '../src/world/index.js';

describe('stakeSplit (§11.2)', () => {
  it('70/30 market gives a 70/30 split, floored to whole cents', () => {
    expect(stakeSplit(10_000_000n, 7000)).toEqual({ proposer_stake: 7_000_000n, counterparty_stake: 3_000_000n });
    // T·p/10000 = 1_234_567·3333/10000 = 411_481.1 → floor to cents → 410_000
    expect(stakeSplit(1_234_567, 3333)).toEqual({ proposer_stake: 410_000n, counterparty_stake: 824_567n });
  });
  it('clamps p to [100, 9900]', () => {
    expect(clampProb(0)).toBe(100);
    expect(clampProb(10000)).toBe(9900);
    expect(clampProb(5000)).toBe(5000);
    expect(stakeSplit(100_000_000n, 10000)).toEqual({ proposer_stake: 99_000_000n, counterparty_stake: 1_000_000n });
    expect(stakeSplit(100_000_000n, 0)).toEqual({ proposer_stake: 1_000_000n, counterparty_stake: 99_000_000n });
  });
  it('BAD_STAKE when either side is below 10_000', () => {
    const e = (() => {
      try {
        stakeSplit(1_000_000n, 100); // proposer 10_000 ok, counter 990_000
        return null;
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeNull();
    expect(() => stakeSplit(999_999n, 100)).toThrow(WorldMathError); // proposer floor(9999.99/1e4)*1e4 = 0
    try {
      stakeSplit(19_999n, 5000);
    } catch (x) {
      expect((x as WorldMathError).code).toBe('BAD_STAKE');
    }
    expect(() => stakeSplit(19_999n, 5000)).toThrow(/out of range/);
    expect(() => stakeSplit(0n, 5000)).toThrow(WorldMathError);
    expect(() => stakeSplit(1.5, 5000)).toThrow(WorldMathError);
    expect(() => stakeSplit(10_000_000n, 10001)).toThrow(WorldMathError);
  });
  it('boundary: counterparty exactly 10_000', () => {
    expect(stakeSplit(20_000n, 5000)).toEqual({ proposer_stake: 10_000n, counterparty_stake: 10_000n });
    expect(stakeSplit(1_000_000n, 9900)).toEqual({ proposer_stake: 990_000n, counterparty_stake: 10_000n });
  });
  it('sideProb', () => {
    expect(sideProb(6500, 'yes')).toBe(6500);
    expect(sideProb(6500, 'no')).toBe(3500);
  });
});

describe('parlayProb (§11.3)', () => {
  it('multiplies in leg order with flooring', () => {
    expect(parlayProb([7000])).toBe(7000);
    expect(parlayProb([7000, 5000])).toBe(3500);
    // floor(floor(3333·6667/10000)·5001/10000) = floor(2222·5001/10000) = 1111
    expect(parlayProb([3333, 6667, 5001])).toBe(1111);
    expect(parlayProb([9999, 9999, 9999, 9999])).toBe(9996);
  });
  it('result is unclamped; stakeSplit clamps it', () => {
    expect(parlayProb([100, 100])).toBe(1);
    expect(stakeSplit(10_000_000n, parlayProb([100, 100]))).toEqual({ proposer_stake: 100_000n, counterparty_stake: 9_900_000n });
  });
  it('1..4 legs with valid bps', () => {
    expect(() => parlayProb([])).toThrow(WorldMathError);
    expect(() => parlayProb([1, 2, 3, 4, 5])).toThrow(WorldMathError);
    expect(() => parlayProb([10001])).toThrow(WorldMathError);
    expect(() => parlayProb([5000.5])).toThrow(WorldMathError);
  });
});
