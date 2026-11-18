import { describe, expect, it } from 'vitest';
import { bytesToEmbedding, FaceMatchResponse } from '@youre-on/shared/face';

import type { FaceEmbedder } from '../../enroll/embedder';
import type { DetectedFace } from '../../enroll/flow';
import { FACE_MODEL } from '../../face/model';
import { overlayItems, viewBoxToStill } from '../../rivalry/geometry';
import { createFakeClock, flushMicrotasks } from '../../rivalry/previewScript';
import type { LiveFaceMatchRequest, LiveSnapshot, RawDetection, Track } from '../../rivalry/types';
import {
  createLiveScanEngine,
  ERROR_RETRY_MS,
  IN_FLIGHT_PAUSE_MS,
  LIVE_TUNING,
  type LiveTuning,
} from '../liveScan';
import { TICKET_MARGIN_MS, type ScanMatch } from '../scan';

const VIEW = { width: 393, height: 852 };
const STILL = { width: 960, height: 1280 };
const T0 = 1_000_000;
const FRAME = 66;

/** A face in view coordinates; `who` is the person (the fake embedder encodes it). */
interface Face {
  readonly id?: number | undefined;
  readonly who: number;
  readonly cx: number;
  readonly cy?: number;
  readonly w?: number;
  readonly yaw?: number;
}

const detOf = (f: Face): RawDetection => {
  const w = f.w ?? 110;
  const cy = f.cy ?? 420;
  return {
    ...(f.id !== undefined ? { trackingId: f.id } : {}),
    bounds: { x: f.cx - w / 2, y: cy - w * 0.65, width: w, height: w * 1.3 },
    yawAngle: f.yaw ?? 0,
  };
};

const PEOPLE = ['Jake', 'Priya', 'Sam', 'Ana', 'Ben', 'Cy'];
const h2h = (who: number) => ({
  wins: 4 + who,
  losses: 7,
  pushes: 0,
  net: '-7000000',
  net_display: '−$7.00',
  last_settled_at: null,
  includes_seed: true,
  total: 11 + who,
  last_result: 'loss' as const,
  streak: { holder: 'them' as const, length: 1 },
  rival: true,
});

type Answer = 'match' | 'none' | Error;

