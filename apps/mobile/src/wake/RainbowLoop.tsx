// RainbowLoop: the "Jarvis" activation light. A crisp spectrum loop that travels clockwise around
// the physical screen edge, following the display's rounded corners, with a soft breathing glow
// inside it (think the Apple Intelligence edge glow, as a clean rotating rainbow).
//
// Mount it once, last, at the root of the screen tree (a full-screen absolute overlay above
// everything; it never takes a touch and is hidden from VoiceOver: announce "Listening" from the
// screen that owns the mic). Safe areas are NOT applied: it hugs the glass.
//
// Drawing (react-native-svg): the same rounded rectangle (wake/spectrum loopGeometry, ON the edge
// so half of each stroke falls off the glass) drawn once per hue, each a single dash placed along
// the loop. Two layers, two Svg canvases:
// - glow: 24 hues, an opaque 22 pt band plus a 48 pt halo at 0.4 inside it, the whole canvas
//   faded to ~0.35-0.55 and breathing (view opacity, composited, so the band's overlaps never
//   double up);
// - core: 36 hues, a 7 pt line (3.5 pt visible), opaque.
// Motion (Reanimated, UI thread only; the JS thread renders on mount, unmount and mode change,
// never per frame): one frame callback advances the phase (turns) at the mode's speed; every
// dash's strokeDashoffset derives from it (useAnimatedProps); the mode mix (1 listening,
// 0 thinking) glides over one transition, so the speed and brightness cross over instead of
// jumping. The layers unmount once the fade-out finishes, and the frame callback stops with them.
//
// Reduce Motion: no sweep and no breathing; the spectrum border sits still and fades in and out.
// Every withTiming / withRepeat passes reduceMotion explicitly (ui/__tests__/motionAudit).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type FrameInfo,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path, type PathProps } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';

import { motion } from '../ui/tokens';
import {
  advancePhase,
  coreOpacity,
  dashOffset,
  displayCornerRadius,
  glowOpacity,
  LOOP,
  loopGeometry,
  segmentDashes,
  spectrumColors,
  type LoopSegment,
} from './spectrum';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const easeOut = Easing.bezier(...motion.easing);
const NEVER = ReduceMotion.Never;

export type RainbowLoopMode = 'listening' | 'thinking';

export type RainbowLoopProps = {
  /** Shown (fades in) while true; fades out and unmounts its layers when false. */
  active: boolean;
  /** listening: brighter, faster sweep (default). thinking: calmer, slower, a little dimmer. */
  mode?: RainbowLoopMode;
  /** The display's corner radius (pt). Defaults to the known radius for this screen size. */
  cornerRadius?: number;
  testID?: string;
};

