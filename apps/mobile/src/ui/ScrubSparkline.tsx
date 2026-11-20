// The Home sparkline you can scrub (design §2), Robinhood-style: drag a finger along it and a
// hairline with a dot snaps to the nearest balance point, the line right of it greys out, and the
// header above shows that point's balance (ui/figures BalanceHeader). Let go and it all fades
// back to live.
//
// Drawing is the Sparkline's (react-native-svg: a 2 pt monotone-cubic line, end dot and halo);
// the scrub overlays are plain Views moved only by transforms on the UI thread (Reanimated), so
// a scrub costs the JS thread one call per point change (onScrub + a throttled tick haptic),
// never per frame. Vertices come from spark.sparkPoints, the same layout the path is drawn from.
//
// Gesture (react-native-gesture-handler 3, callbacks run as worklets on the UI thread):
// - activates after 6 pt of horizontal travel; 14 pt vertical first fails it (the page keeps its
//   scroll, the operator long-press on the header keeps working);
// - when it activates it cancels the JS responder (RNGH default), so an OperatorHold Pressable
//   around the header cannot fire mid-scrub; a still long-press never activates it.
// Reduce Motion: the scrub still works (direct manipulation); overlays jump instead of fading or
// gliding. Every withTiming passes reduceMotion explicitly.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';

import { feel } from '../device/feedback';
import { indexAtX, SCRUB } from './scrub';
import { SPARK_MIN_POINTS, sparkDirection, sparkGeometry, sparkPoints } from './spark';
import { color, motion, palette, sparkline, type HapticMoment } from './tokens';

const easeOut = Easing.bezier(...motion.easing);

/** The tick on each new point (a selection haptic). */
const SCRUB_TICK: HapticMoment = 'scrubTick';

/** The line's insets, the same as Sparkline's: the halo's room top/bottom/right, the cap left. */
const PAD = sparkline.haloRadius;
/** One sparkline is on screen at a time (Home), so one gradient id is enough. */
const SPARK_AREA_ID = 'balance-spark-area';
const PAD_LEFT = sparkline.strokeWidth / 2;

/**
 * A scrubbable sparkline of `points` (oldest first, finite; pass the same array the header
 * indexes). `onScrub(i)` reports the point under the finger as it changes (touch-down included),
 * `onScrub(null)` when the finger lifts or the gesture fails. `disabled` draws the line but
 * ignores touches (Home: while a payout is pending or its delta is showing). Fills its
 * container's width. Renders nothing under SPARK_MIN_POINTS.
 *
 * Not an accessibility element itself (VoiceOver scrubs through the header's adjustable block);
 * `testID` (default 'balance-spark') stays findable for Maestro.
 */
