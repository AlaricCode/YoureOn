// The live rivalry scan without a camera (pure): a scripted pan across a row of people, plus
// fake camera, embedder and server that answer for them, so the REAL engine and the REAL overlay
// run end to end in the offline preview and in tests.
//
//   Jake    4-7, −$7.00, lost the last one, rivals
//   Priya   3-0, +$9.00, won 3 straight, rivals
//   Sam     0-0, first bet
//   (a stranger, never matched)
//
// The pan holds on Jake (~0.8-3.6 s), Priya (~4.4-7.2 s) and Sam (~8.0-10.6 s), passing the
// stranger, then leaves everyone (empty from ~11 s; 12 s loop). Each pass gets new tracking ids,
// as ML Kit does when a face re-enters the frame. Suggested frames: 2500 (Jake), 6500 (Priya: streak, rivals),
// 9500 (Sam: first bet, plus the stranger's ring).
import { bytesToEmbedding, FaceMatchResponse } from '@youre-on/shared/face';

import type { LiveScanDeps } from '../app/liveScan';
import type { FaceEmbedder } from '../enroll/embedder';
import type { DetectedFace } from '../enroll/flow';
import { FACE_MODEL } from '../face/model';
import { viewBoxToStill } from './geometry';
import type { LiveFaceMatchRequest, RawDetection, Size } from './types';

/** The head-to-head the fake server returns (the full wire shape, rivalry fields included). */
export interface PreviewH2H {
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly net: string;
  readonly net_display: string;
  readonly last_settled_at: string | null;
  readonly includes_seed: boolean;
  readonly total: number;
  readonly last_result: 'win' | 'loss' | 'push' | null;
  readonly streak: { readonly holder: 'me' | 'them'; readonly length: number } | null;
  readonly rival: boolean;
}

export interface PreviewPerson {
  readonly user_id: string;
  readonly display_name: string;
  /** null: a stranger (not in the room, or not opted in): never matched. */
  readonly h2h: PreviewH2H | null;
}

export const PREVIEW_PEOPLE: readonly PreviewPerson[] = [
  {
    user_id: '00000000-0000-4000-8000-00000000000b',
    display_name: 'Jake',
    h2h: {
      wins: 4,
      losses: 7,
      pushes: 0,
      net: '-7000000',
      net_display: '−$7.00',
      last_settled_at: '2026-11-17T21:00:00.000Z',
      includes_seed: true,
      total: 11,
      last_result: 'loss',
      streak: { holder: 'them', length: 1 },
      rival: true,
    },
  },
  {
    user_id: '00000000-0000-4000-8000-00000000000c',
    display_name: 'Priya',
    h2h: {
      wins: 3,
      losses: 0,
      pushes: 0,
      net: '9000000',
      net_display: '+$9.00',
      last_settled_at: '2026-11-18T01:30:00.000Z',
      includes_seed: false,
      total: 3,
      last_result: 'win',
      streak: { holder: 'me', length: 3 },
      rival: true,
    },
  },
  {
    user_id: '00000000-0000-4000-8000-00000000000d',
    display_name: 'Sam',
    h2h: {
      wins: 0,
      losses: 0,
      pushes: 0,
      net: '0',
      net_display: '$0',
      last_settled_at: null,
      includes_seed: false,
      total: 0,
      last_result: null,
      streak: null,
      rival: false,
    },
  },
  { user_id: '00000000-0000-4000-8000-00000000000e', display_name: 'Stranger', h2h: null },
];

/** Left to right: Jake, Priya, the stranger, Sam (indexes into PREVIEW_PEOPLE). */
export const PREVIEW_ROW: readonly number[] = [0, 1, 3, 2];
export const PREVIEW_LOOP_MS = 12_000;
/** The fake server's answer time. */
export const PREVIEW_LATENCY_MS = 600;
/** The fake photo (an upright 3:4 still, like the embedder's). */
export const PREVIEW_STILL: Size = { width: 960, height: 1280 };

