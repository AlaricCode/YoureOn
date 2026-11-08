import { describe, expect, it } from 'vitest';
import {
  bindPersons,
  fuseTimeline,
  fuseTimelineTrace,
  observationWeight,
  proverInput,
  referencedEntities,
  strictArgmax,
  type SegmentedIdObservation,
} from '../src/identity/index.js';
import type { IdObservation, PersonTrack, Program, QFrame, ReidLink, SessionTracks } from '../src/types.js';

const q = (x: number, conf = 90): QFrame => ({ x0: x, y0: 1000, x1: x + 1000, y1: 5000, conf, fill: 50, id_conf: 0, pose: 1 });
/** Track present on [from, to] (inclusive) within n frames. */
function track(id: number, n: number, from: number, to: number): PersonTrack {
  return { track_id: id, frames: Array.from({ length: n }, (_, f) => (f >= from && f <= to ? q(100 * id + f) : null)) };
}
const face = (frame: number, track_id: number, cos: number[]): IdObservation => ({
  frame,
  modality: 'face',
  track_id,
  scores: cos.map((cos_bps, candidate) => ({ candidate, cos_bps })),
});
const voice = (frame: number, cos: number[], seg?: [number, number]): SegmentedIdObservation => ({
  frame,
  modality: 'voice',
  track_id: null,
  scores: cos.map((cos_bps, candidate) => ({ candidate, cos_bps })),
  ...(seg ? { start_frame: seg[0], end_frame: seg[1] } : {}),
});
const dec = (x: number) => Math.floor((x * 9977) / 10000);
const conf = (s: number, sum: number) => Math.floor((100 * s) / (sum + 1000));

describe('observation weight', () => {
  it('min(4000, 1000 + (cos1−τ) + ((cos1−cos2)−δ))', () => {
    expect(observationWeight(8000, 3000, 5500, 1000)).toBe(4000);
    expect(observationWeight(6000, 4900, 5500, 1000)).toBe(1600);
    expect(observationWeight(5500, 4500, 5500, 1000)).toBe(1000);
  });
  it('strictArgmax', () => {
    expect(strictArgmax([0, 5, 3])).toBe(1);
    expect(strictArgmax([5, 5, 3])).toBe(-1);
    expect(strictArgmax([0, 0])).toBe(-1);
    expect(strictArgmax([0])).toBe(0);
  });
});

