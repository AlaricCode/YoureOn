// One round, two phones, one instant (DANCE-OFF §6.2). The server stamps every attempt with
// `go_at` (POST /attempts and attempt.started: the server's clock, GO_DELAY_MS after the start).
// Both phones derive the whole round from it, so they agree to within the clock-sync error:
//
//   go_at                         the count-in starts: "3" on the routine's beat
//   go_at + COUNT_IN_BEATS beats  t0: the recorder's startRound, the reference and the music
//   t0 + duration_ms              the routine ends (the recorder keeps ROUND_TAIL_MS more)
//
// Each phone maps the server instant onto its own monotonic round clock (nowMs, i.e.
// performance.now) through the server-time offset the app already keeps (net/signedFetch Clock:
// offsetMs = server time − Date.now(), synced from the socket's welcome and the session's
// server_time). The recording phone films and scores on that clock; the display phone plays the
// mirrored reference with the music on it.
//
// A recorder that is handed an attempt too late to meet its t0 (an attempt given back by "Dance
// again", one already open when the screen mounted) counts in from now instead, and that run is
// not in sync with the display: it plays its own music and shows its own reference.
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
