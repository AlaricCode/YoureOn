/**
 * Primitive boundary vectors (§0.6 coverage list, second to fourth bullets and
 * `still` jitter): segment start, stale region 30/31, disappears_into
 * look-ahead at the segment end, line side 0, polygon edges and vertices,
 * attempt-window overlap, rising at frame 0, level success across attempts,
 * one-frame dropout during enters, occluded hold before release, tail frames,
 * still at 1 px / 5 px jitter.
 */
import { Prng } from '../../src/perception/simulate/prng.js';
import type { Expr, LegExpr, Program, QFrame } from '../../src/types.js';
import { box, buffer, calib, col, makeVector, prog, ref, rep, type Col, type VectorJson } from './common.js';

const EXISTS = { kind: 'exists' } as const;
const countGe = (k: number, attempts = 0) => ({ kind: 'count', cmp: '>=', k, attempts }) as const;

/** and-chain over leg ids 1..n (left-nested). */
function allLegs(n: number): LegExpr {
  let c: LegExpr = { op: 'leg', id: 1 };
  for (let i = 2; i <= n; i++) c = { op: 'and', args: [c, { op: 'leg', id: i }] };
  return c;
}

const obj = (name: string, phrase = name.replace(/_/g, ' ')) => ({ name, kind: 'object' as const, phrase });
const zone = (name: string) => ({ name, kind: 'region' as const, shape: 'zone' as const });
const line = (name: string) => ({ name, kind: 'region' as const, shape: 'line' as const });
const anyone = (name: string) => ({ name, kind: 'person_any' as const });

const SQUARE: [number, number][] = [
  [2000, 2000],
  [6000, 2000],
  [6000, 6000],
  [2000, 6000],
];

function segmentStart(): VectorJson {
  // Three segments. Segment 2 starts with the ball already inside: lastSeen
  // never looks back across a segment boundary, so there is no `enters` at 40.
  const p = prog({
    entities: [obj('ball'), zone('bin')],
    legs: [{ success: { op: 'enters', a: ref('ball'), b: ref('bin') }, rule: countGe(1) }],
  });
  const outside = box(8000, 8000);
  const inside = box(4000, 4000);
  const ball: Col = [
    ...rep(outside, 10), // [0, 10)
    ...rep(inside, 10), // [40, 50): inside from the first frame
    ...rep(outside, 3), // [100, 110): outside, then enters at 103
    ...rep(inside, 7),
  ];
  return makeVector({
    name: 'multi_segment_enters_at_segment_start',
    description:
      'Three segments [0,10) [40,50) [100,110). The ball is inside the zone from the first frame of segment 2 (no lastSeen across segments ⇒ no enters at 40); it enters at 103 in segment 3',
    covers: ['multi_segment', 'primitive segment_start'],
    program: p,
    calibration: calib([{ entity: 'bin', shape: 'zone', points: SQUARE }]),
    buffer: buffer(p, { cols: { ball }, segs: [[0, 10], [40, 10], [100, 10]] }),
    intent: { leg_results: [1], decisive_frames: [[103]], winner_mask: 1 },
  });
}

function staleRegion(gap: 30 | 31): VectorJson {
  // The can is seen at frames 0..4 only; the ball is seen at 4 + gap only.
  const p = prog({
    entities: [obj('ball'), obj('can')],
    legs: [{ success: { op: 'inside', a: ref('ball'), b: ref('can', 'interior') }, rule: EXISTS }],
  });
  const n = 4 + gap + 3;
  const can = col(n, (f) => (f <= 4 ? box(5000, 5000, 1000) : null));
  const ball = col(n, (f) => (f === 4 + gap ? box(5000, 5000, 50) : null));
  return makeVector({
    name: `stale_region_${gap}_frames`,
    description: `can.interior after the can was last seen ${gap} frames earlier: ${
      gap === 30 ? 'still defined (f - p ≤ STALE_REGION_FRAMES)' : 'undefined (> STALE_REGION_FRAMES) ⇒ inside is false'
    }`,
    covers: [`primitive stale_region_${gap}`],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { ball, can } }),
    intent: { leg_results: [gap === 30 ? 1 : 0] },
  });
}

