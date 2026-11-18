// The app's mark and the in-app splash. The mark is the icon's switch flipped "on" (accent track,
// light knob), drawn with Views. SplashView repeats the native splash (app.json expo-splash-screen:
// assets/splash-icon.png at 180 pt, centred on #0B0B0C) so the hand-off from the native launch
// screen to JS has no jump, then adds the boot state under it: loading, or "Can't connect" with a
// retry. After the src/app merge it replaces DemoApp's `Loading` (one component swap).
import { StyleSheet, View } from 'react-native';
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
}: {
  failed?: boolean;
  onRetry?: (() => void) | undefined;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root} testID="splash">
      <View style={styles.center} pointerEvents="none">
        <AppMark width={SPLASH_MARK_WIDTH} />
      </View>
      <View style={[styles.status, { top: '50%' }]}>
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
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  status: {
    position: 'absolute',
    left: 0,
    right: 0,
    marginTop: space.x6,
    alignItems: 'center',
  },
  failed: { color: palette.textSecondary },
  retry: { position: 'absolute', left: space.page, right: space.page },
});
