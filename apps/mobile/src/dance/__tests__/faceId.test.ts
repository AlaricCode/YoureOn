// DANCE-OFF §3 face assignment on the phone: faces to heads, faces to send, the answer to A / B
// (model/faceId), following the identified players through framing (model/identity), and the
// whole time-boxed attempt with every native and network step faked (../faceIdentify).
import { JOINT } from '@youre-on/shared/dance/joints';
import { describe, expect, it, vi } from 'vitest';

import type { FaceStill } from '../../enroll/embedder';
import type { DetectedFace } from '../../enroll/flow';
import {
  FACE_ID_RETRY,
  identifyPlayers,
  isFaceIdResult,
  mayTryFaces,
  withTimeout,
  type FaceIdDeps,
} from '../faceIdentify';
import {
  associateFaces,
  facePlayers,
  facesToSend,
  headPoint,
  normalizeBox,
  resolveIdentity,
} from '../model/faceId';
import { createPlayerIdentity, IDENTITY } from '../model/identity';
import { createRoundPipeline } from '../model/pipeline';
import { frame, leftDancer, place, rightStill, WAVE_POP } from './helpers';
import { referencePoseAt } from '../model/reference';

const W = 720;
const H = 1280;
/** The two synthetic players: L stands left (x ≈ 0.28), R right (x ≈ 0.72). */
const L = leftDancer(WAVE_POP, 0);
const R = rightStill(WAVE_POP);

/** A face box (still pixels) centred on a person's head, `size` px square. */
function faceOn(k: readonly number[], size = 56, dx = 0): DetectedFace {
  const h = headPoint(k)!;
  return {
    yawAngle: 0,
    pitchAngle: 0,
    bounds: { x: h[0] * W - size / 2 + dx, y: h[1] * H - size / 2, width: size, height: size },
    frameWidth: W,
    frameHeight: H,
  };
}

describe('headPoint / associateFaces / facesToSend (model/faceId)', () => {
  it('the head is the mean of the face joints, else the neck, else nothing', () => {
    const h = headPoint(L)!;
    expect(h[1]).toBeLessThan(0.5); // above the middle of the frame
    const noFace = [...L];
    for (const j of [JOINT.nose, JOINT.leftEye, JOINT.rightEye, JOINT.leftEar, JOINT.rightEar])
      noFace[j * 3 + 2] = 0;
    expect(headPoint(noFace)).toEqual([L[JOINT.neck * 3]!, L[JOINT.neck * 3 + 1]!]);
    noFace[JOINT.neck * 3 + 2] = 0;
    expect(headPoint(noFace)).toBeNull();
  });

  it('pairs each face with the nearest head, one each, and drops a face on nobody', () => {
    const still = { width: W, height: H };
    const faces = [faceOn(R), { ...faceOn(L), bounds: { ...faceOn(L).bounds } }, faceOn(L, 40, 12)];
    const boxes = faces.map((f) => normalizeBox(f.bounds, still));
    const owners = associateFaces(boxes, [L, R], W / H);
    // face 0 is R's, face 1 L's; face 2 is also on L, but L already has the nearer one, so it is
    // nobody's
    expect(owners).toEqual([1, 0, null]);
    const far = normalizeBox({ x: 340, y: 1100, width: 50, height: 50 }, still);
    expect(associateFaces([far], [L, R], W / H)).toEqual([null]);
  });

  it('sends only the framed players’ faces, at most four', () => {
    expect(facesToSend([1, null, 2, 0], { a: 0, b: 1 })).toEqual([
      { face: 0, person: 1 },
      { face: 3, person: 0 },
    ]);
    expect(facesToSend([0, 1, 0, 1, 0], { a: 0, b: 1 })).toHaveLength(4);
  });

  it('resolveIdentity: both parties, two different framed people, else null', () => {
    const sent = [{ person: 1 }, { person: 0 }];
    const players = { a: 0, b: 1 };
    // face 0 (person 1, the right one) is A: A stands on the right
    expect(
      resolveIdentity(
        [
          { face_index: 0, party: 'A' },
          { face_index: 1, party: 'B' },
        ],
        sent,
        players,
      ),
    ).toEqual({ aPerson: 1, bPerson: 0 });
    expect(resolveIdentity([{ face_index: 0, party: 'A' }], sent, players)).toBeNull();
    expect(
      resolveIdentity(
        [
          { face_index: 0, party: 'A' },
          { face_index: 0, party: 'B' },
        ],
        sent,
        players,
      ),
    ).toBeNull();
    expect(
      resolveIdentity(
        [
          { face_index: 0, party: 'A' },
          { face_index: 1, party: 'A' },
        ],
        sent,
        players,
      ),
    ).toBeNull();
    expect(resolveIdentity([{ face_index: 5, party: 'A' }], sent, players)).toBeNull();
    expect(
      resolveIdentity(
        [
          { face_index: 0, party: 'A' },
          { face_index: 1, party: 'B' },
        ],
        [{ person: 2 }, { person: 0 }],
        players,
      ),
    ).toBeNull();
  });
});

