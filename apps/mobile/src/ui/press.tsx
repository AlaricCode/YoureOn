// PressScale: a Pressable that gives under the finger. Pressed, it scales to 0.97 and dims to
// 0.85 over 90 ms; released, it comes back over 150 ms. Both run on the UI thread (reanimated).
// It is still a plain RN Pressable underneath, so testID, accessibility props and Maestro taps
// behave exactly as before. No haptics: plain presses stay silent so the haptics that mean
// something (lock, payout) keep their weight.
//
// Reduce Motion: no scale; the old pressed dim (0.7), instantly.
import { useEffect } from 'react';
import {
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { press, pressAt } from './polish';
import { motion } from './tokens';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const easeOut = Easing.bezier(...motion.easing);

export type PressScaleProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Pressed scale: 0.97 for buttons (default), `press.chipScale`, `press.avatarScale`. */
  scaleTo?: number;
  /**
   * Whether it responds visually. Defaults to "not disabled and has a press handler", so a button
   * rendered with `onPress={undefined}` (BaseButton when off) never gives.
   */
  active?: boolean;
};

export function PressScale({
  style,
  scaleTo = press.scale,
  active,
  onPressIn,
  onPressOut,
  children,
  ...rest
}: PressScaleProps) {
  const reduced = useReducedMotion();
  const enabled = active ?? (!rest.disabled && (rest.onPress != null || rest.onLongPress != null));
  const amt = useSharedValue(0);
  // The caller's own opacity (BaseButton's 0.35 "dimmed") is the base the press dims from; the
  // animated style sets opacity last, so it has to carry it.
  const base = StyleSheet.flatten(style)?.opacity ?? 1;

  // Turned off mid-press (busy, disabled): back to rest without waiting for the release.
  useEffect(() => {
    if (!enabled) amt.value = 0;
  }, [enabled, amt]);

  const animated = useAnimatedStyle(() => {
    const p = pressAt(amt.value, reduced, scaleTo);
    return { opacity: base * p.opacity, transform: [{ scale: p.scale }] };
  });

  const handleIn = (e: GestureResponderEvent) => {
    if (enabled) {
      amt.value = reduced
        ? 1
        : withTiming(1, {
            duration: press.inMs,
            easing: easeOut,
            reduceMotion: ReduceMotion.Never,
          });
    }
    onPressIn?.(e);
  };
  const handleOut = (e: GestureResponderEvent) => {
    amt.value = reduced
      ? 0
      : withTiming(0, {
          duration: press.outMs,
          easing: easeOut,
          reduceMotion: ReduceMotion.Never,
        });
    onPressOut?.(e);
  };

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={handleIn}
      onPressOut={handleOut}
      style={[style, animated]}
    >
      {children}
    </AnimatedPressable>
  );
}
