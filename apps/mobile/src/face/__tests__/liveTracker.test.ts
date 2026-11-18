import { describe, expect, it } from 'vitest';

import type { RawDetection, Track } from '../../rivalry/types';
import {
  eligible,
  FOCUS_SWITCH_MARGIN,
  iou,
  LIVE_MIN_FACE_WIDTH_SHARE,
  LOST_GRACE_MS,
  pickFocus,
  STABLE_MS,
  updateTracks,
} from '../liveTracker';
import { pickProbeFace } from '../pipeline';

const VIEW = { width: 400, height: 800 };

const det = (id: number | undefined, cx: number, cy = 400, w = 100, yaw = 0): RawDetection => ({
  ...(id !== undefined ? { trackingId: id } : {}),
  bounds: { x: cx - w / 2, y: cy - w / 2, width: w, height: w },
  yawAngle: yaw,
});

/** Feeds frames every `stepMs` from `t0`; returns the tracks after the last. */
function feed(
  frames: readonly (readonly RawDetection[])[],
  t0 = 0,
  stepMs = 66,
  start: Track[] = [],
): Track[] {
  let tracks = start;
  frames.forEach((dets, i) => {
    tracks = updateTracks(tracks, dets, t0 + i * stepMs, VIEW);
  });
  return tracks;
}

const centreOf = (t: Track) => t.box.x + t.box.width / 2;

describe('updateTracks', () => {
  it('keeps a detector id across frames as t<id>', () => {
    const tracks = feed([[det(7, 200)], [det(7, 205)], [det(7, 210)]]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ key: 't7', hits: 3, firstSeenMs: 0, lastSeenMs: 132 });
    expect(tracks[0]?.status).toEqual({ kind: 'pending' });
  });

  it('a new detector id is a new track, even for the same box', () => {
    const tracks = feed([[det(1, 200)], [det(2, 200)]]);
    expect(tracks.map((t) => t.key).sort()).toEqual(['t1', 't2']);
  });

  it('falls back to IoU without ids, and gives new faces fresh i<n> keys', () => {
    let tracks = feed([[det(undefined, 100), det(undefined, 300)]]);
    expect(tracks.map((t) => t.key).sort()).toEqual(['i0', 'i1']);
    const left = tracks.find((t) => centreOf(t) < 200)?.key;
    tracks = updateTracks(tracks, [det(undefined, 110), det(undefined, 295)], 66, VIEW);
    expect(tracks.find((t) => centreOf(t) < 200)?.key).toBe(left);
    expect(tracks.every((t) => t.hits === 2)).toBe(true);
    // A face far from both is new.
    tracks = updateTracks(tracks, [det(undefined, 110, 700)], 132, VIEW);
    expect(tracks.map((t) => t.key)).toContain('i2');
  });

  it('never reuses an i<n> key when given a sequence', () => {
    const seq = { next: 0 };
    let tracks = updateTracks([], [det(undefined, 100)], 0, VIEW, seq);
    tracks = updateTracks(tracks, [], 1000, VIEW, seq); // lost
    expect(tracks).toEqual([]);
    tracks = updateTracks(tracks, [det(undefined, 100)], 1066, VIEW, seq);
    expect(tracks[0]?.key).toBe('i1');
  });

  it('keeps an unseen track for LOST_GRACE_MS, then drops it', () => {
    let tracks = feed([[det(1, 200)]]);
    tracks = updateTracks(tracks, [], LOST_GRACE_MS, VIEW);
    expect(tracks.map((t) => t.key)).toEqual(['t1']);
    tracks = updateTracks(tracks, [], LOST_GRACE_MS + 1, VIEW);
    expect(tracks).toEqual([]);
  });

  it('carries the status through', () => {
    const [t] = feed([[det(1, 200)]]);
    const known = { ...(t as Track), status: { kind: 'too_far' } as const };
    const [next] = updateTracks([known], [det(1, 202)], 66, VIEW);
    expect(next?.status).toEqual({ kind: 'too_far' });
  });

  it('smooths the box (EMA 0.5)', () => {
    const tracks = feed([[det(1, 200)], [det(1, 240)]]);
    expect(centreOf(tracks[0] as Track)).toBeCloseTo(220);
  });

  it('times stability: steady -> stableSince holds; a jump resets it', () => {
    let tracks = feed([[det(1, 200)], [det(1, 202)], [det(1, 201)], [det(1, 203)]]);
    expect(tracks[0]?.stableSinceMs).toBe(0);
    tracks = updateTracks(tracks, [det(1, 320)], 264, VIEW); // moved > 0.2 x width
    expect(tracks[0]?.stableSinceMs).toBe(264);
  });
});

