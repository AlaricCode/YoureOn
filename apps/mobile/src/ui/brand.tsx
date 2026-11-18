// The app's mark and the in-app splash. The mark is the icon's switch flipped "on" (green track,
// white knob), drawn with Views. SplashView repeats the native splash (app.json
// expo-splash-screen: assets/splash-icon.png at 180 pt, centred on black #000000) so the hand-off
// from the native launch screen to JS has no jump: the mark is pinned to the centre of the
// window (not of the view, which may sit under other chrome), and the boot state is absolutely
// placed 24 pt under it, so it never pushes the mark: loading, or "Can't connect" with a retry.
// `bare` shows the mark alone (the app root, while fonts load).
import { useRef, useState, type ComponentRef } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COPY, t } from '../screens/copy';
import { Label, PrimaryButton } from './kit';
import { DotsLabel } from './parts';
import { palette, space } from './tokens';

/**
 * The switch. `width` is the track's width; the track is 0.56 of that tall and the knob fills
 * 78 % of its height, as in assets/icon.png and assets/splash-icon.png.
 */
export function AppMark({ width = 98 }: { width?: number }) {
  const height = width * 0.56;
  const knob = height * 0.78;
  const inset = (height - knob) / 2;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="You're On"
      style={{ width, height, borderRadius: height / 2, backgroundColor: palette.accent }}
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
        <View style={[styles.retry, { bottom: insets.bottom + space.x2 }]}>
          <PrimaryButton testID="splash-retry" label={t(COPY.app.failed)} onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  mark: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  status: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  failed: { color: palette.textSecondary },
  retry: { position: 'absolute', left: space.page, right: space.page },
});
