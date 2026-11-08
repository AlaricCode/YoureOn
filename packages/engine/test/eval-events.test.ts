import { describe, expect, it } from 'vitest';
import { at, bits, mkCtx, q, type Col } from './eval-fixtures.js';
import { sigCrosses, sigDisappearsInto, sigEnters, sigLeaves, sigReleasedBy, sigTouches } from '../src/eval/events.js';
import type { DecodedRegion } from '../src/types.js';

const A = { entity: 0, sub: 0 as const };
const B = { entity: 1, sub: 0 as const };
const OPEN = { entity: 1, sub: 1 as const };
const ZONE: DecodedRegion = { entity_idx: 1, shape: 1, points: [[1000, 1000], [5000, 1000], [5000, 5000], [1000, 5000]], behind_sign: 0 };
const LINE: DecodedRegion = { entity_idx: 1, shape: 0, points: [[3000, 0], [3000, 10000]], behind_sign: 1 };

const OUT = at(500, 500, 50);
const IN = at(2000, 2000, 50);

function zoneCtx(col: Col, segs?: [number, number][]) {
  return mkCtx({ entities: [2, 4], regions: [ZONE], trackEntities: [0], cols: [col], segs });
}

describe('enters / leaves', () => {
  it('enters fires once on the outside→inside transition', () => {
    expect(bits(sigEnters(zoneCtx([OUT, OUT, IN, IN, OUT]), A, B))).toBe('00100');
    expect(bits(sigLeaves(zoneCtx([OUT, OUT, IN, IN, OUT]), A, B))).toBe('00001');
  });

  it('a one-frame dropout during enters is bridged by lastSeen', () => {
    expect(bits(sigEnters(zoneCtx([OUT, null, IN, IN]), A, B))).toBe('0010');
    // dropout inside the zone does not re-fire
    expect(bits(sigEnters(zoneCtx([OUT, IN, null, IN]), A, B))).toBe('0100');
    // a gap longer than RELEASE_GAP loses the previous sample
    expect(bits(sigEnters(zoneCtx([OUT, null, null, null, IN]), A, B))).toBe('00000');
    expect(bits(sigEnters(zoneCtx([OUT, null, null, IN]), A, B))).toBe('0001');
  });

  it('does not fire at a segment start', () => {
    expect(bits(sigEnters(zoneCtx([OUT, IN, IN], [[0, 1], [5, 2]]), A, B))).toBe('000');
  });

  it('leaves requires presence at f', () => {
    expect(bits(sigLeaves(zoneCtx([IN, null, null]), A, B))).toBe('000');
  });

  it('enters an object needs b present at f and at p', () => {
    const can = q(1000, 1000, 3000, 3000);
    const ctx = mkCtx({ entities: [2, 2], trackEntities: [0, 1], cols: [[OUT, IN, OUT, IN], [can, can, null, can]] });
    // pos 3: p = 2 where b is absent ⇒ no event
    expect(bits(sigEnters(ctx, A, B))).toBe('0100');
  });
});

describe('touches', () => {
  it('fires on the first overlapping frame after a non-overlapping one', () => {
    const b = q(1000, 1000, 2000, 2000);
    const ctx = mkCtx({
      entities: [2, 2],
      trackEntities: [0, 1],
      cols: [
        [at(500, 500), at(955, 955), at(960, 960), at(500, 500), at(960, 960)],
        [b, b, b, null, b],
      ],
    });
    // pos 4: p = 3 where b is absent ⇒ "b defined at p" fails
    expect(bits(sigTouches(ctx, A, B))).toBe('01000');
  });
});

describe('crosses', () => {
  function lineCtx(col: Col) {
    return mkCtx({ entities: [1, 3], regions: [LINE], trackEntities: [0], cols: [col] });
  }
  const person = (x: number): ReturnType<typeof q> => q(x - 100, 1000, x + 100, 3000);

  it('fires when the anchor side changes between nonzero sides', () => {
    expect(bits(sigCrosses(lineCtx([person(2000), person(2500), person(3500), person(3600)]), A, B))).toBe('0010');
    expect(bits(sigCrosses(lineCtx([person(3500), person(2500)]), A, B))).toBe('01');
  });

  it('side 0 (anchor on the line) never counts', () => {
    expect(bits(sigCrosses(lineCtx([person(2000), person(3000), person(4000)]), A, B))).toBe('000');
  });

  it('bridges a short dropout but requires presence at f', () => {
    expect(bits(sigCrosses(lineCtx([person(2000), null, null, person(4000)]), A, B))).toBe('0001');
    expect(bits(sigCrosses(lineCtx([person(2000), null, null, null, person(4000)]), A, B))).toBe('00000');
  });
});

