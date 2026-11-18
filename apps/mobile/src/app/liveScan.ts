// The live rivalry scan's engine (pure TS, every dependency injected, so vitest runs all of it).
//
// Point the camera at people and each recognised face shows your record against them, updating
// as you pan. The detector (src/rivalry/LiveScanCamera.tsx) feeds `ingest` 10-15 times a second;
// the tracker (src/face/liveTracker.ts) follows each face; this engine decides who to identify
// next and keeps the answer per track:
//
//   scheduler   at most one job in flight; at least `minGapMs` between jobs; a client token
//               bucket under the server's live bucket; the focused face first, the others only
//               while at least half the budget is left
//   one job     one photo -> embedder.open -> pair the photo's faces with the tracks (by
//               position, src/rivalry/geometry associate) -> embed up to `maxMatchesPerStill`
//               of them -> close the still and delete the photo -> POST face-match (mode 'live')
//               per face -> the answer goes to that track (dropped if the track has gone)
//   cache       known: shown until the track is lost, refreshed quietly after `knownTtlMs`
//               (under the 60 s ticket); unknown: retried with back-off, at most `maxAttempts`
//               matches per track; a 429 pauses silently; NOT_IN_ROOM stops matching
//   challenge   `challengeTarget(key)` returns the cached match while its ticket is fresh, or
//               re-matches that face first and waits up to `challengeWaitMs`
//
// Privacy is unchanged from the tap scan (app/scan.ts): the photo never leaves the phone and is
// deleted after every job, success or failure; each embedding is zeroed as soon as its request is
// built; nothing is cached but what the match card already shows; there are no scores; a face is
// never named without a match. Unknown and not-opted-in look the same ({match: null}).
import type { FaceMatchResponse } from '@youre-on/shared/face';

import type { FaceEmbedder, FaceStill } from '../enroll/embedder';
import type { DetectedFace } from '../enroll/flow';
import {
  eligible,
  pickFocus,
  updateTracks,
  bigEnough,
  type TrackKeySeq,
} from '../face/liveTracker';
import { MIN_SCAN_FACE_SHARE } from '../face/pipeline';
import { statsOf } from '../rivalry/format';
import { associate } from '../rivalry/geometry';
import type {
  LiveFaceMatchRequest,
  LiveMatch,
  LiveSnapshot,
  LiveStatus,
  RawDetection,
  Size,
  Track,
  TrackStatus,
} from '../rivalry/types';
import {
  buildFaceMatchRequest,
  matchErrorMiss,
  scanMatchOf,
  ticketFresh,
  type ScanMatch,
  type ScanMiss,
} from './scan';

export interface LiveScanDeps {
  /** Takes one photo; resolves its file:// url. */
  captureStill(): Promise<string>;
  embedder: FaceEmbedder;
  /** POST /v1/rooms/:room_id/face-match for the current room. */
  faceMatch(req: LiveFaceMatchRequest): Promise<FaceMatchResponse>;
  /** Deletes the photo (best effort, never throws). */
  deletePhoto(url: string): void;
  /** Server-corrected clock (ms). `ingest`'s `atMs` must be on this clock too. */
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
}

export interface LiveScanEngine {
  /** One detector frame (view coordinates), at `atMs` on deps.now()'s clock. */
  ingest(dets: readonly RawDetection[], view: Size, atMs: number): void;
  subscribe(fn: (s: LiveSnapshot) => void): () => void;
  snapshot(): LiveSnapshot;
  /** The match to challenge for this face: the cached one if its ticket is fresh, else a
   *  priority re-match (resolves within `challengeWaitMs`). */
  challengeTarget(key: string): Promise<ScanMatch | ScanMiss>;
  /** The ticket was refused ('expired'): re-match this face before the next challenge. */
  markStale(key: string): void;
  start(): void;
  /** Drops tracks and any in-flight result (the photo is still deleted). */
  stop(): void;
}

export interface LiveTuning {
  /** Least time between two jobs (photo + matches). */
  minGapMs: number;
  /** Client budget: face-match calls per minute (the server's live bucket is 60). */
  budgetPerMin: number;
  /** Client budget: burst. */
  burst: number;
  /** A known face is re-matched (quietly) after this; under the 60 s ticket minus its margin. */
  knownTtlMs: number;
  /** Back-off after the 1st, 2nd, ... `{match: null}` for a face. */
  retryMs: readonly number[];
  /** Match calls per face that may come back unknown (or fail) before it stays unknown. */
  maxAttempts: number;
  /** Faces matched from one photo. */
  maxMatchesPerStill: number;
  /** Silent pause after a 429 (1 s for the one-in-flight guard). */
  pauseOn429Ms: number;
  /** How long `challengeTarget` waits for a re-match. */
  challengeWaitMs: number;
}

