// SAM 3.1 camera checks, design final.md §2-§5, §7: the p1 evaluator on synthetic masks. Frames are
// 144x256 (the real 288x512 halved; every threshold is relative), 12 judge frames over 3 s:
// lead-in 0-3, landing 4-11, end 9-11.
import { describe, expect, it } from 'vitest';
import { hashJcs } from '../../src/jcs';
import { decodeRle, encodeRle, mainBlob } from '../../src/checks/rle';
import {
  CheckReport,
  evaluateChecks,
  matchInstances,
  P1,
  resolve,
} from '../../src/checks/evaluate';
import type { CheckSpec } from '../../src/checks/spec';
import { judgeFrameTimesMs } from '../../src/judge/frames';
import {
  bar,
  box,
  det,
  DUR,
  END,
  frames,
  H,
  META,
  N,
  type Obj,
  rect,
  reply,
  spec,
  TIMES,
  union,
  W,
} from './synth';

function run(s: CheckSpec, r: unknown, times: number[] = TIMES, dur = DUR) {
  const meta = { ...META, frame_hashes: META.frame_hashes.slice(0, Math.max(1, times.length)) };
  return CheckReport.parse(evaluateChecks(s, r, times, dur, meta));
}
/** frames() with `end` objects on the end frames (9-11) and `rest` elsewhere. */
const ending = (rest: Obj[], end: Obj[]) => frames((i) => (END.includes(i) ? end : rest));
const at = (map: Record<number, Obj[]>, rest: Obj[] = []) => frames((i) => map[i] ?? rest);

const BOTTLE = box(60, 100, 80, 180); // upright: 20x80, tilt 0, elong 4
const LYING = box(30, 160, 110, 180);

describe('RLE and the main blob (§2)', () => {
  it('round-trips the service convention (column-major, counts start with zeros)', () => {
    const data = new Uint8Array(W * H);
    data[0] = 1; // first pixel set: counts start with a 0-length zeros run
    data[5 * W + 7] = 1;
    const r = encodeRle({ width: W, height: H, data });
    expect(r.counts[0]).toBe(0);
    expect(r.size).toEqual([H, W]);
    expect(decodeRle(r).data).toEqual(data);
    expect(() => decodeRle({ size: [H, W], counts: [5, 3] })).toThrow();
  });

  it('largest 4-connected component (diagonal neighbours are separate, as in scipy)', () => {
    const data = new Uint8Array(4 * 4);
    for (const p of [0, 5, 6, 10]) data[p] = 1; // (0,0) alone; (1,1) (2,1) (2,2) joined
    const s = mainBlob({ width: 4, height: 4, data });
    expect(s).toMatchObject({ components: 2, mainArea: 3, maskArea: 4, box: [1, 1, 3, 3] });
  });

  it('tilt and elongation from second moments', () => {
    const m = (o: Obj) => mainBlob(decodeRle(o.mask_rle!))!;
    expect(m(BOTTLE).tiltDeg).toBeCloseTo(0, 5);
    expect(m(BOTTLE).elong).toBeCloseTo(4, 1);
    expect(m(LYING).tiltDeg).toBeCloseTo(90, 5);
    const b30 = m(det(bar(72, 140, 80, 20, 30), 0.95, 0, 'bar30'));
    expect(b30.tiltDeg).toBeGreaterThan(27);
    expect(b30.tiltDeg).toBeLessThan(33);
  });
});

