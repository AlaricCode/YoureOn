// SAM 3.1 camera checks, design final.md §3-§5: the band edges and blocking-side guards of each p1
// predicate, so a constant or a conjunct cannot drift without a failing test. Frames as in
// evaluate.test.ts: 144x256 (Fmin 144, EDGE 1.44 px in x and 2.56 px in y), end frames 9-11.
import { describe, expect, it } from 'vitest';
import { CheckReport, evaluateChecks, matchInstances, resolve } from '../../src/checks/evaluate';
import type { CheckSpec } from '../../src/checks/spec';
import { bar, box, det, DUR, END, frames, META, type Obj, reply, spec, TIMES, W, H } from './synth';

const run = (s: CheckSpec, r: unknown) => CheckReport.parse(evaluateChecks(s, r, TIMES, DUR, META));
const ending = (rest: Obj[], end: Obj[]) => frames((i) => (END.includes(i) ? end : rest));
const at = (map: Record<number, Obj[]>, rest: Obj[] = []) => frames((i) => map[i] ?? rest);
const asDet = (o: Obj) => ({
  id: o.id,
  score: o.score,
  box: o.box_xyxy as unknown as [number, number, number, number],
  mainArea: o.mask_area,
  maskArea: o.mask_area,
  tiltDeg: 0,
  elong: 4,
  clip: { l: false, r: false, t: false, b: false },
  clipped: false,
});

const BOTTLE = box(60, 100, 80, 180);
const one = (p: Record<string, unknown>) => spec([['bottle', 'bottle', 1]], [['need', p]]);
const bottle = (p: Record<string, unknown>, f: Obj[][]) =>
  run(one(p), reply({ bottle: f })).results[0]!;

describe('identity edges (§5)', () => {
  it('DEDUPE_IOU 0.5: IoU 0.67 is one object, IoU 0.39 is a rival', () => {
    const A = W * H;
    const a = { ...asDet(box(60, 100, 80, 180)), score: 0.95 };
    expect(resolve([a, { ...asDet(box(60, 116, 80, 196)), score: 0.9 }], 1, A).state).toBe('seen');
    expect(resolve([a, { ...asDet(box(60, 135, 80, 215)), score: 0.9 }], 1, A).state).toBe(
      'ambiguous',
    );
  });
  it('MATCH_DIAG and MATCH_SECOND', () => {
    const two = [asDet(box(20, 150, 40, 180)), asDet(box(52, 150, 72, 180))];
    // A moves 10 px (0.28 diag) but B lands 16 px from A: nearest is not < 0.5 x second
    const near = [asDet(box(10, 150, 30, 180)), asDet(box(36, 150, 56, 180))];
    expect(matchInstances(two, near)).toBeNull();
    // both move 22 px (0.61 diag) in parallel: unique nearest, but over MATCH_DIAG
    const apart = [asDet(box(20, 150, 40, 180)), asDet(box(100, 150, 120, 180))];
    const far = [asDet(box(42, 150, 62, 180)), asDet(box(122, 150, 142, 180))];
    expect(matchInstances(apart, far)).toBeNull();
    const ok = [asDet(box(24, 150, 44, 180)), asDet(box(104, 150, 124, 180))];
    expect(matchInstances(apart, ok)).toEqual([0, 1]);
  });
});

describe('subject clipping: the EDGE margin and all four sides (§2, §4)', () => {
  const up = { p: 'upright', e: 'bottle' };
  it('within 0.01 W of the left edge is clipped; 2 px in is not', () => {
    expect(bottle(up, frames([box(1, 100, 21, 180)])).why).toBe('clipped');
    expect(bottle(up, frames([box(2, 100, 22, 180)])).value).toBe('true');
  });
  it('top and bottom clip too, with the margin taken from H', () => {
    expect(bottle(up, frames([box(60, 0, 80, 80)])).why).toBe('clipped');
    expect(bottle(up, frames([box(60, 2, 80, 82)])).why).toBe('clipped'); // 2 <= 2.56
    expect(bottle(up, frames([box(60, 3, 80, 83)])).value).toBe('true');
    expect(bottle(up, frames([box(60, 176, 80, 256)])).why).toBe('clipped');
    const vis = spec(
      [['bottle', 'bottle', 1]],
      [
        ['gate', { p: 'visible', e: 'bottle', window: 'end' }],
        ['need', up],
      ],
    );
    expect(run(vis, reply({ bottle: frames([box(60, 0, 80, 80)]) })).results[0]!.why).toBe(
      'clipped',
    );
  });
});

