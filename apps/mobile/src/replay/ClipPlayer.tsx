// The real clip, slowed (mode A-clip / B with a clip; SCHEMAS §4.1 ReplayClip). expo-video plays
// the signed URL muted from clip.from_ms at clipPlan's rate (0.25x for a real-time source, 1x for
// Alaric's pre-slowed render) and freezes on clip.moment_ms; the parent then holds and ends.
// Anything that goes wrong (expired URL, network, decode, not ready in CLIP_READY_TIMEOUT_MS)
// calls onFailed once, and the parent falls back to the frames when there are any.
import type { ReplayMoment } from '@youre-on/shared/replay';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';

import { CLIP_READY_TIMEOUT_MS, clipReachedFreeze, clipRun } from './model';

export function ClipPlayer({
  moment,
  run,
  playing,
  onReady,
  onFailed,
  onFreeze,
}: {
  moment: ReplayMoment;
  /** Bumped by the parent on each (re)start: seek back and play again. */
  run: number;
  /** The parent's phase is 'playing' (false while loading / holding / ended). */
  playing: boolean;
  onReady: () => void;
  onFailed: () => void;
  /** Playback reached clip.moment_ms and is paused there. */
  onFreeze: () => void;
}) {
  const plan = useMemo(() => clipRun(moment), [moment]);
  const uri = moment.clip?.url ?? '';
  const cb = useRef({ onReady, onFailed, onFreeze });
  cb.current = { onReady, onFailed, onFreeze };
  const settled = useRef({ ready: false, failed: false, frozen: false });

  const player = useVideoPlayer({ uri }, (p) => {
    p.muted = true;
    p.loop = false;
    p.timeUpdateEventInterval = 0.05;
    if (plan) p.playbackRate = plan.playbackRate;
  });

  // Ready / error, with a timeout.
  useEffect(() => {
    const fail = () => {
      if (settled.current.failed) return;
      settled.current.failed = true;
      cb.current.onFailed();
    };
    const t = setTimeout(() => {
      if (!settled.current.ready) fail();
    }, CLIP_READY_TIMEOUT_MS);
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') {
        clearTimeout(t);
        // Before or during the run (an expired URL, a stall): fall back to the frames. Never
        // hold on whatever picture the error left, since it is not the moment.
        if (!settled.current.frozen) fail();
      } else if (status === 'readyToPlay' && !settled.current.ready && !settled.current.failed) {
        clearTimeout(t);
        settled.current.ready = true;
        cb.current.onReady();
      }
    });
    if (player.status === 'readyToPlay' && !settled.current.ready) {
      clearTimeout(t);
      settled.current.ready = true;
      cb.current.onReady();
    }
    return () => {
      clearTimeout(t);
      sub.remove();
    };
  }, [player]);

  // Each run: seek to from_ms and play slowed; pause on the moment.
  useEffect(() => {
    if (!plan || !playing) return;
    settled.current.frozen = false;
    player.playbackRate = plan.playbackRate;
    player.currentTime = plan.seekSec;
    player.play();
    const sub = player.addListener('timeUpdate', ({ currentTime }) => {
      if (settled.current.frozen || !clipReachedFreeze(plan, currentTime)) return;
      settled.current.frozen = true;
      player.pause();
      player.currentTime = plan.freezeSec;
      cb.current.onFreeze();
    });
    // A clip that ends before the moment (bad metadata) still freezes.
    const end = player.addListener('playToEnd', () => {
      if (settled.current.frozen) return;
      settled.current.frozen = true;
      cb.current.onFreeze();
    });
    return () => {
      sub.remove();
      end.remove();
    };
  }, [player, plan, run, playing]);

  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      nativeControls={false}
      allowsPictureInPicture={false}
    />
  );
}
