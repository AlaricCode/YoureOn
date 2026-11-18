// The phone's slow-mo player, as pure TS (vitest runs it in node; SlowMoPlayer.tsx only renders
// what this decides). The timing itself is shared: slowmoTimeline / clipPlan in
// @youre-on/shared/replay, the same functions the stage plays from.
//
//   loading -> playing -> holding -> ended        "Replay again" -> playing (run + 1)
//      \-> error (fewer than 2 frames loaded, or a clip that failed with no frames to fall back to)
//
// Preload policy: start once every frame has settled (onLoad / onError) with at least 2 loaded,
// or after PRELOAD_TIMEOUT_MS with at least 2 loaded; otherwise error. Frames that failed are
// left out of the sequence; the last frame that loaded is the one held.
import {
  clipPlan,
  SLOWMO_RATE,
  slowmoTimeline,
  type ReplayFrame,
  type ReplayMoment,
  type ReplayResponse,
  type ReplayWhy,
} from '@youre-on/shared/replay';

import { REPLAY_COPY, speedTag, winsChip } from './copy';

export const PRELOAD_TIMEOUT_MS = 4_000;
export const PRELOAD_MIN_FRAMES = 2;
/** A clip that is not ready to play within this long falls back to frames. */
export const CLIP_READY_TIMEOUT_MS = 6_000;
/** A signed clip URL this close to expiry is treated as expired (the fetch would race it). */
export const CLIP_EXPIRY_MARGIN_MS = 5_000;

// ---------------------------------------------------------------------------------------
// Mode: the real clip when there is a live one, else the evidence frames
// ---------------------------------------------------------------------------------------

export type PlayerMode = 'clip' | 'frames';

/** 'clip' for a clip whose signed URL is still good, else 'frames'; null = nothing to play. */
export function chooseMode(m: ReplayMoment, nowMs: number): PlayerMode | null {
  if (m.clip && Date.parse(m.clip.expires_at) - CLIP_EXPIRY_MARGIN_MS > nowMs) return 'clip';
  return m.frames.length > 0 ? 'frames' : null;
}

// ---------------------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------------------

export type PlayerPhase = 'loading' | 'playing' | 'holding' | 'ended' | 'error';

export interface PlayerState {
  readonly phase: PlayerPhase;
  readonly mode: PlayerMode | null;
  /** Per moment.frames index. */
  readonly loaded: readonly boolean[];
  readonly failed: readonly boolean[];
  /** Bumped on every (re)start: the component restarts its animations when it changes. */
  readonly run: number;
}

export type PlayerAction =
  | { type: 'frame_loaded'; i: number }
  | { type: 'frame_failed'; i: number }
  | { type: 'preload_timeout' }
  | { type: 'clip_ready' }
  | { type: 'clip_failed' }
  | { type: 'hold' }
  | { type: 'end' }
  | { type: 'again' };

const count = (xs: readonly boolean[]) => xs.filter(Boolean).length;
const minFrames = (total: number) => Math.min(PRELOAD_MIN_FRAMES, total);

/**
 * The first state for `m`. `preloaded` (the preview's drawn frames) marks every frame loaded, so
 * frames mode starts playing at once.
 */
export function initPlayer(
  m: ReplayMoment,
  o: { nowMs: number; preloaded?: boolean },
): PlayerState {
  const mode = chooseMode(m, o.nowMs);
  const n = m.frames.length;
  const pre = o.preloaded === true;
  const base = {
    mode,
    loaded: Array<boolean>(n).fill(pre),
    failed: Array<boolean>(n).fill(false),
    run: 0,
  };
  if (mode === null) return { ...base, phase: 'error' };
  if (mode === 'frames' && pre) return { ...base, phase: 'playing', run: 1 };
  return { ...base, phase: 'loading' };
}

/** After a frame settles: start, wait, or give up. */
function settle(s: PlayerState): PlayerState {
  if (s.phase !== 'loading' || s.mode !== 'frames') return s;
  const total = s.loaded.length;
  const ok = count(s.loaded);
  const done = ok + count(s.failed) >= total;
  if (!done) return s;
  return ok >= minFrames(total) && ok > 0
    ? { ...s, phase: 'playing', run: s.run + 1 }
    : { ...s, phase: 'error' };
}

const setAt = (xs: readonly boolean[], i: number) =>
  i >= 0 && i < xs.length && !xs[i] ? xs.map((x, j) => (j === i ? true : x)) : xs;

