// The Dance Off display (DANCE-OFF §6.3). This is what the HDMI display shows (iOS mirroring),
// so it is laid out like a broadcast: the beat bar on top, then two equal 9:16 panels side by
// side: the MIRRORED reference (the routine's video when there is one, else its animated
// skeleton) and the live camera with A (green) and B (white) drawn on the dancers, each with a
// name tag pinned above their head carrying the live match score ("Logan · 87"; no separate
// meters), PERFECT / GOOD / MISS popups over each player's half, and the 3-2-1-GO count-in over
// both. It fits portrait and landscape: the panels take the largest equal size the
// space allows. With a display phone in the room (DanceDisplayScreen plays the reference and the
// music), `reference={false}` drops the reference panel and the camera panel takes the space.
import type { RoutineData } from '@youre-on/shared/dance/routine';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { importSafely } from '../app/importSafely';
import { half, palette, radius, space, TABULAR, type } from '../ui/tokens';
import { clockText, DANCE_COPY, dt } from './copy';
import { useFrameClock, useLive } from './hooks';
import { CameraSkeletons, DebugReadout, NameTags, PopupLayer } from './LiveParts';
import { routineMedia } from './media';
import { mirroredClipShift } from './model/framing';
import type { LiveStore } from './model/liveStore';
import { CAMERA_ASPECT, fitPanels, stagePanelLayout, type Size } from './model/overlay';
import { referencePoseAt, upcomingKeyMove } from './model/reference';
import { beatAt, countInLabel, type RoundState } from './model/round';
import { SkeletonLayer } from './SkeletonLayer';
import { REFERENCE_TINT } from './theme';

/** expo-video, only when a routine has a reference clip (see media.ts). */
const ReferenceVideo = lazy(() => importSafely(() => import('./ReferenceVideo')));

const PANEL_GAP = space.x1;
const COUNT_NUMERAL_SIZE = 160;
/** A beat flash fades over this long. */
const FLASH_MS = 180;
const BEATS_PER_BAR = 4;

// ---------------------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------------------

/**
 * The mirrored reference. Before t0 it holds the first pose; from t0 (`startAt`, the same tick
 * as startRound) it plays: the skeleton follows the clock at ~30 fps.
 */
