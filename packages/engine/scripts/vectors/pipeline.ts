/**
 * Vectors whose track_bin comes out of the offchain pipeline rather than being
 * written by hand: multi-ball rebind after `disappears_into` (quantizeSession,
 * §6.2 [D-44]) and the greedy identity-assignment conflict (§8.5).
 */
import { TRACK_FLAG_CROSS_CHECK_OK } from '../../src/constants.js';
import { bindPersons, fuseTimeline } from '../../src/identity/index.js';
import { extractDecisiveWindows, quantizeSession } from '../../src/perception/index.js';
import { crossCheckEval } from '../../src/perception/crosscheck.js';
import type { IdObservation, PersonTrack, QFrame, RawDetection, SessionTracks } from '../../src/types.js';
import { buffer, calib, makeVector, prog, ref, VECTOR_MODEL_HASH, type VectorJson } from './common.js';
import { PAPER_BALL_CALIBRATION } from './worked.js';

type Box4 = [number, number, number, number];

/** Detection on a 1000×1000 px camera (1 px = 10 normalized units); box in normalized units. */
function det(entity: string, track_id: number, f: number, b: Box4, confidence = 0.9): RawDetection {
  const [x0, y0, x1, y1] = b.map((v) => v / 10) as Box4;
  return { t_ms: f * 100 + 7, entity, track_id, bbox_px: [x0, y0, x1, y1], mask_area_px: ((x1 - x0) * (y1 - y0)) / 2, confidence };
}

const around = (cx: number, cy: number, h = 150): Box4 => [cx - h, cy - h, cx + h, cy + h];

/** Throw from the hand at `r` into the can: in the opening (descending) at r+6, last seen at r+7. */
const FLIGHT: [number, number][] = [
  [3500, 4000],
  [4800, 3500],
  [6000, 3300],
  [7000, 3600],
  [7800, 4300],
  [8100, 5200],
  [8200, 6000],
  [8200, 6500],
];

function multiBallRebind(): VectorJson {
  const p = prog({
    entities: [
      { name: 'shooter', kind: 'person_any' },
      { name: 'ball', kind: 'object', phrase: 'crumpled paper ball' },
      { name: 'can', kind: 'object', phrase: 'trash can' },
      { name: 'line', kind: 'region', shape: 'line' },
    ],
    legs: [
      {
        valid_attempt: {
          op: 'and',
          args: [
            { op: 'released_by', a: ref('ball'), b: ref('shooter') },
            { op: 'behind', a: ref('shooter'), b: ref('line') },
          ],
        },
        success: { op: 'disappears_into', a: ref('ball'), b: ref('can', 'opening') },
        rule: { kind: 'count', cmp: '>=', k: 2, attempts: 3 },
      },
    ],
    time_limit_s: 60,
  });
  const n = 120;
  const hand = around(2000, 5000);
  const raw: RawDetection[] = [];
  for (let f = 0; f < n; f++) raw.push(det('person', 1, f, [500, 1500, 2500, 9800]));
  for (let f = 0; f < n; f++) raw.push(det('can', 2, f, [7600, 6200, 8800, 9400], 0.95));
  // ball 1: in hand 0..9, thrown at 10, last seen at 17 (track ends)
  for (let f = 0; f <= 9; f++) raw.push(det('ball', 1, f, hand));
  FLIGHT.forEach(([x, y], i) => raw.push(det('ball', 1, 10 + i, around(x, y))));
  // a second ball lying on the floor from 20 on (higher conf, not in hand)
  for (let f = 20; f < n; f++) raw.push(det('ball', 4, f, around(5000, 9500), 0.95));
  // a third ball picked up at 25, thrown at 60, last seen at 67
  for (let f = 25; f <= 59; f++) raw.push(det('ball', 6, f, hand, 0.6));
  FLIGHT.forEach(([x, y], i) => raw.push(det('ball', 6, 60 + i, around(x, y), 0.6)));

  const session = quantizeSession(raw, {
    width_px: 1000,
    height_px: 1000,
    n_frames: n,
    model_hash: VECTOR_MODEL_HASH,
    flags: TRACK_FLAG_CROSS_CHECK_OK,
    program: p,
    calibration: PAPER_BALL_CALIBRATION,
  });
  const ball = session.tracks.find((t) => t.entity === 'ball')!.frames;
  // binding sanity: ball 1 until 17, absent 18..32 (REBIND_DELAY_FRAMES), then the in-hand ball 6
  if (!ball[17] || ball[18] || ball[32] || !ball[33] || ball[33].x0 !== hand[0]) throw new Error('rebind vector: unexpected binding');
  const full = crossCheckEval(p, PAPER_BALL_CALIBRATION, session);
  const windows = extractDecisiveWindows(p, PAPER_BALL_CALIBRATION, session, full.checkpoints);
  if (!windows) throw new Error('rebind vector: no decisive windows');
  return makeVector({
    name: 'quantize_multi_ball_rebind',
    description:
      'quantizeSession on raw detections: ball 1 is thrown into the can (track ends at 17); the entity stays absent REBIND_DELAY_FRAMES, then rebinds to the ball in the shooter\'s hand (preferred over a higher-conf ball on the floor), which is thrown at 60. Decisive windows ⇒ 2 attempts, 2 successes',
    covers: ['quantize_multi_ball_rebind'],
    program: p,
    calibration: PAPER_BALL_CALIBRATION,
    buffer: windows,
    intent: { status: 'ok', leg_results: [1], decisive_frames: [[10, 16, 60, 66]], winner_mask: 1 },
  });
}