/** [seconds into the loop, row position at the view's centre]; eased in between. */
const PAN: readonly (readonly [number, number])[] = [
  [0, -1.6],
  [0.8, 0],
  [3.6, 0],
  [4.4, 1],
  [7.2, 1],
  [8.0, 3],
  [10.6, 3],
  [11.3, 5],
  [12, 5],
];

const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));

/** The row position at the view's centre, `s` seconds into the loop. */
export function panPosition(s: number): number {
  for (let i = 1; i < PAN.length; i++) {
    const [t1, p1] = PAN[i] as readonly [number, number];
    const [t0, p0] = PAN[i - 1] as readonly [number, number];
    if (s <= t1) return p0 + (p1 - p0) * ease((s - t0) / (t1 - t0));
  }
  return (PAN[PAN.length - 1] as readonly [number, number])[1];
}

/** Spacing between people, face width, as shares of the view width. */
const SLOT = 0.4;
const FACE_W = 0.26;
const FACE_ASPECT = 1.3;
const ROW_Y = [0.44, 0.41, 0.46, 0.43];

export interface PreviewDetection extends RawDetection {
  readonly trackingId: number;
  /** Index into PREVIEW_PEOPLE. */
  readonly person: number;
}

/**
 * The faces the detector would report `tMs` into the preview (view coordinates): those at
 * least 60% inside the view. `loopMs` stretches or squeezes the 12 s script.
 */
