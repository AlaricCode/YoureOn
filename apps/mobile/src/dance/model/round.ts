// The Dance Off round on the judge-cam phone (DANCE-OFF §6.2), as a pure state machine:
//
//   framing → ready → starting → countIn → dancing → scoring → result → uploading → submitted
//                                                                 ↘ failed (retry / dance again)
//
// - framing / ready: the framing check (shared dance/track framingCheck) must pass continuously
//   for FRAMING_STABLE_MS before Start is enabled. A dropout shorter than FRAMING_GRACE_MS (one
//   Vision frame losing an ankle) does not restart the timer.
// - starting: Start was pressed; the screen POSTs /attempts and waits for the attempt.
// - countIn: 3 beats of the routine's tempo; GO (t0) is the instant after the third beat. A bet
//   round counts in from the attempt's go_at (./schedule: t0 = go_at + 3 beats, the same instant
//   the display phone uses), so the phase starts a little before its first beat.
// - dancing: the routine's duration plus ROUND_TAIL_MS (so the last key-move windows close).
// - scoring: stopRound + the local final score. result: shown with no network so far.
// A camera error mid-round does not abort: the round runs out, and the scorer marks it failed
// (the "too close to call" refund path). Only a round that never started (startRound refused)
// or one with no key frames to upload ends in `failed`.
//
// Times are ms on one monotonic clock the screen owns (performance.now). No React here.
import type { FramingReason } from '@youre-on/shared/dance/track';
import type { RoutineData } from '@youre-on/shared/dance/routine';

/** Framing must pass this long, continuously, before Start is enabled (DANCE-OFF §6.2). */
export const FRAMING_STABLE_MS = 1_000;
/**
 * Once the framing has held (the round is `ready`), the round starts by itself after this much
 * longer, with both dancers in position the whole time: a countdown they can see from where
 * they stand. Leaving the frame drops the round back to `framing` and the count starts over.
 * Starting the moment the framing held (as it did at first) began a round while the players were
 * still at the phone, and left no time for the faces to say who is who.
 */
export const AUTO_START_MS = 5_000;
/** A framing dropout shorter than this is jitter, not a break. */
export const FRAMING_GRACE_MS = 250;
/** Recording keeps going this long past the routine, so the last key-move window closes. */
export const ROUND_TAIL_MS = 600;
/** Start pressed, no attempt from the server after this long: give up. */
export const ATTEMPT_WAIT_MS = 12_000;
/** The count-in: "3, 2, 1" on the routine's beat, then GO. */
export const COUNT_IN_BEATS = 3;
/** Key frames the phone uploads (DANCE-OFF §5: `frame` × 4). */
export const SNAPSHOT_COUNT = 4;
/** How long after a key move's beat its snapshot is taken (players land the pose a touch late). */
export const SNAPSHOT_LAG_MS = 150;
/** "GO" stays up this long after t0. */
export const GO_LABEL_MS = 700;

export type RoundPhase =
  | 'framing'
  | 'ready'
  | 'starting'
  | 'countIn'
  | 'dancing'
  | 'scoring'
  | 'result'
  | 'uploading'
  | 'submitted'
  | 'failed';

export type RoundError =
  /** POST /attempts was refused. */
  | 'start_failed'
  /** The attempt never arrived. */
  | 'no_attempt'
  /** startRound refused (the camera was not running). */
  | 'camera'
  /** The round produced no key frame to upload. */
  | 'no_frames'
  | 'upload_failed';

export interface RoundState {
  phase: RoundPhase;
  /** The last framing verdict (null before the first camera frame). */
  framingReason: FramingReason | null;
  /** Since when framing has passed (null while it is not passing). */
  okSince: number | null;
  /** The last frame that passed. */
  lastOkAt: number | null;
  /** When Start was pressed. */
  startedAt: number | null;
  attemptNo: number | null;
  countInAt: number | null;
  /** t0: the GO instant (countInAt + COUNT_IN_BEATS beats). */
  goAt: number | null;
  /** When recording stopped. */
  stopAt: number | null;
  error: RoundError | null;
  /** A technical detail for logs / the debug overlay (never shown as copy). */
  message: string | null;
  /** Bumped on every new round, so per-round resources can key on it. */
  run: number;
  /** A failed upload keeps its bundle: "Try again" re-sends it. */
  canRetryUpload: boolean;
}