/** Ball path that drops into the can opening at frame 9 and is then unseen. */
function dropIntoCan(n: number, entryFrame = 9): { ball: Col; can: Col } {
  // can (4000,5000)-(6000,8000): opening = (4200, 4700, 5800, 5600)
  const can = rep({ x0: 4000, y0: 5000, x1: 6000, y1: 8000, conf: 90, fill: 0, id_conf: 0, pose: 0 }, n);
  const ys: Record<number, number> = { [entryFrame - 3]: 3800, [entryFrame - 2]: 4300, [entryFrame - 1]: 4600, [entryFrame]: 4900 };
  const ball = col(n, (f) => {
    if (f < entryFrame - 3) return box(5000, 3000, 50);
    if (f <= entryFrame) return box(5000, ys[f]!, 50);
    return null;
  });
  return { ball, can };
}

function disappearLookahead(fits: boolean): VectorJson {
  const p = prog({
    entities: [obj('ball'), obj('can')],
    legs: [{ success: { op: 'disappears_into', a: ref('ball'), b: ref('can', 'opening') }, rule: EXISTS }],
  });
  const n = fits ? 20 : 19;
  const { ball, can } = dropIntoCan(n);
  return makeVector({
    name: fits ? 'disappears_into_lookahead_fits' : 'disappears_into_lookahead_segment_end',
    description: fits
      ? 'Entry at frame 9 in segment [0,20): f + DISAPPEAR_FRAMES = 19 is in the segment ⇒ the event fires'
      : 'Entry at frame 9 in segment [0,19): f + DISAPPEAR_FRAMES = 19 is outside the segment ⇒ no event',
    covers: ['primitive disappears_into_lookahead_segment_end'],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { ball, can } }),
    intent: { leg_results: [fits ? 1 : 0], decisive_frames: [fits ? [9] : []] },
  });
}

function lineSideZero(): VectorJson {
  // Line x = 3000 from (3000,6000) to (3000,10000), behind_sign +1 (x < 3000 is behind).
  // Person anchor = bottom-center. Frame 0: anchor x = 3000 (side 0), 1: 2999, 2: 3000, 3: 3001.
  const p = prog({
    entities: [anyone('someone'), line('mark')],
    legs: [
      { success: { op: 'behind', a: ref('someone'), b: ref('mark') }, rule: countGe(1) },
      { success: { op: 'beyond', a: ref('someone'), b: ref('mark') }, rule: countGe(1) },
      { success: { op: 'crosses', a: ref('someone'), b: ref('mark') }, rule: countGe(1) },
    ],
    outcome: { if_true: 0, condition: allLegs(3), else: 1 },
  });
  const xs = [3000, 2999, 3000, 3001];
  const someone = xs.map((x) => ({ x0: x - 500, y0: 2000, x1: x + 500, y1: 8000, conf: 90, fill: 0, id_conf: 0, pose: 0 }));
  return makeVector({
    name: 'line_side_zero',
    description:
      'Anchor exactly on the line (side 0) is neither behind nor beyond, and a move from side 0 to a side is not a crossing; 2999 → behind at 1, 3001 → beyond at 3; no crossing (each sample next to a side-0 sample)',
    covers: ['primitive line_side_0'],
    program: p,
    calibration: calib([{ entity: 'mark', shape: 'line', points: [[3000, 6000], [3000, 10000]], behind_sign: 1 }]),
    buffer: buffer(p, { cols: { someone } }),
    intent: { leg_results: [1, 1, 0], decisive_frames: [[1], [3], []] },
  });
}

