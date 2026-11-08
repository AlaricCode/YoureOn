import { describe, expect, it } from 'vitest';
import { quantizePersonTracks, quantizeSession, refHeight } from '../src/perception/index.js';
import { occlusionFill, interpCoord } from '../src/perception/fill.js';
import { poseBits, quantizeDetection } from '../src/perception/raw.js';
import { bindObject } from '../src/perception/binding.js';
import type { Program, QFrame, QuantizeMeta, RawDetection } from '../src/types.js';
import { cupTower, paperBall, paperBallCalibration, pushUps } from './perception-fixtures.js';

const W = 1000;
const H = 1000; // 1 px = 10 normalized units in both axes
const MH = 'ab'.repeat(32);

function meta(program: Program, n = 50, calibration = paperBallCalibration as QuantizeMeta['calibration']): QuantizeMeta {
  return { width_px: W, height_px: H, n_frames: n, model_hash: MH, flags: 0, program, calibration };
}

/** Detection with a box given in normalized units (÷10 → px). */
function det(entity: string, track_id: number, t_ms: number, box: [number, number, number, number], confidence = 0.9, extra: Partial<RawDetection> = {}): RawDetection {
  const [x0, y0, x1, y1] = box.map((v) => v / 10) as [number, number, number, number];
  return { t_ms, entity, track_id, bbox_px: [x0, y0, x1, y1], mask_area_px: ((x1 - x0) * (y1 - y0)) / 2, confidence, ...extra };
}

function track(s: ReturnType<typeof quantizeSession>, name: string): (QFrame | null)[] {
  return s.tracks.find((t) => t.entity === name)!.frames;
}

describe('quantizeDetection (§6.2)', () => {
  const g = { width_px: 1920, height_px: 1080, n_frames: 10 };
  it('normalizes and clamps coordinates with floor', () => {
    const q = quantizeDetection(det('ball', 1, 0, [0, 0, 0, 0], 0.9, { bbox_px: [-5, 100.7, 1920.5, 1080] }), g, false)!;
    expect(q.x0).toBe(0);
    expect(q.y0).toBe(Math.floor((100.7 * 10000) / 1080));
    expect(q.x1).toBe(10000);
    expect(q.y1).toBe(10000);
  });
  it('orders inverted boxes so x0 <= x1, y0 <= y1', () => {
    const q = quantizeDetection({ t_ms: 0, entity: 'b', track_id: 1, bbox_px: [100, 100, 50, 40], mask_area_px: 0, confidence: 0.5 }, g, false)!;
    expect(q.x0).toBeLessThanOrEqual(q.x1);
    expect(q.y0).toBeLessThanOrEqual(q.y1);
  });
  it('conf = clamp(floor(confidence*100)), conf 0 ⇒ absent', () => {
    const mk = (c: number) => quantizeDetection({ t_ms: 0, entity: 'b', track_id: 1, bbox_px: [0, 0, 10, 10], mask_area_px: 0, confidence: c }, g, false);
    expect(mk(0.999)!.conf).toBe(99);
    expect(mk(1.5)!.conf).toBe(100);
    expect(mk(0.009)).toBeNull();
    expect(mk(-1)).toBeNull();
    expect(mk(Number.NaN)).toBeNull();
  });
  it('fill = min(100, mask_area_norm*100/area), 0 for zero area', () => {
    const g2 = { width_px: 1000, height_px: 1000, n_frames: 1 };
    const q = quantizeDetection({ t_ms: 0, entity: 'b', track_id: 1, bbox_px: [0, 0, 100, 100], mask_area_px: 2500, confidence: 1 }, g2, false)!;
    expect(q.fill).toBe(25);
    const over = quantizeDetection({ t_ms: 0, entity: 'b', track_id: 1, bbox_px: [0, 0, 100, 100], mask_area_px: 99999, confidence: 1 }, g2, false)!;
    expect(over.fill).toBe(100);
    const zero = quantizeDetection({ t_ms: 0, entity: 'b', track_id: 1, bbox_px: [10, 10, 10, 50], mask_area_px: 50, confidence: 1 }, g2, false)!;
    expect(zero.fill).toBe(0);
  });
  it('pose bits: standing, elbow < 90 low, > 160 high, boundaries excluded', () => {
    expect(poseBits({ standing: true })).toBe(1);
    expect(poseBits({ standing: false, elbow_deg: 89.9 })).toBe(2);
    expect(poseBits({ standing: false, elbow_deg: 90 })).toBe(0);
    expect(poseBits({ standing: false, elbow_deg: 160 })).toBe(0);
    expect(poseBits({ standing: true, elbow_deg: 161 })).toBe(5);
    expect(poseBits(undefined)).toBe(0);
  });
  it('object tracks never carry pose bits', () => {
    const q = quantizeDetection({ t_ms: 0, entity: 'ball', track_id: 1, bbox_px: [0, 0, 10, 10], mask_area_px: 0, confidence: 1, pose: { standing: true } }, g, false)!;
    expect(q.pose).toBe(0);
  });
});