class CodeError extends Error {
  constructor(
    readonly code: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

function harness(
  opts: {
    tuning?: Partial<LiveTuning>;
    latencyMs?: number;
    /** Who is enrolled in the room (others answer {match: null}). */
    answer?: (who: number, call: number) => Answer;
    /** The still shows these instead of what the camera sees. */
    stillFaces?: () => readonly Face[];
    embedThrows?: boolean;
    manual?: boolean;
  } = {},
) {
  const clock = createFakeClock(T0);
  let scene: readonly Face[] = [];
  const calls: { who: number; req: LiveFaceMatchRequest; at: number }[] = [];
  const captures: number[] = [];
  const deleted: string[] = [];
  const embeddings: Float32Array[] = [];
  let closed = 0;
  let opened = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const manual: { who: number; resolve: (a: Answer) => void }[] = [];

  const respond = (who: number, a: Answer, now: number): FaceMatchResponse => {
    if (a instanceof Error) throw a;
    if (a === 'none') return { match: null };
    return FaceMatchResponse.parse({
      match: {
        user: {
          user_id: `00000000-0000-4000-8000-00000000000${who}`,
          pubkey: '11111111111111111111111111111111',
          display_name: PEOPLE[who],
          avatar_url: null,
        },
        match_ticket: `mt.${who}.${now}`,
        ticket_expires_at: new Date(now + 60_000).toISOString(),
        head_to_head: h2h(who),
      },
    });
  };

  const embedder: FaceEmbedder = {
    preview: false,
    async open() {
      opened++;
      const faces = (opts.stillFaces?.() ?? scene).map((f): DetectedFace & { who: number } => ({
        who: f.who,
        bounds: viewBoxToStill(detOf(f).bounds, STILL, VIEW),
        yawAngle: f.yaw ?? 0,
        pitchAngle: 0,
        frameWidth: STILL.width,
        frameHeight: STILL.height,
      }));
      return {
        faces,
        ...STILL,
        async embed(face) {
          if (opts.embedThrows) throw new Error('model failed');
          const v = new Float32Array(FACE_MODEL.dim);
          v[(face as DetectedFace & { who: number }).who] = 1;
          embeddings.push(v);
          return v;
        },
        close() {
          closed++;
        },
      };
    },
  };

  const engine = createLiveScanEngine(
    {
      captureStill: async () => {
        captures.push(clock.now());
        return `file:///tmp/p${captures.length}.jpg`;
      },
      embedder,
      deletePhoto: (url) => deleted.push(url),
      now: clock.now,
      setTimer: clock.setTimer,
      faceMatch(req) {
        const v = bytesToEmbedding(Uint8Array.from(atob(req.probe.ct_b64), (c) => c.charCodeAt(0)));
        const who = v.indexOf(1);
        const at = clock.now();
        calls.push({ who, req, at });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<FaceMatchResponse>((resolve, reject) => {
          const done = (a: Answer) => {
            inFlight--;
            try {
              resolve(respond(who, a, clock.now()));
            } catch (e) {
              reject(e);
            }
          };
          if (opts.manual) manual.push({ who, resolve: done });
          else
            clock.setTimer(
              () => done((opts.answer ?? (() => 'match'))(who, calls.length)),
              opts.latencyMs ?? 300,
            );
        });
      },
    },
    opts.tuning,
  );
  const snaps: LiveSnapshot[] = [];
  engine.subscribe((s) => snaps.push(s));

  /** Plays `ms` of detector frames showing `faces` (or a function of time). */
  const play = async (ms: number, faces: readonly Face[] | ((t: number) => readonly Face[])) => {
    const end = clock.now() + ms;
    while (clock.now() < end) {
      const t = Math.min(end, clock.now() + FRAME);
      clock.advanceTo(t);
      await flushMicrotasks();
      scene = typeof faces === 'function' ? faces(t - T0) : faces;
      engine.ingest(scene.map(detOf), VIEW, t);
      await flushMicrotasks();
    }
  };
  /** Lets time pass with no new frames. */
  const idle = async (ms: number) => {
    clock.advanceTo(clock.now() + ms);
    await flushMicrotasks();
  };
  const track = (key: string): Track | undefined =>
    engine.snapshot().tracks.find((t) => t.key === key);

  return {
    engine,
    clock,
    calls,
    captures,
    deleted,
    embeddings,
    manual,
    snaps,
    play,
    idle,
    track,
    counts: () => ({ opened, closed, maxInFlight }),
  };
}

const JAKE: Face = { id: 1, who: 0, cx: 196 };
const PRIYA: Face = { id: 2, who: 1, cx: 60 };

describe('one face', () => {
  it('a steady face gets one photo and one match, then shows the record', async () => {
    const h = harness();
    h.engine.start();
    expect(h.engine.snapshot().status).toBe('point');
    await h.play(1500, [JAKE]);
    expect(h.captures).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.req.mode).toBe('live');
    const t = h.track('t1');
    expect(t?.status.kind).toBe('known');
    if (t?.status.kind !== 'known') return;
    expect(t.status.match.user.display_name).toBe('Jake');
    expect(t.status.match.stats).toMatchObject({ wins: 4, losses: 7, netDisplay: '−$7.00' });
    expect(h.engine.snapshot()).toMatchObject({ focusedKey: 't1', status: 'live' });
    // Photo deleted, still closed, embedding zeroed.
    expect(h.deleted).toEqual(['file:///tmp/p1.jpg']);
    expect(h.counts()).toMatchObject({ opened: 1, closed: 1 });
    expect(h.embeddings.every((v) => v.every((x) => x === 0))).toBe(true);
  });

  it('waits for the face to settle: nothing is matched while it moves', async () => {
    const h = harness();
    h.engine.start();
    await h.play(1500, (t) => [{ ...JAKE, cx: 40 + t / 5 }]); // 200 pt/s
    expect(h.captures).toHaveLength(0);
    expect(h.engine.snapshot().status).toBe('live');
  });

  it('a small face reads "closer" and is not matched', async () => {
    const h = harness();
    h.engine.start();
    await h.play(1500, [{ ...JAKE, w: 40 }]);
    expect(h.calls).toHaveLength(0);
    expect(h.engine.snapshot().status).toBe('closer');
    const items = overlayItems(h.engine.snapshot(), {
      card: { width: 200, height: 100 },
      pill: { width: 100, height: 30 },
    });
    expect(items[0]?.kind).toBe('too_far');
  });

  it('caches a known face: no second match until the TTL, then a quiet refresh', async () => {
    const h = harness();
    h.engine.start();
    await h.play(20_000, [JAKE]);
    expect(h.calls).toHaveLength(1);
    await h.play(LIVE_TUNING.knownTtlMs - 20_000 + 2_500, [JAKE]);
    expect(h.calls).toHaveLength(2);
    // While refreshing it keeps showing the old record.
    const during = h.snaps.find(
      (s) => s.tracks[0]?.status.kind === 'known' && s.tracks[0].status.refreshing === true,
    );
    expect(during).toBeDefined();
    expect(h.track('t1')?.status).toMatchObject({ kind: 'known', refreshing: false });
  });
});

describe('the scheduler', () => {
  it('respects the minimum gap, the budget and one-in-flight over a 60 s pan', async () => {
    // A new face (new id) enters every 0.5 s: far more than the budget allows.
    const h = harness({ latencyMs: 500 });
    h.engine.start();
    const faces = (t: number): Face[] => {
      const n = Math.floor(t / 500);
      return [
        { id: 100 + n, who: n % 6, cx: 196 },
        { id: 1000 + n, who: (n + 1) % 6, cx: 330, w: 100 },
      ];
    };
    await h.play(60_000, faces);
    const gaps = h.captures.slice(1).map((t, i) => t - (h.captures[i] as number));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(LIVE_TUNING.minGapMs);
    // 45/min plus the burst of 8, at most.
    expect(h.calls.length).toBeLessThanOrEqual(LIVE_TUNING.budgetPerMin + LIVE_TUNING.burst);
    expect(h.calls.length).toBeGreaterThan(30);
    expect(h.counts().maxInFlight).toBe(1);
    // Every photo deleted.
    expect(h.deleted).toHaveLength(h.captures.length);
  });

  it('never runs two jobs at once, however slow the server', async () => {
    const h = harness({ manual: true });
    h.engine.start();
    await h.play(3000, [JAKE, PRIYA]);
    expect(h.calls).toHaveLength(1);
    expect(h.captures).toHaveLength(1);
    h.manual[0]?.resolve('match');
    await h.play(200, [JAKE, PRIYA]);
    expect(h.calls).toHaveLength(2); // the second face of the same photo
    expect(h.captures).toHaveLength(1);
    expect(h.counts().maxInFlight).toBe(1);
  });

  it('matches the focused face first, then the others while budget allows', async () => {
    const h = harness();
    h.engine.start();
    await h.play(2000, [PRIYA, JAKE]);
    expect(h.calls.map((c) => c.who)).toEqual([0, 1]); // Jake (centre) first
    expect(h.captures).toHaveLength(1); // both from one photo
  });

  it('keeps faces other than the focused one waiting when the budget is low', async () => {
    // Five tokens and (almost) no refill: 5 -> 3 -> 1, then only the focused face.
    const h = harness({ tuning: { burst: 5, budgetPerMin: 0.001 } });
    h.engine.start();
    await h.play(2000, [PRIYA, JAKE]);
    await h.play(2000, [
      { id: 3, who: 2, cx: 196 },
      { id: 4, who: 3, cx: 330 },
    ]);
    expect(h.calls.map((c) => c.who)).toEqual([0, 1, 2, 3]);
    await h.play(3000, [
      { id: 5, who: 4, cx: 196 },
      { id: 6, who: 5, cx: 330 },
    ]);
    expect(h.calls.map((c) => c.who)).toEqual([0, 1, 2, 3, 4]); // Cy (5) waits
    expect(h.track('t6')?.status).toEqual({ kind: 'pending' });
  });
});

describe('server answers', () => {
  it('a 429 pauses silently and the face stays pending', async () => {
    let n = 0;
    const h = harness({
      answer: () =>
        ++n === 1 ? new CodeError('RATE_LIMITED', { bucket: 'face-match/live' }) : 'match',
    });
    h.engine.start();
    await h.play(1500, [JAKE]);
    expect(h.engine.snapshot().status).toBe('paused');
    expect(h.track('t1')?.status).toEqual({ kind: 'pending' });
    // The 429 came back 300 ms (the fake latency) after the call.
    const pausedAt = (h.calls[0]?.at as number) + 300;
    await h.play(pausedAt + LIVE_TUNING.pauseOn429Ms - 100 - h.clock.now(), [JAKE]);
    expect(h.calls).toHaveLength(1);
    await h.play(1500, [JAKE]);
    expect(h.calls).toHaveLength(2);
    expect((h.calls[1]?.at as number) - pausedAt).toBeGreaterThanOrEqual(LIVE_TUNING.pauseOn429Ms);
    expect(h.track('t1')?.status.kind).toBe('known');
    // Never shown as unknown or an error in between.
    expect(
      h.snaps.some((s) =>
        s.tracks.some((t) => t.status.kind === 'unknown' || t.status.kind === 'error'),
      ),
    ).toBe(false);
  });

  it('honours Retry-After and the one-in-flight bucket', async () => {
    const long = harness({
      answer: () => new CodeError('RATE_LIMITED', { bucket: 'face-match/live' }, 9_000),
    });
    long.engine.start();
    await long.play(1500, [JAKE]);
    await long.play(8000, [JAKE]);
    expect(long.calls).toHaveLength(1);

    let n = 0;
    const busy = harness({
      answer: () =>
        ++n === 1 ? new CodeError('RATE_LIMITED', { bucket: 'face-match/in-flight' }) : 'match',
    });
    busy.engine.start();
    await busy.play(1500, [JAKE]);
    await busy.play(IN_FLIGHT_PAUSE_MS + 200, [JAKE]);
    expect(busy.calls).toHaveLength(2);
  });

  it('NOT_IN_ROOM stops matching', async () => {
    const h = harness({ answer: () => new CodeError('NOT_IN_ROOM') });
    h.engine.start();
    await h.play(1500, [JAKE]);
    expect(h.engine.snapshot().status).toBe('not_in_room');
    await h.play(10_000, [JAKE, PRIYA]);
    expect(h.calls).toHaveLength(1);
    expect(await h.engine.challengeTarget('t1')).toBe('not_in_room');
  });

  it('an unknown face backs off (2 s, 4 s) and stops after 3 attempts', async () => {
    const h = harness({ answer: () => 'none' });
    h.engine.start();
    await h.play(30_000, [JAKE]);
    expect(h.calls).toHaveLength(LIVE_TUNING.maxAttempts);
    const at = h.calls.map((c) => c.at);
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(2_000 + 300);
    expect((at[2] as number) - (at[1] as number)).toBeGreaterThanOrEqual(4_000 + 300);
    expect(h.track('t1')?.status).toEqual({ kind: 'unknown', attempts: 3, retryAtMs: null });
    // Never named.
    const items = overlayItems(h.engine.snapshot(), {
      card: { width: 200, height: 100 },
      pill: { width: 100, height: 30 },
    });
    expect(items).toEqual([{ key: 't1', kind: 'unknown', focused: true, box: expect.anything() }]);
  });

  it('other errors retry after 3 s, at most 3 times', async () => {
    const h = harness({ answer: () => new CodeError('INTERNAL') });
    h.engine.start();
    await h.play(20_000, [JAKE]);
    expect(h.calls).toHaveLength(3);
    expect((h.calls[1]?.at as number) - (h.calls[0]?.at as number)).toBeGreaterThanOrEqual(
      ERROR_RETRY_MS,
    );
    expect(h.track('t1')?.status).toEqual({ kind: 'error', attempts: 3, retryAtMs: null });
  });
});

describe('panning', () => {
  it('a new tracking id for the same person is a new face, matched again', async () => {
    const h = harness();
    h.engine.start();
    await h.play(1500, [JAKE]);
    await h.play(1500, [{ ...JAKE, id: 9 }]);
    expect(h.calls.map((c) => c.who)).toEqual([0, 0]);
    expect(h.track('t9')?.status.kind).toBe('known');
    expect(h.track('t1')).toBeUndefined();
  });

  it('the card follows the focus as the camera pans, stats changing with it', async () => {
    const h = harness();
    h.engine.start();
    // Jake centre, Priya right; then pan so Priya is centre.
    await h.play(2500, [JAKE, { id: 2, who: 1, cx: 330 }]);
    const card = () =>
      overlayItems(h.engine.snapshot(), {
        card: { width: 200, height: 100 },
        pill: { width: 100, height: 30 },
      }).find((i) => i.focused);
    expect(card()).toMatchObject({ kind: 'known', name: 'Jake', record: '4-7' });
    const calls = h.calls.length;
    await h.play(1200, (t) => {
      const shift = Math.min(1, Math.max(0, (t - 2500) / 600)) * 134;
      return [
        { ...JAKE, cx: 196 - shift },
        { id: 2, who: 1, cx: 330 - shift },
      ];
    });
    expect(h.engine.snapshot().focusedKey).toBe('t2');
    expect(card()).toMatchObject({ kind: 'known', name: 'Priya', record: '5-7' });
    // Instant: from the cache, no new match.
    expect(h.calls.length).toBe(calls);
  });

  it('drops a result whose face left before it arrived', async () => {
    const h = harness({ manual: true });
    h.engine.start();
    await h.play(1500, [JAKE]);
    expect(h.calls).toHaveLength(1);
    // Jake leaves; Sam steps in at the same spot with a new id.
    await h.play(1000, [{ id: 3, who: 2, cx: 196 }]);
    expect(h.track('t1')).toBeUndefined();
    h.manual[0]?.resolve('match');
    await h.play(100, [{ id: 3, who: 2, cx: 196 }]);
    // Sam is never shown with Jake's record.
    const sam = h.track('t3');
    expect(sam?.status.kind === 'known' && sam.status.match.user.display_name).not.toBe('Jake');
  });

  it('a face missing from the photo costs no network call and is retried soon', async () => {
    let empty = true;
    const h = harness({ stillFaces: () => (empty ? [] : [JAKE]) });
    h.engine.start();
    await h.play(1200, [JAKE]);
    expect(h.captures.length).toBeGreaterThanOrEqual(1);
    expect(h.calls).toHaveLength(0);
    expect(h.track('t1')?.status).toEqual({ kind: 'pending' });
    empty = false;
    await h.play(1500, [JAKE]);
    expect(h.calls).toHaveLength(1);
  });

  it('a face too small in the photo is too_far, with no network call', async () => {
    const h = harness({ stillFaces: () => [{ ...JAKE, w: 40 }] });
    h.engine.start();
    await h.play(1200, [JAKE]);
    expect(h.calls).toHaveLength(0);
    expect(h.track('t1')?.status).toEqual({ kind: 'too_far' });
    expect(h.engine.snapshot().status).toBe('closer');
  });

  it('stop() drops late results but still deletes the photo', async () => {
    const h = harness({ manual: true });
    h.engine.start();
    await h.play(1500, [JAKE]);
    h.engine.stop();
    h.manual[0]?.resolve('match');
    await flushMicrotasks();
    expect(h.engine.snapshot()).toMatchObject({ status: 'stopped', tracks: [] });
    expect(h.deleted).toHaveLength(1);
    // Restarting: a fresh engine state, and only one call in flight across the restart.
    h.engine.start();
    await h.play(1500, [JAKE]);
    expect(h.track('t1')?.status.kind).toBe('checking');
    expect(h.counts().maxInFlight).toBe(1);
  });
});

describe('challenge', () => {
  const known = (h: ReturnType<typeof harness>) => {
    const t = h.track('t1');
    if (t?.status.kind !== 'known') throw new Error('not known');
    return t.status.match;
  };

  it('returns the cached match at once while its ticket is fresh', async () => {
    const h = harness();
    h.engine.start();
    await h.play(1500, [JAKE]);
    const calls = h.calls.length;
    const r = await h.engine.challengeTarget('t1');
    expect(r).toBe(known(h));
    expect((r as ScanMatch).ticket).toMatch(/^mt\.0\./);
    expect(h.calls.length).toBe(calls);
  });

  it('re-matches when the ticket is stale, skipping the minimum gap', async () => {
    const h = harness({ tuning: { knownTtlMs: 600_000 } });
    h.engine.start();
    await h.play(1500, [JAKE]);
    const first = known(h);
    await h.play(first.expiresAtMs - h.clock.now() - TICKET_MARGIN_MS + 100, [JAKE]);
    const p = h.engine.challengeTarget('t1');
    await h.play(400, [JAKE]);
    const r = await p;
    expect(typeof r).toBe('object');
    expect((r as ScanMatch).ticket).not.toBe(first.ticket);
    expect((r as ScanMatch).expiresAtMs).toBeGreaterThan(first.expiresAtMs);
  });

  it('markStale forces a re-match for the next challenge', async () => {
    const h = harness();
    h.engine.start();
    await h.play(1500, [JAKE]);
    const first = known(h);
    h.engine.markStale('t1');
    await h.play(1000, [JAKE]);
    expect(h.calls).toHaveLength(2);
    const r = await h.engine.challengeTarget('t1');
    expect((r as ScanMatch).ticket).not.toBe(first.ticket);
  });

  it('gives up after challengeWaitMs, and says why a face cannot be challenged', async () => {
    const h = harness({ manual: true });
    h.engine.start();
    await h.play(1500, [JAKE]);
    const p = h.engine.challengeTarget('t1');
    await h.play(LIVE_TUNING.challengeWaitMs + 100, [JAKE]);
    expect(await p).toBe('failed');
    expect(await h.engine.challengeTarget('nobody')).toBe('no_face');

    const u = harness({ answer: () => 'none' });
    u.engine.start();
    await u.play(1500, [JAKE]);
    const q = u.engine.challengeTarget('t1');
    await u.play(600, [JAKE]);
    expect(await q).toBe('no_match');
  });
});

describe('privacy', () => {
  it('zeroes every embedding and deletes every photo, whatever fails', async () => {
    for (const opts of [
      {},
      { embedThrows: true },
      { answer: () => new CodeError('INTERNAL') as Answer },
      { answer: () => 'none' as Answer },
    ]) {
      const h = harness(opts);
      h.engine.start();
      await h.play(4000, [JAKE, PRIYA]);
      expect(h.captures.length).toBeGreaterThan(0);
      expect(h.deleted).toHaveLength(h.captures.length);
      expect(h.counts().closed).toBe(h.counts().opened);
      expect(h.embeddings.every((v) => v.every((x) => x === 0))).toBe(true);
    }
  });

  it('keeps no score and no embedding anywhere in what it shows', async () => {
    const h = harness({ answer: (who) => (who === 0 ? 'match' : 'none') });
    h.engine.start();
    await h.play(3000, [JAKE, PRIYA]);
    const json = JSON.stringify(h.snaps);
    expect(json).not.toMatch(/score|similarity|distance|embedding|probe/i);
    // The unknown face is never named.
    const priya = h.track('t2');
    expect(priya?.status.kind).toBe('unknown');
    expect(JSON.stringify(priya)).not.toContain('Priya');
  });
});