export function ReferencePanel({
  routine,
  startAt,
  size,
  mutedUntil = null,
}: {
  routine: RoutineData;
  /** The round's t0 on the nowMs clock, or null (not started). */
  startAt: number | null;
  size: Size;
  /** The clip is silent until this instant (nowMs clock; null: never). */
  mutedUntil?: number | null;
}) {
  const media = routineMedia(routine);
  const playing = startAt !== null;
  const now = useFrameClock(playing && media.video === null, 30);
  const elapsed = startAt === null ? 0 : Math.max(0, now - startAt);
  const done = elapsed > routine.duration_ms;
  if (media.video !== null) {
    return (
      <Suspense fallback={null}>
        <ReferenceVideo
          source={media.video}
          startAt={startAt}
          durationMs={routine.duration_ms}
          mutedUntil={mutedUntil}
          shiftX={mirroredClipShift(routine, size)}
        />
      </Suspense>
    );
  }
  const k = referencePoseAt(routine, Math.min(elapsed, routine.duration_ms));
  const beat = playing ? beatAt(routine, elapsed) : null;
  const flash = beat ? Math.max(0, 1 - beat.sinceMs / FLASH_MS) : 0;
  return (
    <>
      <View style={[StyleSheet.absoluteFill, styles.flash, { opacity: flash * 0.5 }]} />
      <SkeletonLayer
        size={size}
        image={{ width: routine.w, height: routine.h }}
        figures={[{ k, tint: REFERENCE_TINT, mirrored: true, opacity: done ? 0.4 : 1 }]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Beat bar: four beat dots (the current one lit, flashing on the beat), the routine's progress,
// and the next key move.
// ---------------------------------------------------------------------------------------

export function BeatBar({ routine, startAt }: { routine: RoutineData; startAt: number | null }) {
  const running = startAt !== null;
  const now = useFrameClock(running, 30);
  const elapsed = startAt === null ? 0 : Math.max(0, now - startAt);
  const beat = running ? beatAt(routine, elapsed) : null;
  const progress = Math.min(1, elapsed / routine.duration_ms);
  const next = running ? upcomingKeyMove(routine, elapsed) : null;
  const left = Math.max(0, Math.ceil((routine.duration_ms - elapsed) / 1000));
  return (
    <View style={styles.beatBar}>
      <View style={styles.beatRow}>
        <View style={styles.beatDots}>
          {Array.from({ length: BEATS_PER_BAR }, (_, i) => {
            const on = beat !== null && beat.index % BEATS_PER_BAR === i;
            const flash = on && beat ? Math.max(0, 1 - beat.sinceMs / (FLASH_MS * 2)) : 0;
            return (
              <View
                key={i}
                style={[
                  styles.beatDot,
                  on && styles.beatDotOn,
                  on && { transform: [{ scale: 1 + 0.35 * flash }] },
                ]}
              />
            );
          })}
        </View>
        <View style={styles.nextMove}>
          {next ? (
            <>
              <Text style={styles.nextLabel}>{dt(DANCE_COPY.nextMove)}</Text>
              <Text style={styles.nextName} numberOfLines={1}>
                {next.name}
              </Text>
            </>
          ) : null}
        </View>
        <Text style={styles.clock}>
          {clockText(running ? left : Math.ceil(routine.duration_ms / 1000))}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Count-in: 3, 2, 1 on the beat, then GO (green), over both panels.
// ---------------------------------------------------------------------------------------

export function CountInOverlay({
  round,
  beatMs,
  numeralSize = COUNT_NUMERAL_SIZE,
}: {
  round: Pick<RoundState, 'phase' | 'countInAt' | 'goAt'>;
  beatMs: number;
  /** The numeral's font size (the display phone draws it bigger). */
  numeralSize?: number;
}) {
  const active = round.phase === 'countIn' || round.phase === 'dancing';
  const now = useFrameClock(active, 30);
  const label = active ? countInLabel(round, now, beatMs) : null;
  if (label === null) return null;
  const go = label === 'GO';
  const beatStart =
    round.phase === 'countIn' && round.countInAt !== null
      ? round.countInAt + Math.floor((now - round.countInAt) / beatMs) * beatMs
      : (round.goAt ?? now);
  const age = Math.max(0, now - beatStart);
  // Each numeral lands big and settles in one beat (scale 1.15 → 1), no bounce.
  const scale = 1 + 0.15 * Math.max(0, 1 - age / Math.min(beatMs, 300));
  return (
    <View style={[StyleSheet.absoluteFill, styles.countIn]} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, styles.scrim]} />
      <Text
        style={[
          styles.countNumeral,
          numeralSize !== COUNT_NUMERAL_SIZE && {
            fontSize: numeralSize,
            lineHeight: Math.round(numeralSize * 1.1),
          },
          go && { color: palette.accent },
          { transform: [{ scale }] },
        ]}
        accessibilityLiveRegion="assertive"
      >
        {go ? dt(DANCE_COPY.go) : label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// The whole display
// ---------------------------------------------------------------------------------------

export function DanceStage({
  routine,
  names,
  store,
  round,
  beatMs,
  startAt,
  camera,
  mirrored = false,
  cameraOverlay,
  debug,
  syncOffsetMs,
  footer,
  reference = true,
  mutedUntil = null,
}: {
  routine: RoutineData;
  names: { a: string; b: string };
  store: LiveStore;
  round: Pick<RoundState, 'phase' | 'countInAt' | 'goAt'>;
  beatMs: number;
  /** t0 on the nowMs clock (reference playback, the beat bar), null before GO. */
  startAt: number | null;
  /** The live camera view (DancePoseView), or a placeholder. Fills the camera panel. */
  camera: ReactNode;
  /** The camera is the selfie one: its preview is a mirror image (see the layer below). */
  mirrored?: boolean;
  /** Extra layers over the camera panel (the framing guide). */
  cameraOverlay?: ReactNode;
  debug: boolean;
  syncOffsetMs: number;
  footer?: ReactNode;
  /** Show the reference panel (false: a display phone shows it; the camera panel only). */
  reference?: boolean;
  /** The reference's music is silent until this instant (nowMs clock; null: never). */
  mutedUntil?: number | null;
}) {
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== box.width || height !== box.height) setBox({ width, height });
  };
  // Both panels at the CAMERA's shape (9:16 held upright, 16:9 on its side: the frames follow the
  // device), whatever the routine's own: the reference contain-fits inside its panel, the live
  // view keeps its full size. Two wide panels sit one above the other when that is bigger.
  const cameraAspect = useLive(store, (v) => (v.w > 0 && v.h > 0 ? v.w / v.h : CAMERA_ASPECT));
  const { panel, stacked } = reference
    ? stagePanelLayout(box, cameraAspect, PANEL_GAP)
    : { panel: fitPanels(box, cameraAspect, 0, 1), stacked: false };
  return (
    <View style={styles.stage}>
      <BeatBar routine={routine} startAt={startAt} />
      <View style={[styles.panels, stacked && styles.panelsStacked]} onLayout={onLayout}>
        {reference ? (
          <View style={[styles.panel, panel]}>
            <ReferencePanel
              routine={routine}
              startAt={startAt}
              size={panel}
              mutedUntil={mutedUntil}
            />
          </View>
        ) : null}
        <View style={[styles.panel, panel]}>
          {camera}
          {/* The selfie camera's preview is a mirror image, the poses are not: everything drawn
              from them is flipped as one layer, and each piece of text flips itself back. */}
          <View style={[StyleSheet.absoluteFill, mirrored && styles.flipped]} pointerEvents="none">
            <CameraSkeletons store={store} size={panel} />
            <NameTags store={store} size={panel} names={names} flipped={mirrored} />
            <PopupLayer store={store} size={panel} flipped={mirrored} />
          </View>
          {cameraOverlay}
        </View>
        <CountInOverlay round={round} beatMs={beatMs} />
        {debug ? (
          <View style={styles.debugSlot} pointerEvents="none">
            <DebugReadout store={store} syncOffsetMs={syncOffsetMs} />
          </View>
        ) : null}
      </View>
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, gap: half.x15, paddingHorizontal: half.x15, paddingTop: space.x1 },
  panels: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: PANEL_GAP,
  },
  panel: {
    borderRadius: radius.lg,
    backgroundColor: palette.surface,
    overflow: 'hidden',
  },
  panelsStacked: { flexDirection: 'column' },
  flipped: { transform: [{ scaleX: -1 }] },
  flash: { backgroundColor: palette.fill },
  beatBar: { gap: space.x1 },
  beatRow: { flexDirection: 'row', alignItems: 'center', gap: space.x2 },
  beatDots: { flexDirection: 'row', gap: space.x1 },
  beatDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.fill },
  beatDotOn: { backgroundColor: palette.accent },
  nextMove: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: space.x1 },
  nextLabel: { ...type.section },
  nextName: { ...type.heading, flexShrink: 1 },
  clock: { ...type.amount, fontVariant: TABULAR },
  progressTrack: {
    height: 2,
    borderRadius: 1,
    backgroundColor: palette.fill,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: palette.accent },
  countIn: { alignItems: 'center', justifyContent: 'center' },
  scrim: { backgroundColor: palette.black, opacity: 0.45 },
  countNumeral: {
    ...type.moment,
    fontSize: COUNT_NUMERAL_SIZE,
    lineHeight: 176,
    letterSpacing: -4,
    color: palette.text,
  },
  debugSlot: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