describe('upright band edges (§3)', () => {
  const up = { p: 'upright', e: 'bottle' };
  const tilt = (deg: number) => frames([det(bar(72, 140, 80, 20, deg), 0.95, 0, `bar${deg}`)]);
  it('10 deg true; 20 and 45 deg unknown (never false); 60 deg false', () => {
    expect(bottle(up, tilt(10)).value).toBe('true');
    expect(bottle(up, tilt(20))).toMatchObject({ value: 'unknown', why: 'between_bands' });
    expect(bottle(up, tilt(45))).toMatchObject({ value: 'unknown', why: 'between_bands' });
    expect(bottle(up, tilt(60)).value).toBe('false');
  });
  it('a 1.3:1 blob at 0 deg is too compact to judge (elong < 1.6)', () => {
    expect(bottle(up, frames([box(60, 120, 80, 146)]))).toMatchObject({
      value: 'unknown',
      why: 'between_bands',
    });
  });
});

describe('at_rest band edges (§3)', () => {
  const still = { p: 'at_rest', e: 'bottle', ref: null };
  it('a 20% size change is between the bands', () => {
    const r = bottle(still, at({ 11: [box(60, 92, 80, 188)] }, [BOTTLE]));
    expect(r).toMatchObject({ value: 'unknown', why: 'between_bands' });
  });
  it('the shake allowance A applies only without a ref', () => {
    const f = at({ 11: [box(69, 100, 89, 180)] }, [BOTTLE]); // 9 px: 0.1 diag (8.2) + A (2.2)
    expect(bottle(still, f).value).toBe('true');
    const withRef = spec(
      [
        ['bottle', 'bottle', 1],
        ['table', 'table', 1],
      ],
      [
        ['gate', { p: 'visible', e: 'table', window: 'end' }],
        ['need', { p: 'at_rest', e: 'bottle', ref: 'table' }],
      ],
    );
    const r = run(withRef, reply({ bottle: f, table: frames([box(10, 180, 100, 230)]) }));
    expect(r.results[1]).toMatchObject({ value: 'unknown', why: 'between_bands' });
  });
  it('two cups moving 0.6 diag in parallel are unmatched, not "moved"', () => {
    const c = spec([['cup', 'cup', 2]], [['need', { p: 'at_rest', e: 'cup', ref: null }]]);
    const two = [box(20, 150, 40, 180), box(80, 150, 100, 180)];
    const moved = [box(42, 150, 62, 180), box(102, 150, 122, 180)];
    expect(run(c, reply({ cup: at({ 10: moved, 11: moved }, two) })).results[0]!.why).toBe(
      'unmatched',
    );
  });
});