export function playerReducer(s: PlayerState, a: PlayerAction): PlayerState {
  switch (a.type) {
    case 'frame_loaded':
      if (s.failed[a.i]) return s;
      return settle({ ...s, loaded: setAt(s.loaded, a.i) });
    case 'frame_failed':
      if (s.loaded[a.i]) return s;
      return settle({ ...s, failed: setAt(s.failed, a.i) });
    case 'preload_timeout': {
      if (s.phase !== 'loading' || s.mode !== 'frames') return s;
      const ok = count(s.loaded);
      return ok >= minFrames(s.loaded.length) && ok > 0
        ? { ...s, phase: 'playing', run: s.run + 1 }
        : { ...s, phase: 'error' };
    }
    case 'clip_ready':
      return s.phase === 'loading' && s.mode === 'clip'
        ? { ...s, phase: 'playing', run: s.run + 1 }
        : s;
    case 'clip_failed': {
      if (s.mode !== 'clip') return s;
      // Fall back to the frames (preloading them now), else nothing to show.
      if (s.loaded.length === 0) return { ...s, phase: 'error' };
      return settle({ ...s, mode: 'frames', phase: 'loading' });
    }
    case 'hold':
      return s.phase === 'playing' ? { ...s, phase: 'holding' } : s;
    case 'end':
      return s.phase === 'playing' || s.phase === 'holding' ? { ...s, phase: 'ended' } : s;
    case 'again':
      return s.phase === 'ended' || s.phase === 'holding' || s.phase === 'playing'
        ? { ...s, phase: 'playing', run: s.run + 1 }
        : s;
  }
}

// ---------------------------------------------------------------------------------------
// What plays: the frames that loaded, the last one held
// ---------------------------------------------------------------------------------------

/** One frame in play order, with its index in moment.frames (the Image it mounts as). */
export interface PlayFrame {
  readonly at: number;
  readonly frame: ReplayFrame;
}

/** The loaded frames in play order (moment order is already t_ms order). */
export function playableFrames(m: ReplayMoment, loaded: readonly boolean[]): PlayFrame[] {
  return m.frames.flatMap((frame, at) => (loaded[at] ? [{ at, frame }] : []));
}

/** The frame held at the end: the last playable one. */
export const heldFrame = (frames: readonly PlayFrame[]): PlayFrame | null =>
  frames.length > 0 ? frames[frames.length - 1]! : null;

/**
 * The judge's frame tag shows only when the held frame really is the decisive cited one: a win
 * held on `judge_cited` (not `last_frame`, e.g. an appeal flipped it) and that frame loaded.
 */
export const isJudgesFrame = (m: ReplayMoment, held: PlayFrame | null): boolean =>
  m.kind === 'win' && m.hold_source === 'judge_cited' && held !== null && held.frame.cited;

// ---------------------------------------------------------------------------------------
// Animation plan (frames mode), from the shared timeline
// ---------------------------------------------------------------------------------------

export interface FrameAnim {
  /** Index into moment.frames (the Image to animate). */
  readonly at: number;
  /** Fade this frame in from here, over fadeMs (0 = cut). */
  readonly fadeInAt: number;
  readonly fadeMs: number;
  /** Fade it out when the next one has fully covered it; null for the held frame. */
  readonly fadeOutAt: number | null;
  /** Scale from -> to over [scaleAt, scaleAt + scaleMs]. */
  readonly scaleFrom: number;
  readonly scaleTo: number;
  readonly scaleAt: number;
  readonly scaleMs: number;
}

export interface FramesPlan {
  readonly anims: readonly FrameAnim[];
  readonly holdAt: number;
  readonly endAt: number;
}

/**
 * Per-Image animations for the playable frames, from the shared slowmoTimeline: each frame fades
 * in over its step's crossfade (the crop over the longer closing zoom), the previous frame stays
 * under it until it is fully in (no dip to black), and the scale runs over the step's dwell (the
 * held frame's over the hold, to SLOWMO_ZOOM.holdTo).
 */
export function framesPlan(
  m: ReplayMoment,
  loaded: readonly boolean[],
  o: { reduceMotion: boolean },
): FramesPlan {
  const play = playableFrames(m, loaded);
  const tl = slowmoTimeline({ frames: play.map((p) => p.frame) }, { reduceMotion: o.reduceMotion });
  const anims: FrameAnim[] = play.map((p, i) => {
    const st = tl.steps[i]!;
    const next = tl.steps[i + 1];
    return {
      at: p.at,
      fadeInAt: st.at_ms,
      fadeMs: st.xfade_ms,
      fadeOutAt: next ? next.at_ms + next.xfade_ms : null,
      scaleFrom: st.scale_from,
      scaleTo: st.scale_to,
      scaleAt: st.at_ms,
      scaleMs: st.dwell_ms,
    };
  });
  return { anims, holdAt: tl.hold_at_ms, endAt: tl.total_ms };
}

