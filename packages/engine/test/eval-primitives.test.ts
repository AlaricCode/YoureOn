import { describe, expect, it } from 'vitest';
import { at, bits, fromBits, mkCtx, q, type Col } from './eval-fixtures.js';
import { containerArr, lastSeenArr, bOperand, prevPos } from '../src/eval/frames.js';
import {
  sigAboveBelow,
  sigAtRest,
  sigBehindBeyond,
  sigDirection,
  sigInside,
  sigIntact,
  sigMoving,
  sigNear,
  sigOverlaps,
  sigPresent,
  sigRepCount,
  sigSpeed,
  sigStanding,
  sigStill,
} from '../src/eval/state.js';
import { beforeSig, forDuration, rising, sigAnd, sigNot, sigOr, thenWithin } from '../src/eval/combinators.js';
import type { DecodedRegion } from '../src/types.js';

const A = { entity: 0, sub: 0 as const };
const B = { entity: 1, sub: 0 as const };
const OPEN = { entity: 1, sub: 1 as const };
const INT = { entity: 1, sub: 2 as const };

const LINE: DecodedRegion = { entity_idx: 1, shape: 0, points: [[3000, 6000], [3000, 10000]], behind_sign: 1 };
const ZONE: DecodedRegion = { entity_idx: 1, shape: 1, points: [[1000, 1000], [5000, 1000], [5000, 5000], [1000, 5000]], behind_sign: 0 };

/** ctx with object a (track 0) and object b (track 1). */
function twoObjects(a: Col, b: Col, segs?: [number, number][]) {
  return mkCtx({ entities: [2, 2], trackEntities: [0, 1], cols: [a, b], segs });
}

describe('frame space', () => {
  it('prev stays within the segment', () => {
    const ctx = mkCtx({ entities: [2], trackEntities: [0], cols: [[null, null, null, null]], segs: [[0, 2], [10, 2]] });
    expect([0, 1, 2, 3].map((p) => prevPos(ctx.fs, p))).toEqual([-1, 0, -1, 2]);
    expect(ctx.fs.abs).toEqual([0, 1, 10, 11]);
  });

  it('lastSeen bridges gaps up to RELEASE_GAP and never crosses segments', () => {
    const o = at(500, 500);
    // positions: 0 present, 1-2 absent, 3 query (gap 3) ; 4-7 absent, 8 query (gap 5 from 3)
    const col: Col = [o, null, null, o, null, null, null, null, o, o, o];
    const ctx = mkCtx({ entities: [2], trackEntities: [0], cols: [col], segs: [[0, 9], [20, 2]] });
    const ls = Array.from(lastSeenArr(ctx, 0));
    expect(ls[3]).toBe(0);
    expect(ls[4]).toBe(3);
    expect(ls[6]).toBe(3);
    expect(ls[7]).toBe(-1); // 7 - 3 = 4 > 3
    expect(ls[8]).toBe(-1);
    expect(ls[9]).toBe(-1); // segment start
    expect(ls[10]).toBe(9);
  });

  it('stale sub-region survives 30 frames, not 31, and not across segments', () => {
    const can = q(1000, 1000, 2000, 2000);
    const col: Col = [can];
    for (let i = 1; i <= 31; i++) col.push(null);
    col.push(null);
    const ctx = mkCtx({ entities: [2, 2], trackEntities: [0, 1], cols: [[], col], segs: [[0, 32], [100, 1]] });
    const cont = containerArr(ctx, 1);
    expect(cont[30]).toEqual({ x0: 1000, y0: 1000, x1: 2000, y1: 2000 });
    expect(cont[31]).toBeNull();
    expect(cont[32]).toBeNull();
    expect(bOperand(ctx, OPEN, 30)).not.toBeNull();
    expect(bOperand(ctx, OPEN, 31)).toBeNull();
  });

  it('records below PRESENCE_MIN are absent', () => {
    const ctx = mkCtx({ entities: [2], trackEntities: [0], cols: [[q(0, 0, 10, 10, { conf: 29 }), q(0, 0, 10, 10, { conf: 30 })]] });
    expect(bits(sigPresent(ctx, A))).toBe('01');
  });
});

