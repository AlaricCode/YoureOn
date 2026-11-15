/**
 * Audio cross-check (§7.6, advisory) and beacon-offset time mapping (§7.5).
 */
import { FPS, TRACK_FLAG_AUDIO_DISAGREE } from '../constants.js';
import type { ScribeTranscript } from '../types.js';

/** Default tolerance around a decisive frame (±500 ms). */
export const AUDIO_TOLERANCE_MS = 500;
/** Decisive event types the backend looks up audio tags for. */
export const AUDIO_CHECK_EVENTS = ['disappears_into', 'touches', 'released_by', 'crosses'] as const;
/** Event types whose missing impact tag sets `audio_disagree`. */
export const AUDIO_DISAGREE_EVENTS = ['disappears_into', 'touches'] as const;

const IMPACT_RE = /impact|thud|clap/i;

/** True for Scribe audio-event tags that count as an impact (impact / thud / clap). */
export function isImpactTag(type: string): boolean {
  return IMPACT_RE.test(type);
}

/**
 * Maps a device-local Scribe transcript to session time using the witness's
 * beacon offset (`session = device − offset_w`, §7.5).
 */
export function scribeToSessionTime(t: ScribeTranscript, offsetMs: number): ScribeTranscript {
  return {
    segments: t.segments.map((s) => ({ ...s, start_ms: s.start_ms - offsetMs, end_ms: s.end_ms - offsetMs })),
    events: t.events.map((e) => ({ ...e, at_ms: e.at_ms - offsetMs })),
  };
}

/** `offset_w` (device-local ms of t0) from a decoded beacon's t0 sample. */
export function beaconOffsetMs(t0Sample: number, sampleRate: number, recordingStartMs = 0): number {
  return recordingStartMs + Math.round((t0Sample * 1000) / sampleRate);
}

export interface DecisiveEvent {
  /** primitive op, e.g. "disappears_into" */
  type: string;
  /** absolute session frame */
  frame: number;
}

export interface AudioEventCheck {
  type: string;
  frame: number;
  /** indices of audio witnesses with an impact tag within tolerance */
  witnesses: number[];
}

export interface AudioCrossCheckResult {
  audio_disagree: boolean;
  /** TRACK_FLAG_AUDIO_DISAGREE when audio_disagree, else 0 */
  flag: number;
  /** true if any audio witness has an impact tag anywhere in the session */
  any_impact: boolean;
  /** one entry per decisive event of a checked type, input order */
  events: AudioEventCheck[];
}

/**
 * §7.6: for every decisive `disappears_into`/`touches`/`released_by`/`crosses`
 * event, find impact tags within ±tolerance of the event's frame interval
 * `[f·100, f·100+100)` ms on each audio witness (events already in session time).
 * `audio_disagree` iff some witness has any impact tag in the session but some
 * `disappears_into`/`touches` decisive event has none nearby on any witness.
 */
export function audioCrossCheck(
  decisive: DecisiveEvent[],
  witnessEvents: { type: string; at_ms: number }[][],
  toleranceMs: number = AUDIO_TOLERANCE_MS,
): AudioCrossCheckResult {
  const frameMs = 1000 / FPS;
  const impacts = witnessEvents.map((evs) => evs.filter((e) => isImpactTag(e.type)).map((e) => e.at_ms));
  const anyImpact = impacts.some((l) => l.length > 0);
  const events: AudioEventCheck[] = [];
  let disagree = false;
  for (const d of decisive) {
    if (!(AUDIO_CHECK_EVENTS as readonly string[]).includes(d.type)) continue;
    const lo = d.frame * frameMs - toleranceMs;
    const hi = d.frame * frameMs + frameMs + toleranceMs;
    const ws: number[] = [];
    impacts.forEach((l, w) => {
      if (l.some((t) => t >= lo && t < hi)) ws.push(w);
    });
    events.push({ type: d.type, frame: d.frame, witnesses: ws });
    if (anyImpact && ws.length === 0 && (AUDIO_DISAGREE_EVENTS as readonly string[]).includes(d.type)) {
      disagree = true;
    }
  }
  return { audio_disagree: disagree, flag: disagree ? TRACK_FLAG_AUDIO_DISAGREE : 0, any_impact: anyImpact, events };
}