export interface RoundConfig {
  beatMs: number;
  durationMs: number;
}

export type RoundEvent =
  | { type: 'framing'; at: number; ok: boolean; reason: FramingReason }
  | { type: 'tick'; at: number }
  /** `force`: start from framing too (the calibration screen: one dancer never frames as two). */
  | { type: 'start'; at: number; force?: boolean }
  /**
   * The attempt is open: count in. `force`: from framing / ready too, for an attempt another
   * phone started (A pressed Start; the server named this judge cam as the recorder).
   * `countInAt`: the count-in's first beat (the attempt's go_at on this clock, ./schedule
   * recorderCountIn); `at` when absent.
   */
  | { type: 'attempt'; at: number; attemptNo: number; force?: boolean; countInAt?: number }
  | { type: 'start_failed'; message: string }
  | { type: 'round_failed'; message: string }
  | { type: 'scored'; ok: true }
  | { type: 'scored'; ok: false; message: string }
  | { type: 'upload' }
  | { type: 'uploaded' }
  | { type: 'upload_failed'; message: string }
  | { type: 'reset' };

export function initialRound(run = 0): RoundState {
  return {
    phase: 'framing',
    framingReason: null,
    okSince: null,
    lastOkAt: null,
    startedAt: null,
    attemptNo: null,
    countInAt: null,
    goAt: null,
    stopAt: null,
    error: null,
    message: null,
    run,
    canRetryUpload: false,
  };
}

export const roundConfig = (r: Pick<RoutineData, 'bpm' | 'duration_ms'>): RoundConfig => ({
  beatMs: 60_000 / r.bpm,
  durationMs: r.duration_ms,
});

const framingPhase = (p: RoundPhase): boolean => p === 'framing' || p === 'ready';

/** The camera is live and the pose pipeline should run (frames feed the framing or the round). */
export const cameraWanted = (p: RoundPhase): boolean =>
  p !== 'result' && p !== 'uploading' && p !== 'submitted';

/** Frames feed the round's series (count-in frames too: they land at negative t). */
export const recordingPhase = (p: RoundPhase): boolean => p === 'countIn' || p === 'dancing';

function fail(s: RoundState, error: RoundError, message: string | null): RoundState {
  return { ...s, phase: 'failed', error, message, canRetryUpload: error === 'upload_failed' };
}

/** Framing timers on a frame or a tick (framing / ready only). */
function framingTimers(s: RoundState, at: number): RoundState {
  let next = s;
  if (next.lastOkAt !== null && at - next.lastOkAt > FRAMING_GRACE_MS) {
    next = { ...next, okSince: null, lastOkAt: null };
  }
  const stable = next.okSince !== null && at - next.okSince >= FRAMING_STABLE_MS;
  const phase: RoundPhase = stable ? 'ready' : 'framing';
  return phase === next.phase ? next : { ...next, phase };
}

/**
 * The screen's attempt prop changed (or the phase did): count in on it? After this phone's own
 * Start (`waiting`), on any attempt not used yet. While framing, only on a NEW one (another
 * phone started it and the server named this device the recorder), forced past the framing
 * check. An attempt already open when the screen mounted waits for Start.
 */
export function attemptCountIn(p: {
  phase: RoundPhase;
  /** First time this screen sees this attempt number. */
  fresh: boolean;
  /** This screen already counted in on it. */
  used: boolean;
  /** Start was pressed and POST /attempts is out. */
  waiting: boolean;
}): 'count_in' | 'forced' | null {
  if (p.used) return null;
  if (p.phase === 'starting') return p.waiting ? 'count_in' : null;
  return p.fresh && framingPhase(p.phase) ? 'forced' : null;
}