export function RainbowLoop({
  active,
  mode = 'listening',
  cornerRadius,
  testID = 'rainbow-loop',
}: RainbowLoopProps) {
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();

  // Layers exist from activation until the fade-out finishes.
  const [mounted, setMounted] = useState(active);
  const activeRef = useRef(active);

  const fade = useSharedValue(0);
  const phase = useSharedValue(0);
  const level = useSharedValue(mode === 'listening' ? 1 : 0);
  const breath = useSharedValue(0.5);

  // A fade-out that finished after the loop was switched back on must not unmount it (and if
  // one slips in before the effect below records the switch, that effect mounts it again).
  const onFadedOut = useCallback(() => {
    if (!activeRef.current) setMounted(false);
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (active) {
      setMounted(true);
      fade.value = withTiming(1, {
        duration: LOOP.fadeInMs,
        easing: easeOut,
        reduceMotion: NEVER,
      });
    } else {
      fade.value = withTiming(
        0,
        { duration: LOOP.fadeOutMs, easing: easeOut, reduceMotion: NEVER },
        (finished) => {
          'worklet';
          if (finished) scheduleOnRN(onFadedOut);
        },
      );
    }
  }, [active, fade, onFadedOut]);

  useEffect(() => {
    level.value = withTiming(mode === 'listening' ? 1 : 0, {
      duration: LOOP.modeMs,
      easing: easeOut,
      reduceMotion: NEVER,
    });
  }, [mode, level]);

  // The sweep: one callback per frame on the UI thread, only while the layers are up.
  const tick = useCallback(
    (frame: FrameInfo) => {
      'worklet';
      phase.value = advancePhase(phase.value, frame.timeSincePreviousFrame, level.value);
    },
    [phase, level],
  );
  const frames = useFrameCallback(tick, false);
  const moving = mounted && !reduced;

  useEffect(() => {
    frames.setActive(moving);
    if (moving) {
      breath.value = 0;
      breath.value = withRepeat(
        withTiming(1, {
          duration: LOOP.breathMs,
          easing: Easing.inOut(Easing.sin),
          reduceMotion: NEVER,
        }),
        -1,
        true,
        undefined,
        NEVER,
      );
    } else {
      cancelAnimation(breath);
      breath.value = 0.5;
    }
    return () => cancelAnimation(breath);
  }, [moving, frames, breath]);

  const radius = cornerRadius ?? displayCornerRadius(width, height);
  const geometry = useMemo(() => loopGeometry(width, height, radius, 0), [width, height, radius]);
  const core = useMemo(
    () => ({
      segments: segmentDashes(geometry.length, LOOP.coreSegments),
      colors: spectrumColors(LOOP.coreSegments),
    }),
    [geometry.length],
  );
  const glow = useMemo(
    () => ({
      segments: segmentDashes(geometry.length, LOOP.glowSegments),
      // The halo is translucent within its layer: no overlap, so neighbours never double up.
      halos: segmentDashes(geometry.length, LOOP.glowSegments, 0),
      colors: spectrumColors(LOOP.glowSegments),
    }),
    [geometry.length],
  );

  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glowOpacity(breath.value, level.value) }));
  const coreStyle = useAnimatedStyle(() => ({ opacity: coreOpacity(level.value) }));

  if (!mounted || geometry.length <= 0) return null;

  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.overlay, fadeStyle]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, glowStyle]}>
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          {glow.segments.map((s, i) => (
            <GlowSegment
              key={i}
              d={geometry.d}
              length={geometry.length}
              segment={s}
              halo={glow.halos[i] ?? s}
              stroke={glow.colors[i] ?? 'none'}
              phase={phase}
            />
          ))}
        </Svg>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, coreStyle]}>
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          {core.segments.map((s, i) => (
            <CoreSegment
              key={i}
              d={geometry.d}
              length={geometry.length}
              segment={s}
              stroke={core.colors[i] ?? 'none'}
              phase={phase}
            />
          ))}
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}

type SegmentProps = {
  d: string;
  length: number;
  segment: LoopSegment;
  stroke: string;
  phase: SharedValue<number>;
};

/** One hue of the crisp line. */
const CoreSegment = memo(function CoreSegment({ d, length, segment, stroke, phase }: SegmentProps) {
  const start = segment.start;
  const animatedProps = useAnimatedProps<PathProps>(() => ({
    strokeDashoffset: dashOffset(start, phase.value, length),
  }));
  return (
    <AnimatedPath
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={LOOP.coreWidth}
      strokeLinecap="butt"
      strokeDasharray={segment.dash}
      animatedProps={animatedProps}
    />
  );
});

/**
 * One hue of the glow: the wide translucent halo, then the opaque band over it. Both start at the
 * same place, so they share one animated offset (Reanimated drives every view an animated-props
 * object is attached to).
 */
const GlowSegment = memo(function GlowSegment({
  d,
  length,
  segment,
  halo,
  stroke,
  phase,
}: SegmentProps & { halo: LoopSegment }) {
  const start = segment.start;
  const animatedProps = useAnimatedProps<PathProps>(() => ({
    strokeDashoffset: dashOffset(start, phase.value, length),
  }));
  return (
    <>
      <AnimatedPath
        d={d}
        fill="none"
        stroke={stroke}
        strokeOpacity={LOOP.haloOpacity}
        strokeWidth={LOOP.haloWidth}
        strokeLinecap="butt"
        strokeDasharray={halo.dash}
        animatedProps={animatedProps}
      />
      <AnimatedPath
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={LOOP.glowWidth}
        strokeLinecap="butt"
        strokeDasharray={segment.dash}
        animatedProps={animatedProps}
      />
    </>
  );
});

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: LOOP.zIndex,
  },
});