describe('identity per frame (§5)', () => {
  const d = (score: number, x = 60) => ({ ...dd(box(x, 100, x + 20, 180)), score });
  const dd = (o: Obj) => ({
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
  const A = W * H;
  it('S_FLOOR, S_SEEN and MARGIN (the plate vs baking tray case)', () => {
    expect(resolve([d(0.95), d(0.73, 100)], 1, A).state).toBe('seen'); // 0.80 > 0.73
    expect(resolve([d(0.73)], 1, A).state).toBe('weak');
    expect(resolve([d(0.95), d(0.81, 100)], 1, A).state).toBe('ambiguous'); // 2 strong
    expect(resolve([d(0.85), d(0.72, 100)], 1, A).state).toBe('ambiguous'); // within margin
    expect(resolve([d(0.49)], 1, A).state).toBe('absent');
    expect(resolve([d(-10000)], 1, A).state).toBe('absent');
  });
  it('dedupe: overlapping boxes (IoU >= 0.5) are one object, the higher score kept', () => {
    const r = resolve([d(0.9, 61), d(0.95, 60)], 1, A);
    expect(r.state).toBe('seen');
    expect(r.inst[0]?.score).toBe(0.95);
    expect(r.cands).toHaveLength(1);
  });
  it('count N: exactly N strong and the (N+1)th below the Nth - MARGIN', () => {
    const three = [d(0.95, 0), d(0.95, 40), d(0.9, 80)];
    expect(resolve(three, 3, A).state).toBe('seen');
    expect(resolve([...three, d(0.6, 120)], 3, A).state).toBe('seen');
    expect(resolve([...three, d(0.78, 120)], 3, A).state).toBe('ambiguous');
    expect(resolve([...three, d(0.85, 120)], 3, A).state).toBe('ambiguous');
    expect(resolve(three.slice(0, 2), 3, A).state).toBe('partial');
  });
  it('MIN_AREA: blobs under 0.0003 W H are noise', () => {
    const tiny = { ...d(0.95), mainArea: Math.floor(P1.MIN_AREA_FRAC * A) };
    expect(resolve([tiny], 1, A).state).toBe('absent');
  });
  it('cross-frame matching: unique nearest or unmatched', () => {
    const a = [dd(box(20, 150, 40, 180)), dd(box(80, 150, 100, 180))];
    expect(matchInstances(a, [...a].reverse())).toEqual([1, 0]);
    const close = [dd(box(50, 150, 70, 180)), dd(box(72, 150, 92, 180))];
    const mid = [dd(box(61, 150, 81, 180)), dd(box(83, 150, 103, 180))];
    expect(matchInstances(close, mid)).toBeNull();
  });
});

describe('visible (§4 #1)', () => {
  const gate = (w = 'end', also: [string, Record<string, unknown>][] = []) =>
    spec([['bottle', 'bottle', 1]], [['gate', { p: 'visible', e: 'bottle', window: w }], ...also]);
  const res = (s: CheckSpec, f: Obj[][]) => run(s, reply({ bottle: f })).results[0]!;

  it('true when seen on every window frame; false when every window frame is empty', () => {
    expect(res(gate(), frames([BOTTLE]))).toMatchObject({ value: 'true', frames: END });
    expect(res(gate(), ending([BOTTLE], []))).toMatchObject({ value: 'false', why: 'absent' });
    expect(res(gate('start'), at({ 0: [], 1: [] }, [BOTTLE])).value).toBe('false');
  });

  it('S_FLOOR / MIN_AREA: low scores and tiny blobs count as not there', () => {
    expect(res(gate(), ending([BOTTLE], [{ ...BOTTLE, score: -10000 }])).value).toBe('false');
    expect(res(gate(), ending([BOTTLE], [{ ...BOTTLE, score: 0.4 }])).value).toBe('false');
    expect(res(gate(), ending([BOTTLE], [box(60, 100, 63, 103)])).value).toBe('false');
  });

  it('weak, ambiguous or partly present is unknown', () => {
    expect(res(gate(), at({ 10: [{ ...BOTTLE, score: 0.7 }] }, [BOTTLE]))).toMatchObject({
      value: 'unknown',
      why: 'weak',
      frames: [10],
    });
    const twin = box(100, 100, 120, 180, 0.9, 1);
    expect(res(gate(), ending([BOTTLE], [BOTTLE, twin])).why).toBe('ambiguous');
    expect(res(gate(), at({ 11: [] }, [BOTTLE])).value).toBe('unknown'); // one empty frame
  });

  it('margin: a 0.73 rival next to a 0.95 bottle is outside it; dedupe absorbs re-detection', () => {
    expect(res(gate(), frames([BOTTLE, box(100, 20, 120, 60, 0.73, 1)])).value).toBe('true');
    expect(res(gate(), frames([BOTTLE, box(61, 102, 81, 182, 0.9, 1)])).value).toBe('true');
  });

  it('a subject must be unclipped ("fully in shot"); a non-subject may be clipped', () => {
    const edge = box(0, 100, 20, 180);
    expect(res(gate(), frames([edge])).value).toBe('true');
    const sub = gate('end', [['need', { p: 'upright', e: 'bottle' }]]);
    expect(res(sub, frames([edge]))).toMatchObject({ value: 'unknown', why: 'clipped' });
  });

  it('landing: up to floor(n/4) frames may be merely weak (n = 12 uploads: 3 of 8)', () => {
    const weak = { ...BOTTLE, score: 0.7 };
    const w3 = { 5: [weak], 6: [weak], 7: [weak] };
    expect(res(gate('landing'), at(w3, [BOTTLE])).value).toBe('true');
    expect(res(gate('landing'), at({ ...w3, 8: [weak] }, [BOTTLE])).value).toBe('unknown');
    // a clipped weak subject does not use the allowance (interpretation 7)
    const sub = gate('landing', [['need', { p: 'upright', e: 'bottle' }]]);
    const cw = { ...box(0, 100, 20, 180), score: 0.7 };
    expect(res(sub, at({ 5: [cw], 6: [cw] }, [BOTTLE])).value).toBe('unknown');
    expect(res(gate('landing'), at({ 5: [cw], 6: [cw] }, [BOTTLE])).value).toBe('true');
    expect(res(gate('end'), at({ 10: [weak] }, [BOTTLE])).value).toBe('unknown');
  });

  it('count > 1: all instances seen; fewer candidates than count on every frame is false', () => {
    const s = spec([['cup', 'cup', 3]], [['gate', { p: 'visible', e: 'cup', window: 'end' }]]);
    const cups = [box(10, 150, 30, 180), box(50, 150, 70, 180), box(90, 150, 110, 180, 0.9)];
    const r = (f: Obj[][]) => run(s, reply({ cup: f })).results[0]!;
    expect(r(frames(cups)).value).toBe('true');
    expect(r(frames(cups.slice(0, 2))).value).toBe('false');
    expect(r(frames([...cups.slice(0, 2), { ...cups[2]!, score: 0.6 }]))).toMatchObject({
      value: 'unknown',
      why: 'count_mismatch',
    });
    expect(r(frames([...cups, box(120, 20, 140, 50, 0.78)])).why).toBe('ambiguous');
  });
});

describe('at_rest (§4 #2)', () => {
  const s = spec([['bottle', 'bottle', 1]], [['need', { p: 'at_rest', e: 'bottle', ref: null }]]);
  const res = (f: Obj[][]) => run(s, reply({ bottle: f })).results[0]!;

  it('true when every end pair is still', () => {
    expect(res(frames([BOTTLE]))).toMatchObject({ value: 'true', frames: END });
  });
  it('one false pair is enough (a pair already spans two frames)', () => {
    expect(res(at({ 11: [box(100, 100, 120, 180)] }, [BOTTLE]))).toMatchObject({
      value: 'false',
      frames: [10, 11],
    });
    expect(res(at({ 11: [box(60, 100, 80, 140)] }, [BOTTLE])).value).toBe('false'); // size 0.67
  });
  it('between the bands, or not seen on an end frame: unknown', () => {
    expect(res(at({ 11: [box(75, 100, 95, 180)] }, [BOTTLE]))).toMatchObject({
      value: 'unknown',
      why: 'between_bands',
    });
    expect(res(at({ 10: [] }, [BOTTLE])).why).toBe('absent');
  });

  it('a ref cancels hand-held drift; without one the drift is not "at rest"', () => {
    const pan = (k: number) => [box(60 + k, 100, 80 + k, 180)];
    const table = (k: number) => [box(10 + k, 180, 100 + k, 230)];
    const shift = (i: number) => (i === 10 ? 12 : i === 11 ? 24 : 0);
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
    const per = { bottle: frames((i) => pan(shift(i))), table: frames((i) => table(shift(i))) };
    expect(run(withRef, reply(per)).results[1]!.value).toBe('true');
    expect(run(s, reply({ bottle: per.bottle })).results[0]!.value).toBe('unknown');
    expect(run(withRef, reply({ ...per, table: at({ 10: [] }, table(0)) })).results[1]!.why).toBe(
      'ref_missing',
    );
  });

  it('count > 1: instances matched geometrically; an ambiguous match is unknown', () => {
    const c = spec([['cup', 'cup', 2]], [['need', { p: 'at_rest', e: 'cup', ref: null }]]);
    const two = [box(20, 150, 40, 180), box(80, 150, 100, 180)];
    expect(run(c, reply({ cup: frames(two) })).results[0]!.value).toBe('true');
    expect(run(c, reply({ cup: frames([...two].reverse()) })).results[0]!.value).toBe('true');
    const close = [box(50, 150, 70, 180), box(72, 150, 92, 180)];
    const mid = [box(61, 150, 81, 180), box(83, 150, 103, 180)];
    expect(run(c, reply({ cup: at({ 10: mid }, close) })).results[0]!.why).toBe('unmatched');
  });
});

describe('upright (§4 #3) and the two-frame rule', () => {
  const s = spec([['bottle', 'bottle', 1]], [['need', { p: 'upright', e: 'bottle' }]]);
  const res = (f: Obj[][]) => run(s, reply({ bottle: f })).results[0]!;

  it('true: tilt <= 15 and elong >= 1.6 on every end frame', () => {
    expect(res(frames([BOTTLE]))).toMatchObject({
      value: 'true',
      measures: [
        { k: 'tilt_deg', v: 0 },
        { k: 'elong', v: 4 },
      ],
    });
  });
  it('false needs 2 clearly horizontal end frames; one alone is unknown', () => {
    expect(res(ending([BOTTLE], [LYING])).value).toBe('false');
    expect(res(at({ 10: [LYING], 11: [LYING] }, [BOTTLE])).value).toBe('false');
    expect(res(at({ 11: [LYING] }, [BOTTLE]))).toMatchObject({
      value: 'unknown',
      why: 'single_frame',
      frames: [11],
    });
  });
  it('between 15 and 55 degrees (clip B) or a compact blob: unknown, never false', () => {
    const tilted = det(bar(72, 140, 80, 20, 30), 0.95, 0, 'bar30');
    expect(res(frames([tilted]))).toMatchObject({ value: 'unknown', why: 'between_bands' });
    expect(res(frames([box(60, 140, 90, 170)]))).toMatchObject({
      value: 'unknown',
      why: 'between_bands',
    });
  });
  it('fragmented (main blob < 70% of the mask) or clipped: unknown', () => {
    const frag = det(union(rect(60, 100, 80, 150), rect(100, 100, 120, 140)), 0.95, 0, 'frag');
    expect(frag.components).toBe(2);
    expect(res(frames([frag])).why).toBe('fragmented');
    expect(res(frames([box(0, 100, 20, 180)])).why).toBe('clipped');
  });
});

describe('moved_from_start (§4 #4)', () => {
  const cans = [box(20, 120, 32, 150), box(60, 120, 72, 150), box(100, 120, 112, 150)];
  const TABLE = box(5, 150, 110, 200);
  const mk = (of: 'all' | 'any', ref: string | null) =>
    spec(
      [
        ['can', 'can', 3],
        ['table', 'table', 1],
      ],
      [
        ['gate', { p: 'visible', e: 'can', window: 'start' }],
        ['gate', { p: 'visible', e: 'table', window: 'end' }],
        ['need', { p: 'moved_from_start', e: 'can', of, ref }],
      ],
    );
  const res = (
    of: 'all' | 'any',
    can: Obj[][],
    table = frames([TABLE]),
    ref: string | null = 'table',
  ) => run(mk(of, ref), reply({ can, table })).results[2]!;

  it('all knocked out of their spots (gone counts as moved): true', () => {
    expect(res('all', ending(cans, [])).value).toBe('true');
  });
  it('a can still standing in its spot on >= 2 end frames: false for all, true for any', () => {
    expect(res('all', ending(cans, [cans[1]!]))).toMatchObject({ value: 'false' });
    expect(res('any', ending(cans, [cans[1]!])).value).toBe('true');
    expect(res('any', frames(cans)).value).toBe('false');
  });
  it('toppled in place (aspect change > 30%) counts as moved', () => {
    expect(res('all', ending(cans, [box(56, 126, 76, 150)])).value).toBe('true');
  });
  it('between the bands: unknown', () => {
    expect(res('all', ending(cans, [box(66, 120, 78, 150)]))).toMatchObject({
      value: 'unknown',
      why: 'between_bands',
    });
  });
  it('the table ref cancels a pan; without it the drift reads as moved (fails open)', () => {
    const panned = ending(cans, [box(80, 120, 92, 150)]);
    const table = ending([TABLE], [box(25, 150, 130, 200)]);
    expect(res('all', panned, table).value).toBe('false');
    expect(res('all', panned, table, null).value).toBe('true');
  });
  it('start unstable, crowded end, or fewer than count at the start: unknown', () => {
    const moved = cans.map((c) => box(c.box_xyxy![0]! + 8, 120, c.box_xyxy![2]! + 8, 150));
    expect(res('all', at({ 1: moved }, cans)).why).toBe('start_unstable');
    const extra = box(130, 20, 140, 50);
    expect(res('all', ending(cans, [...cans, extra])).why).toBe('ambiguous');
    expect(res('all', at({ 0: cans.slice(0, 2) }, cans)).why).toBe('count_mismatch');
  });
  it("count 1 with of: 'all'", () => {
    const s = spec(
      [['can', 'can', 1]],
      [['need', { p: 'moved_from_start', e: 'can', of: 'all', ref: null }]],
    );
    expect(run(s, reply({ can: ending([cans[0]!], []) })).results[0]!.value).toBe('true');
    expect(run(s, reply({ can: frames([cans[0]!]) })).results[0]!.value).toBe('false');
  });
});

describe('stacked (§4 #5)', () => {
  const s = spec([['cup', 'cup', 3]], [['need', { p: 'stacked', e: 'cup' }]]);
  const res = (f: Obj[][]) => run(s, reply({ cup: f })).results[0]!;
  const base = [box(40, 200, 64, 230), box(66, 200, 90, 230)];
  it('the highest cup sits on the union of the others: true', () => {
    expect(res(frames([...base, box(53, 172, 77, 200)])).value).toBe('true');
  });
  it('all side by side: false', () => {
    expect(res(frames([...base, box(92, 200, 116, 230)])).value).toBe('false');
  });
  it('count mismatch (nested cups merge) or between the bands: unknown', () => {
    expect(res(frames(base)).why).toBe('count_mismatch');
    expect(res(frames([...base, box(80, 150, 104, 178)])).why).toBe('between_bands');
  });
});

describe('touching (§4 #6)', () => {
  const FACE = box(40, 20, 100, 90);
  const ON = box(60, 90, 66, 120);
  const OFF = box(60, 140, 66, 170);
  const mk = (window: string) =>
    spec(
      [
        ['face', 'face', 1],
        ['spoon', 'spoon', 1],
      ],
      [
        ['gate', { p: 'visible', e: 'face', window: 'landing' }],
        ['need', { p: 'touching', a: 'spoon', b: 'face', window }],
      ],
    );
  const res = (window: string, spoon: Obj[][], face = frames([FACE]), dur = DUR) =>
    run(mk(window), reply({ face, spoon }), judgeFrameTimesMs(dur, N), dur).results[1]!;

  it('touching on every window frame: true; apart on >= 2: false; one apart: unknown', () => {
    expect(res('end', frames([ON])).value).toBe('true');
    expect(res('end', ending([ON], [OFF])).value).toBe('false');
    expect(res('end', at({ 11: [OFF] }, [ON])).why).toBe('single_frame');
    expect(res('end', frames([box(60, 95, 66, 125)])).why).toBe('between_bands');
  });
  it('last_Ns covers the frames in the last N seconds', () => {
    expect(res('last_3s', frames([ON])).value).toBe('true');
    expect(res('last_3s', at({ 1: [OFF], 2: [OFF] }, [ON])).value).toBe('false');
    expect(res('last_2s', at({ 1: [OFF], 2: [OFF] }, [ON])).value).toBe('true'); // t < 920
  });
  it('a clip shorter than the hold is false (clip_too_short)', () => {
    expect(res('last_3s', frames([ON]), frames([FACE]), 2000)).toMatchObject({
      value: 'false',
      why: 'clip_too_short',
    });
    expect(res('last_3s', frames([ON]), frames([FACE]), 2980).value).toBe('true'); // 2900 >= 2900
  });
  it('b missing or a clipped: unknown', () => {
    expect(res('end', frames([ON]), at({ 10: [] }, [FACE])).why).toBe('ref_missing');
    expect(res('end', frames([box(0, 90, 6, 120)]), frames([box(0, 20, 60, 90)])).why).toBe(
      'clipped',
    );
  });
});

describe('on_top (§4 #7)', () => {
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
  const TABLE = box(80, 150, 134, 240);
  const res = (f: Obj[][], t = frames([TABLE])) =>
    run(s, reply({ frisbee: f, table: t })).results[1]!;
  it('base on the tabletop band, centre above, touching: true', () => {
    expect(res(frames([box(90, 140, 124, 150)])).value).toBe('true');
  });
  it('below its support or clearly beside it on >= 2 end frames: false', () => {
    expect(res(frames([box(90, 245, 124, 252)])).value).toBe('false');
    expect(res(frames([box(10, 200, 40, 210)])).value).toBe('false');
  });
  // No "table bottom clipped" case: a clipped bottom is at y1 >= 0.99 H, so "below" would need
  // a.cy > 1.01 H. The §4 guard is kept as written but cannot fire under §3 (EDGE < 0.02 H).
  it('floating above it: between the bands', () => {
    expect(res(frames([box(90, 100, 124, 110)])).why).toBe('between_bands');
  });
});

describe('ends_at (§4 #8) and never_seen abstention (§7.6)', () => {
  const CAN = box(80, 150, 130, 230);
  const AWAY = box(10, 200, 20, 210);
  const NEAR = box(70, 190, 80, 200);
  const mk = (gate: string | null = null) =>
    spec(
      [
        ['can', 'trash can', 1],
        ['paper', 'paper ball', 1],
      ],
      [
        ['gate', { p: 'visible', e: 'can', window: 'end' }],
        ...(gate === null
          ? []
          : [['gate', { p: 'visible', e: 'paper', window: gate }] as [string, object]]),
        ['need', { p: 'ends_at', a: 'paper', b: 'can' }],
      ] as [string, Record<string, unknown>][],
    );
  const res = (paper: Obj[][], can = frames([CAN]), s = mk()) =>
    run(s, reply({ 'trash can': can, 'paper ball': paper })).results.at(-1)!;

  it('absent on the last frame, or touching the target: true', () => {
    expect(res(at({ 11: [] }, [AWAY])).value).toBe('true');
    expect(res(at({ 11: [NEAR] }, [AWAY])).value).toBe('true');
  });
  it('lying away on >= 2 end frames including the last: false', () => {
    expect(res(frames([AWAY]))).toMatchObject({ value: 'false', frames: END });
    expect(res(at({ 10: [], 11: [AWAY] }, [AWAY])).value).toBe('false');
  });
  it('a stale sighting can never give false: only the last frame away is unknown', () => {
    expect(res(at({ 11: [AWAY] }, [])).why).toBe('single_frame');
    expect(res(at({ 9: [AWAY], 10: [AWAY], 11: [box(5, 200, 15, 210, 0.6)] }, [])).why).toBe(
      'weak',
    );
  });
  it('target missing on the last frame: unknown', () => {
    expect(res(at({ 11: [] }, [AWAY]), at({ 11: [] }, [CAN])).why).toBe('ref_missing');
  });
  it('an ungated subject never detected anywhere abstains; gated (at start) it does not', () => {
    const r = run(mk(), reply({ 'trash can': frames([CAN]), 'paper ball': frames([]) }));
    expect(r.results[1]).toMatchObject({ value: 'abstain', why: 'never_seen' });
    expect(r.need).toBe('true');
    const g = run(mk('start'), reply({ 'trash can': frames([CAN]), 'paper ball': frames([]) }));
    expect(g.results.at(-1)!.value).toBe('true');
    expect(g.gate).toBe('false');
    // weak-but-present is not never_seen
    const weak = res(frames([{ ...AWAY, score: 0.6 }]));
    expect(weak.value).toBe('unknown');
  });
});

describe('switched_sides (§4 #9)', () => {
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
  const CHAIR = box(60, 150, 84, 220);
  const L = box(10, 100, 30, 220);
  const R = box(100, 100, 120, 220);
  const res = (p: Obj[][]) => run(s, reply({ chair: frames([CHAIR]), person: p })).results[1]!;
  const lr = (i: number) => (i < 6 ? [L] : [R]);

  it('clearly one side at the first lead-in frame, the other on every end frame: true', () => {
    expect(res(frames(lr)).value).toBe('true');
  });
  it('the same side at the start and on >= 2 end frames, never the other: false', () => {
    expect(res(frames([L])).value).toBe('false');
  });
  it('once seen on the other side: never false', () => {
    expect(res(at({ 5: [R] }, [L])).value).toBe('unknown');
  });
  it('straddling at the start, clipped at the side, never together in the lead-in: unknown', () => {
    expect(res(at({ 0: [box(62, 100, 82, 220)] }, [L])).why).toBe('between_bands');
    expect(res(frames((i) => (i < 6 ? [L] : [box(124, 100, 144, 220)]))).why).toBe('clipped');
    expect(res(frames((i) => (i < 4 ? [] : [R]))).why).toBe('not_together');
    // top/bottom clipping does not matter for sides
    expect(res(frames((i) => (i < 6 ? [box(10, 100, 30, 256)] : [R]))).value).toBe('true');
  });
});

describe('U1, outages and the report (§4 U1, §7, §8)', () => {
  const s = spec(
    [['bottle', 'bottle', 1]],
    [
      ['gate', { p: 'visible', e: 'bottle', window: 'end' }],
      ['need', { p: 'upright', e: 'bottle' }],
    ],
  );
  it('fewer than 8 frames, or a frame-count mismatch: every row unknown', () => {
    const seven = run(s, reply({ bottle: frames([BOTTLE], 7) }), TIMES.slice(0, 7));
    expect(seven.results.map((r) => r.why)).toEqual(['too_few_frames', 'too_few_frames']);
    expect(seven.gate).toBe('unknown');
    const mismatch = run(s, reply({ bottle: frames([BOTTLE], 11) }));
    expect(mismatch.results[0]!.value).toBe('unknown');
  });
  it('8 frames (4 + 4) are enough', () => {
    const t8 = judgeFrameTimesMs(DUR, 8);
    expect(run(s, reply({ bottle: frames([BOTTLE], 8) }), t8).gate).toBe('true');
  });
  it('no reply, an unparseable or unmeasurable reply: unavailable', () => {
    const bad = [
      null,
      { rev: 'x' },
      reply({ cup: frames([BOTTLE]) }), // the prompt is missing
      reply({ bottle: frames([{ ...BOTTLE, mask_rle: undefined }]) }),
      reply({ bottle: frames([{ ...BOTTLE, mask_rle: { size: [H, W], counts: [3, 4] } }]) }),
    ];
    for (const r of bad) {
      const rep = run(s, r);
      expect(rep).toMatchObject({ status: 'unavailable', sam_reply_hash: null, results: [] });
    }
  });
  it('ok reports carry the reply hash, the service rev and the gate/need summary', () => {
    const r = reply({ bottle: frames([BOTTLE]) });
    const rep = run(s, r);
    expect(rep).toMatchObject({
      status: 'ok',
      sam_rev: 'test',
      sam_reply_hash: hashJcs(r),
      gate: 'true',
      need: 'true',
    });
    expect(CheckReport.safeParse({ ...rep, extra: 1 }).success).toBe(false);
    expect(CheckReport.safeParse({ ...rep, status: 'unavailable' }).success).toBe(false);
  });
  it('is deterministic', () => {
    const r = reply({ bottle: ending([BOTTLE], [LYING]) });
    expect(run(s, r)).toEqual(run(s, r));
  });
});