describe('fuseTimeline (§8.5)', () => {
  it('face match adds w, decay applies on later frames, conf formula', () => {
    const n = 4;
    const tl = fuseTimeline([track(0, n, 0, 3)], [face(0, 0, [8000, 3000])], [], 2, 2, n);
    expect(tl.n_frames).toBe(4);
    expect(tl.n_candidates).toBe(2);
    let s = 4000;
    expect(tl.stitched[0]![0]).toEqual({ track_id: 0, conf: conf(s, s) });
    expect(tl.stitched[0]![0]!.conf).toBe(80);
    for (let f = 1; f < n; f++) {
      s = dec(s);
      expect(tl.stitched[0]![f]).toEqual({ track_id: 0, conf: conf(s, s) });
    }
    expect(tl.stitched[1]!.every((x) => x === null)).toBe(true);
  });

  it('face clear non-match (cos1 < τ) multiplies all scores by 0.7; ambiguous margin does nothing', () => {
    const n = 3;
    const obs = [face(0, 0, [8000, 3000]), face(1, 0, [5499, 0]), face(2, 0, [7000, 6500])];
    const tr = fuseTimelineTrace([track(0, n, 0, 2)], obs, [], 2, 2, n);
    const s0 = 4000;
    const s1 = Math.floor((dec(s0) * 7000) / 10000);
    const s2 = dec(s1);
    expect(tr.conf[1]!.get(0)).toEqual([conf(s1, s1), 0]);
    expect(tr.conf[2]!.get(0)).toEqual([conf(s2, s2), 0]);
  });

  it('observations on absent tracks or out-of-range frames are ignored', () => {
    const n = 3;
    const tl = fuseTimeline([track(0, n, 1, 2)], [face(0, 0, [8000, 0]), face(5, 0, [8000, 0]), face(1, 9, [8000, 0])], [], 2, 1, n);
    expect(tl.stitched[0]).toEqual([null, null, null]);
  });

  it('greedy stitching conflict: the stronger track wins p0, p1 gets the leftover', () => {
    const n = 1;
    const obs = [face(0, 1, [4900, 6000]), face(0, 0, [8000, 3000]), face(0, 1, [8000, 3000])];
    const tr = fuseTimelineTrace([track(0, n, 0, 0), track(1, n, 0, 0)], obs, [], 2, 2, n);
    expect(tr.conf[0]!.get(0)).toEqual([80, 0]);
    expect(tr.conf[0]!.get(1)).toEqual([60, 24]);
    expect(tr.timeline.stitched[0]![0]).toEqual({ track_id: 0, conf: 80 });
    expect(tr.timeline.stitched[1]![0]).toEqual({ track_id: 1, conf: 24 });
  });

  it('equal conf ties go to the lower track id; non-participant candidates are never stitched', () => {
    const n = 1;
    const obs = [face(0, 3, [8000, 0, 0]), face(0, 2, [8000, 0, 0])];
    const tl = fuseTimeline([track(3, n, 0, 0), track(2, n, 0, 0)], obs, [], 3, 1, n);
    expect(tl.stitched[0]![0]).toEqual({ track_id: 2, conf: 80 });
    expect(tl.stitched.length).toBe(1);
    // candidate 2 (non-participant) competes in normalization only
    const tl2 = fuseTimeline([track(0, n, 0, 0)], [face(0, 0, [0, 0, 9000])], [], 3, 2, n);
    expect(tl2.stitched[0]![0]).toBeNull();
    expect(tl2.stitched[1]![0]).toBeNull();
  });

  it('re-ID inheritance: ×0.8 from the best link; sim, lookback and tie boundaries', () => {
    const n = 70;
    const base = [track(0, n, 0, 4), track(5, n, 0, 4)];
    const obs = [face(0, 0, [8000, 3000]), face(0, 5, [3000, 8000])];
    // S at frame 4 (last present): 4000 decayed 4 times
    let s = 4000;
    for (let i = 0; i < 4; i++) s = dec(s);
    const inh = Math.floor((s * 8000) / 10000);
    const run = (start: number, links: ReidLink[]) =>
      fuseTimelineTrace([...base, track(9, n, start, start + 1)], obs, links, 2, 2, n).conf[start]!.get(9)!;

    expect(run(10, [{ from_track: 0, to_track: 9, sim_bps: 7000 }])).toEqual([conf(inh, inh), 0]);
    expect(run(10, [{ from_track: 0, to_track: 9, sim_bps: 6999 }])).toEqual([0, 0]);
    // last present frame 4 must be in [f−50, f−1]: f = 54 ok, f = 55 not
    expect(run(54, [{ from_track: 0, to_track: 9, sim_bps: 9000 }])).toEqual([conf(inh, inh), 0]);
    expect(run(55, [{ from_track: 0, to_track: 9, sim_bps: 9000 }])).toEqual([0, 0]);
    // highest sim wins; ties → lower from_track
    const two = [
      { from_track: 5, to_track: 9, sim_bps: 8000 },
      { from_track: 0, to_track: 9, sim_bps: 7500 },
    ];
    expect(run(10, two)).toEqual([0, conf(inh, inh)]);
    const tie = [
      { from_track: 5, to_track: 9, sim_bps: 8000 },
      { from_track: 0, to_track: 9, sim_bps: 8000 },
    ];
    expect(run(10, tie)).toEqual([conf(inh, inh), 0]);
    // a link from a track still present (last frame ≥ f) does not apply
    expect(
      fuseTimelineTrace([track(0, n, 0, 20), track(9, n, 10, 11)], obs, [{ from_track: 0, to_track: 9, sim_bps: 9000 }], 2, 2, n)
        .conf[10]!.get(9),
    ).toEqual([0, 0]);
    // no decay on the inheriting frame, decay on the next one
    const tr = fuseTimelineTrace([...base, track(9, n, 10, 11)], obs, [{ from_track: 0, to_track: 9, sim_bps: 9000 }], 2, 2, n);
    expect(tr.conf[11]!.get(9)).toEqual([conf(dec(inh), dec(inh)), 0]);
  });

  it('voice: single present track gets floor(w/2); otherwise the unique track whose strict argmax is c*', () => {
    const n = 3;
    // one track: voice matched to candidate 1 (τ 5000, δ 1000): w = min(4000, 1000+2000+4000) = 4000 → 2000
    const tr1 = fuseTimelineTrace([track(0, n, 0, 2)], [voice(0, [2000, 7000])], [], 2, 2, n);
    expect(tr1.conf[0]!.get(0)).toEqual([0, conf(2000, 2000)]);
    // two tracks: t0 argmax p0, t1 argmax p1 → voice for p1 goes to t1
    const tracks = [track(0, n, 0, 2), track(1, n, 0, 2)];
    const obs = [face(0, 0, [8000, 3000]), face(0, 1, [3000, 8000]), voice(0, [2000, 7000])];
    const tr2 = fuseTimelineTrace(tracks, obs, [], 2, 2, n);
    expect(tr2.conf[0]!.get(1)).toEqual([0, conf(6000, 6000)]);
    expect(tr2.conf[0]!.get(0)).toEqual([conf(4000, 4000), 0]);
    // two tracks, neither has argmax p1 → dropped
    const tr3 = fuseTimelineTrace(tracks, [face(0, 0, [8000, 3000]), voice(0, [2000, 7000])], [], 2, 2, n);
    expect(tr3.conf[0]!.get(1)).toEqual([0, 0]);
    // unmatched voice does nothing
    const tr4 = fuseTimelineTrace([track(0, n, 0, 2)], [voice(0, [4999, 0])], [], 2, 2, n);
    expect(tr4.conf[0]!.get(0)).toEqual([0, 0]);
  });

  it('faces are applied before voices in the same frame', () => {
    const n = 1;
    const tracks = [track(0, n, 0, 0), track(1, n, 0, 0)];
    // voice listed first, but the face on t1 makes t1's argmax p1 before the voice is placed
    const tr = fuseTimelineTrace(tracks, [voice(0, [2000, 7000]), face(0, 1, [3000, 8000])], [], 2, 2, n);
    expect(tr.conf[0]!.get(1)).toEqual([0, conf(6000, 6000)]);
  });

  it('validates arguments', () => {
    expect(() => fuseTimeline([], [], [], 11, 2, 1)).toThrow();
    expect(() => fuseTimeline([], [], [], 2, 3, 1)).toThrow();
    expect(() => fuseTimeline([track(0, 1, 0, 0), track(0, 1, 0, 0)], [], [], 2, 2, 1)).toThrow();
    expect(fuseTimeline([], [], [], 0, 0, 0)).toEqual({ n_frames: 0, n_candidates: 0, stitched: [] });
  });
});