export function roundReducer(s: RoundState, e: RoundEvent, cfg: RoundConfig): RoundState {
  switch (e.type) {
    case 'framing': {
      if (!framingPhase(s.phase)) return s;
      const next: RoundState = e.ok
        ? { ...s, framingReason: e.reason, okSince: s.okSince ?? e.at, lastOkAt: e.at }
        : { ...s, framingReason: e.reason };
      return framingTimers(next, e.at);
    }
    case 'tick': {
      if (framingPhase(s.phase)) return framingTimers(s, e.at);
      if (s.phase === 'starting') {
        if (s.startedAt !== null && e.at - s.startedAt > ATTEMPT_WAIT_MS)
          return fail(s, 'no_attempt', 'no attempt from the server');
        return s;
      }
      if (s.phase === 'countIn' && s.goAt !== null && e.at >= s.goAt) {
        return { ...s, phase: 'dancing' };
      }
      if (s.phase === 'dancing' && s.goAt !== null) {
        if (e.at >= s.goAt + cfg.durationMs + ROUND_TAIL_MS)
          return { ...s, phase: 'scoring', stopAt: e.at };
      }
      return s;
    }
    case 'start':
      if (s.phase !== 'ready' && !(e.force === true && s.phase === 'framing')) return s;
      return { ...s, phase: 'starting', startedAt: e.at, error: null, message: null };
    case 'attempt': {
      if (s.phase !== 'starting' && !(e.force === true && framingPhase(s.phase))) return s;
      const countInAt = e.countInAt ?? e.at;
      return {
        ...s,
        phase: 'countIn',
        startedAt: s.startedAt ?? e.at,
        attemptNo: e.attemptNo,
        countInAt,
        goAt: countInAt + COUNT_IN_BEATS * cfg.beatMs,
      };
    }
    case 'start_failed':
      if (s.phase !== 'starting') return s;
      return fail(s, 'start_failed', e.message);
    case 'round_failed':
      if (s.phase !== 'dancing' && s.phase !== 'countIn') return s;
      return fail(s, 'camera', e.message);
    case 'scored':
      if (s.phase !== 'scoring') return s;
      return e.ok ? { ...s, phase: 'result' } : fail(s, 'no_frames', e.message);
    case 'upload':
      if (s.phase === 'result' || (s.phase === 'failed' && s.canRetryUpload))
        return { ...s, phase: 'uploading', error: null, message: null };
      return s;
    case 'uploaded':
      return s.phase === 'uploading' ? { ...s, phase: 'submitted' } : s;
    case 'upload_failed':
      return s.phase === 'uploading' ? fail(s, 'upload_failed', e.message) : s;
    case 'reset':
      return initialRound(s.run + 1);
  }
}

// ---- schedules ------------------------------------------------------------------------------

export interface CountInBeat {
  at: number;
  label: '3' | '2' | '1';
}

/** The count-in beats from `countInAt`, and GO (= t0) one beat after the last. */
export function countInSchedule(
  countInAt: number,
  beatMs: number,
): { beats: CountInBeat[]; goAt: number } {
  const labels = ['3', '2', '1'] as const;
  const beats = labels.slice(0, COUNT_IN_BEATS).map((label, i) => ({
    at: countInAt + i * beatMs,
    label,
  }));
  return { beats, goAt: countInAt + COUNT_IN_BEATS * beatMs };
}

/**
 * What the big numeral shows at `now`: nothing before the count-in's first beat (the wait for
 * go_at), 3 / 2 / 1 during the count-in, GO just after t0.
 */
export function countInLabel(
  s: Pick<RoundState, 'phase' | 'countInAt' | 'goAt'>,
  now: number,
  beatMs: number,
): '3' | '2' | '1' | 'GO' | null {
  if (s.phase === 'countIn' && s.countInAt !== null) {
    const i = Math.floor((now - s.countInAt) / beatMs);
    if (i < 0) return null;
    if (i >= COUNT_IN_BEATS) return 'GO';
    return (['3', '2', '1'] as const)[i] ?? null;
  }
  if (s.phase === 'dancing' && s.goAt !== null && now - s.goAt < GO_LABEL_MS) return 'GO';
  return null;
}