function personBox(x0: number, conf = 90): QFrame {
  return { x0, y0: 2000, x1: x0 + 1000, y1: 9000, conf, fill: 50, id_conf: 0, pose: 1 };
}

function greedyIdentityConflict(): VectorJson {
  const n = 20;
  const LEFT: [number, number][] = [
    [0, 0],
    [4000, 0],
    [4000, 10000],
    [0, 10000],
  ];
  const RIGHT: [number, number][] = [
    [6000, 0],
    [10000, 0],
    [10000, 10000],
    [6000, 10000],
  ];
  const p = prog({
    entities: [
      { name: 'alex', kind: 'person', participant: 0 },
      { name: 'maya', kind: 'person', participant: 1 },
      { name: 'home', kind: 'region', shape: 'zone' },
      { name: 'away', kind: 'region', shape: 'zone' },
    ],
    legs: [
      { success: { op: 'inside', a: ref('alex'), b: ref('home') }, rule: { kind: 'exists' } },
      { success: { op: 'inside', a: ref('maya'), b: ref('away') }, rule: { kind: 'exists' } },
      { success: { op: 'present', a: ref('maya') }, rule: { kind: 'exists' } },
    ],
    outcome: { if_true: 0, condition: { op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'leg', id: 2 }] }, else: 1 },
  });
  const tracks: PersonTrack[] = [
    { track_id: 0, frames: Array.from({ length: n }, () => personBox(1500)) },
    { track_id: 1, frames: Array.from({ length: n }, (_, f) => personBox(f < 12 ? 4500 : 7000)) },
  ];
  const face = (frame: number, track_id: number, cos: number[]): IdObservation => ({
    frame,
    modality: 'face',
    track_id,
    scores: cos.map((cos_bps, candidate) => ({ candidate, cos_bps })),
  });
  // Frame 0: track 1 looks like p0 (cos 8000) and weakly like p1; track 0 is clearly p0.
  // Greedy (conf desc): (t0, p0) wins p0; t1 gets the leftover p1 at low conf.
  const observations: IdObservation[] = [face(0, 1, [4900, 6000]), face(0, 0, [8000, 3000]), face(0, 1, [8000, 3000])];
  for (let f = 3; f < n; f += 3) observations.push(face(f, 0, [8000, 3000]), face(f, 1, [3000, 8000]));
  const timeline = fuseTimeline(tracks, observations, [], 2, 2, n);
  const empty: SessionTracks = {
    fps: 10,
    n_frames: n,
    model_hash: VECTOR_MODEL_HASH,
    flags: TRACK_FLAG_CROSS_CHECK_OK,
    tracks: [
      { entity: 'alex', entity_idx: 0, participant_idx: 0, ref_h: 0, frames: new Array(n).fill(null) },
      { entity: 'maya', entity_idx: 1, participant_idx: 1, ref_h: 0, frames: new Array(n).fill(null) },
    ],
  };
  const session = bindPersons(empty, tracks, timeline, p);
  const colOf = (name: string) => session.tracks.find((t) => t.entity === name)!.frames;
  const c = calib([
    { entity: 'home', shape: 'zone', points: LEFT },
    { entity: 'away', shape: 'zone', points: RIGHT },
  ]);
  const b = buffer(p, { cols: { alex: colOf('alex'), maya: colOf('maya') } });
  const verified = crossCheckEval(p, c, session).checkpoints;
  const v = makeVector({
    name: 'identity_greedy_conflict',
    description:
      'fuseTimeline + bindPersons (§8.5): at frame 0 track 1 scores p0 conf 60 / p1 conf 24 and track 0 scores p0 conf 80. Greedy stitching gives p0 → track 0 and the leftover track 1 → p1 with id_conf 24, so leg 3 (maya present, checkpoint (1, 0)) is Unknown (IDENTITY) even with every checkpoint verified; by frame 12 track 1 is clearly p1 (leg 2 passes)',
    covers: ['identity_greedy_conflict', 'unknown_cause IDENTITY'],
    program: p,
    calibration: c,
    buffer: b,
    verified,
    intent: {
      leg_results: [1, 1, 2],
      leg_causes: [[], [], ['IDENTITY']],
      checkpoints: [
        { participant: 0, frame: 0 },
        { participant: 1, frame: 0 },
        { participant: 1, frame: 12 },
      ],
    },
  });
  return { ...v, fusion: { person_tracks: tracks, observations, reid: [], n_candidates: 2, n_participants: 2, stitched: timeline.stitched } };
}

export function pipelineVectors(): VectorJson[] {
  return [multiBallRebind(), greedyIdentityConflict()];
}
