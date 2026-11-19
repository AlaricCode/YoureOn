// One round, two phones, one instant (DANCE-OFF §6.2). The server stamps every attempt with
// `go_at` (POST /attempts and attempt.started: the server's clock, GO_DELAY_MS after the start).
// Both phones derive the whole round from it, so they agree to within the clock-sync error:
//
//   go_at                         the count-in starts: "3" on the routine's beat
//   go_at + COUNT_IN_BEATS beats  t0: the recorder's startRound, the reference and the music
//   t0 + duration_ms              the routine ends (the recorder keeps ROUND_TAIL_MS more)
//
// Each phone maps the server instant onto its own monotonic round clock (nowMs, i.e.
// performance.now) through a server-time offset (server time − Date.now()): the round-trip-
// compensated probe the app takes when it enters a dance screen (app/danceClock, net/clockProbe:
// within rtt / 2), or until it answers the app Clock's (one-way samples: the socket's welcome,
// the session's server_time). The recording phone films and scores on that clock; the display phone plays the
// mirrored reference with the music on it.
//
// A recorder that is handed an attempt too late to meet its t0 (an attempt given back by "Dance
// again", one already open when the screen mounted) counts in from now instead, and that run is
// not in sync with the display: it shows its own reference, and plays its own music once the
// display is done with go_at's timeline (fallbackMutedUntil: never two songs out of step).
// Pure TS: tested in node.
import { COUNT_IN_BEATS } from './round';

/** The clocks read at one moment: the server offset, the wall clock and the round clock. */
export interface ClockReading {
  /** Server time − device wall time (Clock.offsetMs). */
  offsetMs: number;
  /** Date.now() at the reading. */
  wallNow: number;
  /** nowMs() (the monotonic round clock) at the same reading. */
  monoNow: number;
}

/** A server instant (epoch ms) on this phone's round clock (nowMs). */
export const serverToLocalMs = (serverMs: number, c: ClockReading): number =>
  c.monoNow + (serverMs - c.offsetMs - c.wallNow);

/** A server ISO timestamp on this phone's round clock, or null when it does not parse. */
export function serverIsoToLocalMs(iso: string, c: ClockReading): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? serverToLocalMs(t, c) : null;
}

export interface RoundTimeline {
  /** The count-in's first beat ("3"): go_at. */
  countInAt: number;
  /** t0: COUNT_IN_BEATS beats later. */
  goAt: number;
  /** The routine's end: t0 + duration_ms. */
  endAt: number;
}

/** The round on this phone's clock, from go_at (already mapped onto the round clock). */
export const roundTimeline = (
  goAtLocal: number,
  cfg: { beatMs: number; durationMs: number },
): RoundTimeline => {
  const goAt = goAtLocal + COUNT_IN_BEATS * cfg.beatMs;
  return { countInAt: goAtLocal, goAt, endAt: goAt + cfg.durationMs };
};

/**
 * The recorder needs at least this long before t0 to start on it (the count-in state, the GO
 * timer and startRound all run on the JS thread). Later than that, it counts in from now.
 */
export const RECORDER_MIN_LEAD_MS = 150;

/**
 * Where the recorder's count-in starts. On go_at when t0 can still be met (`synced`: both phones
 * run the same timeline); otherwise (no go_at, or too late) from `now` on its own.
 */
export function recorderCountIn(
  goAtLocal: number | null,
  now: number,
  beatMs: number,
): { countInAt: number; synced: boolean } {
  if (goAtLocal !== null && Number.isFinite(goAtLocal)) {
    const t0 = goAtLocal + COUNT_IN_BEATS * beatMs;
    if (t0 - now >= RECORDER_MIN_LEAD_MS) return { countInAt: goAtLocal, synced: true };
  }
  return { countInAt: now, synced: false };
}

export type DisplayPhase =
  /** No attempt yet (LOCKED), or before go_at: the first frame, "Get ready". */
  | 'waiting'
  /** go_at ≤ now < t0: "3, 2, 1" on the beat. */
  | 'countIn'
  /** t0 ≤ now < t0 + duration: the reference plays (GO for its first GO_LABEL_MS). */
  | 'playing'
  /** The routine is over: the recorder is scoring and uploading. */
  | 'done';

/** What the display phone shows at `now` on its round clock. */
export function displayPhase(timeline: RoundTimeline | null, now: number): DisplayPhase {
  if (timeline === null || now < timeline.countInAt) return 'waiting';
  if (now < timeline.goAt) return 'countIn';
  if (now < timeline.endAt) return 'playing';
  return 'done';
}

/**
 * Where a reference clip should be at `now` (seconds into the clip): 0 before t0, then the time
 * since t0 (a display that joins late seeks in, it does not start the routine over).
 */
export const clipPositionSec = (startAt: number, now: number): number =>
  Math.max(0, now - startAt) / 1000;

/** A playing clip further than this from where the clock says it should be is re-seeked. */
export const CLIP_DRIFT_MAX_MS = 150;

/** The clip's drift (ms, + = ahead of the clock), or null before t0 (nothing to correct yet). */
export function clipDriftMs(startAt: number, now: number, clipSec: number): number | null {
  if (now < startAt) return null;
  return clipSec * 1000 - (now - startAt);
}

/** A paused clip this close to its end is left alone (it is finishing, not interrupted). */
export const CLIP_END_SLACK_MS = 250;

/**
 * Where a clip that is NOT playing should be resumed at `now` (seconds), or null to leave it.
 * Inside the round's window [startAt, startAt + duration − slack) a paused clip was interrupted
 * (the app went to the background, a call or Siri took the audio session): it picks up where
 * the round is. Before t0 the start timer plays it; after the end it stays finished.
 */
export function clipResumeSec(startAt: number, now: number, durationMs: number): number | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  if (now < startAt || now >= startAt + durationMs - CLIP_END_SLACK_MS) return null;
  return clipPositionSec(startAt, now);
}

/**
 * A recorder run that could not meet go_at while a display phone is in the room (DANCE-OFF
 * §6.2): the display still plays its own timeline, with its music, until its endAt. The run is
 * silent until then (one song in the room, not two out of step), and plays its own music from
 * then on. Returns the instant (round clock) the run's music may start, or null: no wait.
 */
export function fallbackMutedUntil(p: {
  /** This run is on the go_at timeline (then the display plays the music, nothing to do). */
  synced: boolean;
  displayPhone: boolean;
  /** The attempt's go_at on this phone's round clock, null when unknown. */
  goAtLocal: number | null;
  cfg: { beatMs: number; durationMs: number };
  /** The run's own t0 (its count-in start + the count-in). */
  runT0: number;
}): number | null {
  if (p.synced || !p.displayPhone) return null;
  if (p.goAtLocal === null || !Number.isFinite(p.goAtLocal)) return null;
  const { endAt } = roundTimeline(p.goAtLocal, p.cfg);
  return endAt > p.runT0 ? endAt : null;
}