export function ScrubSparkline({
  points,
  onScrub,
  disabled = false,
  height = sparkline.height,
  tint,
  testID = 'balance-spark',
}: {
  points: readonly number[];
  onScrub: (index: number | null) => void;
  disabled?: boolean;
  height?: number;
  tint?: string;
  testID?: string;
}) {
  const reduce = useReducedMotion();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const verts = useMemo(
    () => sparkPoints(points, width, height, PAD, PAD_LEFT),
    [points, width, height],
  );
  const g = useMemo(
    () => sparkGeometry(points, width, height, PAD, PAD_LEFT),
    [points, width, height],
  );
  const dir = sparkDirection(points);
  const stroke =
    tint ?? (dir > 0 ? color.positive : dir < 0 ? color.negative : palette.textSecondary);

  // UI-thread copies of the layout the worklets read.
  const xs = useSharedValue<number[]>([]);
  const ys = useSharedValue<number[]>([]);
  const boxW = useSharedValue(0);
  useEffect(() => {
    xs.value = verts.map((p) => p.x);
    ys.value = verts.map((p) => p.y);
    boxW.value = width;
  }, [xs, ys, boxW, verts, width]);

  // Scrub state: the point under the finger (-1 none), where the overlays sit, how visible.
  const at = useSharedValue(-1);
  const px = useSharedValue(0);
  const py = useSharedValue(0);
  const shown = useSharedValue(0);

  // JS side: stable callbacks the worklets schedule, reading the latest onScrub.
  const onScrubRef = useRef(onScrub);
  useEffect(() => {
    onScrubRef.current = onScrub;
  });
  const lastTick = useRef(0);
  const report = useCallback((i: number, tick: boolean) => {
    onScrubRef.current(i);
    if (!tick) return;
    const now = Date.now();
    if (now - lastTick.current < SCRUB.tickMinGapMs) return;
    lastTick.current = now;
    feel(SCRUB_TICK);
  }, []);
  const release = useCallback(() => onScrubRef.current(null), []);

  // A scrub left showing when the control turns off (a payout lands mid-scrub) is cleared.
  useEffect(() => {
    if (!disabled) return;
    at.value = -1;
    shown.value = 0;
  }, [disabled, at, shown]);

  const fade = (to: number) => {
    'worklet';
    return reduce
      ? to
      : withTiming(to, {
          duration: SCRUB.fadeMs,
          easing: easeOut,
          reduceMotion: ReduceMotion.Never,
        });
  };
  const glide = (to: number) => {
    'worklet';
    return reduce
      ? to
      : withTiming(to, {
          duration: SCRUB.glideMs,
          easing: easeOut,
          reduceMotion: ReduceMotion.Never,
        });
  };

  const pan = usePanGesture({
    enabled: !disabled && verts.length >= SPARK_MIN_POINTS,
    activeOffsetX: [-SCRUB.activeOffsetX, SCRUB.activeOffsetX],
    failOffsetY: [-SCRUB.failOffsetY, SCRUB.failOffsetY],
    hitSlop: { top: SCRUB.hitSlopY, bottom: SCRUB.hitSlopY },
    shouldCancelWhenOutside: false,
    onBegin: (e) => {
      'worklet';
      const vx = xs.value;
      const n = vx.length;
      if (n < SPARK_MIN_POINTS) return;
      const i = indexAtX(e.x, n, boxW.value, PAD, PAD_LEFT);
      at.value = i;
      px.value = vx[i] ?? 0;
      py.value = ys.value[i] ?? 0;
      shown.value = fade(1);
      scheduleOnRN(report, i, false);
    },
    onUpdate: (e) => {
      'worklet';
      const vx = xs.value;
      const n = vx.length;
      if (n < SPARK_MIN_POINTS || at.value < 0) return;
      const i = indexAtX(e.x, n, boxW.value, PAD, PAD_LEFT);
      if (i === at.value) return;
      at.value = i;
      px.value = glide(vx[i] ?? 0);
      py.value = glide(ys.value[i] ?? 0);
      scheduleOnRN(report, i, true);
    },
    onFinalize: () => {
      'worklet';
      if (at.value < 0) return;
      at.value = -1;
      shown.value = fade(0);
      scheduleOnRN(release);
    },
  });

  const hairline = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateX: px.value - SCRUB.hairline / 2 }],
  }));
  const dim = useAnimatedStyle(() => ({
    opacity: shown.value * SCRUB.dimOpacity,
    transform: [{ translateX: px.value }],
  }));
  const halo = useAnimatedStyle(() => ({
    opacity: shown.value * SCRUB.haloOpacity,
    transform: [{ translateX: px.value - SCRUB.halo }, { translateY: py.value - SCRUB.halo }],
  }));
  const dot = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateX: px.value - SCRUB.dot }, { translateY: py.value - SCRUB.dot }],
  }));

  if (points.length < SPARK_MIN_POINTS) return null;
  return (
    <GestureDetector gesture={pan}>
      <View testID={testID} style={[styles.box, { height }]} onLayout={onLayout} accessible={false}>
        {g.d ? (
          <Svg width={width} height={height}>
            {/* The wash under the line: its own colour, fading to nothing at the floor. */}
            {g.end && verts[0] ? (
              <>
                <Defs>
                  <LinearGradient id={SPARK_AREA_ID} x1="0" y1="0" x2="0" y2="1">
                    <Stop offset={0} stopColor={stroke} stopOpacity={sparkline.areaOpacity} />
                    <Stop offset={1} stopColor={stroke} stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Path
                  d={`${g.d} L${g.end.x} ${height} L${verts[0].x} ${height} Z`}
                  fill={`url(#${SPARK_AREA_ID})`}
                />
              </>
            ) : null}
            <Path
              d={g.d}
              stroke={stroke}
              strokeWidth={sparkline.strokeWidth}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill="none"
            />
            {g.end ? (
              <>
                <Circle
                  cx={g.end.x}
                  cy={g.end.y}
                  r={sparkline.haloRadius}
                  fill={stroke}
                  opacity={sparkline.haloOpacity}
                />
                <Circle cx={g.end.x} cy={g.end.y} r={sparkline.endDot} fill={stroke} />
              </>
            ) : null}
          </Svg>
        ) : null}
        {/* The "future" (right of the hairline) greys out under a black wash, clipped to the box. */}
        <View style={styles.clip} pointerEvents="none">
          <Animated.View style={[styles.dim, { width }, dim]} />
        </View>
        <Animated.View pointerEvents="none" style={[styles.hairline, hairline]} />
        <Animated.View
          pointerEvents="none"
          style={[styles.halo, { backgroundColor: stroke }, halo]}
        />
        <Animated.View
          pointerEvents="none"
          style={[styles.dot, { backgroundColor: stroke }, dot]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  box: { width: '100%' },
  clip: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
  dim: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: palette.black },
  hairline: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: SCRUB.hairline,
    backgroundColor: palette.textTertiary,
  },
  halo: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCRUB.halo * 2,
    height: SCRUB.halo * 2,
    borderRadius: SCRUB.halo,
  },
  dot: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCRUB.dot * 2,
    height: SCRUB.dot * 2,
    borderRadius: SCRUB.dot,
  },
});
