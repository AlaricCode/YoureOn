// A countdown bar that drains smoothly on the UI thread: the same 2 pt hairline track and white
// fill as CountdownBar, but one linear animation to empty instead of a width re-render every tick
// (which stepped at 2-5 fps). It re-syncs whenever `endsAtMs` or `windowMs` changes.
//
// The drain is information, not decoration, so it runs under Reduce Motion too (a steady linear
// shrink, no easing, nothing moving across the screen). `reduceMotion: Never` is deliberate:
// reanimated's default would jump it to empty at once.
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { drainFrom } from './swipe';
import { half, palette } from './tokens';

export function DrainBar({
  endsAtMs,
  windowMs,
  testID,
}: {
  /** When the bar is empty (epoch ms, the same clock as Date.now()). */
  endsAtMs: number;
  /** The full bar's length in ms. */
  windowMs: number;
  testID?: string;
}) {
  const k = useSharedValue(drainFrom(endsAtMs, windowMs, Date.now()).fraction);

  useEffect(() => {
    const { fraction, holdMs, drainMs } = drainFrom(endsAtMs, windowMs, Date.now());
    cancelAnimation(k);
    k.value = fraction;
    if (drainMs > 0) {
      k.value = withDelay(
        holdMs,
        withTiming(0, {
          duration: drainMs,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
        ReduceMotion.Never,
      );
    }
    return () => cancelAnimation(k);
  }, [endsAtMs, windowMs, k]);

  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: k.value }] }));

  return (
    <View
      testID={testID}
      style={styles.track}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[styles.fill, fillStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 2,
    borderRadius: 1,
    backgroundColor: palette.hairline,
    overflow: 'hidden',
    marginTop: half.x05,
  },
  fill: {
    height: 2,
    width: '100%',
    borderRadius: 1,
    backgroundColor: palette.text,
    transformOrigin: 'left',
  },
});