describe('quantizeSession: frames and sampling', () => {
  it('f = floor(t_ms/100); smallest t_ms per frame wins; samples ≥ n_frames dropped', () => {
    const p = cupTower();
    const raw = [
      det('tower', 1, 150, [1000, 1000, 2000, 2000], 0.8),
      det('tower', 1, 101, [3000, 3000, 4000, 4000], 0.7),
      det('tower', 1, 199.9, [5000, 5000, 6000, 6000], 0.6),
      det('tower', 1, 500, [1000, 1000, 2000, 2000]),
      det('tower', 1, -1, [1000, 1000, 2000, 2000]),
    ];
    const s = quantizeSession(raw, meta(p, 5, null));
    const fr = track(s, 'tower');
    expect(fr.length).toBe(5);
    expect(fr[0]).toBeNull();
    expect(fr[1]).toMatchObject({ x0: 3000, conf: 70 });
    expect(s.n_frames).toBe(5);
    expect(s.fps).toBe(10);
    expect(s.model_hash).toBe(MH);
  });

  it('emits every non-region entity in entity order, with participant_idx and ref_h', () => {
    const p = paperBall();
    const raw = [det('can', 3, 0, [7600, 6200, 8800, 9400]), det('person', 9, 0, [500, 1500, 2500, 9800], 0.9, { pose: { standing: true } })];
    const s = quantizeSession(raw, meta(p, 3));
    expect(s.tracks.map((t) => [t.entity, t.entity_idx, t.participant_idx])).toEqual([
      ['shooter', 0, 1],
      ['ball', 1, null],
      ['can', 2, null],
    ]);
    expect(s.tracks[2]!.ref_h).toBe(3200);
    expect(s.tracks[1]!.ref_h).toBe(0);
    // Referenced participant person: pre-identity binding to the largest person track.
    expect(s.tracks[0]!.frames[0]).toMatchObject({ x0: 500, pose: 1, id_conf: 0 });
  });

  it('a person referenced only in the outcome stays all-null', () => {
    const p = cupTower();
    p.entities.push({ name: 'sam', kind: 'person', participant: 1 });
    const s = quantizeSession([det('person', 1, 0, [0, 0, 5000, 5000])], meta(p, 2, null));
    expect(track(s, 'sam')).toEqual([null, null]);
  });

  it('ref_h uses the first present (conf ≥ 30) frame', () => {
    expect(refHeight([null, { x0: 0, y0: 0, x1: 1, y1: 7, conf: 29, fill: 0, id_conf: 0, pose: 0 }, { x0: 0, y0: 10, x1: 1, y1: 50, conf: 30, fill: 0, id_conf: 0, pose: 0 }])).toBe(40);
  });

  it('person_any binds per frame to the largest person track (ties → lower track_id)', () => {
    const p: Program = { ...pushUps(), entities: [{ name: 'anyone', kind: 'person_any' }], legs: [{ id: 1, actor_bound: false, attempt_window_frames: 50, success: { op: 'present', a: { e: 'anyone' } }, rule: { kind: 'exists' } }] };
    const raw = [
      det('person', 5, 0, [0, 0, 1000, 1000]),
      det('person', 2, 0, [0, 0, 2000, 2000]),
      det('person', 5, 100, [0, 0, 3000, 3000]),
      det('person', 2, 100, [0, 0, 2000, 2000]),
      det('person', 7, 200, [0, 0, 1000, 1000]),
      det('person', 4, 200, [5000, 5000, 6000, 6000]),
    ];
    const fr = track(quantizeSession(raw, meta(p, 3, null)), 'anyone');
    expect(fr[0]!.x1).toBe(2000);
    expect(fr[1]!.x1).toBe(3000);
    expect(fr[2]!.x0).toBe(5000); // equal area → lower track_id (4)
  });
});