describe('two-frame rule on every frame-wise predicate (§3)', () => {
  it('on_top: beside on frame 11 only', () => {
    const s = spec(
      [
        ['frisbee', 'frisbee', 1],
        ['table', 'table', 1],
      ],
      [
        ['gate', { p: 'visible', e: 'table', window: 'end' }],
        ['need', { p: 'on_top', a: 'frisbee', b: 'table' }],
      ],
    );
    const fr = at({ 11: [box(10, 200, 40, 210)] }, [box(90, 140, 124, 150)]);
    const r = run(s, reply({ frisbee: fr, table: frames([box(80, 150, 134, 240)]) }));
    expect(r.results[1]).toMatchObject({ value: 'unknown', why: 'single_frame' });
  });
  it('stacked: side by side on frame 11 only', () => {
    const s = spec([['cup', 'cup', 3]], [['need', { p: 'stacked', e: 'cup' }]]);
    const base = [box(40, 200, 64, 230), box(66, 200, 90, 230)];
    const f = at({ 11: [...base, box(92, 200, 116, 230)] }, [...base, box(53, 172, 77, 200)]);
    expect(run(s, reply({ cup: f })).results[0]).toMatchObject({
      value: 'unknown',
      why: 'single_frame',
    });
  });
  it('moved_from_start: a can back in its spot on frame 11 only', () => {
    const s = spec(
      [['can', 'can', 3]],
      [
        ['gate', { p: 'visible', e: 'can', window: 'start' }],
        ['need', { p: 'moved_from_start', e: 'can', of: 'all', ref: null }],
      ],
    );
    const cans = [box(20, 120, 32, 150), box(60, 120, 72, 150), box(100, 120, 112, 150)];
    const r = run(s, reply({ can: at({ 9: [], 10: [], 11: [cans[1]!] }, cans) }));
    expect(r.results[1]).toMatchObject({ value: 'unknown', why: 'single_frame' });
  });
  it('switched_sides: the same side on frame 11 only, straddling on 9-10', () => {
    const s = spec(
      [
        ['chair', 'chair', 1],
        ['person', 'person', 1],
      ],
      [
        ['gate', { p: 'visible', e: 'chair', window: 'end' }],
        ['need', { p: 'switched_sides', a: 'person', b: 'chair' }],
      ],
    );
    const L = box(10, 100, 30, 220);
    const mid = box(62, 100, 82, 220);
    const p = frames((i) => (i === 9 || i === 10 ? [mid] : [L]));
    const r = run(s, reply({ chair: frames([box(60, 150, 84, 220)]), person: p }));
    expect(r.results[1]!.value).toBe('unknown');
  });
});

describe('moved_from_start: STAYED is the trusted side (§3, §4 #4)', () => {
  const s = spec(
    [['can', 'can', 1]],
    [['need', { p: 'moved_from_start', e: 'can', of: 'all', ref: null }]],
  );
  const res = (f: Obj[][]) => run(s, reply({ can: f })).results[0]!;
  const CAN = box(60, 120, 72, 150); // 12x30
  it('the same can in its spot: false; a weak lookalike there: unknown', () => {
    expect(res(frames([CAN])).value).toBe('false');
    expect(res(ending([CAN], [{ ...CAN, score: 0.6 }]))).toMatchObject({ value: 'unknown' });
  });
  it('area 1.4x at the same centre: not STAYED', () => {
    expect(res(ending([CAN], [box(59, 117, 73, 153)]))).toMatchObject({
      value: 'unknown',
      why: 'between_bands',
    });
  });
  it('aspect change 1.16 is STAYED; 1.30 is neither STAYED nor toppled', () => {
    expect(res(ending([CAN], [box(60, 121, 73, 149)])).value).toBe('false');
    expect(res(ending([CAN], [box(59, 121, 73, 148)]))).toMatchObject({
      value: 'unknown',
      why: 'between_bands',
    });
  });
  it('a 3 px wobble between frames 0 and 1 (IoU 0.6) is start_unstable', () => {
    expect(res(at({ 1: [box(63, 120, 75, 150)] }, [CAN])).why).toBe('start_unstable');
  });
  it('an ambiguous end frame (rival within MARGIN) is unknown, never STAYED (U2)', () => {
    const rival = box(110, 20, 122, 50, 0.78, 1);
    const r = res(ending([{ ...CAN, score: 0.9 }], [{ ...CAN, score: 0.9 }, rival]));
    expect(r).toMatchObject({ value: 'unknown', why: 'ambiguous' });
  });
  it('a subject clipped on the end frames is unknown, whether in its spot or cut down', () => {
    const edge = box(110, 100, 140, 160);
    expect(res(ending([edge], [box(112, 100, 144, 160)]))).toMatchObject({
      value: 'unknown',
      why: 'clipped',
    });
    expect(res(ending([box(100, 100, 140, 180)], [box(110, 100, 144, 150)]))).toMatchObject({
      value: 'unknown',
      why: 'clipped',
    });
  });
});