describe('state primitives', () => {
  it('overlaps with box, sub-region and zone', () => {
    const ctx = twoObjects([q(0, 0, 100, 100), q(0, 0, 100, 100), q(200, 200, 300, 300), null], [q(50, 50, 150, 150), q(100, 0, 200, 100), q(50, 50, 150, 150), q(0, 0, 10, 10)]);
    expect(bits(sigOverlaps(ctx, A, B))).toBe('1000');
    const z = mkCtx({ entities: [1, 4], regions: [ZONE], trackEntities: [0], cols: [[q(900, 900, 1100, 1100), q(0, 0, 400, 400), q(900, 0, 1100, 1000)]] });
    // center (1000,1000) is a vertex of the zone (in); second outside; third: center (1000,500) out, anchor (1000,1000) in
    expect(bits(sigOverlaps(z, A, B))).toBe('101');
  });

  it('inside: object needs center in box and half the area', () => {
    const can = q(0, 0, 1000, 1000);
    const ctx = twoObjects(
      [q(400, 400, 600, 600), q(900, 400, 1300, 600), q(990, 0, 1010, 10), q(1000, 1000, 1000, 1000)],
      [can, can, can, can],
    );
    // 2: center (1000,5) on edge, overlap area 10*10=100 of 200 → exactly half ⇒ inside
    // 3: zero-area box at the corner ⇒ point test only
    expect(bits(sigInside(ctx, A, B))).toBe('1011');
    // sub-regions: point test against the rect
    const ctx2 = twoObjects([at(500, 50, 5), at(500, 500, 5)], [can, can]);
    expect(bits(sigInside(ctx2, A, OPEN))).toBe('10');
    expect(bits(sigInside(ctx2, A, INT))).toBe('01');
  });

  it('inside a zone uses the anchor (feet for persons)', () => {
    const ctx = mkCtx({ entities: [1, 4], regions: [ZONE], trackEntities: [0], cols: [[q(2000, 4000, 2400, 4999), q(2000, 4000, 2400, 5000), q(2000, 100, 2400, 1000)]] });
    // feet on the bottom edge (y = 5000) are outside under even-odd; feet on the top edge are inside
    expect(bits(sigInside(ctx, A, B))).toBe('101');
  });

  it('above / below require strict x overlap', () => {
    const b = q(1000, 1000, 2000, 2000);
    const ctx = twoObjects([q(1500, 0, 1600, 100), q(2000, 0, 2100, 100), q(1500, 2500, 1600, 2600), q(1500, 900, 1600, 1100)], [b, b, b, b]);
    expect(bits(sigAboveBelow(ctx, A, B, true))).toBe('1000');
    expect(bits(sigAboveBelow(ctx, A, B, false))).toBe('0010');
  });

  it('near uses the box gap and an inclusive distance', () => {
    const b = q(1000, 1000, 2000, 2000);
    const ctx = twoObjects([q(0, 0, 700, 600), q(0, 0, 699, 600), q(1500, 1500, 1600, 1600)], [b, b, b]);
    // gap (300, 400) ⇒ 500² exactly (inclusive); gap (301, 400) is farther
    expect(bits(sigNear(ctx, A, B, 500))).toBe('101');
    expect(bits(sigNear(ctx, A, B, 0))).toBe('001');
  });

  it('behind / beyond: side 0 is neither', () => {
    const ctx = mkCtx({
      entities: [1, 3],
      regions: [LINE],
      trackEntities: [0],
      cols: [[q(500, 1000, 1500, 9000), q(4500, 1000, 5500, 9000), q(2500, 1000, 3500, 9000), null]],
    });
    expect(bits(sigBehindBeyond(ctx, A, B, false))).toBe('1000');
    expect(bits(sigBehindBeyond(ctx, A, B, true))).toBe('0100');
  });

  it('moving / speed / direction use VEL_K = 2 within the segment', () => {
    // centers: x = 0, 30, 60, 90 ... (30 per frame ⇒ 60 per 2 frames ⇒ 300 ups)
    const col: Col = [0, 1, 2, 3, 4].map((i) => at(1000 + 30 * i, 1000));
    const ctx = mkCtx({ entities: [2], trackEntities: [0], cols: [col], segs: [[0, 3], [10, 2]] });
    expect(bits(sigMoving(ctx, A))).toBe('00100');
    expect(bits(sigSpeed(ctx, A, 4, 300))).toBe('00100');
    expect(bits(sigDirection(ctx, A, 3))).toBe('00100');
    expect(bits(sigDirection(ctx, A, 2))).toBe('00000');
    // 29 per frame ⇒ isqrt(58²)=58 ⇒ 290 ups < 300
    const slow = mkCtx({ entities: [2], trackEntities: [0], cols: [[0, 1, 2].map((i) => at(1000 + 29 * i, 1000))] });
    expect(bits(sigMoving(slow, A))).toBe('000');
    expect(bits(sigSpeed(slow, A, 0, 290))).toBe('001');
  });

  it('direction cone boundaries (2·|dy| >= |dx| for up)', () => {
    // dx = 200, dy = -100 over 2 frames ⇒ up requires 200 >= 200 ✓, right requires 400 >= 100 ✓
    const ctx = mkCtx({ entities: [2], trackEntities: [0], cols: [[at(1000, 1000), null, at(1200, 900)]] });
    expect(bits(sigDirection(ctx, A, 0))).toBe('001');
    expect(bits(sigDirection(ctx, A, 3))).toBe('001');
    expect(bits(sigDirection(ctx, A, 1))).toBe('000');
  });

  it('still at the STILL_MAX_UPS boundary and at 1 px / 5 px jitter', () => {
    // 50 units over 2 frames ⇒ 250 ups ⇒ still; 51 ⇒ 255 ⇒ not
    const ctx = mkCtx({ entities: [2], trackEntities: [0], cols: [[at(1000, 1000), at(1000, 1000), at(1050, 1000), at(1051, 1000)]] });
    expect(bits(sigStill(ctx, A))).toBe('0010');
    // 1 px ≈ 5 units and 5 px ≈ 26 units of jitter on a 1920-px frame: still
    for (const j of [5, 26]) {
      const col: Col = [];
      for (let i = 0; i < 20; i++) col.push(at(5000 + (i % 3 === 0 ? j : 0), 5000 + (i % 2 ? j : 0)));
      const c = mkCtx({ entities: [2], trackEntities: [0], cols: [col] });
      expect(bits(sigAtRest(c, A, 10)).slice(11)).toBe('111111111');
      expect(bits(sigAtRest(c, A, 10)).slice(0, 11)).toBe('00000000000');
    }
  });

  it('intact compares against ref_h; ref_h = 0 means present', () => {
    const col: Col = [q(0, 0, 10, 750), q(0, 0, 10, 749), null];
    const ctx = mkCtx({ entities: [2], trackEntities: [0], refH: [1000], cols: [col] });
    expect(bits(sigIntact(ctx, A))).toBe('100');
    const ctx0 = mkCtx({ entities: [2], trackEntities: [0], refH: [0], cols: [col] });
    expect(bits(sigIntact(ctx0, A))).toBe('110');
  });

  it('standing reads pose bit0', () => {
    const ctx = mkCtx({ entities: [1], trackEntities: [0], cols: [[q(0, 0, 9, 9, { pose: 1 }), q(0, 0, 9, 9, { pose: 2 }), null]] });
    expect(bits(sigStanding(ctx, A))).toBe('100');
  });

  it('rep_count scans all of F across segments and needs presence', () => {
    const L = (): ReturnType<typeof q> => q(0, 0, 9, 9, { pose: 2 });
    const H = (): ReturnType<typeof q> => q(0, 0, 9, 9, { pose: 4 });
    // H (no low yet), L, H ⇒ 1 ; segment break; L, absent, H ⇒ 2 ; H again ⇒ still 2
    const col: Col = [H(), L(), H(), L(), null, H(), H()];
    const ctx = mkCtx({ entities: [1], trackEntities: [0], cols: [col], segs: [[0, 3], [50, 4]] });
    expect(bits(sigRepCount(ctx, A, 0, 1))).toBe('0011011');
    expect(bits(sigRepCount(ctx, A, 0, 2))).toBe('0000011');
    expect(bits(sigRepCount(ctx, A, 4, 0))).toBe('1100000');
  });
});