describe('bindPersons', () => {
  const program = {
    version: 2,
    kind: 'rules',
    participants: ['A', 'B'],
    sides: [0, 1],
    entities: [
      { name: 'alice', kind: 'person', participant: 0 },
      { name: 'bob', kind: 'person', participant: 1 },
      { name: 'ball', kind: 'object', phrase: 'ball' },
      { name: 'hoop', kind: 'region', shape: 'zone' },
    ],
    legs: [
      {
        id: 1,
        actor_bound: true,
        attempt_window_frames: 50,
        valid_attempt: { op: 'released_by', a: { e: 'ball' }, b: { e: 'alice' } },
        success: { op: 'and', args: [{ op: 'enters', a: { e: 'ball' }, b: { e: 'hoop' } }, { op: 'not', arg: { op: 'present', a: { e: 'ball' } } }] },
        rule: { kind: 'exists' },
      },
    ],
    outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
    stake_each: 10000,
    time_limit_s: 60,
  } as unknown as Program;

  const n = 4;
  const session: SessionTracks = {
    fps: 10,
    n_frames: n,
    model_hash: '00'.repeat(32),
    flags: 0,
    tracks: [
      { entity: 'alice', entity_idx: 0, participant_idx: 0, ref_h: 0, frames: new Array(n).fill(null) },
      { entity: 'bob', entity_idx: 1, participant_idx: 1, ref_h: 0, frames: new Array(n).fill(null) },
      { entity: 'ball', entity_idx: 2, participant_idx: null, ref_h: 10, frames: [q(1), q(2), null, q(3)] },
    ],
  };

  it('collects referenced entities from leg expressions', () => {
    expect([...referencedEntities(program)].sort()).toEqual(['alice', 'ball', 'hoop']);
  });

  it('writes stitched frames with id_conf into referenced person tracks only', () => {
    const pts = [track(7, n, 1, 3)];
    const tl = {
      n_frames: n,
      n_candidates: 2,
      stitched: [
        [null, { track_id: 7, conf: 72 }, { track_id: 7, conf: 65 }, null],
        [null, { track_id: 7, conf: 10 }, null, null],
      ],
    };
    const out = bindPersons(session, pts, tl, program);
    const alice = out.tracks[0]!;
    expect(alice.frames[0]).toBeNull();
    expect(alice.frames[1]).toEqual({ ...pts[0]!.frames[1]!, id_conf: 72 });
    expect(alice.frames[2]!.id_conf).toBe(65);
    expect(alice.frames[3]).toBeNull();
    expect(alice.ref_h).toBe(4000);
    expect(out.tracks[1]!.frames.every((x) => x === null)).toBe(true); // bob only in outcome
    expect(out.tracks[2]).toBe(session.tracks[2]);
    expect(session.tracks[0]!.frames[1]).toBeNull(); // input not mutated
  });

  it('end-to-end with fuseTimeline and rejects frame-count mismatch', () => {
    const pts = [track(0, n, 0, 3), track(1, n, 0, 3)];
    const tl = fuseTimeline(pts, [face(0, 1, [8000, 1000]), face(0, 0, [1000, 8000])], [], 2, 2, n);
    const out = bindPersons(session, pts, tl, program);
    expect(out.tracks[0]!.frames.every((x) => x !== null && x.id_conf > 0)).toBe(true);
    expect(out.tracks[0]!.frames[0]!.x0).toBe(100); // track 1 → alice
    expect(() => bindPersons(session, pts, { ...tl, n_frames: 5 }, program)).toThrow();
  });
});

