// B's phone during a Dance Off round: the DISPLAY (../app/danceFlow showsDanceDisplay). The
// recording phone (A's phone or the judge cam) films both dancers; this phone stands where they
// can see it and plays the routine for them:
//   - full screen, the reference MIRRORED (scaleX −1: players copy it like a mirror, DANCE-OFF
//     §4.2) and contain-fit on the routine's dark backdrop, with its music. A routine with no clip
//     (the synthetic ones) shows its mirrored skeleton full screen instead, with its music if it
//     has any. It follows the phone's orientation like the rest of the app (no orientation lock:
//     that needs expo-screen-orientation, a native module the binary does not have): meant to
//     stand upright, and on its side the contain-fit still shows the whole reference, smaller;
//   - the screen kept awake (expo-keep-awake) for as long as it is up;
//   - a big "3, 2, 1" on the routine's beat from the attempt's go_at, then the reference from t0
//     = go_at + 3 beats: the server's instant mapped onto this phone's clock (./model/schedule),
//     the same instant the recorder starts filming on;
//   - when the routine is over it says "Scoring" until the bet moves on (JUDGING and the ruling
//     are the usual screens).
// Native-free apart from expo-video (lazily, for a clip), expo-audio and expo-keep-awake (both
// through importSafely), so a binary missing any of them loses that part, not the screen.
import { parseDanceTermsRoutine } from '@youre-on/shared/dance/terms';
import type { RoutineData } from '@youre-on/shared/dance/routine';
import type { Terms } from '@youre-on/shared/terms';
import { useEffect, useMemo, useState } from 'react';
import { StatusBar, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { importSafely } from '../app/importSafely';
import { AlertLine } from '../ui/kit';
import { DotsLabel } from '../ui/parts';
import { half, palette, space, type } from '../ui/tokens';
import { DANCE_COPY, dt, firstName } from './copy';
import { nowMs, useFrameClock } from './hooks';
import { routineMedia } from './media';
import type { Size } from './model/overlay';
import { roundConfig } from './model/round';
import {
  clipPositionSec,
  displayPhase,
  roundTimeline,
  serverIsoToLocalMs,
  type DisplayPhase,
  type RoundTimeline,
} from './model/schedule';
import { CountInOverlay, ReferencePanel } from './Stage';
import { PLAYER_TINT, REFERENCE_BACKDROP } from './theme';

export type DanceDisplayScreenProps = {
  terms: Terms;
  names: { a: string; b: string };
  /** The open attempt (null while LOCKED): go_at is the SERVER's instant. */
  attempt: { attempt_no: number; go_at: string } | null;
  /** Server time − this phone's Date.now() (net Clock.offsetMs). */
  clockOffsetMs: number;
};

const KEEP_AWAKE_TAG = 'dance-display';
/** The count-in numeral on the display: as big as a phone held at arm's length needs. */
const DISPLAY_NUMERAL_SIZE = 240;

/** The screen stays on while the display is up. */
function useKeepAwake() {
  useEffect(() => {
    let live = true;
    let release: (() => void) | null = null;
    importSafely(() => import('expo-keep-awake'))
      .then((m) => {
        if (!live) return;
        release = () => void m.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
        void m.activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      release?.();
    };
  }, []);
}

interface MusicPlayer {
  play(): void;
  pause(): void;
  remove(): void;
  seekTo(seconds: number): Promise<void>;
}

/**
 * A separate music track (a routine with audio and no clip; the clip carries its own) from t0:
 * created up front, started on a timer at exactly `startAt`, or seeked in when already past it.
 */
function useScheduledMusic(asset: number | null, startAt: number | null) {
  const [player, setPlayer] = useState<MusicPlayer | null>(null);
  useEffect(() => {
    if (asset === null) return;
    let live = true;
    let p: MusicPlayer | null = null;
    importSafely(() => import('expo-audio'))
      .then((A) => {
        if (!live) return;
        p = A.createAudioPlayer(asset) as MusicPlayer;
        setPlayer(p);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      setPlayer(null);
      try {
        p?.pause();
        p?.remove();
      } catch {
        // Already released.
      }
    };
  }, [asset]);
  useEffect(() => {
    if (!player || startAt === null) return;
    const begin = () => {
      try {
        const at = clipPositionSec(startAt, nowMs());
        if (at > 0) void player.seekTo(at).catch(() => undefined);
        player.play();
      } catch {
        // Music is a nicety: the reference still runs.
      }
    };
    const wait = startAt - nowMs();
    const tm = wait > 0 ? setTimeout(begin, wait) : null;
    if (tm === null) begin();
    return () => {
      if (tm) clearTimeout(tm);
      try {
        player.pause();
      } catch {
        // Already released.
      }
    };
  }, [player, startAt]);
}

export function DanceDisplayScreen(props: DanceDisplayScreenProps) {
  const parsed = parseDanceTermsRoutine(props.terms);
  if (!parsed.ok) {
    return (
      <View style={[styles.root, styles.center]}>
        <AlertLine message={dt(DANCE_COPY.unknownRoutine)} />
      </View>
    );
  }
  return <Display {...props} routine={parsed.routine} />;
}

function Display({
  routine,
  names,
  attempt,
  clockOffsetMs,
}: DanceDisplayScreenProps & { routine: RoutineData }) {
  useKeepAwake();
  const cfg = useMemo(() => roundConfig(routine), [routine]);
  const goAtIso = attempt?.go_at ?? null;
  // The round on this phone's clock, from the server's go_at (re-mapped if the offset re-syncs).
  const timeline = useMemo<RoundTimeline | null>(() => {
    if (goAtIso === null) return null;
    const local = serverIsoToLocalMs(goAtIso, {
      offsetMs: clockOffsetMs,
      wallNow: Date.now(),
      monoNow: nowMs(),
    });
    return local === null ? null : roundTimeline(local, cfg);
  }, [goAtIso, clockOffsetMs, cfg]);

  const [settled, setSettled] = useState<DisplayPhase>('waiting');
  const now = useFrameClock(timeline !== null && settled !== 'done', 30);
  const phase = displayPhase(timeline, now);
  useEffect(() => setSettled(phase), [phase]);

  const media = routineMedia(routine);
  const startAt = timeline?.goAt ?? null;
  useScheduledMusic(media.video === null ? media.audio : null, startAt);

  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== box.width || height !== box.height) setBox({ width, height });
  };

  const round = {
    phase: phase === 'playing' ? ('dancing' as const) : ('countIn' as const),
    countInAt: timeline?.countInAt ?? null,
    goAt: timeline?.goAt ?? null,
  };
  const progress =
    timeline && phase === 'playing' ? Math.min(1, (now - timeline.goAt) / cfg.durationMs) : 0;
  const status =
    phase === 'done' ? (
      <DotsLabel text={dt(DANCE_COPY.scoring)} variant="subtitle" />
    ) : phase === 'waiting' ? (
      timeline ? (
        <Text style={styles.status}>{dt(DANCE_COPY.getReady)}</Text>
      ) : (
        <DotsLabel text={dt(DANCE_COPY.gettingReady)} variant="subtitle" />
      )
    ) : null;

  return (
    <View style={styles.root} onLayout={onLayout} testID="dance-display">
      <StatusBar hidden />
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <ReferencePanel routine={routine} startAt={startAt} size={box} />
      </View>
      {phase === 'countIn' || phase === 'playing' ? (
        <CountInOverlay round={round} beatMs={cfg.beatMs} numeralSize={DISPLAY_NUMERAL_SIZE} />
      ) : null}
      {phase === 'waiting' || phase === 'done' ? (
        <View style={styles.top} pointerEvents="none">
          <Text style={styles.title} numberOfLines={1}>
            {routine.title}
          </Text>
          <View style={styles.versus}>
            <Text style={[styles.name, { color: PLAYER_TINT.A }]} numberOfLines={1}>
              {firstName(names.a)}
            </Text>
            <Text style={styles.vs}>{dt(DANCE_COPY.versus)}</Text>
            <Text style={[styles.name, { color: PLAYER_TINT.B }]} numberOfLines={1}>
              {firstName(names.b)}
            </Text>
          </View>
        </View>
      ) : null}
      <View style={styles.bottom} pointerEvents="none">
        {status}
        {phase === 'playing' ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: REFERENCE_BACKDROP },
  center: { alignItems: 'center', justifyContent: 'center' },
  top: {
    position: 'absolute',
    top: space.x6,
    left: space.page,
    right: space.page,
    alignItems: 'center',
    gap: space.x1,
  },
  title: { ...type.heading },
  versus: { flexDirection: 'row', alignItems: 'baseline', gap: space.x1 },
  name: { ...type.subtitle, flexShrink: 1 },
  vs: { ...type.section },
  bottom: {
    position: 'absolute',
    bottom: space.x6,
    left: space.page,
    right: space.page,
    alignItems: 'center',
    gap: half.x15,
  },
  status: { ...type.subtitle },
  progressTrack: {
    alignSelf: 'stretch',
    height: 2,
    borderRadius: 1,
    backgroundColor: palette.fill,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: palette.accent },
});