describe('combinators', () => {
  const ctx = mkCtx({ entities: [2], trackEntities: [0], cols: [new Array<null>(8).fill(null)], segs: [[0, 4], [10, 4]] });
  const fs = ctx.fs;

  it('pointwise and / or / not', () => {
    expect(bits(sigAnd(fromBits('1100'), fromBits('1010')))).toBe('1000');
    expect(bits(sigOr(fromBits('1100'), fromBits('1010')))).toBe('1110');
    expect(bits(sigNot(fromBits('1100')))).toBe('0011');
  });

  it('then_within looks back D frames inside the segment only', () => {
    const x = fromBits('10001000');
    const y = fromBits('00110110');
    // pos 2 (abs 2): X at 0, 2-0 = 2 <= 2 ✓ ; pos 3 (abs 3): 3 > 2 ✗ ; pos 5,6: X at pos 4 (abs 10)
    expect(bits(thenWithin(fs, 2, x, y))).toBe('00100110');
    // X in another segment never counts
    expect(bits(thenWithin(fs, 100, fromBits('10000000'), fromBits('00001111')))).toBe('00000000');
    // same frame counts (D window includes g)
    expect(bits(thenWithin(fs, 1, fromBits('01000000'), fromBits('01000000')))).toBe('01000000');
  });

  it('for_duration needs D frames inside the segment', () => {
    expect(bits(forDuration(fs, 2, fromBits('11111111')))).toBe('01110111');
    expect(bits(forDuration(fs, 4, fromBits('11111111')))).toBe('00010001');
    expect(bits(forDuration(fs, 5, fromBits('11111111')))).toBe('00000000');
    expect(bits(forDuration(fs, 1, fromBits('10110100')))).toBe('10110100');
  });

  it('before uses absolute frames', () => {
    expect(bits(beforeSig(fs, 11, fromBits('11111111')))).toBe('11111000');
  });

  it('rising: absolute frame 0 rises, other segment starts never do', () => {
    expect(bits(rising(fs, fromBits('11011111')))).toBe('10010000');
    const late = mkCtx({ entities: [2], trackEntities: [0], cols: [[null, null]], segs: [[5, 2]] });
    expect(bits(rising(late.fs, fromBits('11')))).toBe('00');
  });
});