describe('quantizeSession: sticky object binding [D-44]', () => {
  const p = paperBall();
  const shooterBox: [number, number, number, number] = [500, 1500, 2500, 9800];
  const hand: [number, number, number, number] = [1800, 4000, 2100, 4500]; // center inside the shooter box
  const floor: [number, number, number, number] = [5000, 9000, 5300, 9500];

  it('initial track = max IoU with the calibration bbox; ties → lower track_id', () => {
    const raw = [det('ball', 9, 0, [1200, 7000, 1500, 7500]), det('ball', 3, 0, [6000, 1000, 6300, 1500], 0.99)];
    const fr = track(quantizeSession(raw, meta(p, 1)), 'ball');
    expect(fr[0]!.x0).toBe(1200);
    const tie = [det('ball', 9, 0, [1200, 7000, 1500, 7500]), det('ball', 3, 0, [1200, 7000, 1500, 7500], 0.5)];
    const s2 = quantizeSession(tie, meta(p, 1));
    expect(track(s2, 'ball')[0]!.conf).toBe(50);
  });

  it('falls back to the highest conf without calibration (ties → lower track_id)', () => {
    const raw = [det('ball', 9, 0, [100, 100, 200, 200], 0.6), det('ball', 3, 0, [300, 300, 400, 400], 0.8), det('ball', 1, 0, [500, 500, 600, 600], 0.8)];
    expect(track(quantizeSession(raw, meta(p, 1, null)), 'ball')[0]!.x0).toBe(500);
  });

  it('keeps the bound track while it exists, ignoring other candidates', () => {
    const raw: RawDetection[] = [];
    for (let f = 0; f < 10; f++) {
      raw.push(det('ball', 1, f * 100, [1200, 7000, 1500, 7500], 0.5));
      raw.push(det('ball', 2, f * 100, [6000, 7000, 6300, 7500], 0.99));
    }
    const fr = track(quantizeSession(raw, meta(p, 10)), 'ball');
    expect(fr.every((r) => r!.x0 === 1200)).toBe(true);
  });

  it('multi-ball rebind after disappears_into: absent REBIND_DELAY_FRAMES, then the ball in hand', () => {
    const raw: RawDetection[] = [];
    for (let f = 0; f < 60; f++) raw.push(det('person', 1, f * 100, shooterBox));
    for (let f = 0; f <= 9; f++) raw.push(det('ball', 1, f * 100, [7900, 6000, 8200, 6500])); // goes into the can, track ends at 9
    for (let f = 12; f < 60; f++) raw.push(det('ball', 4, f * 100, floor, 0.95)); // another ball lying on the floor
    for (let f = 20; f < 60; f++) raw.push(det('ball', 6, f * 100, hand, 0.6)); // new ball in the shooter's hand
    const fr = track(quantizeSession(raw, meta(p, 60)), 'ball');
    expect(fr[9]!.x0).toBe(7900);
    for (let f = 10; f <= 24; f++) expect(fr[f]).toBeNull(); // 9 + 1 .. 9 + 15
    expect(fr[25]!.x0).toBe(hand[0]); // in-hand candidate preferred over higher-conf floor ball
    expect(fr[59]!.x0).toBe(hand[0]);
  });

  it('rebind without an in-hand candidate picks the highest conf', () => {
    const raw: RawDetection[] = [];
    for (let f = 0; f <= 2; f++) raw.push(det('ball', 1, f * 100, [1200, 7000, 1500, 7500]));
    for (let f = 0; f < 30; f++) raw.push(det('ball', 4, f * 100, floor, 0.4));
    for (let f = 0; f < 30; f++) raw.push(det('ball', 5, f * 100, [6000, 9000, 6300, 9500], 0.7));
    const fr = track(quantizeSession(raw, meta(p, 30)), 'ball');
    expect(fr[17]).toBeNull();
    expect(fr[18]!.x0).toBe(6000); // 2 + 1 + 15
  });

  it('hand-off: another candidate held for RELEASE_HOLD frames while the bound one is not', () => {
    const raw: RawDetection[] = [];
    for (let f = 0; f < 20; f++) raw.push(det('person', 1, f * 100, shooterBox));
    for (let f = 0; f < 20; f++) raw.push(det('ball', 1, f * 100, floor)); // bound (IoU with ref is 0 → highest conf)
    raw.push(det('ball', 2, 500, hand, 0.5));
    raw.push(det('ball', 2, 700, hand, 0.5)); // held at 5 and 7, not consecutive
    for (let f = 10; f < 20; f++) raw.push(det('ball', 2, f * 100, hand, 0.5));
    const fr = track(quantizeSession(raw, meta(p, 20, null)), 'ball');
    expect(fr[7]!.x0).toBe(floor[0]);
    expect(fr[10]!.x0).toBe(floor[0]);
    expect(fr[11]!.x0).toBe(hand[0]); // second consecutive held frame
    expect(fr[19]!.x0).toBe(hand[0]);
  });

  it('no hand-off while the bound track itself is held', () => {
    const raw: RawDetection[] = [];
    for (let f = 0; f < 10; f++) {
      raw.push(det('person', 1, f * 100, shooterBox));
      raw.push(det('ball', 1, f * 100, [1200, 7000, 1500, 7500]));
      raw.push(det('ball', 2, f * 100, hand, 0.5));
    }
    const fr = track(quantizeSession(raw, meta(p, 10)), 'ball');
    expect(fr.every((r) => r!.x0 === 1200)).toBe(true);
  });

  it('bindObject with no candidates yields all-null', () => {
    const b = bindObject([], 4, null, []);
    expect(b.frames).toEqual([null, null, null, null]);
    expect(b.source).toEqual([null, null, null, null]);
  });
});

