// The reference clip (when a routine has one, see media.ts), mirrored: players copy it like a
// mirror (DANCE-OFF §4.2). It plays with sound (the music is muxed in, one clock) from t0 and
// holds its first frame before that. Loaded lazily by Stage, so expo-video never loads for the
// skeleton-only routines.
//
// `startAt` is t0 on the nowMs round clock. On the recording phone it arrives at t0 itself (the
// same tick as startRound); on the display phone it is known ahead (go_at + the count-in), so the
// clip starts on a timer at exactly t0, and a display that mounts late seeks in to where the
// round is.
//
// Staying on the clock (./model/clipSync): while it plays, the clip is checked four times a
// second and small drift is taken out with SPEED (a few percent fast or slow, pitch preserved,
// until it is back on the clock), which is seamless. It is seeked only when it is far off,
// aiming ahead by what a seek costs on this device. Correcting by seeking alone never converged:
// a seek costs more than the tolerance it was meeting, so the clip was re-seeked every 2 s with
// a freeze each time.
//
// Interruptions: expo-video pauses every player when the app goes to the background, and an
// audio-session interruption (a call, Siri) pauses it too; nothing resumes it. So a clip found
// paused inside the round's window (./model/schedule clipResumeSec) is seeked to where the
// round is and played again: on a check and as soon as the app is active again.
//
// `mutedUntil` (a recorder run out of step with a display phone that is still playing, ./model/
// schedule fallbackMutedUntil): the clip plays silent until then, and with its sound after.
//
// `shiftX`: the mirrored picture is drawn this many points to the right, so a dancer who is off
// centre in the clip is in the middle of the screen (./model/framing). The view clips it.
import { useVideoPlayer, VideoView } from 'expo-video';
import { memo, useEffect } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { nowMs } from './hooks';
import {
  CLIP_SEEK_LEAD_MS,
  CLIP_SEEK_SETTLE_MS,
  CLIP_START_NEAR_MS,
  CLIP_START_SETTLE_MS,
  CLIP_SYNC_CHECK_MS,
  clipNeedsSeek,
  clipRateFor,
  clipSeekTargetSec,
  nextSeekLeadMs,
} from './model/clipSync';
import { clipDriftMs, clipResumeSec } from './model/schedule';

function ReferenceVideo({
  source,
  startAt,
  durationMs,
  mutedUntil = null,
  shiftX = 0,
}: {
  /** Metro asset id. */
  source: number;
  /** t0 on the nowMs clock (now, ahead or past), null before GO. */
  startAt: number | null;
  /** The routine's length: the window a paused clip is resumed in. */
  durationMs: number;
  /** Silent until this instant on the nowMs clock (null: never muted). */
  mutedUntil?: number | null;
  /** Points the mirrored picture is moved to the right (the dancer centred). */
  shiftX?: number;
}) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.muted = false;
    p.timeUpdateEventInterval = 0;
    p.preservesPitch = true;
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
    const setRate = (rate: number) => {
      if (Math.abs(player.playbackRate - rate) > 0.004) player.playbackRate = rate;
    };
    if (startAt === null) {
      player.pause();
      setRate(1);
      player.currentTime = 0;
      return;
    }
    let live = true;
    /** What a seek costs on this device: a guess until one has been measured. */
    let leadMs = CLIP_SEEK_LEAD_MS;
    /** Nothing is corrected before this instant: a start or a seek is still settling. */
    let settleUntil = 0;
    /** The last jump was a seek whose cost has not been measured yet. */
    let measuring = false;

    /** Put the clip where the round is and play it. */
    const playFromClock = () => {
      const now = nowMs();
      setRate(1);
      if (now - startAt <= CLIP_START_NEAR_MS && player.currentTime * 1000 <= CLIP_START_NEAR_MS) {
        // On time, and already holding its first frame: no seek, so no wait for one.
        settleUntil = now + CLIP_START_SETTLE_MS;
        measuring = false;
      } else {
        player.currentTime = clipSeekTargetSec(startAt, now, leadMs, durationMs);
        settleUntil = now + CLIP_SEEK_SETTLE_MS;
        measuring = true;
      }
      player.play();
    };
    const begin = () => {
      if (live) playFromClock();
    };
    const wait = startAt - nowMs();
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    if (wait > 0) {
      player.pause();
      setRate(1);
      player.currentTime = 0;
      startTimer = setTimeout(begin, wait);
    } else {
      begin();
    }
    /** An interrupted clip picks up where the round is. */
    const resume = () => {
      if (!live || player.playing) return false;
      if (clipResumeSec(startAt, nowMs(), durationMs) === null) return false;
      playFromClock();
      return true;
    };
    const check = setInterval(() => {
      if (!live) return;
      const now = nowMs();
      if (now < settleUntil) return;
      if (resume() || !player.playing) return;
      const drift = clipDriftMs(startAt, now, player.currentTime);
      if (drift === null) return;
      if (measuring) {
        leadMs = nextSeekLeadMs(leadMs, drift);
        measuring = false;
      }
      if (clipNeedsSeek(drift)) playFromClock();
      else setRate(clipRateFor(drift, player.playbackRate));
    }, CLIP_SYNC_CHECK_MS);
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') resume();
    });
    return () => {
      live = false;
      if (startTimer) clearTimeout(startTimer);
      clearInterval(check);
      app.remove();
      player.pause();
      setRate(1);
    };
  }, [player, startAt, durationMs]);
  return (
    <View style={styles.clip} pointerEvents="none">
      <VideoView
        player={player}
        style={[
          StyleSheet.absoluteFill,
          shiftX === 0 ? styles.mirrored : { transform: [{ translateX: shiftX }, { scaleX: -1 }] },
        ]}
        contentFit="contain"
        nativeControls={false}
        allowsPictureInPicture={false}
      />
    </View>
  );
}

// The display re-renders 30 times a second for its count-in and progress bar: the player and
// its view are left out of that.
export default memo(ReferenceVideo);

const styles = StyleSheet.create({
  clip: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
  mirrored: { transform: [{ scaleX: -1 }] },
});
