// The app's mark, its wordmark and the in-app splash. The mark is the logo (two figures in a high
// five, white and green: assets/logo-mark.png, the artwork of assets/splash-icon.png with its
// empty margin trimmed off); the wordmark is the mark with the name beside it in bold (the top of
// Home). SplashView repeats the native splash (app.json expo-splash-screen:
// assets/splash-icon.png at 180 pt, centred on black #000000) so the hand-off from the native
// launch screen to JS has no jump: the mark is pinned to the centre of the window (not of the
// view, which may sit under other chrome), and the boot state is absolutely placed 24 pt under
// it, so it never pushes the mark: loading, or "Can't connect" with a retry. `bare` shows the
// mark alone (the app root, while fonts load).
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COPY, t } from '../screens/copy';
import { Label, PrimaryButton, useColumn } from './kit';
import { DotsLabel, useReduceMotion } from './parts';
import { dp, motion, palette, space, type } from './tokens';
import { typographic } from './typography';

/** The logo artwork, trimmed to its edges (961 x 591 px, transparent around it). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const LOGO = require('../../assets/logo-mark.png') as number;
/** The mark's height over its width. */
export const MARK_ASPECT = 591 / 961;

/** The logo at `width` wide (its height follows: MARK_ASPECT). */
export function AppMark({
  width = 98,
  lit = false,
}: {
  width?: number;
  /** A bloom of green light behind the mark (the first screen: the light is on). */
  lit?: boolean;
}) {
  const height = width * MARK_ASPECT;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="You're On"
      style={{ width, height }}
    >
      {lit ? <View style={[styles.bloom, bloomBox(width, height)]} pointerEvents="none" /> : null}
      <Image source={LOGO} style={{ width, height }} resizeMode="contain" fadeDuration={0} />
    </View>
  );
}

/**
 * The light behind the mark: a point under the two hands whose shadow spreads into a round glow.
 * (A box with a shadow showed as a dark rectangle between the figures.)
 */
const bloomBox = (width: number, height: number) => ({
  left: width / 2 - 1,
  top: height * 0.55,
  width: 2,
  height: 2,
  borderRadius: 1,
  // filled, or the point itself shows as a dark speck in its own light
  backgroundColor: BLOOM_COLOR,
  boxShadow: `0 0 ${Math.round(width * 0.34)}px ${Math.round(width * 0.16)}px ${BLOOM_COLOR}`,
});
/** The app's green light, soft enough to sit behind white and lime artwork. */
const BLOOM_COLOR = 'rgba(0, 212, 122, 0.3)';

/**
 * The mark coming on: it starts dim and a little small and comes up once, `delayMs` after it
 * appears, with its bloom. The lock moment, where the name of the app happens. One move,
 * ease-out, inside the moment budget; Reduce Motion: it is simply on.
 */
export function MarkOn({ width = 98, delayMs = 0 }: { width?: number; delayMs?: number }) {
  const reduced = useReduceMotion();
  const k = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced === null) return;
    if (reduced) {
      k.setValue(1);
      return;
    }
    const a = Animated.timing(k, {
      toValue: 1,
      duration: motion.momentMs,
      delay: delayMs,
      easing: Easing.bezier(...motion.easing),
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [k, reduced, delayMs]);
  const height = width * MARK_ASPECT;
  const opacity = k.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] });
  const scale = k.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] });
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="On" style={{ width, height }}>
      <Animated.View
        style={[styles.bloom, bloomBox(width, height), { opacity: k }]}
        pointerEvents="none"
      />
      <Animated.Image
        source={LOGO}
        style={{ width, height, opacity, transform: [{ scale }] }}
        resizeMode="contain"
        fadeDuration={0}
      />
    </View>
  );
}

/**
 * The wordmark: the mark and the app's name in bold, on one line. One element to
 * VoiceOver, read as the name.
 */
export function Wordmark({ name }: { name: string }) {
  return (
    <View style={styles.wordmark} accessible accessibilityRole="image" accessibilityLabel={name}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <AppMark width={WORDMARK_MARK} />
      </View>
      <Text style={type.wordmark} allowFontScaling={false} numberOfLines={1}>
        {typographic(name)}
      </Text>
    </View>
  );
}

/** The mark beside the wordmark. */
const WORDMARK_MARK = dp(40);

/** The native splash's mark: a 180 pt image whose artwork is 961/1001 of it ≈ 173 pt wide. */
export const SPLASH_MARK_WIDTH = Math.round((180 * 961) / 1001);

export function SplashView({
  failed = false,
  onRetry,
  bare = false,
}: {
  failed?: boolean;
  onRetry?: (() => void) | undefined;
  /** The mark alone, no status line (no text before the fonts are loaded). */
  bare?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const column = useColumn();
  const root = useRef<ComponentRef<typeof View>>(null);
  // Where this view starts in the window (0 at the app root; lower inside the design preview).
  const [offsetY, setOffsetY] = useState(0);
  const markH = SPLASH_MARK_WIDTH * MARK_ASPECT;
  const markTop = windowH / 2 - offsetY - markH / 2;
  const mark = (
    <View style={[styles.mark, { top: markTop }]} pointerEvents="none">
      <AppMark width={SPLASH_MARK_WIDTH} />
    </View>
  );
  const measure = () =>
    root.current?.measureInWindow((_x: number, y: number) => {
      if (Number.isFinite(y)) setOffsetY(y);
    });
  if (bare) {
    return (
      <View ref={root} onLayout={measure} style={styles.root} testID="splash">
        {mark}
      </View>
    );
  }
  return (
    <View ref={root} onLayout={measure} style={styles.root} testID="splash">
      {mark}
      <View style={[styles.status, { top: markTop + markH + space.x3 }]}>
        {failed ? (
          <Label style={styles.failed}>{t(COPY.app.offline)}</Label>
        ) : (
          <DotsLabel text={t(COPY.app.loading)} variant="small" />
        )}
      </View>
      {failed && onRetry ? (
        <View
          style={[
            styles.retry,
            {
              bottom: insets.bottom + space.x2,
              left: column.inset + space.page,
              right: column.inset + space.page,
            },
          ]}
        >
          <PrimaryButton testID="splash-retry" label={t(COPY.app.failed)} onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  bloom: { position: 'absolute' },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  mark: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  status: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  failed: { color: palette.textSecondary },
  retry: { position: 'absolute', left: space.page, right: space.page },
});