describe('createPlayerIdentity (model/identity)', () => {
  it('follows the identified players from the still’s frame, even when they cross', () => {
    const id = createPlayerIdentity({ w: W, h: H });
    // The still was taken at ts 1000 while L and R stood apart; then they swap places by 2500.
    const at = (ts: number) => {
      const u = Math.min(1, Math.max(0, (ts - 1500) / 1000));
      const a = place(referencePoseAt(WAVE_POP, 0), 0.5, 0.22 - 0.44 * u); // starts right
      // smaller (stands farther back), so the two hip centres never coincide as they cross
      const b = place(referencePoseAt(WAVE_POP, 0), 0.4, -0.22 + 0.44 * u); // starts left
      return { ts, people: [b, a] };
    };
    for (let ts = 0; ts <= 1200; ts += 50) expect(id.observe(at(ts))).toBeNull();
    expect(id.identified()).toBe(false);
    expect(id.start()).toBeNull();
    // A is person 1 (the right one) in the frame at ts 1000
    expect(id.identify(1003, 1, 0)).toBe(true);
    expect(id.identified()).toBe(true);
    for (let ts = 1250; ts <= 3000; ts += 50) {
      const f = at(ts);
      const who = id.observe(f)!;
      expect(who.a).toBe(f.people[1]);
      expect(who.b).toBe(f.people[0]);
    }
    // A now stands on the LEFT: the round's tracker is seeded there.
    const start = id.start()!;
    expect(start.a[0]).toBeLessThan(0.5);
    expect(start.b[0]).toBeGreaterThan(0.5);
  });

  it('refuses a still whose frame is gone; drops the identity when a player is lost', () => {
    const id = createPlayerIdentity({ w: W, h: H });
    for (let ts = 0; ts <= 1000; ts += 50) id.observe({ ts, people: [L, R] });
    expect(id.identify(1000 + IDENTITY.MATCH_TS_MS + 30, 1, 0)).toBe(false);
    expect(id.identify(1000, 0, 0)).toBe(false);
    expect(id.identify(1000, 1, 0)).toBe(true);
    for (let ts = 1050; ts <= 1000 + IDENTITY.LOST_MS + 100; ts += 50)
      id.observe({ ts, people: [L] });
    expect(id.identified()).toBe(false);
    expect(id.start()).toBeNull();
  });

  it('seeds the round pipeline: A tracked on the right from the first frame', () => {
    const p = createRoundPipeline({
      routine: WAVE_POP,
      syncOffsetMs: 0,
      start: { a: [0.72, 0.5], b: [0.28, 0.5] },
    });
    const out = p.push(frame(0, 0, [L, R]));
    expect(out.a).toBe(R);
    expect(out.b).toBe(L);
    const plain = createRoundPipeline({ routine: WAVE_POP, syncOffsetMs: 0 });
    const lr = plain.push(frame(0, 0, [R, L]));
    expect(lr.a).toBe(L);
    expect(lr.b).toBe(R);
  });
});

// ---- the orchestrated attempt (../faceIdentify) ------------------------------------------

function fakeStill(faces: DetectedFace[], opts: { embedFails?: boolean } = {}) {
  const closed = { n: 0 };
  const embedded: Float32Array[] = [];
  const still: FaceStill = {
    faces,
    width: W,
    height: H,
    async embed(face) {
      if (opts.embedFails) throw new Error('tflite');
      const v = new Float32Array(512);
      v[faces.indexOf(face) % 512] = 1;
      embedded.push(v);
      return v;
    },
    close() {
      closed.n += 1;
    },
  };
  return { still, closed, embedded };
}

function deps(over: Partial<FaceIdDeps> = {}, faces = [faceOn(L), faceOn(R)]) {
  const s = fakeStill(faces);
  const deleted: string[] = [];
  const identity = createPlayerIdentity({ w: W, h: H });
  identity.observe({ ts: 500, people: [L, R] });
  const identify = vi.fn(async () => ({
    // face 0 (on L) is B, face 1 (on R) is A
    assignments: [
      { face_index: 1, party: 'A' as const },
      { face_index: 0, party: 'B' as const },
    ],
  }));
  const d: FaceIdDeps = {
    captureStill: async () => ({
      ok: true,
      uri: 'file:///c/still-1.jpg',
      width: W,
      height: H,
      ts: 510,
    }),
    frameAt: (ts) => identity.frameAt(ts),
    open: async () => s.still,
    identify,
    deleteFile: (uri) => void deleted.push(uri),
    size: { w: W, h: H },
    ...over,
  };
  return { d, s, deleted, identify };
}

