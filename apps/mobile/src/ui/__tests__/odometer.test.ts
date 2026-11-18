import { describe, expect, it } from 'vitest';

import { payout, MAX_MOMENT_MS, MAX_TRANSITION_MS } from '../tokens';
import {
  CENTS_STRIP,
  columnsOf,
  dollarDigits,
  leadingReveal,
  numberOf,
  odometerRow,
  rollPlan,
  TEXT_STRIP,
  textDirection,
  TICKER,
} from '../odometer';

/** The digits the cents-mode columns show at `v` (rows rounded to the digit on screen). */
const shown = (v: number, columns: number) =>
  Array.from({ length: columns }, (_, i) => Math.round(odometerRow(v, columns - 1 - i)) % 10).join(
    '',
  );

describe('odometer (cents mode)', () => {
  it('shows every digit of a whole value', () => {
    expect(shown(1250, 4)).toBe('1250');
    expect(shown(5, 3)).toBe('005');
    expect(shown(99_999, 5)).toBe('99999');
  });

  it('spins the lowest digit continuously', () => {
    expect(odometerRow(1234, 0)).toBe(4);
    expect(odometerRow(1234.5, 0)).toBeCloseTo(4.5);
    expect(odometerRow(1239.5, 0)).toBeCloseTo(9.5); // halfway 9 -> the 0 below it (row 10)
  });

  it('carries higher digits only while everything below passes nines', () => {
    // 1234.5: the tens digit (3) is not carrying, the 4 below it is not all nines.
    expect(odometerRow(1234.5, 1)).toBe(3);
    // 1299.5: the tens (9) and hundreds (2) both carry halfway; the thousands do not.
    expect(odometerRow(1299.5, 1)).toBeCloseTo(9.5);
    expect(odometerRow(1299.5, 2)).toBeCloseTo(2.5);
    expect(odometerRow(1299.5, 3)).toBe(1);
    // $9.99 -> $10.00 halfway: every column rolls together.
    expect(odometerRow(999.5, 0)).toBeCloseTo(9.5);
    expect(odometerRow(999.5, 1)).toBeCloseTo(9.5);
    expect(odometerRow(999.5, 2)).toBeCloseTo(9.5);
    expect(odometerRow(999.5, 3)).toBeCloseTo(0.5);
  });

  it('is continuous: rows never jump by more than a step for a small change in v', () => {
    for (let k = 0; k < 4; k++) {
      let prev = odometerRow(0, k);
      for (let v = 0.25; v <= 2_000; v += 0.25) {
        const r = odometerRow(v, k);
        // A wrap (row 10 -> row 0 is the same glyph) is the only allowed jump.
        const step = Math.abs(r - prev);
        expect(step < 1.0001 || Math.abs(step - 10) < 1.0001).toBe(true);
        prev = r;
      }
    }
  });

  it('lands exactly on whole rows at the end of a roll', () => {
    for (const v of [0, 7, 999, 1000, 4_250, 123_456]) {
      for (let k = 0; k < 6; k++) expect(Number.isInteger(odometerRow(v, k))).toBe(true);
    }
  });

  it('opens a leading column exactly as it carries in', () => {
    expect(leadingReveal(5, 0)).toBe(1);
    expect(leadingReveal(5, 2)).toBe(1); // dollars ones always shows ("$0.05")
    expect(leadingReveal(999, 3)).toBe(0);
    expect(leadingReveal(999.5, 3)).toBeCloseTo(0.5);
    expect(leadingReveal(1000, 3)).toBe(1);
    expect(leadingReveal(9_999, 4)).toBe(0);
    expect(leadingReveal(25_000, 4)).toBe(1);
  });

  it('counts whole-dollar digits', () => {
    expect(dollarDigits(0)).toBe(1);
    expect(dollarDigits(5)).toBe(1);
    expect(dollarDigits(1250)).toBe(2);
    expect(dollarDigits(-125_000)).toBe(4);
  });

  it('has strips of one and two turns', () => {
    expect(CENTS_STRIP.split('\n')).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '0',
    ]);
    expect(TEXT_STRIP.split('\n').map(Number)).toEqual(
      Array.from({ length: 20 }, (_, i) => i % 10),
    );
  });
});

