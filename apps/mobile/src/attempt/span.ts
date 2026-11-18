// How long the judge-cam clip really is. The D10 sampler (./frames, capture.ts) puts the last 8
// frames in the clip's last ~1.2 s from this number, and CameraEvidence.duration_ms carries it.
//
// The wall clock around recordAsync overstates it twice over: the camera starts writing a moment
// after the call (the start delay), and recordAsync resolves only once the file is finalized,
// well after Stop (the finalize wait). Past the real end, expo-video-thumbnails returns the clip's
// last frame, so an overstated length turns the last landing frames (and the crop) into copies of
// one still. So the span runs from when the file began (the first onRecordingProgress: its arrival
// minus the media it reports) to the Stop tap, and never past the end the camera reached on its
// own (maxDuration). Each estimate errs short, never long. Pure TS: tested in node.

/** What JudgeCamScreen notes around one recording (all Date.now() ms). */
export interface RecordingMarks {
  /** Just before recordAsync. */
  requestedAtMs: number;
  /** The first onRecordingProgress: when it came in, and the media recorded by then (s). */
  firstProgress?: { atMs: number; durationS: number } | null | undefined;
  /** When Stop was tapped (or the max timer fired), before stopRecording. */
  stopAtMs: number;
  /** When recordAsync resolved, if the camera ended the clip itself (maxDuration). */
  finishedAtMs?: number | null | undefined;
  /** The recordAsync maxDuration (ms): no clip is longer. */
  maxMs: number;
}

/** The clip's length and its end (both for the Clip JudgeCamScreen hands to onSend). */
export function recordedSpan(m: RecordingMarks): { durationMs: number; endedAtMs: number } {
  const p = m.firstProgress;
  const fromProgress =
    p && Number.isFinite(p.atMs) && Number.isFinite(p.durationS) && p.durationS >= 0
      ? p.atMs - p.durationS * 1000
      : -Infinity;
  const startMs = Math.max(m.requestedAtMs, fromProgress);
  const endMs =
    m.finishedAtMs !== null && m.finishedAtMs !== undefined
      ? Math.min(m.stopAtMs, m.finishedAtMs)
      : m.stopAtMs;
  const durationMs = Math.min(m.maxMs, Math.max(1, Math.round(endMs - startMs)));
  return { durationMs, endedAtMs: Math.min(endMs, startMs + durationMs) };
}
