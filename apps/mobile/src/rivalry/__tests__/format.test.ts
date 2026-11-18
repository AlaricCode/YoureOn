import { describe, expect, it } from 'vitest';

import { recordText, statsOf, streakLabel } from '../format';

describe('statsOf', () => {
  it('passes the new server fields through', () => {
    expect(
      statsOf({
        wins: 4,
        losses: 7,
        pushes: 0,
        net: '-7000000',
        net_display: '−$7.00',
        total: 11,
        last_result: 'loss',
        streak: { holder: 'them', length: 1 },
        rival: true,
      }),
    ).toEqual({
      wins: 4,
      losses: 7,
      pushes: 0,
      net: '-7000000',
      netDisplay: '−$7.00',
      total: 11,
      streak: { holder: 'them', length: 1 },
      rival: true,
      lastResult: 'loss',
    });
  });

  it('fills total, rival and the net from an older server reply', () => {
    expect(statsOf({ wins: 2, losses: 0, pushes: 1, net: '4500000' })).toEqual({
      wins: 2,
      losses: 0,
      pushes: 1,
      net: '4500000',
      netDisplay: '+$4.50',
      total: 3,
      streak: null,
      rival: true,
      lastResult: null,
    });
    expect(statsOf({ wins: 1, losses: 1, net: '0' })).toMatchObject({
      total: 2,
      rival: false,
      netDisplay: '$0',
      pushes: 0,
    });
  });
});

describe('recordText', () => {
  it('is W-L, with pushes as a third number', () => {
    expect(recordText({ wins: 4, losses: 7, pushes: 0 })).toBe('4-7');
    expect(recordText({ wins: 4, losses: 7, pushes: 1 })).toBe('4-7-1');
    expect(recordText({ wins: 0, losses: 0, pushes: 0 })).toBe('0-0');
  });
});

describe('streakLabel', () => {
  it('names runs of two or more', () => {
    expect(streakLabel({ streak: { holder: 'me', length: 3 } })).toBe('Won 3 straight');
    expect(streakLabel({ streak: { holder: 'them', length: 2 } })).toBe('Lost 2 straight');
    expect(streakLabel({ streak: { holder: 'them', length: 1 } })).toBeNull();
    expect(streakLabel({ streak: null })).toBeNull();
  });
});