function polygonPoints(name: string, desc: string, poly: [number, number][], pts: [number, number][], want?: (0 | 1)[]): VectorJson {
  const balls = pts.map((_, i) => obj(`ball${i + 1}`));
  const p = prog({
    entities: [...balls, zone('area')],
    legs: pts.map((_, i) => ({ success: { op: 'inside', a: ref(`ball${i + 1}`), b: ref('area') } as Expr, rule: EXISTS })),
    outcome: { if_true: 0, condition: allLegs(pts.length), else: 1 },
  });
  const cols: Record<string, Col> = {};
  pts.forEach(([x, y], i) => (cols[`ball${i + 1}`] = [box(x, y, 40)]));
  return makeVector({
    name,
    description: desc,
    covers: ['primitive polygon_edge_vertex'],
    program: p,
    calibration: calib([{ entity: 'area', shape: 'zone', points: poly }]),
    buffer: buffer(p, { cols }),
    intent: want ? { leg_results: want } : undefined,
  });
}

function attemptWindowOverlap(): VectorJson {
  // V rises at 10 and 30 (W = 50); S rises once, at 35. Attempt 1 ends at 30
  // (the next rising V), so S at 35 only counts for attempt 2.
  const va: Expr = { op: 'present', a: ref('token') };
  const success: Expr = { op: 'present', a: ref('ball') };
  const p = prog({
    entities: [obj('token'), obj('ball')],
    legs: [
      { valid_attempt: va, success, rule: countGe(1, 1) },
      { valid_attempt: va, success, rule: countGe(1, 2) },
    ],
    outcome: { if_true: 0, condition: { op: 'or', args: [{ op: 'leg', id: 1 }, { op: 'leg', id: 2 }] }, else: 1 },
  });
  const n = 50;
  const token = col(n, (f) => ((f >= 10 && f <= 12) || (f >= 30 && f <= 32) ? box(1000, 1000) : null));
  const ball = col(n, (f) => (f >= 35 && f <= 36 ? box(5000, 5000) : null));
  return makeVector({
    name: 'attempt_window_overlap',
    description:
      'Attempts at 10 and 30 with W = 50: attempt 1 ends at the next rising(valid_attempt) (30), so the success at 35 belongs to attempt 2 only. Leg 1 (1 attempt) False, leg 2 (2 attempts) True',
    covers: ['primitive attempt_window_overlap'],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { token, ball } }),
    intent: { leg_results: [0, 1], decisive_frames: [[10], [10, 30, 35]], winner_mask: 1 },
  });
}

function risingFrame0(): VectorJson {
  const p = prog({
    entities: [obj('ball')],
    legs: [{ success: { op: 'present', a: ref('ball') }, rule: { kind: 'count', cmp: '==', k: 1, attempts: 0 } }],
  });
  const ball = rep(box(5000, 5000), 6);
  return makeVector({
    name: 'rising_at_frame_0',
    description:
      'success true from absolute frame 0 (rises there: frame 0 has no predecessor) and true from the start of segment [10,13) (no rise: a segment start f ≠ 0 has no prev). count == 1',
    covers: ['primitive rising_frame_0'],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { ball }, segs: [[0, 3], [10, 3]] }),
    intent: { leg_results: [1], decisive_frames: [[0]] },
  });
}

function levelSuccess(): VectorJson {
  const va: Expr = { op: 'present', a: ref('token') };
  const p = prog({
    entities: [obj('token'), obj('ball')],
    legs: [{ valid_attempt: va, success: { op: 'present', a: ref('ball') }, rule: countGe(2, 2) }],
  });
  const n = 60;
  const token = col(n, (f) => (f === 10 || f === 30 ? box(1000, 1000) : null));
  const ball = col(n, (f) => (f >= 15 ? box(5000, 5000) : null));
  return makeVector({
    name: 'level_success_across_attempts',
    description:
      'success is a level that turns true at 15 and stays true. Attempt 1 (10) gets it (rising at 15); attempt 2 (30) does not, because success never rises again ⇒ count 1 < 2',
    covers: ['primitive level_success_across_attempts'],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { token, ball } }),
    intent: { leg_results: [0], decisive_frames: [[10, 15, 30]] },
  });
}