/** The timers the component sets for one run: when to hold and when to end. */
export function playbackSchedule(plan: {
  holdAt: number;
  endAt: number;
}): readonly { at_ms: number; action: 'hold' | 'end' }[] {
  return [
    { at_ms: plan.holdAt, action: 'hold' },
    { at_ms: Math.max(plan.endAt, plan.holdAt), action: 'end' },
  ];
}

// ---------------------------------------------------------------------------------------
// Clip mode
// ---------------------------------------------------------------------------------------

export interface ClipRun {
  readonly playbackRate: number;
  readonly seekSec: number;
  readonly freezeSec: number;
  /** Wall-clock length of the slowed run up to the freeze (for the progress bar). */
  readonly playMs: number;
}

/** clipPlan in the units expo-video takes (seconds), plus the wall-clock run length. */
export function clipRun(m: ReplayMoment): ClipRun | null {
  if (!m.clip) return null;
  const p = clipPlan(m.clip);
  return {
    playbackRate: p.playbackRate,
    seekSec: p.seekMs / 1000,
    freezeSec: p.freezeAtMs / 1000,
    playMs: Math.round((p.freezeAtMs - p.seekMs) / p.playbackRate),
  };
}

/** True once playback has reached the frozen moment (timeUpdate fires every ~50 ms). */
export const clipReachedFreeze = (run: ClipRun, currentSec: number): boolean =>
  currentSec >= run.freezeSec - 0.02;

// ---------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------

export interface ReplayCopy {
  /** "Slow-mo replay". */
  readonly badge: string;
  /** "Winning moment" | "Foul". */
  readonly title: string;
  /** "0.25x" (data). */
  readonly speed: string;
  /** "{name} wins" (data). */
  readonly chip: string;
  /** On the held frame: "Judge's frame", "Foul", or nothing. */
  readonly holdTag: string | null;
  /** The detector's measurement beside "Foul", e.g. "Toe 17 cm over" (data). */
  readonly holdData: string | null;
  /** The clip already has its boxes and FOUL text drawn in: draw only the badge. */
  readonly badgeOnly: boolean;
}

export function replayCopy(
  m: ReplayMoment,
  names: { A: string; B: string },
  o: { mode: PlayerMode | null; held: PlayFrame | null },
): ReplayCopy {
  const clip = o.mode === 'clip' ? m.clip : null;
  const rate = clip && clip.source_rate < 1 ? clip.source_rate : SLOWMO_RATE;
  const foul = m.kind === 'foul' ? m.foul : null;
  // The foul tag goes only on the detector's own moment: the clip's freeze, or the held frame
  // when it is the moment's last (a lost moment frame leaves the hold untagged).
  const onFoulMoment = foul !== null && (clip !== null || o.held?.at === m.frames.length - 1);
  return {
    badge: REPLAY_COPY.badge,
    title: foul ? REPLAY_COPY.foul : REPLAY_COPY.win,
    speed: speedTag(rate),
    chip: winsChip(names[m.winner]),
    holdTag: foul
      ? onFoulMoment
        ? REPLAY_COPY.foul
        : null
      : isJudgesFrame(m, o.held)
        ? REPLAY_COPY.judgesFrame
        : null,
    holdData: foul && onFoulMoment ? foul.label : null,
    badgeOnly: clip?.overlays_burned === true,
  };
}

// ---------------------------------------------------------------------------------------
// The response, for useReplay / ReplayButton
// ---------------------------------------------------------------------------------------

export interface ReplayView {
  /** Set iff there is something to play (why = 'ready'): the Replay button shows. */
  readonly moment: ReplayMoment | null;
  /** null until the first answer, or after a failed fetch. */
  readonly why: ReplayWhy | null;
  /** The bet is terminal: no later answer will differ except a detector foul. */
  readonly final: boolean;
}

export const EMPTY_REPLAY_VIEW: ReplayView = { moment: null, why: null, final: false };

/** The hide/show rule: only a 'ready' answer with a playable moment shows the button. */
export function replayViewOf(res: ReplayResponse, nowMs: number): ReplayView {
  const m = res.why === 'ready' ? res.replay : null;
  return {
    moment: m && chooseMode(m, nowMs) !== null ? m : null,
    why: res.why,
    final: res.final,
  };
}
