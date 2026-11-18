// SkeletonRows: History while its first page loads. Rows shaped like the real hairline rows (a
// 40 pt disc, a title bar, the amount over its caption on the right), all in #1C1C1F, pulsing
// together in opacity (1 <-> 0.45, 1100 ms each way, sine in-out) on the UI thread. No gradient
// shimmer: the tokens ban gradients. One accessible element reading "Loading".
//
// Reduce Motion: still, at 0.75.
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { COPY, t } from '../screens/copy';
import { half, palette, space, color } from './tokens';
import { skeleton, skeletonTitleFraction } from './polish';

export function SkeletonRows({
  count = 6,
  testID = 'history-loading',
  accessibilityLabel,
}: {
  count?: number;
  testID?: string;
  /** Defaults to "Loading" (COPY.app.loading). */
  accessibilityLabel?: string;
}) {
  const reduced = useReducedMotion();
  const o = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      cancelAnimation(o);
      o.value = skeleton.reducedOpacity;
      return;
    }
    o.value = 1;
    o.value = withRepeat(
      withTiming(skeleton.low, {
        duration: skeleton.pulseMs,
        easing: Easing.inOut(Easing.sin),
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      true,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(o);
  }, [reduced, o]);

  const pulse = useAnimatedStyle(() => ({ opacity: o.value }));

  return (
    <Animated.View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel ?? t(COPY.app.loading)}
      accessibilityState={{ busy: true }}
      style={pulse}
    >
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.row}>
          <View style={styles.disc} />
          <View style={styles.text}>
            <View style={styles.titleCol}>
              <View style={[styles.bar, { width: `${skeletonTitleFraction(i) * 100}%` }]} />
            </View>
            <View style={styles.result}>
              <View style={[styles.bar, styles.amount]} />
              <View style={[styles.bar, styles.caption]} />
            </View>
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // HomeScreens `historyRow`: 72 pt min, 16 pt gaps, a hairline under each row.
  row: {
    minHeight: space.x8 + space.x1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: half.x15 + half.x05,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.divider,
  },
  disc: {
    width: skeleton.disc,
    height: skeleton.disc,
    borderRadius: skeleton.disc / 2,
    backgroundColor: palette.fill,
  },
  text: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: half.x15 + half.x05 },
  titleCol: { flex: 1 },
  result: { alignItems: 'flex-end', gap: half.x05 + 2 },
  bar: { height: skeleton.bar, borderRadius: skeleton.bar / 2, backgroundColor: palette.fill },
  amount: { width: skeleton.amountWidth },
  caption: {
    width: skeleton.captionWidth,
    height: skeleton.caption,
    borderRadius: skeleton.caption / 2,
  },
});