function dropoutEnters(): VectorJson {
  // ball1: outside at 4, absent at 5, inside at 6 ⇒ lastSeen(6) = 4 (gap 2 ≤ RELEASE_GAP) ⇒ enters at 6.
  // ball2: outside at 4, absent 5..7, inside at 8 ⇒ gap 4 > RELEASE_GAP ⇒ no lastSeen ⇒ no enters.
  const p = prog({
    entities: [obj('ball1'), obj('ball2'), zone('bin')],
    legs: [
      { success: { op: 'enters', a: ref('ball1'), b: ref('bin') }, rule: EXISTS },
      { success: { op: 'enters', a: ref('ball2'), b: ref('bin') }, rule: EXISTS },
    ],
    outcome: { if_true: 0, condition: { op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'not', arg: { op: 'leg', id: 2 } }] }, else: 1 },
  });
  const n = 12;
  const outside = box(8000, 4000);
  const inside = box(4000, 4000);
  const ball1 = col(n, (f) => (f <= 4 ? outside : f === 5 ? null : inside));
  const ball2 = col(n, (f) => (f <= 4 ? outside : f <= 7 ? null : inside));
  return makeVector({
    name: 'enters_one_frame_dropout',
    description:
      'enters across a one-frame dropout (lastSeen bridges gaps ≤ RELEASE_GAP: fires at 6) vs. a three-frame dropout (gap 4: no event)',
    covers: ['primitive enters_one_frame_dropout'],
    program: p,
    calibration: calib([{ entity: 'bin', shape: 'zone', points: SQUARE }]),
    buffer: buffer(p, { cols: { ball1, ball2 } }),
    intent: { leg_results: [1, 0], decisive_frames: [[6], []], winner_mask: 1 },
  });
}

function occludedHold(): VectorJson {
  // thrower box (1000,2000)-(3000,9000): expand 10% ⇒ x 800..3200, y 1300..9700.
  const p = prog({
    entities: [anyone('thrower'), obj('ball1'), obj('ball2')],
    legs: [
      { success: { op: 'released_by', a: ref('ball1'), b: ref('thrower') }, rule: EXISTS },
      { success: { op: 'released_by', a: ref('ball2'), b: ref('thrower') }, rule: EXISTS },
    ],
    outcome: { if_true: 0, condition: { op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'not', arg: { op: 'leg', id: 2 } }] }, else: 1 },
  });
  const n = 6;
  const thrower = rep({ x0: 1000, y0: 2000, x1: 3000, y1: 9000, conf: 90, fill: 0, id_conf: 0, pose: 0 }, n);
  const hand = box(2000, 5000, 50);
  const away = box(6000, 5000, 50);
  // ball1: held 0, occluded 1, held 2, released 3 ⇒ heldrun(2) = 2 ⇒ release at 3.
  const ball1 = [hand, null, hand, away, away, away];
  // ball2: away 0, occluded 1, held 2, released 3 ⇒ heldrun(2) = 1 < RELEASE_HOLD ⇒ no release.
  const ball2 = [away, null, hand, away, away, away];
  return makeVector({
    name: 'released_by_occluded_hold',
    description:
      'released_by after a hold interrupted by one occluded frame (heldrun bridges absent gaps ≤ RELEASE_GAP: release at 3) vs. a single held frame (heldrun 1 < RELEASE_HOLD: no release)',
    covers: ['primitive occluded_hold_before_release'],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { thrower, ball1, ball2 } }),
    intent: { leg_results: [1, 0], decisive_frames: [[3], []], winner_mask: 1 },
  });
}