describe('eligible', () => {
  const steady = (cx: number, w: number, yaw = 0, frames = 6) =>
    feed(Array.from({ length: frames }, () => [det(1, cx, 400, w, yaw)]))[0] as Track;

  it('needs hits, stability and a face in view now', () => {
    const t = steady(200, 100);
    const last = t.lastSeenMs;
    expect(last).toBe(330);
    expect(eligible(t, VIEW, last)).toBe(true);
    expect(eligible(feed([[det(1, 200)], [det(1, 200)]])[0] as Track, VIEW, 66)).toBe(false);
    // Seen 2 frames ago is fine; gone a while is not.
    expect(eligible(t, VIEW, last + 1000)).toBe(false);
  });

  it(`waits ${STABLE_MS} ms of holding still`, () => {
    const t = feed([[det(1, 200)], [det(1, 200)], [det(1, 200)]])[0] as Track;
    expect(t.hits).toBe(3);
    expect(eligible(t, VIEW, 132)).toBe(false);
    const later = updateTracks([t], [det(1, 200)], STABLE_MS, VIEW)[0] as Track;
    expect(eligible(later, VIEW, STABLE_MS)).toBe(true);
  });

  it('rejects faces too small for a match, and heads turned away', () => {
    const minW = LIVE_MIN_FACE_WIDTH_SHARE * VIEW.width;
    expect(eligible(steady(200, minW - 1), VIEW, 330)).toBe(false);
    expect(eligible(steady(200, minW + 1), VIEW, 330)).toBe(true);
    expect(eligible(steady(200, 100, 35), VIEW, 330)).toBe(false);
    expect(eligible(steady(200, 100, -29), VIEW, 330)).toBe(true);
  });
});

describe('pickFocus', () => {
  const at = 0;
  const tracksOf = (...ds: RawDetection[]) => updateTracks([], ds, at, VIEW);

  it('is pickProbeFace in view space when there is no previous focus', () => {
    // The big face off-centre vs a small one dead centre (under half its area): the big one.
    const big = det(1, 80, 400, 150);
    const small = det(2, 200, 400, 90);
    const near = det(3, 230, 420, 120); // over half the big one's area, nearer the centre
    for (const set of [[big, small], [big, small, near], [small], [near, big]]) {
      const tracks = tracksOf(...set);
      const expected = pickProbeFace(
        set.map((d) => ({ bounds: d.bounds, id: d.trackingId })),
        VIEW,
      );
      const id = expected.ok ? expected.face.id : undefined;
      expect(pickFocus(tracks, null, VIEW, at)).toBe(`t${id}`);
    }
    expect(pickFocus([], null, VIEW, at)).toBeNull();
  });

  it('holds the focus between two faces almost the same distance from centre', () => {
    let tracks = tracksOf(det(1, 170), det(2, 236));
    let focus = pickFocus(tracks, null, VIEW, 0);
    expect(focus).toBe('t1'); // 30 vs 36 from centre
    const flips: string[] = [];
    for (let i = 1; i <= 20; i++) {
      // Both sway a little; t1 is sometimes nearer, never by the margin.
      const s = 12 * Math.sin(i);
      tracks = updateTracks(tracks, [det(1, 170 + s), det(2, 236 + s)], i * 66, VIEW);
      const next = pickFocus(tracks, focus, VIEW, i * 66);
      if (next !== focus) flips.push(next ?? 'null');
      focus = next;
    }
    expect(flips).toEqual([]);
  });

  it('moves when another face is nearer by the margin, or the focused one is gone', () => {
    const tracks = tracksOf(det(1, 200), det(2, 330));
    expect(pickFocus(tracks, 't2', VIEW, 0)).toBe('t1');
    const close = tracksOf(det(1, 200), det(2, 200 + FOCUS_SWITCH_MARGIN * VIEW.width - 4));
    expect(pickFocus(close, 't2', VIEW, 0)).toBe('t2');
    // The focused face drops out for a moment: kept; gone longer: moves.
    let t = tracksOf(det(1, 120), det(2, 260));
    t = updateTracks(t, [det(1, 120)], 200, VIEW);
    expect(pickFocus(t, 't2', VIEW, 200)).toBe('t2');
    t = updateTracks(t, [det(1, 120)], 400, VIEW);
    expect(pickFocus(t, 't2', VIEW, 400)).toBe('t1');
  });
});

describe('iou', () => {
  it('is 1 for the same box and 0 for disjoint ones', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { x: 20, y: 0, width: 10, height: 10 })).toBe(0);
    expect(iou(a, { x: 5, y: 0, width: 10, height: 10 })).toBeCloseTo(50 / 150);
  });
});