describe('released_by', () => {
  const hand = q(1000, 1000, 2000, 2000); // expanded: (900, 900, 2100, 2100)
  const held = at(1500, 1500, 20);
  const free = at(3000, 1500, 20);
  function relCtx(ball: Col, person: Col = ball.map(() => hand)) {
    return mkCtx({ entities: [2, 0], params: [0, 1], trackEntities: [0, 1], cols: [ball, person] });
  }

  it('needs RELEASE_HOLD held frames before the release', () => {
    expect(bits(sigReleasedBy(relCtx([held, held, free, free]), A, B))).toBe('0010');
    expect(bits(sigReleasedBy(relCtx([held, free, free]), A, B))).toBe('000');
    expect(bits(sigReleasedBy(relCtx([free, held, held, held, free]), A, B))).toBe('00001');
  });

  it('expand(10%) border counts as held', () => {
    expect(bits(sigReleasedBy(relCtx([at(2100, 1500, 5), at(2100, 1500, 5), free]), A, B))).toBe('001');
    expect(bits(sigReleasedBy(relCtx([at(2101, 1500, 5), at(2101, 1500, 5), free]), A, B))).toBe('000');
  });

  it('an occluded hold (gap ≤ RELEASE_GAP between held frames) is bridged', () => {
    expect(bits(sigReleasedBy(relCtx([held, null, null, held, free]), A, B))).toBe('00001');
    // release right after a short occlusion of the held ball
    expect(bits(sigReleasedBy(relCtx([held, held, null, free]), A, B))).toBe('0001');
    // too long an occlusion breaks the chain
    expect(bits(sigReleasedBy(relCtx([held, null, null, null, held, free]), A, B))).toBe('000000');
  });

  it('person absent ⇒ not held', () => {
    expect(bits(sigReleasedBy(relCtx([held, held, free], [hand, null, hand]), A, B))).toBe('000');
  });
});

describe('disappears_into', () => {
  const can = q(7600, 6200, 8800, 9400); // opening (7720, 5880, 8680, 6840)
  function ctxOf(ball: Col, canCol: Col = ball.map(() => can), segs?: [number, number][]) {
    return mkCtx({ entities: [2, 2], trackEntities: [0, 1], cols: [ball, canCol], segs });
  }
  /** descend into the opening at pos 2, then gone for `gone` frames */
  function drop(gone: number, tail: Col = []): Col {
    const col: Col = [at(8200, 5000, 50), at(8200, 5600, 50), at(8200, 6300, 50)];
    for (let i = 0; i < gone; i++) col.push(null);
    return [...col, ...tail];
  }

  it('fires once at the entry frame', () => {
    expect(bits(sigDisappearsInto(ctxOf(drop(10)), A, OPEN))).toBe('0010000000000');
  });

  it('requires the full DISAPPEAR_FRAMES look-ahead inside the segment', () => {
    expect(bits(sigDisappearsInto(ctxOf(drop(9)), A, OPEN))).toBe('000000000000');
    // look-ahead at the segment end: frames exist but in the next segment
    const col = drop(10);
    expect(bits(sigDisappearsInto(ctxOf(col, undefined, [[0, 12], [12, 1]]), A, OPEN))).toBe('0000000000000');
  });

  it('requires descending within DESCEND_LOOKBACK', () => {
    const col: Col = [at(8200, 6300, 50), at(8200, 6300, 50), at(8200, 6300, 50)];
    for (let i = 0; i < 10; i++) col.push(null);
    expect(bits(sigDisappearsInto(ctxOf(col), A, OPEN)).slice(0, 3)).toBe('000');
  });

  it('the object may reappear only inside the container', () => {
    const inside = at(8000, 8000, 50);
    const outside = at(5000, 8000, 50);
    expect(bits(sigDisappearsInto(ctxOf(drop(5, [inside, null, null, null, null])), A, OPEN))[2]).toBe('1');
    expect(bits(sigDisappearsInto(ctxOf(drop(5, [outside, null, null, null, null])), A, OPEN))[2]).toBe('0');
  });

  it('must vanish at least once within the look-ahead', () => {
    const col: Col = [at(8200, 5000, 50), at(8200, 5600, 50), at(8200, 6300, 50)];
    for (let i = 0; i < 10; i++) col.push(at(8200, 7000, 50));
    expect(bits(sigDisappearsInto(ctxOf(col), A, OPEN))[2]).toBe('0');
  });

  it('container uses the stale rule; undefined container ⇒ object must be absent', () => {
    // can occluded during the look-ahead but recently seen ⇒ still a container
    const canCol: Col = [can, can, can, ...new Array<null>(10).fill(null)];
    expect(bits(sigDisappearsInto(ctxOf(drop(10), canCol), A, OPEN))[2]).toBe('1');
    // can never seen ⇒ b undefined at f
    expect(bits(sigDisappearsInto(ctxOf(drop(10), new Array<null>(13).fill(null)), A, OPEN))[2]).toBe('0');
  });

  it('works with a zone', () => {
    const zone: DecodedRegion = { entity_idx: 1, shape: 1, points: [[7000, 6000], [9000, 6000], [9000, 9000], [7000, 9000]], behind_sign: 0 };
    const ball = drop(10);
    const ctx = mkCtx({ entities: [2, 4], regions: [zone], trackEntities: [0], cols: [ball] });
    expect(bits(sigDisappearsInto(ctx, A, B))).toBe('0010000000000');
  });
});