describe('occlusion fill (§6.2)', () => {
  const r = (x: number, conf = 90, extra: Partial<QFrame> = {}): QFrame => ({ x0: x, y0: x, x1: x + 100, y1: x + 100, conf, fill: 10, id_conf: 0, pose: 0, ...extra });

  it('interpolates gaps of 1..3 frames with integer arithmetic in both directions', () => {
    expect(interpCoord(100, 200, 1, 3)).toBe(133);
    expect(interpCoord(200, 100, 1, 3)).toBe(200 - 33);
    expect(interpCoord(200, 100, 2, 3)).toBe(200 - 66);
    const out = occlusionFill([r(0, 80, { fill: 7, pose: 3, id_conf: 66 }), null, null, null, r(400, 60)], [1, 1, 1, 1, 1]);
    expect(out.map((x) => x?.x0)).toEqual([0, 100, 200, 300, 400]);
    expect(out[2]).toMatchObject({ conf: 60, fill: 7, pose: 3, id_conf: 66 });
  });

  it('leaves gaps of 4 frames, leading and trailing gaps alone', () => {
    const out = occlusionFill([null, r(0), null, null, null, null, r(500), null], [1, 1, 1, 1, 1, 1, 1, 1]);
    expect(out[0]).toBeNull();
    expect(out.slice(2, 6)).toEqual([null, null, null, null]);
    expect(out[7]).toBeNull();
  });

  it('treats conf < PRESENCE_MIN as absent and overwrites it', () => {
    const out = occlusionFill([r(0), r(999, 20), r(200)], [1, 1, 1]);
    expect(out[1]).toMatchObject({ x0: 100, conf: 90 });
  });

  it('never bridges two different bound tracks', () => {
    const out = occlusionFill([r(0), null, r(200)], [1, null, 2]);
    expect(out[1]).toBeNull();
    const out2 = occlusionFill([r(0), r(5, 10), r(200)], [1, 3, 1]);
    expect(out2[1]!.x0).toBe(5);
  });

  it('is applied by quantizeSession to the bound track', () => {
    const p = cupTower();
    const raw = [0, 1, 4, 5].map((f) => det('tower', 1, f * 100, [1000 + f * 100, 1000, 2000 + f * 100, 4000]));
    const fr = track(quantizeSession(raw, meta(p, 6, null)), 'tower');
    expect(fr[2]!.x0).toBe(1200);
    expect(fr[3]!.x0).toBe(1300);
  });
});

describe('quantizePersonTracks', () => {
  it('returns anonymous person tracks, session-length, ascending track_id, occlusion-filled', () => {
    const p = pushUps();
    const raw = [det('person', 7, 0, [0, 0, 1000, 1000]), det('person', 7, 300, [300, 0, 1300, 1000]), det('person', 2, 100, [0, 0, 10, 10], 0.5, { pose: { standing: false, elbow_deg: 30 } })];
    const tracks = quantizePersonTracks(raw, meta(p, 5, null));
    expect(tracks.map((t) => t.track_id)).toEqual([2, 7]);
    expect(tracks[0]!.frames[1]!.pose).toBe(2);
    expect(tracks[1]!.frames.map((r) => r?.x0 ?? null)).toEqual([0, 100, 200, 300, null]);
  });

  it('rejects bad geometry', () => {
    expect(() => quantizeSession([], { ...meta(pushUps(), 1, null), width_px: 0 })).toThrow();
    expect(() => quantizeSession([], { ...meta(pushUps(), 1, null), n_frames: -1 })).toThrow();
  });
});
