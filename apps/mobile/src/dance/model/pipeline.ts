// The live round pipeline (DANCE-OFF §3, §4.6, §6.2): native onPoses frames → the shared
// identity tracker (A = left at round start, or where the face assignment found A: `start`) →
// the shared live scorer (meters, key-move events)
// → the quantized PoseSeries that gets hashed and uploaded. Pure: the screen feeds it frames and
// reads what comes back; tests feed it synthetic frames.
//
// Clocks. Before startRound, a frame's `t` is ms since the camera session started; from the first
// round frame on it is ms since t0. Every frame also carries `ts` (always session ms). Count-in
// frames are buffered by `ts` and, once the first round frame fixes the offset (ts₀ − t₀), land
// in the series at negative t (PoseSeries allows −3000..45000). The tracker runs on `ts`, so its
// velocities never see the clock switch.
//
// Two trackers, so the phone and the server agree on where A and B started (DANCE-OFF §3). The
// count-in can start well before the series window opens (a bet round counts in from go_at,
// GO_DELAY_MS + 3 beats before t0, while the series keeps only t ≥ −3000), and seriesChecks reads
// the starting sides from the series' first frame with both players. So a PREVIEW tracker colours
// the skeletons from the count-in on, and the ROUND tracker, whose A / B go into the series, is
// made when the round clock is known and replays the buffered frames from the window's start:
// its round-start assignment is the series' first frame with both. Left / right (no `start`): A
// is the left one THERE, however the two moved before. Face-identified (`start`): the round
// tracker is seeded with where the preview (itself seeded at the count-in) has A and B on that
// frame, so it follows the identified players.
import {
  dequantizePerson,
  POSE_MAX_FPS,
  POSE_T_MIN_MS,
  type PoseSeries,
} from '@youre-on/shared/dance/pose';
import type { RoutineData } from '@youre-on/shared/dance/routine';
import {
  createLiveScorer,
  scoreRound,
  type DanceRoundResult,
  type LiveScorer,
  type LiveUpdate,
} from '@youre-on/shared/dance/score';
import {
  createTracker,
  hipCenter,
  type Tracker,
  type TrackerStart,
  type TrackerStats,
} from '@youre-on/shared/dance/track';

/** One onPoses payload (modules/dance-pose PoseFrameEvent, already validated). */
export interface PoseInput {
  t: number;
  ts?: number;
  w: number;
  h: number;
  fps: number;
  people: { k: number[] }[];
}

/** Count-in frames older than this before t0 are dropped (PoseSeries t ≥ −3000). */
const PRE_ROLL_MS = -POSE_T_MIN_MS;
/** A frame's t and ts differ by more than this once a round runs (t0 is past ts = 0). */
const ROUND_CLOCK_EPS_MS = 0.5;

/** The min spacing between series frames for a cap (a little jitter allowed under 1000/fps). */
export const minFrameGapMs = (fpsCap: number): number =>
  Math.max(1, Math.floor(1000 / Math.max(1, Math.min(POSE_MAX_FPS, fpsCap))) - 8);

export interface PipelineFrame {
  /** The frame entered the series (false: dropped by the fps cap or before the round). */
  accepted: boolean;
  /** Its series time (ms since t0), null before the round clock is known. */
  t: number | null;
  /** This frame's tracked players (raw floats), null when not seen. */
  a: number[] | null;
  b: number[] | null;
  /** The live scorer's state after this frame (null if the frame did not enter the series). */
  live: LiveUpdate | null;
  /** Live updates from flushed count-in frames plus this one, in order (key events never repeat). */
  updates: LiveUpdate[];
}

export interface RoundPipeline {
  /** Called with startRound: frames whose clock has switched to t0 are round frames from now. */
  beginRound(): void;
  /** Whether the first round frame has arrived. */
  roundStarted(): boolean;
  push(frame: PoseInput): PipelineFrame;
  series(): PoseSeries;
  final(): { series: PoseSeries; result: DanceRoundResult };
  tracking(): TrackerStats | null;
}