export function panDetections(
  tMs: number,
  view: Size,
  loopMs: number = PREVIEW_LOOP_MS,
): PreviewDetection[] {
  const t = Math.max(0, tMs);
  const pass = Math.floor(t / loopMs);
  const s = ((t - pass * loopMs) / loopMs) * (PREVIEW_LOOP_MS / 1000);
  const p = panPosition(s);
  const w = FACE_W * view.width;
  const h = w * FACE_ASPECT;
  const out: PreviewDetection[] = [];
  PREVIEW_ROW.forEach((person, r) => {
    // A little hand shake, well under the tracker's stability drift.
    const shakeX = 0.006 * view.width * Math.sin(t / 270 + r);
    const shakeY = 0.004 * view.height * Math.sin(t / 340 + 2 * r);
    const cx = view.width / 2 + (r - p) * SLOT * view.width + shakeX;
    const cy = (ROW_Y[r] ?? 0.44) * view.height + shakeY;
    const x = cx - w / 2;
    const inside = Math.min(x + w, view.width) - Math.max(x, 0);
    if (inside < 0.6 * w) return;
    out.push({
      trackingId: pass * 10 + r + 1,
      person,
      bounds: { x, y: cy - h / 2, width: w, height: h },
      yawAngle: 6 * Math.sin(t / 900 + r),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// A fake clock (deterministic frames and tests)
// ---------------------------------------------------------------------------------------

export interface FakeClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  /** Moves time to `t`, running due timers in order (synchronously). */
  advanceTo(t: number): void;
}

export function createFakeClock(start = 0): FakeClock {
  let now = start;
  let seq = 0;
  const timers: { at: number; seq: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer(fn, ms) {
      const timer = { at: now + Math.max(0, ms), seq: seq++, fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    advanceTo(t) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers[0];
        if (!next || next.at > t) break;
        timers.shift();
        now = Math.max(now, next.at);
        next.fn();
      }
      now = Math.max(now, t);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Fake camera, embedder and server
// ---------------------------------------------------------------------------------------

export interface PreviewTiming {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

const realTiming: PreviewTiming = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

const STILL_URL = /^preview:\/\/(-?\d+(?:\.\d+)?)$/;

function decodeProbe(ct: string): Float32Array {
  const bin = atob(ct);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytesToEmbedding(bytes);
}

type PreviewFace = DetectedFace & { readonly person: number };

/**
 * Deps for createLiveScanEngine that play the script: the "photo" is `preview://<t>`; opening it
 * puts the script's faces at `t - startMs` into a 960x1280 still; a face's "embedding" is one-hot
 * on its person; the "server" answers that person's record (or {match: null} for the stranger)
 * after PREVIEW_LATENCY_MS. `startMs` is the clock time the script starts at.
 */
export function createPreviewLiveDeps(
  view: Size,
  opts: {
    timing?: PreviewTiming;
    startMs?: number;
    loopMs?: number;
    latencyMs?: number;
    people?: readonly PreviewPerson[];
  } = {},
): LiveScanDeps & { readonly deleted: string[] } {
  const timing = opts.timing ?? realTiming;
  const start = opts.startMs ?? timing.now();
  const loopMs = opts.loopMs ?? PREVIEW_LOOP_MS;
  const latency = opts.latencyMs ?? PREVIEW_LATENCY_MS;
  const people = opts.people ?? PREVIEW_PEOPLE;
  const deleted: string[] = [];

  const embedder: FaceEmbedder = {
    preview: true,
    async open(url) {
      const m = STILL_URL.exec(url);
      if (!m) throw new Error(`not a preview photo: ${url}`);
      const faces: PreviewFace[] = panDetections(Number(m[1]) - start, view, loopMs).map((d) => ({
        person: d.person,
        bounds: viewBoxToStill(d.bounds, PREVIEW_STILL, view),
        yawAngle: d.yawAngle,
        pitchAngle: 0,
        frameWidth: PREVIEW_STILL.width,
        frameHeight: PREVIEW_STILL.height,
      }));
      return {
        faces,
        width: PREVIEW_STILL.width,
        height: PREVIEW_STILL.height,
        async embed(face) {
          const v = new Float32Array(FACE_MODEL.dim);
          v[(face as Partial<PreviewFace>).person ?? 0] = 1;
          return v;
        },
        close() {},
      };
    },
  };

  return {
    deleted,
    embedder,
    now: timing.now,
    setTimer: timing.setTimer,
    captureStill: async () => `preview://${timing.now()}`,
    deletePhoto: (url) => {
      deleted.push(url);
    },
    faceMatch(req: LiveFaceMatchRequest) {
      const v = decodeProbe(req.probe.ct_b64);
      let best = 0;
      for (let i = 1; i < v.length; i++) if ((v[i] ?? 0) > (v[best] ?? 0)) best = i;
      const person = people[best];
      return new Promise<FaceMatchResponse>((resolve) => {
        timing.setTimer(() => {
          const now = timing.now();
          // Parsed like a real reply (brands the pubkey; drops what an older contract lacks).
          resolve(
            FaceMatchResponse.parse(
              person?.h2h
                ? {
                    match: {
                      user: {
                        user_id: person.user_id,
                        pubkey: '11111111111111111111111111111111',
                        display_name: person.display_name,
                        avatar_url: null,
                      },
                      match_ticket: `preview.${best}.${now}`,
                      ticket_expires_at: new Date(now + 60_000).toISOString(),
                      head_to_head: person.h2h,
                    },
                  }
                : { match: null },
            ),
          );
        }, latency);
      });
    },
  };
}

/** Lets pending promise callbacks run (a job awaits a handful of times per step). */
export async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** The detector's frame interval in the preview (15 Hz). */
export const PREVIEW_FRAME_MS = 66;

/**
 * Plays the script into `engine` from `fromMs` to `toMs` (script time) on a fake clock: a
 * detector frame every PREVIEW_FRAME_MS, timers run in order, promises flushed between frames.
 * The clock must be the one the engine's deps use, with the script starting at clock 0.
 */
export async function simulateTo(
  engine: { ingest(d: readonly RawDetection[], v: Size, at: number): void },
  clock: FakeClock,
  view: Size,
  toMs: number,
  opts: { fromMs?: number; loopMs?: number } = {},
): Promise<void> {
  for (let t = opts.fromMs ?? clock.now(); t <= toMs; t += PREVIEW_FRAME_MS) {
    clock.advanceTo(t);
    await flushMicrotasks();
    engine.ingest(panDetections(t, view, opts.loopMs), view, t);
    await flushMicrotasks();
  }
  clock.advanceTo(toMs);
  await flushMicrotasks();
}
