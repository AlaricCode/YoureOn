// The app's mark, its wordmark and the in-app splash. The mark is the icon's switch flipped "on"
// (green track, white knob), drawn with Views; the wordmark is the mark with the name beside it
// in bold (the top of Home). SplashView repeats the native splash (app.json
// expo-splash-screen: assets/splash-icon.png at 180 pt, centred on black #000000) so the hand-off
// from the native launch screen to JS has no jump: the mark is pinned to the centre of the
// window (not of the view, which may sit under other chrome), and the boot state is absolutely
// placed 24 pt under it, so it never pushes the mark: loading, or "Can't connect" with a retry.
// `bare` shows the mark alone (the app root, while fonts load).
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COPY, t } from '../screens/copy';
import { Label, PrimaryButton, useColumn } from './kit';
import { DotsLabel, useReduceMotion } from './parts';
import { material, motion, palette, space, type } from './tokens';
import { typographic } from './typography';

/**
 * The switch. `width` is the track's width; the track is 0.56 of that tall and the knob fills
 * 78 % of its height, as in assets/icon.png and assets/splash-icon.png.
 */
export function AppMark({
  width = 98,
  lit = false,
}: {
  width?: number;
  /** A bloom of its own green light under the switch (the first screen: the light is on). */
  lit?: boolean;
}) {
  const height = width * 0.56;
  const knob = height * 0.78;
  const inset = (height - knob) / 2;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="You're On"
      style={[
        { width, height, borderRadius: height / 2, backgroundColor: palette.accent },
        lit ? styles.lit : null,
      ]}
    >
      <View
        style={{
          position: 'absolute',
          top: inset,
          right: inset,
          width: knob,
          height: knob,
          borderRadius: knob / 2,
          backgroundColor: palette.text,
        }}
      />
    </View>
  );
}

/**
 * The mark turning on: the switch starts off (a dim track, the knob on the left) and flips on
 * once, `delayMs` after it appears: the knob slides across, the track turns green and its bloom
 * comes up. The lock moment, where the name of the app happens. One move, ease-out, inside the
 * moment budget; Reduce Motion: it is simply on.
 */
export function SwitchOn({ width = 98, delayMs = 0 }: { width?: number; delayMs?: number }) {
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
      // The track's colour is animated too, so this one runs on the JS driver (280 ms, once).
      useNativeDriver: false,
    });
    a.start();
    return () => a.stop();
  }, [k, reduced, delayMs]);
  const height = width * 0.56;
  const knob = height * 0.78;
  const inset = (height - knob) / 2;
  const track = k.interpolate({
    inputRange: [0, 1],
    outputRange: [palette.fill, palette.accent],
  });
  const slide = k.interpolate({ inputRange: [0, 1], outputRange: [0, width - knob - 2 * inset] });
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="On" style={{ width, height }}>
      <Animated.View
        style={[styles.switchBloom, { borderRadius: height / 2, opacity: k }]}
        pointerEvents="none"
      />
      <Animated.View style={{ width, height, borderRadius: height / 2, backgroundColor: track }}>
        <Animated.View
          style={{
            position: 'absolute',
            top: inset,
            left: inset,
            width: knob,
            height: knob,
            borderRadius: knob / 2,
            backgroundColor: palette.text,
            transform: [{ translateX: slide }],
          }}
        />
      </Animated.View>
    </View>
  );
}

/**
 * The wordmark: the switch and the app's name in bold, on one line. One element to
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

/** The switch beside the wordmark. */
const WORDMARK_MARK = 30;

/** The native splash's mark: 180 pt image, mark 560/1024 of it ≈ 98 pt wide. */
export const SPLASH_MARK_WIDTH = Math.round((180 * 560) / 1024);

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
  const markH = SPLASH_MARK_WIDTH * 0.56;
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
  lit: { boxShadow: material.bloomOn },
  switchBloom: { ...StyleSheet.absoluteFill, boxShadow: material.bloomOn },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  mark: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  status: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  failed: { color: palette.textSecondary },
  retry: { position: 'absolute', left: space.page, right: space.page },
});