describe('identifyPlayers (../faceIdentify)', () => {
  it('both identified: A is the right one; only embeddings go out; the still is deleted', async () => {
    const { d, s, deleted, identify } = deps();
    const r = await identifyPlayers(d);
    expect(r).toEqual({ ts: 500, aPerson: 1, bPerson: 0 });
    expect(isFaceIdResult(r)).toBe(true);
    const req = (identify.mock.calls[0] as unknown[])[0] as {
      model: { name: string };
      faces: { embedding: { alg: string; ct_b64: string } }[];
    };
    expect(req.model.name).toBe('w600k_mbf');
    expect(req.faces).toHaveLength(2);
    expect(req.faces[0]!.embedding.alg).toBe('plain-v0');
    expect(Object.keys(req.faces[0]!)).toEqual(['embedding']);
    expect(deleted).toEqual(['file:///c/still-1.jpg']);
    expect(s.closed.n).toBe(1);
    // the embeddings are zeroed once sent
    for (const v of s.embedded) expect(v.every((x) => x === 0)).toBe(true);
  });

  it('every miss is the left / right rule, never a throw, and still cleans up', async () => {
    expect(await identifyPlayers(deps({ captureStill: async () => ({ ok: false }) }).d)).toBe(
      'no_still',
    );
    const late = deps({
      captureStill: async () => ({ ok: true, uri: 'file:///x.jpg', width: W, height: H, ts: 9999 }),
    });
    expect(await identifyPlayers(late.d)).toBe('no_frame');
    expect(late.deleted).toEqual(['file:///x.jpg']);
    // the simulator build: the face natives fail to load
    const sim = deps({ open: () => Promise.reject(new Error('ML Kit is not in this build')) });
    expect(await identifyPlayers(sim.d)).toBe('error');
    expect(sim.deleted).toHaveLength(1);
    // one face (a mask, a turned head): one face cannot tell A from B
    const one = deps({}, [faceOn(L)]);
    expect(await identifyPlayers(one.d)).toBe('faces');
    expect(one.identify).not.toHaveBeenCalled();
    // nobody enrolled, or not sure
    const none = deps({ identify: async () => ({ assignments: [] }) });
    expect(await identifyPlayers(none.d)).toBe('unknown');
    const offline = deps({ identify: () => Promise.reject(new Error('network')) });
    expect(await identifyPlayers(offline.d)).toBe('error');
    expect(offline.s.closed.n).toBe(1);
    // framing broke in the still's frame
    const crowd = deps({ frameAt: () => ({ ts: 500, people: [L] }) });
    expect(await identifyPlayers(crowd.d)).toBe('framing');
  });

  it('is time-boxed: a slow answer is the left / right rule', async () => {
    vi.useFakeTimers();
    try {
      const slow = deps({ identify: () => new Promise(() => undefined) });
      const p = identifyPlayers(slow.d, 2_500);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await p).toBe('timeout');
      expect(await withTimeout(Promise.resolve(1), 10, 0)).toBe(1);
      expect(await withTimeout(Promise.reject(new Error('x')), 10, 0)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mayTryFaces: framing ok, not identified, one at a time, a few tries, spaced', () => {
    const base = {
      enabled: true,
      framingOk: true,
      identified: false,
      inFlight: false,
      tries: 0,
      lastTryAt: null,
      now: 10_000,
    };
    expect(mayTryFaces(base)).toBe(true);
    expect(mayTryFaces({ ...base, enabled: false })).toBe(false);
    expect(mayTryFaces({ ...base, framingOk: false })).toBe(false);
    expect(mayTryFaces({ ...base, identified: true })).toBe(false);
    expect(mayTryFaces({ ...base, inFlight: true })).toBe(false);
    expect(mayTryFaces({ ...base, tries: FACE_ID_RETRY.MAX_TRIES })).toBe(false);
    expect(mayTryFaces({ ...base, tries: 1, lastTryAt: 10_000 - FACE_ID_RETRY.GAP_MS + 1 })).toBe(
      false,
    );
    expect(mayTryFaces({ ...base, tries: 1, lastTryAt: 10_000 - FACE_ID_RETRY.GAP_MS })).toBe(true);
  });
});

describe('facePlayers: who a face attempt looks at, in position or not', () => {
  it("in position: the framing check's players", () => {
    expect(facePlayers([L, R], { a: 1, b: 0 })).toEqual({ a: 1, b: 0 });
  });

  it('not in position yet: any two people with heads and hips, the left one first', () => {
    // feet out of the picture, both on one side, walking in: the framing check names nobody
    expect(facePlayers([L, R])).toEqual({ a: 0, b: 1 });
    expect(facePlayers([R, L])).toEqual({ a: 1, b: 0 });
    expect(facePlayers([L, R], { a: undefined, b: undefined })).toEqual({ a: 0, b: 1 });
  });

  it('nobody to look at: one person, a crowd, or a body the follow could not track', () => {
    expect(facePlayers([L])).toBeNull();
    expect(facePlayers([L, R, L])).toBeNull();
    expect(facePlayers([L, new Array<number>(L.length).fill(0)])).toBeNull();
  });
});
