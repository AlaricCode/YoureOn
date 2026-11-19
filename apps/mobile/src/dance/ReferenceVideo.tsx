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
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';

import { nowMs } from './hooks';
import { CLIP_DRIFT_MAX_MS, clipDriftMs, clipPositionSec } from './model/schedule';

/** How often a playing clip is checked against the clock. */
const DRIFT_CHECK_MS = 2_000;

export default function ReferenceVideo({
  source,
  startAt,
}: {
  /** Metro asset id. */
  source: number;
  /** t0 on the nowMs clock (now, ahead or past), null before GO. */
  startAt: number | null;
}) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.muted = false;
    p.timeUpdateEventInterval = 0;
  });
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
    const drift = setInterval(() => {
      if (!live || !player.playing) return;
      const now = nowMs();
      const d = clipDriftMs(startAt, now, player.currentTime);
      if (d !== null && Math.abs(d) > CLIP_DRIFT_MAX_MS)
        player.currentTime = clipPositionSec(startAt, now);
    }, DRIFT_CHECK_MS);
    return () => {
      live = false;
      if (startTimer) clearTimeout(startTimer);
      clearInterval(drift);
      player.pause();
    };
  }, [player, startAt]);
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