export const LIVE_TUNING: Readonly<LiveTuning> = {
  minGapMs: 700,
  budgetPerMin: 45,
  burst: 8,
  knownTtlMs: 40_000,
  retryMs: [2_000, 4_000, 8_000],
  maxAttempts: 3,
  maxMatchesPerStill: 2,
  pauseOn429Ms: 5_000,
  challengeWaitMs: 2_500,
};

/** Pause after the server's one-in-flight guard said no (another scan was running). */
export const IN_FLIGHT_PAUSE_MS = 1_000;
/** A face that failed (network, embed) is retried after this. */
export const ERROR_RETRY_MS = 3_000;
/** A face missing from the photo (moved, blinked out) is retried after this... */
export const MISSED_RETRY_MS = 500;
/** ...and after this once it has been missed MISSES_BEFORE_BACKOFF times in a row. */
export const MISSED_BACKOFF_MS = 4_000;
export const MISSES_BEFORE_BACKOFF = 3;
/** A face too small in the photo is retried after this. */
export const TOO_FAR_RETRY_MS = 2_000;

const codeOf = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : null;
};

const bucketOf = (e: unknown): string | null => {
  const b = (e as { details?: { bucket?: unknown } } | null)?.details?.bucket;
  return typeof b === 'string' ? b : null;
};

/** Retry-After, when the error carries it (`retryAfterMs`, or `retryAfter` in seconds). */
export function retryAfterMsOf(e: unknown): number | null {
  const o = e as { retryAfterMs?: unknown; retryAfter?: unknown } | null;
  if (typeof o?.retryAfterMs === 'number' && o.retryAfterMs > 0) return o.retryAfterMs;
  if (typeof o?.retryAfter === 'number' && o.retryAfter > 0) return o.retryAfter * 1000;
  return null;
}

/** What one job found for one face. */
type Outcome =
  | { readonly kind: 'match'; readonly match: LiveMatch }
  | { readonly kind: 'none' }
  | { readonly kind: 'missed' }
  | { readonly kind: 'too_far' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'rate' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'not_in_room' };

interface Meta {
  /** firstSeenMs of the track this meta belongs to (a reused key is a different face). */
  readonly gen: number;
  /** No job for this face before this. */
  notBefore: number;
  /** Photos in a row this face was missing from. */
  misses: number;
  /** markStale: re-match before the next challenge (and refresh now). */
  stale: boolean;
}

type Waiter = (r: ScanMatch | ScanMiss) => void;