describe('proverInput (§8.6)', () => {
  const n = 100;
  const pts = [track(0, n, 0, 99), track(1, n, 0, 99)];
  const obsBase = [face(0, 0, [9000, 1000]), face(0, 1, [1000, 9000])];
  const tl = fuseTimeline(pts, obsBase, [], 2, 2, n);

  it('picks the most recent face on p’s stitched track within [frame−30, frame]', () => {
    const a = face(30, 0, [7000, 1000]);
    const b = face(50, 0, [6000, 1000]);
    const late = face(61, 0, [9000, 1000]);
    const other = face(55, 1, [9000, 1000]); // on p1's track
    const r = proverInput(tl, [a, b, late, other], { participant: 0, frame: 60 });
    expect(r).toBe(b);
  });

  it('lookback boundary: g = frame−30 accepted, frame−31 rejected', () => {
    const at = face(30, 0, [7000, 0]);
    expect(proverInput(tl, [at], { participant: 0, frame: 60 })).toBe(at);
    expect(proverInput(tl, [at], { participant: 0, frame: 61 })).toBeNull();
  });

  it('requires cos_bps(p) ≥ τ_face (not the closed-set margin) and the circuit check', () => {
    const lowMargin = face(40, 0, [5500, 5400]);
    expect(proverInput(tl, [lowMargin], { participant: 0, frame: 45 })).toBe(lowMargin);
    expect(proverInput(tl, [face(40, 0, [5499, 0])], { participant: 0, frame: 45 })).toBeNull();
    expect(proverInput(tl, [lowMargin], { participant: 0, frame: 45 }, { circuitCheck: () => false })).toBeNull();
  });

  it('falls back to a voice matched to p whose segment covers the frame', () => {
    const v = voice(40, [7000, 1000], [35, 45]);
    const vOther = voice(40, [1000, 7000], [35, 45]);
    const vFar = voice(80, [9000, 1000], [78, 82]);
    expect(proverInput(tl, [face(40, 0, [5000, 0]), vOther, v, vFar], { participant: 0, frame: 45 })).toBe(v);
    expect(proverInput(tl, [v], { participant: 0, frame: 46 })).toBeNull();
    expect(proverInput(tl, [voice(40, [7000, 6500], [35, 45])], { participant: 0, frame: 40 })).toBeNull();
    // without segment bounds the segment is the midpoint frame only
    const mid = voice(40, [7000, 1000]);
    expect(proverInput(tl, [mid], { participant: 0, frame: 40 })).toBe(mid);
    expect(proverInput(tl, [mid], { participant: 0, frame: 41 })).toBeNull();
  });

  it('returns null without observations or an unknown participant', () => {
    expect(proverInput(tl, [], { participant: 0, frame: 10 })).toBeNull();
    expect(proverInput(tl, [face(5, 0, [9000, 0])], { participant: 5, frame: 10 })).toBeNull();
  });
});