/** Index of the count-in beat at `now` (0..2), or −1 before it. */
export function countInBeatIndex(countInAt: number, now: number, beatMs: number): number {
  if (now < countInAt) return -1;
  return Math.min(COUNT_IN_BEATS - 1, Math.floor((now - countInAt) / beatMs));
}

/** The routine's beats, ms since t0, from first_beat_ms to the end of the routine. */
export function routineBeatTimes(r: Pick<RoutineData, 'bpm' | 'first_beat_ms' | 'duration_ms'>) {
  const beat = 60_000 / r.bpm;
  const out: number[] = [];
  for (let t = r.first_beat_ms; t <= r.duration_ms + 1e-6; t += beat) out.push(Math.round(t));
  return out;
}

/** The beat at elapsed ms since t0: its index and how long ago it hit (null before the first). */
export function beatAt(
  r: Pick<RoutineData, 'bpm' | 'first_beat_ms' | 'duration_ms'>,
  elapsedMs: number,
): { index: number; sinceMs: number } | null {
  if (elapsedMs < r.first_beat_ms || elapsedMs > r.duration_ms) return null;
  const beat = 60_000 / r.bpm;
  const index = Math.floor((elapsedMs - r.first_beat_ms) / beat);
  return { index, sinceMs: elapsedMs - (r.first_beat_ms + index * beat) };
}

/**
 * When the native view keeps a JPEG (ms since t0): SNAPSHOT_COUNT key moves spread over the
 * routine (each a touch after its beat), or evenly spread times when the routine has too few.
 * Sorted, distinct, inside [0, duration).
 */
export function snapshotSchedule(
  r: Pick<RoutineData, 'key_moves' | 'duration_ms'>,
  count = SNAPSHOT_COUNT,
): number[] {
  const n = r.key_moves.length;
  const last = r.duration_ms - 1;
  const clampT = (t: number) => Math.max(0, Math.min(last, Math.round(t)));
  let times: number[];
  if (n >= count) {
    times = Array.from({ length: count }, (_, i) => {
      const k = Math.min(n - 1, Math.floor(((i + 0.5) * n) / count));
      return clampT(r.key_moves[k]!.t + SNAPSHOT_LAG_MS);
    });
  } else {
    times = Array.from({ length: count }, (_, i) => clampT(((i + 0.5) * r.duration_ms) / count));
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

/**
 * The auto-start count while the round is `ready`: ms left until it starts by itself (0 when it
 * is due), or null when it is not counting (not ready). `okSince` is when the framing began to
 * hold, so the count runs from FRAMING_STABLE_MS after it.
 */
export function autoStartLeftMs(
  s: Pick<RoundState, 'phase' | 'okSince'>,
  now: number,
): number | null {
  if (s.phase !== 'ready' || s.okSince === null) return null;
  return Math.max(0, s.okSince + FRAMING_STABLE_MS + AUTO_START_MS - now);
}

/** The numeral the count shows ("5" to "1"); null when not counting or already due. */
export function autoStartNumeral(leftMs: number | null): number | null {
  if (leftMs === null || leftMs <= 0) return null;
  return Math.ceil(leftMs / 1000);
}

/** 0..1 of the framing hold before Start is enabled. */
export function framingProgress(s: Pick<RoundState, 'phase' | 'okSince'>, now: number): number {
  if (s.phase === 'ready') return 1;
  if (s.phase !== 'framing' || s.okSince === null) return 0;
  return Math.max(0, Math.min(1, (now - s.okSince) / FRAMING_STABLE_MS));
}

/** 0..1 through the routine (dancing only). */
export function danceProgress(
  s: Pick<RoundState, 'phase' | 'goAt'>,
  now: number,
  durationMs: number,
): number {
  if (s.phase !== 'dancing' || s.goAt === null) return s.phase === 'scoring' ? 1 : 0;
  return Math.max(0, Math.min(1, (now - s.goAt) / durationMs));
}