export function createLiveScanEngine(
  deps: LiveScanDeps,
  opts: Partial<LiveTuning> = {},
): LiveScanEngine {
  const tune: LiveTuning = { ...LIVE_TUNING, ...opts };
  const seq: TrackKeySeq = { next: 0 };
  const listeners = new Set<(s: LiveSnapshot) => void>();
  const meta = new Map<string, Meta>();
  const waiters = new Map<string, Waiter[]>();

  let running = false;
  let started = false;
  /** Bumped by stop(): results of jobs from an older epoch are dropped. */
  let epoch = 0;
  let tracks: Track[] = [];
  let focusedKey: string | null = null;
  let view: Size = { width: 0, height: 0 };
  let notInRoom = false;
  let pauseUntil = -Infinity;
  let lastCallAt = -Infinity;
  let inFlight = false;
  let priorityKey: string | null = null;
  let tokens = tune.burst;
  let tokensAt: number | null = null;
  let cancelWake: (() => void) | null = null;
  let wakeAt = Infinity;
  let snap: LiveSnapshot = { tracks: [], focusedKey: null, status: 'idle', view };

  // ---- small helpers -------------------------------------------------------------------

  const refill = (now: number) => {
    if (tokensAt !== null) {
      tokens = Math.min(tune.burst, tokens + ((now - tokensAt) * tune.budgetPerMin) / 60_000);
    }
    tokensAt = now;
  };

  const findTrack = (key: string) => tracks.find((t) => t.key === key);

  const metaOf = (t: Track): Meta => {
    let m = meta.get(t.key);
    if (!m || m.gen !== t.firstSeenMs) {
      m = { gen: t.firstSeenMs, notBefore: -Infinity, misses: 0, stale: false };
      meta.set(t.key, m);
    }
    return m;
  };

  const setStatus = (key: string, status: TrackStatus) => {
    tracks = tracks.map((t) => (t.key === key ? { ...t, status } : t));
  };

  const status = (): LiveStatus => {
    if (!started) return 'idle';
    if (!running) return 'stopped';
    if (notInRoom) return 'not_in_room';
    if (deps.now() < pauseUntil) return 'paused';
    if (tracks.length === 0) return 'point';
    const f = focusedKey === null ? undefined : findTrack(focusedKey);
    if (
      f &&
      (f.status.kind === 'too_far' || (f.status.kind === 'pending' && !bigEnough(f, view)))
    ) {
      return 'closer';
    }
    return 'live';
  };

  const emit = () => {
    snap = { tracks, focusedKey, status: status(), view };
    for (const fn of [...listeners]) fn(snap);
  };

  const resolveWaiters = (key: string, r: ScanMatch | ScanMiss) => {
    const ws = waiters.get(key);
    if (priorityKey === key) priorityKey = null;
    if (!ws) return;
    waiters.delete(key);
    for (const w of ws) w(r);
  };

  const wake = (at: number) => {
    if (!running || !(at < Infinity)) return;
    if (cancelWake && at >= wakeAt) return;
    cancelWake?.();
    wakeAt = at;
    cancelWake = deps.setTimer(
      () => {
        cancelWake = null;
        wakeAt = Infinity;
        pump();
        emit();
      },
      Math.max(1, Math.ceil(at - deps.now())),
    );
  };

  /** When this face is next worth a match, or null if not (yet) due for one. */
  const dueAt = (t: Track): number | null => {
    const m = metaOf(t);
    const s = t.status;
    switch (s.kind) {
      case 'pending':
      case 'too_far':
        return m.notBefore;
      case 'checking':
        return null;
      case 'known':
        if (s.refreshing) return null;
        return Math.max(m.notBefore, m.stale ? -Infinity : s.match.matchedAtMs + tune.knownTtlMs);
      case 'unknown':
      case 'error':
        return s.retryAtMs;
    }
  };

  // ---- the scheduler -------------------------------------------------------------------

  function pump(): void {
    if (!running || notInRoom || inFlight) return;
    const now = deps.now();
    if (now < pauseUntil) {
      if (priorityKey !== null) resolveWaiters(priorityKey, 'busy');
      wake(pauseUntil);
      return;
    }
    refill(now);

    // A challenge waiting on a re-match goes first, without the minimum gap.
    if (priorityKey !== null) {
      const key = priorityKey;
      const t = findTrack(key);
      if (!t) {
        resolveWaiters(key, 'no_face');
      } else if (tokens < 1) {
        resolveWaiters(key, 'busy');
      } else {
        void runJob([key], now);
        return;
      }
    }

    if (now - lastCallAt < tune.minGapMs) {
      wake(lastCallAt + tune.minGapMs);
      return;
    }
    if (tokens < 1) {
      // Rounded up (+1 ms) so float error never leaves the token a hair short at the wake.
      wake(now + Math.ceil(((1 - tokens) * 60_000) / tune.budgetPerMin) + 1);
      return;
    }

    const area = (t: Track) => t.box.width * t.box.height;
    const due: Track[] = [];
    let next = Infinity;
    for (const t of tracks) {
      const at = dueAt(t);
      if (at === null) continue;
      if (at > now) {
        next = Math.min(next, at);
        continue;
      }
      if (eligible(t, view, now)) due.push(t);
    }
    due.sort(
      (a, b) => Number(b.key === focusedKey) - Number(a.key === focusedKey) || area(b) - area(a),
    );
    const targets: string[] = [];
    for (const t of due) {
      if (targets.length >= Math.min(tune.maxMatchesPerStill, Math.floor(tokens))) break;
      // Faces other than the one pointed at only while half the budget is left.
      if (t.key !== focusedKey && tokens < tune.burst / 2) continue;
      targets.push(t.key);
    }
    if (targets.length === 0) {
      wake(next);
      return;
    }
    void runJob(targets, now);
  }

  // ---- one job ---------------------------------------------------------------------------

  async function runJob(keys: readonly string[], startedAt: number): Promise<void> {
    inFlight = true;
    lastCallAt = startedAt;
    const myEpoch = epoch;
    const stillCurrent = () => epoch === myEpoch;
    const gens = new Map<string, number>();
    const before = new Map<string, TrackStatus>();
    for (const key of keys) {
      const t = findTrack(key);
      if (!t) continue;
      gens.set(key, t.firstSeenMs);
      before.set(key, t.status);
      setStatus(
        key,
        t.status.kind === 'known' ? { ...t.status, refreshing: true } : { kind: 'checking' },
      );
    }
    emit();

    const outcomes = new Map<string, Outcome>();
    const requests: [string, LiveFaceMatchRequest][] = [];
    try {
      // 1. Photo, faces, embeddings. The photo is closed and deleted before any network call.
      let url: string | null = null;
      let still: FaceStill | null = null;
      try {
        url = await deps.captureStill();
        if (!stillCurrent()) return;
        // Where the faces were when the photo was taken.
        const atCapture = tracks;
        still = await deps.embedder.open(url);
        if (!stillCurrent()) return;
        const pairs = associate(still.faces, still, atCapture, view);
        for (const key of gens.keys()) {
          const face: DetectedFace | undefined = pairs.get(key);
          if (!face) {
            outcomes.set(key, { kind: 'missed' });
            continue;
          }
          if (face.bounds.width / still.width < MIN_SCAN_FACE_SHARE) {
            outcomes.set(key, { kind: 'too_far' });
            continue;
          }
          const embedding = await still.embed(face);
          try {
            requests.push([key, buildFaceMatchRequest(embedding, face, deps.now(), 'live')]);
          } finally {
            embedding.fill(0);
          }
          if (!stillCurrent()) return;
        }
      } catch (e) {
        for (const key of gens.keys()) {
          if (!outcomes.has(key)) outcomes.set(key, { kind: 'error', error: e });
        }
        requests.length = 0;
      } finally {
        still?.close();
        if (url !== null) deps.deletePhoto(url);
      }

      // 2. One match call per face, one at a time.
      let halted: Outcome | null = null;
      for (const [key, req] of requests) {
        if (!stillCurrent()) return;
        if (halted) {
          outcomes.set(key, halted.kind === 'not_in_room' ? halted : { kind: 'skip' });
          continue;
        }
        refill(deps.now());
        if (tokens < 1) {
          outcomes.set(key, { kind: 'skip' });
          continue;
        }
        tokens -= 1;
        try {
          const res = await deps.faceMatch(req);
          const m = res.match;
          outcomes.set(
            key,
            m
              ? {
                  kind: 'match',
                  match: {
                    ...scanMatchOf(m),
                    stats: statsOf(m.head_to_head),
                    matchedAtMs: deps.now(),
                  },
                }
              : { kind: 'none' },
          );
        } catch (e) {
          const code = codeOf(e);
          if (code === 'RATE_LIMITED') {
            const base =
              bucketOf(e) === 'face-match/in-flight' ? IN_FLIGHT_PAUSE_MS : tune.pauseOn429Ms;
            if (stillCurrent()) {
              pauseUntil = deps.now() + Math.max(base, retryAfterMsOf(e) ?? 0);
            }
            halted = { kind: 'rate' };
            outcomes.set(key, halted);
          } else if (code === 'NOT_IN_ROOM' || code === 'ROOM_EXPIRED') {
            if (stillCurrent()) notInRoom = true;
            halted = { kind: 'not_in_room' };
            outcomes.set(key, halted);
          } else {
            outcomes.set(key, { kind: 'error', error: e });
          }
        }
      }
      if (!stillCurrent()) return;

      // 3. Each answer to its track, if that face is still the one in view.
      const now = deps.now();
      for (const [key, gen] of gens) {
        const t = findTrack(key);
        const prev = before.get(key) ?? { kind: 'pending' };
        const outcome = outcomes.get(key) ?? { kind: 'skip' };
        if (!t || t.firstSeenMs !== gen) {
          resolveWaiters(key, 'no_face');
          continue;
        }
        apply(t, prev, outcome, now);
      }
    } finally {
      inFlight = false;
      if (stillCurrent()) emit();
      pump();
    }
  }

  /** The status before the job, put back (a known face stops "refreshing"). */
  const revert = (prev: TrackStatus): TrackStatus =>
    prev.kind === 'known'
      ? { ...prev, refreshing: false }
      : prev.kind === 'checking'
        ? { kind: 'pending' }
        : prev;

  /** Puts the status back and delays the next job for this face by `ms`. */
  const later = (t: Track, prev: TrackStatus, now: number, ms: number) => {
    metaOf(t).notBefore = now + ms;
    const s = revert(prev);
    setStatus(
      t.key,
      (s.kind === 'unknown' || s.kind === 'error') && s.retryAtMs !== null
        ? { ...s, retryAtMs: now + ms }
        : s,
    );
  };

  function apply(t: Track, prev: TrackStatus, o: Outcome, now: number): void {
    const m = metaOf(t);
    switch (o.kind) {
      case 'match':
        m.stale = false;
        m.misses = 0;
        m.notBefore = -Infinity;
        setStatus(t.key, { kind: 'known', match: o.match, refreshing: false });
        resolveWaiters(t.key, o.match);
        return;
      case 'none': {
        // Not in this room, not opted in, or not confident: never named.
        const attempts = (prev.kind === 'unknown' ? prev.attempts : 0) + 1;
        const wait = tune.retryMs[Math.min(attempts - 1, tune.retryMs.length - 1)] ?? 0;
        m.misses = 0;
        setStatus(t.key, {
          kind: 'unknown',
          attempts,
          retryAtMs: attempts >= tune.maxAttempts ? null : now + wait,
        });
        resolveWaiters(t.key, 'no_match');
        return;
      }
      case 'missed':
        m.misses += 1;
        later(
          t,
          prev,
          now,
          m.misses >= MISSES_BEFORE_BACKOFF ? MISSED_BACKOFF_MS : MISSED_RETRY_MS,
        );
        resolveWaiters(t.key, 'no_face');
        return;
      case 'too_far':
        m.misses = 0;
        if (prev.kind === 'pending' || prev.kind === 'checking' || prev.kind === 'too_far') {
          m.notBefore = now + TOO_FAR_RETRY_MS;
          setStatus(t.key, { kind: 'too_far' });
        } else {
          later(t, prev, now, TOO_FAR_RETRY_MS);
        }
        resolveWaiters(t.key, 'too_far');
        return;
      case 'error': {
        if (prev.kind === 'known') {
          later(t, prev, now, ERROR_RETRY_MS);
        } else {
          const attempts = (prev.kind === 'error' ? prev.attempts : 0) + 1;
          setStatus(t.key, {
            kind: 'error',
            attempts,
            retryAtMs: attempts >= tune.maxAttempts ? null : now + ERROR_RETRY_MS,
          });
        }
        resolveWaiters(t.key, matchErrorMiss(o.error));
        return;
      }
      case 'rate':
      case 'skip':
        setStatus(t.key, revert(prev));
        resolveWaiters(t.key, 'busy');
        return;
      case 'not_in_room':
        setStatus(t.key, revert(prev));
        resolveWaiters(t.key, 'not_in_room');
        return;
    }
  }

  // ---- the API -----------------------------------------------------------------------------

  return {
    ingest(dets, v, atMs) {
      if (!running) return;
      view = v;
      tracks = updateTracks(tracks, dets, atMs, v, seq);
      const live = new Set(tracks.map((t) => t.key));
      for (const key of [...meta.keys()]) if (!live.has(key)) meta.delete(key);
      for (const key of [...waiters.keys()]) if (!live.has(key)) resolveWaiters(key, 'no_face');
      focusedKey = pickFocus(tracks, focusedKey, v, atMs);
      pump();
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    snapshot: () => snap,
    challengeTarget(key) {
      const t = findTrack(key);
      if (!t) return Promise.resolve('no_face');
      const m = metaOf(t);
      if (t.status.kind === 'known' && !m.stale && ticketFresh(t.status.match, deps.now())) {
        return Promise.resolve(t.status.match);
      }
      if (notInRoom) return Promise.resolve('not_in_room');
      if (!running) return Promise.resolve('failed');
      return new Promise<ScanMatch | ScanMiss>((resolve) => {
        let done = false;
        let cancelTimeout: (() => void) | null = null;
        const finish: Waiter = (r) => {
          if (done) return;
          done = true;
          cancelTimeout?.();
          resolve(r);
        };
        waiters.set(key, [...(waiters.get(key) ?? []), finish]);
        cancelTimeout = deps.setTimer(() => {
          const rest = (waiters.get(key) ?? []).filter((w) => w !== finish);
          if (rest.length > 0) waiters.set(key, rest);
          else {
            waiters.delete(key);
            if (priorityKey === key) priorityKey = null;
          }
          finish('failed');
        }, tune.challengeWaitMs);
        if (done) return;
        priorityKey = key;
        pump();
        emit();
      });
    },
    markStale(key) {
      const t = findTrack(key);
      if (!t) return;
      metaOf(t).stale = true;
      pump();
    },
    start() {
      if (running) return;
      running = true;
      started = true;
      notInRoom = false;
      emit();
      pump();
    },
    stop() {
      if (!running) return;
      running = false;
      epoch += 1;
      cancelWake?.();
      cancelWake = null;
      wakeAt = Infinity;
      for (const key of [...waiters.keys()]) resolveWaiters(key, 'failed');
      priorityKey = null;
      tracks = [];
      focusedKey = null;
      meta.clear();
      emit();
    },
  };
}
