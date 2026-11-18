// Swipe up to confirm: the deliberate intent before money moves (it replaces the 800 ms hold).
// The standard 56 pt green pill; swiping up stretches it toward the thumb (a cap pill lifts, a
// bridge fills the gap), ticks at 25/50/75 %, arms at full travel with a firm tap and a tick
// glyph, and commits ON RELEASE (or on a fast flick from 60 % up). Sliding back down before
// letting go backs out. A tap never commits: it nudges the pill and shows the hint.
//
// Everything visual runs on the UI thread (reanimated worklets, transforms only, no layout);
// the JS thread hears only the start, the tick/arm crossings and the release.
//
// Security contract: `onComplete` is the deliberate intent only; the caller still runs device
// auth (Face ID) after it. It fires on release, never mid-drag, never for a canceled gesture,
// at most once per gesture, and not if the control turned disabled or busy meanwhile.
//
// Accessibility: one button element (label, state, an `activate` action that calls
// `onComplete`), exactly like HoldToConfirm, so VoiceOver users double-tap and Face ID follows.
//
// Reduce Motion: the stretch still follows the finger (direct manipulation); no idle bob, no
// nudge, no press scale; the settle and the tick swap are instant.
import { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import {
  GestureDetector,
  usePanGesture,
  useTapGesture,
  useCompetingGestures,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { feel } from '../device/feedback';
import {
  SWIPE,
  bridgeScale,
  liftVelocity,
  swipeArmed,
  swipeLift,
  swipeOutcome,
  swipeProgress,
  ticksCrossed,
} from './swipe';
import { color, motion, palette, radius, space, type HapticMoment, type } from './tokens';

const NEVER = ReduceMotion.Never;
const easeOut = Easing.bezier(...motion.easing);
const PILL = space.control;
const BRIDGE_H = SWIPE.travel + SWIPE.maxOverdrag;

type SwipeHaptic = Extract<HapticMoment, 'swipeTick' | 'swipeArmed'>;
function buzz(m: SwipeHaptic): void {
  feel(m);
}

export type SwipeToConfirmProps = {
  /** "Swipe up to lock in $5", "GG". Also the VoiceOver label and the `activate` action name. */
  label: string;
  /** Shown in place of the label for a moment after a tap ("Swipe up"). */
  hint?: string;
  disabled?: boolean;
  /** Work in flight: a spinner replaces the content and the gesture is off. */
  busy?: boolean;
  /** The swipe started moving (the Lock screen plays `holdStart` here). */
  onStart?: () => void;
  /** The deliberate intent: a committed release, or VoiceOver's activate. */
  onComplete: () => void;
  testID?: string;
};

export function SwipeToConfirm({
  label,
  hint,
  disabled = false,
  busy = false,
  onStart,
  onComplete,
  testID,
}: SwipeToConfirmProps) {
  const reduced = useReducedMotion();
  const live = !disabled && !busy;

  // --- JS side: the latest callbacks, and the once-per-gesture guard ----------------------
  const onStartRef = useRef(onStart);
  const onCompleteRef = useRef(onComplete);
  const offRef = useRef(!live);
  const firedRef = useRef(false);
  onStartRef.current = onStart;
  onCompleteRef.current = onComplete;
  offRef.current = !live;

  const beginJS = useCallback(() => {
    firedRef.current = false;
  }, []);
  const startJS = useCallback(() => {
    if (!offRef.current) onStartRef.current?.();
  }, []);
  const completeJS = useCallback(() => {
    if (offRef.current || firedRef.current) return;
    firedRef.current = true;
    onCompleteRef.current();
  }, []);

  // --- UI side -----------------------------------------------------------------------------
  /** The stretch, in points (0 at rest). */
  const lift = useSharedValue(0);
  /** Progress at the last update, for the tick crossings. */
  const lastP = useSharedValue(0);
  /** 1 while armed (a release commits). */
  const armed = useSharedValue(0);
  /** 0 = chevron, 1 = tick (the crossfade). */
  const tickV = useSharedValue(0);
  /** 0 = label, 1 = hint (the crossfade). */
  const hintV = useSharedValue(0);
  /** Touch-down press feedback. */
  const pressV = useSharedValue(0);
  /** The idle bob, 0..1. */
  const bobV = useSharedValue(0);
  const reducedSV = useSharedValue(reduced);

  useEffect(() => {
    reducedSV.value = reduced;
  }, [reduced, reducedSV]);

  // Idle bob: only while live, still and motion is allowed.
  useEffect(() => {
    if (!live || reduced) {
      cancelAnimation(bobV);
      bobV.value = 0;
      return;
    }
    const up = withTiming(1, { duration: SWIPE.bobMs, easing: easeOut, reduceMotion: NEVER });
    const down = withTiming(0, { duration: SWIPE.bobMs, easing: easeOut, reduceMotion: NEVER });
    bobV.value = withRepeat(
      withSequence(withDelay(SWIPE.bobEveryMs - 2 * SWIPE.bobMs, up), down),
      -1,
      false,
    );
    return () => cancelAnimation(bobV);
  }, [live, reduced, bobV]);

  // Leaving the live state mid-anything: put the pill back at rest.
  useEffect(() => {
    if (live) return;
    cancelAnimation(lift);
    cancelAnimation(hintV);
    lift.value = 0;
    lastP.value = 0;
    armed.value = 0;
    hintV.value = 0;
  }, [live, lift, lastP, armed, hintV]);

  const pan = usePanGesture({
    enabled: live,
    activeOffsetY: -SWIPE.activateOffset,
    failOffsetY: SWIPE.failOffsetDown,
    failOffsetX: [-SWIPE.failOffsetX, SWIPE.failOffsetX],
    onBegin: () => {
      'worklet';
      scheduleOnRN(beginJS);
      pressV.value = withTiming(1, {
        duration: SWIPE.pressInMs,
        easing: easeOut,
        reduceMotion: NEVER,
      });
    },
    onActivate: () => {
      'worklet';
      cancelAnimation(lift);
      cancelAnimation(hintV);
      hintV.value = 0;
      lastP.value = swipeProgress(lift.value);
      scheduleOnRN(startJS);
    },
    onUpdate: (e) => {
      'worklet';
      const l = swipeLift(e.translationY);
      lift.value = l;
      const p = swipeProgress(l);
      if (ticksCrossed(lastP.value, p) > 0 && !swipeArmed(l)) scheduleOnRN(buzz, 'swipeTick');
      lastP.value = p;
      const isArmed = swipeArmed(l);
      if (isArmed && armed.value === 0) {
        armed.value = 1;
        scheduleOnRN(buzz, 'swipeArmed');
        tickV.value = reducedSV.value
          ? 1
          : withTiming(1, { duration: SWIPE.armMs, easing: easeOut, reduceMotion: NEVER });
      } else if (!isArmed && armed.value === 1) {
        // Backing out: disarm silently.
        armed.value = 0;
        tickV.value = reducedSV.value
          ? 0
          : withTiming(0, { duration: SWIPE.armMs, easing: easeOut, reduceMotion: NEVER });
      }
    },
    onDeactivate: (e) => {
      'worklet';
      const outcome = swipeOutcome({
        lift: lift.value,
        velocityY: e.velocityY,
        canceled: e.canceled,
      });
      armed.value = 0;
      lastP.value = 0;
      if (outcome === 'commit') {
        scheduleOnRN(completeJS);
        // The tick shows for a beat, then the chevron returns.
        const instant = reducedSV.value;
        tickV.value = withSequence(
          withTiming(1, {
            duration: instant ? 0 : SWIPE.armMs,
            easing: easeOut,
            reduceMotion: NEVER,
          }),
          withDelay(
            SWIPE.successHoldMs,
            withTiming(0, {
              duration: instant ? 0 : motion.fastMs,
              easing: easeOut,
              reduceMotion: NEVER,
            }),
          ),
        );
      } else {
        tickV.value = reducedSV.value
          ? 0
          : withTiming(0, { duration: SWIPE.armMs, easing: easeOut, reduceMotion: NEVER });
      }
      if (reducedSV.value) {
        lift.value = 0;
      } else {
        lift.value = withSpring(0, {
          ...motion.settle,
          velocity: liftVelocity(e.velocityY),
          reduceMotion: NEVER,
        });
      }
    },
    onFinalize: () => {
      'worklet';
      pressV.value = withTiming(0, {
        duration: SWIPE.pressOutMs,
        easing: easeOut,
        reduceMotion: NEVER,
      });
    },
  });

  // A tap is not a commit: nudge the pill up and show the hint, then settle.
  const tap = useTapGesture({
    enabled: live,
    onActivate: () => {
      'worklet';
      const instant = reducedSV.value;
      if (!instant) {
        lift.value = withSequence(
          withTiming(SWIPE.nudgeLift, {
            duration: SWIPE.nudgeMs,
            easing: easeOut,
            reduceMotion: NEVER,
          }),
          withSpring(0, { ...motion.settle, reduceMotion: NEVER }),
        );
      }
      if (hint) {
        hintV.value = withSequence(
          withTiming(1, {
            duration: instant ? 0 : motion.fastMs,
            easing: easeOut,
            reduceMotion: NEVER,
          }),
          withDelay(
            SWIPE.hintMs,
            withTiming(0, {
              duration: instant ? 0 : motion.fastMs,
              easing: easeOut,
              reduceMotion: NEVER,
            }),
          ),
        );
      }
    },
    onFinalize: () => {
      'worklet';
      pressV.value = withTiming(0, {
        duration: SWIPE.pressOutMs,
        easing: easeOut,
        reduceMotion: NEVER,
      });
    },
  });

  const gesture = useCompetingGestures(pan, tap);

  // --- Styles (transforms and opacity only) ------------------------------------------------
  const rootStyle = useAnimatedStyle(() =>
    reducedSV.value
      ? { opacity: 1 - 0.15 * pressV.value, transform: [{ scale: 1 }] }
      : { opacity: 1, transform: [{ scale: 1 - (1 - SWIPE.pressScale) * pressV.value }] },
  );
  const bridgeStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: bridgeScale(lift.value) }],
  }));
  const capStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -lift.value }] }));
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -lift.value / 2 }] }));
  const chevronStyle = useAnimatedStyle(() => ({
    opacity: 1 - tickV.value,
    transform: [
      { translateY: -SWIPE.bobRise * bobV.value * (1 - swipeProgress(lift.value)) },
      { rotate: '45deg' },
    ],
  }));
  const tickStyle = useAnimatedStyle(() => ({ opacity: tickV.value }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: 1 - hintV.value }));
  const hintStyle = useAnimatedStyle(() => ({ opacity: hintV.value }));

  const ink = disabled ? palette.textTertiary : color.onAccent;
  const fill = disabled ? palette.fill : color.primaryAction;

  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName !== 'activate' || !live) return;
    onCompleteRef.current();
  };

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        testID={testID}
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, busy }}
        accessibilityActions={[{ name: 'activate', label }]}
        onAccessibilityAction={onAccessibilityAction}
        style={[styles.root, { backgroundColor: fill }, rootStyle]}
      >
        {live ? (
          <>
            <Animated.View
              pointerEvents="none"
              style={[styles.bridge, { backgroundColor: fill }, bridgeStyle]}
            />
            <Animated.View
              pointerEvents="none"
              style={[styles.cap, { backgroundColor: fill }, capStyle]}
            />
          </>
        ) : null}
        {busy ? (
          <ActivityIndicator color={color.onAccent} />
        ) : (
          <Animated.View pointerEvents="none" style={[styles.content, contentStyle]}>
            <View style={styles.glyph}>
              <Animated.View style={[styles.chevron, { borderColor: ink }, chevronStyle]} />
              <Animated.View style={[styles.tickBox, tickStyle]}>
                <View style={[styles.tick, { borderColor: ink }]} />
              </Animated.View>
            </View>
            <View>
              {/* Sizes the text box to the longer of label and hint, so the crossfade never
                  reflows or truncates. Invisible, and not read by VoiceOver (the root is). */}
              <Text style={[type.button, styles.spacer]} numberOfLines={1}>
                {hint && hint.length > label.length ? hint : label}
              </Text>
              <Animated.Text
                style={[type.button, styles.layer, { color: ink }, labelStyle]}
                numberOfLines={1}
              >
                {label}
              </Animated.Text>
              {hint ? (
                <Animated.Text
                  style={[type.button, styles.layer, { color: ink }, hintStyle]}
                  numberOfLines={1}
                >
                  {hint}
                </Animated.Text>
              ) : null}
            </View>
          </Animated.View>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

const G = SWIPE.chevron;

const styles = StyleSheet.create({
  root: {
    height: PILL,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.x3,
    // The stretch draws over the status and alert lines above it.
    zIndex: 1,
  },
  bridge: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: PILL / 2,
    height: BRIDGE_H,
    transformOrigin: 'bottom',
  },
  cap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: PILL,
    borderRadius: radius.pill,
  },
  content: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.x1,
    paddingHorizontal: space.x3,
  },
  glyph: { width: G + 4, height: G + 4, alignItems: 'center', justifyContent: 'center' },
  // An up-chevron: a square's top-left corner, rotated 45 degrees; nudged down to sit optically
  // centred.
  chevron: {
    position: 'absolute',
    width: G * 0.7,
    height: G * 0.7,
    top: (G + 4) / 2 - G * 0.2,
    borderTopWidth: 2,
    borderLeftWidth: 2,
  },
  tickBox: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  // A tick: a tall box's bottom-right corner, rotated 45 degrees.
  tick: {
    width: G * 0.45,
    height: G * 0.85,
    marginTop: -G * 0.2,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    transform: [{ rotate: '45deg' }],
  },
  spacer: { opacity: 0 },
  layer: { position: 'absolute', left: 0, right: 0, top: 0, textAlign: 'center' },
});