interface PreFrame {
  ts: number;
  /** The raw people (the round tracker replays them). */
  people: number[][];
  /** The preview tracker's A and B on this frame (a face-identified round's seed). */
  a: number[] | null;
  b: number[] | null;
}

export function createRoundPipeline(opts: {
  routine: RoutineData;
  syncOffsetMs: number;
  fpsCap?: number;
  /** Face-identified players (model/identity start()); absent: the left / right rule. */
  start?: TrackerStart | null;
}): RoundPipeline {
  const fpsCap = opts.fpsCap ?? POSE_MAX_FPS;
  const gap = minFrameGapMs(fpsCap);
  let scorer: LiveScorer | null = null;
  /** From the first frame: the skeletons' colours until the round tracker takes over. */
  let preview: Tracker | null = null;
  /** The series' tracker, made when the round clock is known. */
  let tracker: Tracker | null = null;
  let size: { w: number; h: number } | null = null;
  let requested = false;
  /** ts − t of the round clock, once the first round frame arrived. */
  let offset: number | null = null;
  let lastT = Number.NEGATIVE_INFINITY;
  let pre: PreFrame[] = [];

  /**
   * The round tracker's seed (see the header): null for left / right; for face-identified
   * players, where the preview has them on the window's first frame with both (else its last
   * spots, else the count-in seed).
   */
  const roundStart = (window: readonly PreFrame[]): TrackerStart | null => {
    if (!opts.start) return null;
    for (const p of window) {
      const ca = p.a ? hipCenter(p.a) : null;
      const cb = p.b ? hipCenter(p.b) : null;
      if (ca && cb) return { a: [ca[0], ca[1]], b: [cb[0], cb[1]] };
    }
    const last = preview?.last();
    if (last?.a && last.b) return { a: last.a, b: last.b };
    return opts.start;
  };

  const ensure = (w: number, h: number) => {
    const next = { w: Math.round(w), h: Math.round(h) };
    if (size && size.w === next.w && size.h === next.h) return;
    // The frames changed shape: the device was turned (upright 720x1280, on its side 1280x720).
    // Before the round that starts everything over at the new size, so the aspect-correct
    // scoring is right. Never mid-round: the native side holds the rotation while it records.
    if (size && (tracker !== null || offset !== null)) return;
    size = next;
    preview = createTracker({ ...size, start: opts.start ?? null });
    scorer = createLiveScorer(opts.routine, {
      syncOffsetMs: opts.syncOffsetMs,
      w: size.w,
      h: size.h,
      fpsCap,
    });
  };

  const add = (t: number, n: number, a: number[] | null, b: number[] | null) => {
    if (!scorer || !size) return null;
    if (t - lastT < gap) return null;
    lastT = t;
    return scorer.push({ t, n, a, b, w: size.w, h: size.h });
  };

  const emptySeries = (): PoseSeries => ({
    schema_version: 1,
    w: size?.w ?? 1,
    h: size?.h ?? 1,
    fps_cap: Math.max(1, Math.min(POSE_MAX_FPS, Math.round(fpsCap))),
    sync_offset_ms: 0,
    frames: [],
  });

  return {
    beginRound() {
      requested = true;
    },
    roundStarted: () => offset !== null,
    push(f) {
      ensure(f.w, f.h);
      const clock = f.ts ?? f.t;
      const people = f.people.map((p) => p.k);
      const isRound =
        requested && (offset !== null || f.ts === undefined || f.ts - f.t > ROUND_CLOCK_EPS_MS);
      if (!isRound) {
        const tracked = preview!.push(clock, people);
        // The same arrays as in `people` (the overlay tells A / B from the rest by identity).
        const { a, b } = tracked;
        if (f.ts !== undefined) {
          pre.push({ ts: f.ts, people, a, b });
          const keepFrom = f.ts - PRE_ROLL_MS - 1_000;
          if (pre.length > 0 && pre[0]!.ts < keepFrom) pre = pre.filter((p) => p.ts >= keepFrom);
        }
        return { accepted: false, t: null, a, b, live: null, updates: [] };
      }
      const updates: LiveUpdate[] = [];
      if (offset === null) {
        const off = f.ts !== undefined ? f.ts - f.t : 0;
        offset = off;
        const window = pre
          .map((p) => ({ p, t: Math.round(p.ts - off) }))
          .filter(({ t }) => t >= POSE_T_MIN_MS && t < f.t);
        tracker = createTracker({ ...size!, start: roundStart(window.map(({ p }) => p)) });
        for (const { p, t } of window) {
          const tr = tracker.push(p.ts, p.people);
          const u = add(t, tr.n, tr.a, tr.b);
          if (u) updates.push(u);
        }
        pre = [];
      }
      const tracked = tracker!.push(clock, people);
      const { a, b } = tracked;
      const t = Math.round(f.t);
      const live = add(t, tracked.n, a, b);
      if (live) updates.push(live);
      return { accepted: live !== null, t, a, b, live, updates };
    },
    series: () => (scorer ? scorer.series() : emptySeries()),
    final() {
      if (scorer) return scorer.final();
      const series = emptySeries();
      return { series, result: scoreRound(opts.routine, series) };
    },
    tracking: () => (tracker ?? preview)?.stats() ?? null,
  };
}