describe('odometer (text mode)', () => {
  it('splits digits from fixed glyphs', () => {
    expect(columnsOf('$1,2.5')).toEqual([
      { kind: 'glyph', ch: '$' },
      { kind: 'digit', digit: 1 },
      { kind: 'glyph', ch: ',' },
      { kind: 'digit', digit: 2 },
      { kind: 'glyph', ch: '.' },
      { kind: 'digit', digit: 5 },
    ]);
  });

  it('reads display strings as numbers and compares them', () => {
    expect(numberOf('$97,120.50')).toBe(97_120.5);
    expect(numberOf('−$3.00')).toBe(-3);
    expect(numberOf('+$3.00')).toBe(3);
    expect(Number.isNaN(numberOf('—'))).toBe(true);
    expect(textDirection('$97,120.50', '$97,121.00')).toBe(1);
    expect(textDirection('$97,121.00', '$97,120.50')).toBe(-1);
    expect(textDirection('$1.00', '$1.00')).toBe(0);
    expect(textDirection('—', '$1.00')).toBe(0);
  });

  it('rolls only changed digits, up the strip when the number went up', () => {
    const plan = rollPlan('$97,129.50', '$97,130.10', 1);
    const digits = plan.filter((c) => c.kind === 'digit');
    expect(digits.map((c) => [c.fromRow, c.toRow])).toEqual([
      [9, 9], // 9 unchanged
      [7, 7], // 7 unchanged
      [1, 1], // 1 unchanged
      [2, 3], // 2 -> 3
      [9, 10], // 9 -> 0 wraps forward
      [5, 11], // 5 -> 1 wraps forward
      [0, 0],
    ]);
    expect(plan[0]).toEqual({ kind: 'glyph', ch: '$' });
  });

  it('rolls down the strip when the number went down, wrapping from the second turn', () => {
    const plan = rollPlan('$10.05', '$9.98', -1);
    expect(plan.map((c) => (c.kind === 'digit' ? [c.fromRow, c.toRow] : c.ch))).toEqual([
      '$',
      [10, 9], // was "0" (aligned right), 0 -> 9 going down wraps: row 10 -> 9
      '.',
      [10, 9], // 0 -> 9 down
      [15, 8], // 5 -> 8 going down wraps: row 15 -> 8
    ]);
  });

  it('every planned row stays on the two-turn strip', () => {
    for (let a = 0; a < 10; a++)
      for (let b = 0; b < 10; b++)
        for (const dir of [1, -1] as const) {
          const [c] = rollPlan(String(a), String(b), dir);
          if (c?.kind !== 'digit') throw new Error('digit expected');
          expect(c.fromRow % 10).toBe(a);
          expect(c.toRow % 10).toBe(b);
          expect(Math.max(c.fromRow, c.toRow)).toBeLessThan(20);
          if (a !== b) expect(Math.sign(c.toRow - c.fromRow)).toBe(dir);
        }
  });

  it('new columns and glyph swaps just appear', () => {
    const plan = rollPlan('$999', '$1,000', 1);
    expect(plan.map((c) => (c.kind === 'digit' ? [c.fromRow, c.toRow] : c.ch))).toEqual([
      '$',
      [1, 1], // no digit was here before
      ',', // was "$"
      [9, 10],
      [9, 10],
      [9, 10],
    ]);
  });
});

describe('ticker tuning', () => {
  it('matches the payout contract and the motion caps', () => {
    expect(TICKER.rollMs).toBe(payout.countUpMs);
    expect(TICKER.tickMs).toBeLessThanOrEqual(MAX_MOMENT_MS);
    expect(TICKER.colorMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(TICKER.leadMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(TICKER.minScale).toBe(0.6);
  });
});
