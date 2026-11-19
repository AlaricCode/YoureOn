// The reference clip (when a routine has one, see media.ts), mirrored: players copy it like a
// mirror (DANCE-OFF §4.2). It plays with sound (the music is muxed in, one clock) from t0 and
// holds its first frame before that. Loaded lazily by Stage, so expo-video never loads for the
// skeleton-only routines.
//
// `startAt` is t0 on the nowMs round clock. On the recording phone it arrives at t0 itself (the
// same tick as startRound); on the display phone it is known ahead (go_at + the count-in), so the
// clip starts on a timer at exactly t0, and a display that mounts late seeks in to where the
// round is (./model/schedule clipPositionSec). While it plays, a clip that drifts more than
// CLIP_DRIFT_MAX_MS from the clock is re-seeked (rare: a stall, a slow first play).
//
// Interruptions: expo-video pauses every player when the app goes to the background, and an
// audio-session interruption (a call, Siri) pauses it too; nothing resumes it. So a clip found
// paused inside the round's window (./model/schedule clipResumeSec) is seeked to where the
// round is and played again: on every drift check and as soon as the app is active again.
//
// `mutedUntil` (a recorder run out of step with a display phone that is still playing, ./model/
// schedule fallbackMutedUntil): the clip plays silent until then, and with its sound after.
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { AppState, StyleSheet } from 'react-native';

import { nowMs } from './hooks';
import { CLIP_DRIFT_MAX_MS, clipDriftMs, clipPositionSec, clipResumeSec } from './model/schedule';

/** How often the clip is checked against the clock. */
const DRIFT_CHECK_MS = 2_000;

export default function ReferenceVideo({
  source,
  startAt,
  durationMs,
  mutedUntil = null,
}: {
  /** Metro asset id. */
  source: number;
  /** t0 on the nowMs clock (now, ahead or past), null before GO. */
  startAt: number | null;
  /** The routine's length: the window a paused clip is resumed in. */
  durationMs: number;
  /** Silent until this instant on the nowMs clock (null: never muted). */
  mutedUntil?: number | null;
}) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.muted = false;
    p.timeUpdateEventInterval = 0;
  });
  useEffect(() => {
    if (mutedUntil === null) {
      player.muted = false;
      return;
    }
    const wait = mutedUntil - nowMs();
    player.muted = wait > 0;
    if (wait <= 0) return;
    const t = setTimeout(() => {
      player.muted = false;
    }, wait);
    return () => clearTimeout(t);
  }, [player, mutedUntil]);
  useEffect(() => {
    if (startAt === null) {
      player.pause();
      player.currentTime = 0;
      return;
    }
    let live = true;
    const begin = () => {
      if (!live) return;
      player.currentTime = clipPositionSec(startAt, nowMs());
      player.play();
    };
    const wait = startAt - nowMs();
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    if (wait > 0) {
      player.pause();
      player.currentTime = 0;
      startTimer = setTimeout(begin, wait);
    } else {
      begin();
    }
    /** An interrupted clip picks up where the round is. */
    const resume = () => {
      if (!live || player.playing) return false;
      const at = clipResumeSec(startAt, nowMs(), durationMs);
      if (at === null) return false;
      player.currentTime = at;
      player.play();
      return true;
    };
    const drift = setInterval(() => {
      if (!live || resume() || !player.playing) return;
      const now = nowMs();
      const d = clipDriftMs(startAt, now, player.currentTime);
      if (d !== null && Math.abs(d) > CLIP_DRIFT_MAX_MS)
        player.currentTime = clipPositionSec(startAt, now);
    }, DRIFT_CHECK_MS);
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') resume();
    });
    return () => {
      live = false;
      if (startTimer) clearTimeout(startTimer);
      clearInterval(drift);
      app.remove();
      player.pause();
    };
  }, [player, startAt, durationMs]);
  return (
    <VideoView
      player={player}
      style={[StyleSheet.absoluteFill, styles.mirrored]}
      contentFit="contain"
      nativeControls={false}
      allowsPictureInPicture={false}
    />
  );
}

const styles = StyleSheet.create({ mirrored: { transform: [{ scaleX: -1 }] } });