/** A series' frames as live-scorer input (dequantized), for replaying a saved session. */
export function replayInputs(
  series: PoseSeries,
): { t: number; n: number; a: number[] | null; b: number[] | null; w: number; h: number }[] {
  return series.frames.map((f) => ({
    t: f.t,
    n: f.n,
    a: f.a ? dequantizePerson(f.a) : null,
    b: f.b ? dequantizePerson(f.b) : null,
    w: series.w,
    h: series.h,
  }));
}

/**
 * The self test (DANCE-OFF §8 `selftest`, on the phone): both players ARE the reference, so each
 * must score exactly 100.0 under `identity`.
 */
export function selfTestSeries(routine: RoutineData): PoseSeries {
  const first = routine.frames[0];
  const last = routine.frames[routine.frames.length - 1];
  const span = first && last && last.t > first.t ? last.t - first.t : 1;
  const fps = Math.round(((routine.frames.length - 1) * 1000) / Math.max(1, span));
  return {
    schema_version: 1,
    w: routine.w,
    h: routine.h,
    fps_cap: Math.max(1, Math.min(POSE_MAX_FPS, fps)),
    sync_offset_ms: 0,
    frames: routine.frames.map((f) => ({ t: f.t, n: 2, a: [...f.k], b: [...f.k] })),
  };
}

/** The sync offsets the calibration sweep tries (ms). */
export const SYNC_SWEEP_MS: readonly number[] = [
  -300, -200, -150, -100, -50, 0, 50, 100, 150, 200, 300,
];

/**
 * Re-scores a saved round at each sync offset (the series keeps its raw times; the scorer
 * subtracts the offset), so the calibration screen can show which offset this display needs.
 */
export function sweepSyncOffsets(
  routine: RoutineData,
  series: PoseSeries,
  offsets: readonly number[] = SYNC_SWEEP_MS,
): { offsetMs: number; a: number; b: number }[] {
  return offsets.map((o) => {
    const r = scoreRound(routine, { ...series, sync_offset_ms: o });
    return { offsetMs: o, a: r.a.score_x10, b: r.b.score_x10 };
  });
}

/** The sweep row with the best combined score (the smallest |offset| on a tie). */
export function bestSyncOffset(
  rows: readonly { offsetMs: number; a: number; b: number }[],
): number | null {
  let best: { offsetMs: number; a: number; b: number } | null = null;
  for (const r of rows) {
    if (
      best === null ||
      r.a + r.b > best.a + best.b ||
      (r.a + r.b === best.a + best.b && Math.abs(r.offsetMs) < Math.abs(best.offsetMs))
    )
      best = r;
  }
  return best ? best.offsetMs : null;
}