function tailFrames(): VectorJson {
  // time_limit_s 10 ⇒ LIMIT 100. ball1 drops in at 95 (look-ahead to 105 uses tail
  // frames); ball2 drops in at 100 = LIMIT (not in F_R ⇒ ignored).
  const p = prog({
    entities: [obj('ball1'), obj('ball2'), obj('can')],
    legs: [
      { success: { op: 'disappears_into', a: ref('ball1'), b: ref('can', 'opening') }, rule: EXISTS },
      { success: { op: 'disappears_into', a: ref('ball2'), b: ref('can', 'opening') }, rule: EXISTS },
    ],
    outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
    time_limit_s: 10,
  });
  const n = 120; // LIMIT + TAIL_FRAMES
  const a = dropIntoCan(n, 95);
  const b = dropIntoCan(n, 100);
  return makeVector({
    name: 'event_in_tail_frames',
    description:
      'time limit 10 s (LIMIT 100), buffer [0,120) incl. TAIL_FRAMES. A drop at 95 needs look-ahead to 105 (tail) and counts; a drop at 100 is outside F_R and is ignored',
    covers: ['primitive event_within_1s_of_time_limit'],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { ball1: a.ball, ball2: b.ball, can: a.can } }),
    intent: { leg_results: [1, 0], decisive_frames: [[95], []], winner_mask: 1 },
  });
}

/** `still` with ±jitter px of center noise on a 1920×1080 frame (quantized as §0.4). */
function stillJitter(px: 1 | 5): VectorJson {
  const p = prog({
    entities: [obj('ball')],
    legs: [
      { success: { op: 'at_rest', a: ref('ball'), frames: 10 }, rule: EXISTS },
      { success: { op: 'moving', a: ref('ball') }, rule: { kind: 'never' } },
    ],
    outcome: { if_true: 0, condition: { op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'leg', id: 2 }] }, else: 1 },
  });
  const rng = new Prng(1000 + px);
  const W = 1920;
  const H = 1080;
  const n = 30;
  const ball = col(n, () => {
    const cx = 960 + rng.int(-px, px);
    const cy = 540 + rng.int(-px, px);
    const half = 20;
    const q = (v: number, d: number) => Math.min(10000, Math.max(0, Math.floor((v * 10000) / d)));
    return { x0: q(cx - half, W), y0: q(cy - half, H), x1: q(cx + half, W), y1: q(cy + half, H), conf: 90, fill: 0, id_conf: 0, pose: 0 } as QFrame;
  });
  return makeVector({
    name: `still_jitter_${px}px`,
    description: `A resting ball with uniform ±${px} px center jitter per frame on a 1920×1080 camera (normalized per §0.4): at_rest 1s and never moving`,
    covers: [`primitive still_${px}px`],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { ball } }),
    intent: px === 1 ? { leg_results: [1, 1] } : undefined,
  });
}

export function primitiveVectors(): VectorJson[] {
  return [
    segmentStart(),
    staleRegion(30),
    staleRegion(31),
    disappearLookahead(true),
    disappearLookahead(false),
    lineSideZero(),
    polygonPoints(
      'polygon_square_edges_vertices',
      'Even-odd ptInPoly (§3.3, exact i64) on a square zone: centers on the left/right/top/bottom edge midpoints and on the four vertices',
      SQUARE,
      [
        [2000, 4000],
        [6000, 4000],
        [4000, 2000],
        [4000, 6000],
        [2000, 2000],
        [6000, 2000],
        [6000, 6000],
        [2000, 6000],
      ],
    ),
    polygonPoints(
      'polygon_concave_slanted_edges',
      'Even-odd ptInPoly on a concave pentagon with slanted edges: points on slanted edges, a reflex vertex, the interior notch and a point level with a vertex',
      [
        [1000, 1000],
        [9000, 1000],
        [9000, 9000],
        [5000, 5000],
        [1000, 9000],
      ],
      [
        [5000, 3000],
        [7000, 7000],
        [3000, 7000],
        [5000, 5000],
        [5000, 6000],
        [1000, 5000],
        [9000, 1000],
        [5000, 1000],
      ],
    ),
    attemptWindowOverlap(),
    risingFrame0(),
    levelSuccess(),
    dropoutEnters(),
    occludedHold(),
    tailFrames(),
    stillJitter(1),
    stillJitter(5),
  ];
}