describe('touching: the GAP_APART band max(0.05 Fmin, 0.5 diag_a) (§3)', () => {
  const s = spec(
    [
      ['face', 'face', 1],
      ['spoon', 'spoon', 1],
    ],
    [
      ['gate', { p: 'visible', e: 'face', window: 'end' }],
      ['need', { p: 'touching', a: 'spoon', b: 'face', window: 'end' }],
    ],
  );
  const res = (spoon: Obj) =>
    run(s, reply({ face: frames([box(40, 20, 100, 90)]), spoon: frames([spoon]) })).results[1]!;
  it('6x30 spoon: a 10 px gap is under 0.5 diag (15.3): unknown; 17 px is apart', () => {
    expect(res(box(60, 100, 66, 130)).why).toBe('between_bands');
    expect(res(box(60, 107, 66, 137)).value).toBe('false');
  });
  it('3x6 crumb: a 5 px gap is under 0.05 Fmin (7.2): unknown', () => {
    expect(res(box(60, 95, 63, 101)).why).toBe('between_bands');
  });
});

describe('on_top and stacked: each true-side conjunct (§3)', () => {
  const s = spec(
    [
      ['frisbee', 'frisbee', 1],
      ['table', 'table', 1],
    ],
    [
      ['gate', { p: 'visible', e: 'table', window: 'end' }],
      ['need', { p: 'on_top', a: 'frisbee', b: 'table' }],
    ],
  );
  const res = (f: Obj) =>
    run(s, reply({ frisbee: frames([f]), table: frames([box(80, 150, 134, 240)]) })).results[1]!;
  it('centre below the table centre, base below the table, a gap, base above the band', () => {
    expect(res(box(90, 190, 124, 210)).why).toBe('between_bands'); // a.cy > b.cy
    expect(res(box(90, 140, 124, 245)).why).toBe('between_bands'); // a.y1 > b.y1
    expect(res(box(90, 105, 124, 145)).why).toBe('between_bands'); // gap 5 > GAP_TOUCH
    expect(res(box(90, 138, 124, 148)).why).toBe('between_bands'); // y1 148 < 150 - 1.5
  });

  const st = spec([['cup', 'cup', 3]], [['need', { p: 'stacked', e: 'cup' }]]);
  const cups = (top: Obj, base = [box(40, 200, 64, 230), box(66, 200, 90, 230)]) =>
    run(st, reply({ cup: frames([...base, top]) })).results[0]!;
  it('stacked: sunk too low is unknown; far beside is false; an overlapping row is not false', () => {
    expect(cups(box(53, 186, 77, 216)).why).toBe('between_bands');
    expect(cups(box(118, 170, 142, 200)).value).toBe('false');
    const row = [box(40, 200, 64, 230), box(60, 200, 84, 230)];
    expect(cups(box(80, 200, 104, 230), row).value).not.toBe('false');
  });
});

describe('switched_sides: the first frame seen together is used even when clipped (§4 #9)', () => {
  it('clipped at the left on that frame: unknown, not a later mid-flight frame', () => {
    const s = spec(
      [
        ['chair', 'chair', 1],
        ['person', 'person', 1],
      ],
      [
        ['gate', { p: 'visible', e: 'chair', window: 'end' }],
        ['need', { p: 'switched_sides', a: 'person', b: 'chair' }],
      ],
    );
    const p = at({ 0: [box(0, 100, 20, 220)], 1: [] }, [box(100, 100, 120, 220)]);
    const r = run(s, reply({ chair: frames([box(60, 150, 84, 220)]), person: p }));
    expect(r.results[1]).toMatchObject({ value: 'unknown', why: 'clipped', frames: [0] });
  });
});

describe('never_seen applies only to needs with subjects (interpretation 8)', () => {
  it('a need visible(e) on a never-detected, ungated entity does not abstain', () => {
    const r = bottle({ p: 'visible', e: 'bottle', window: 'end' }, frames([]));
    expect(r).toMatchObject({ value: 'false', why: 'absent' });
  });
});
