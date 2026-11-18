// More pieces in the enroll redesign's style (./kit), for the bet screens: the page frame and top
// bar, avatars, cards and rows, the balance header that counts up on a payout, a countdown hook,
// the hold-to-confirm control (TASKS D1-M5), status heroes and the reconnect banner.
// Every color, size and duration comes from ./tokens; copy follows ./copyRule.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChevronLeft, Label, Tick } from './kit';
import { color, hold, motion, palette, payout, radius, space, type } from './tokens';

// ---------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------

/** A full screen on the app background, padded by the safe-area insets. */
export function Screen({ children }: { children: ReactNode }) {
  const i = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: i.top, paddingBottom: i.bottom, paddingLeft: i.left, paddingRight: i.right },
      ]}
    >
      {children}
    </View>
  );
}

/** Back arrow on the left (optional), a centred title, an optional tag on the right. */
export function TopBar({
  onBack,
  title,
  tag,
}: {
  onBack?: (() => void) | undefined;
  title?: string;
  tag?: string | undefined;
}) {
  return (
    <View style={styles.topBar}>
      <View style={styles.topSide}>
        {onBack ? (
          <Pressable
            testID="top-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onBack}
            hitSlop={8}
            style={styles.back}
          >
            <ChevronLeft />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.topTitle}>{title ? <Label variant="heading">{title}</Label> : null}</View>
      <View style={[styles.topSide, styles.topRight]}>
        {tag ? <Label variant="small">{tag}</Label> : null}
      </View>
    </View>
  );
}

/** Page content with the standard side margins. */
export function Page({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.page, style]}>{children}</View>;
}

// ---------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? '')
    .join('');

/** Initials in a circle (BRIEF 5i: initials when there is no photo); a dot when online. */
export function Avatar({
  name,
  size = 40,
  online,
  accent = false,
}: {
  name: string;
  size?: number;
  online?: boolean;
  accent?: boolean;
}) {
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.avatar,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: accent ? palette.accent : palette.surface,
          },
        ]}
      >
        <Text style={[type.labelStrong, { fontSize: size >= 64 ? 22 : 15 }]}>{initials(name)}</Text>
      </View>
      {online !== undefined ? (
        <View
          style={[
            styles.presence,
            { backgroundColor: online ? palette.accent : palette.textSecondary },
          ]}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Blocks and rows
// ---------------------------------------------------------------------------------------

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** Plain data text (names, claims, amounts): exempt from the label word limit. */
export function DataText({
  children,
  variant = 'label',
  muted = false,
  style,
  lines,
}: {
  children: string;
  variant?: keyof typeof type;
  muted?: boolean;
  style?: StyleProp<import('react-native').TextStyle>;
  lines?: number;
}) {
  return (
    <Text
      numberOfLines={lines}
      style={[type[variant], muted && { color: palette.textSecondary }, style]}
    >
      {children}
    </Text>
  );
}

/** A label on the left and its value on the right, on one line. */
export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Label style={styles.muted}>{label}</Label>
      <DataText style={styles.infoValue} lines={1}>
        {value}
      </DataText>
    </View>
  );
}

/** A section: its label, then its content (a list of lines, a card). */
export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Label variant="small" style={styles.sectionLabel}>
        {label}
      </Label>
      {children}
    </View>
  );
}

/** Lines with a small dot in front (criteria). */
export function Bullets({ items }: { items: readonly string[] }) {
  return (
    <View style={styles.bullets}>
      {items.map((t, i) => (
        <View key={i} style={styles.bullet}>
          <View style={styles.bulletDot} />
          <DataText style={styles.flex}>{t}</DataText>
        </View>
      ))}
    </View>
  );
}

/** A tappable list row: title, optional value, a chevron. */
export function ListRow({
  title,
  value,
  onPress,
  left,
  testID,
}: {
  title: string;
  value?: string;
  onPress?: () => void;
  left?: ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.listRow, pressed && onPress && styles.pressed]}
    >
      {left}
      <DataText variant="label" style={styles.flex} lines={1}>
        {title}
      </DataText>
      {value ? (
        <DataText muted lines={1}>
          {value}
        </DataText>
      ) : null}
      {onPress ? (
        <View style={styles.chevronRight}>
          <ChevronLeft />
        </View>
      ) : null}
    </Pressable>
  );
}

/** A small rounded tag ("Online", "Face on"). */
export function Chip({
  label,
  tone = 'muted',
  testID,
}: {
  label: string;
  tone?: 'muted' | 'accent';
  testID?: string;
}) {
  return (
    <View style={[styles.chip, tone === 'accent' ? styles.chipAccent : styles.chipMuted]}>
      <Text testID={testID} style={[type.small, tone === 'accent' && { color: palette.text }]}>
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------

/** Dollars, counting from the previous value to the new one over `payout.countUpMs`. */
export function useCountUp(cents: number): number {
  const [shown, setShown] = useState(cents);
  const from = useRef(cents);
  useEffect(() => {
    const start = from.current;
    if (start === cents) return;
    const t0 = Date.now();
    let frame = 0;
    const step = () => {
      const k = Math.min(1, (Date.now() - t0) / payout.countUpMs);
      const eased = 1 - (1 - k) * (1 - k);
      setShown(Math.round(start + (cents - start) * eased));
      if (k < 1) frame = requestAnimationFrame(step);
      else from.current = cents;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [cents]);
  return shown;
}

export const centsToUsd = (c: number) =>
  `$${Math.floor(c / 100)}.${(c % 100).toString().padStart(2, '0')}`;

/**
 * The balance header (TASKS D3-M2): dollars only. While a payout is processed but not yet
 * confirmed the number is in the pending tint, then it settles to the text color.
 */
export function BalanceHeader({
  cents,
  pending = false,
  inBetsUsd,
}: {
  cents: number;
  pending?: boolean;
  inBetsUsd?: string | null;
}) {
  const shown = useCountUp(cents);
  return (
    <View style={styles.balance} testID="balance-header">
      <Label variant="small">Balance</Label>
      <Text
        style={[type.display, { color: pending ? payout.pendingColor : payout.settledColor }]}
        accessibilityLabel={centsToUsd(cents)}
      >
        {centsToUsd(shown)}
      </Text>
      {inBetsUsd ? (
        <View style={styles.inBets}>
          <Label variant="small">In bets</Label>
          <DataText variant="small" muted>
            {inBetsUsd}
          </DataText>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------

/** Re-renders every `everyMs` and returns Date.now(). */
export function useNow(everyMs = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** "Checking", "Locking", "Judging"… with dots cycling . → .. → ... */
export function DotsLabel({
  text,
  variant = 'heading',
}: {
  text: string;
  variant?: keyof typeof type;
}) {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d % 3) + 1), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={styles.dotsRow} accessibilityLabel={text}>
      <Text style={type[variant]}>{text}</Text>
      <Text style={[type[variant], styles.dots]}>{'.'.repeat(dots)}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Hold to confirm (TASKS D1-M5)
// ---------------------------------------------------------------------------------------

/**
 * Press and hold for `hold.durationMs`: the accent fill grows across the button. Releasing early,
 * or moving more than `hold.maxDistance`, returns it to empty over `hold.releaseMs` and nothing
 * happens. A full hold calls `onComplete` (which opens Face ID). VoiceOver users get an
 * "activate" action instead of the hold. No springs (tokens.motion).
 */
export function HoldToConfirm({
  label,
  disabled = false,
  onStart,
  onComplete,
  testID,
}: {
  label: string;
  disabled?: boolean;
  onStart?: () => void;
  onComplete: () => void;
  testID?: string;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const origin = useRef<{ x: number; y: number } | null>(null);
  const done = useRef(false);

  const reset = () => {
    origin.current = null;
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: hold.releaseMs,
      easing: Easing.bezier(...motion.easing),
      useNativeDriver: false,
    }).start();
  };

  const start = (e: GestureResponderEvent) => {
    if (disabled) return;
    done.current = false;
    origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
    onStart?.();
    Animated.timing(progress, {
      toValue: 1,
      duration: hold.durationMs,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && origin.current) {
        done.current = true;
        origin.current = null;
        onComplete();
        progress.setValue(0);
      }
    });
  };

  const move = (e: GestureResponderEvent) => {
    const o = origin.current;
    if (!o) return;
    const dx = e.nativeEvent.pageX - o.x;
    const dy = e.nativeEvent.pageY - o.y;
    if (Math.hypot(dx, dy) > hold.maxDistance) reset();
  };

  const end = () => {
    if (!done.current) reset();
  };

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'activate', label }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate' && !disabled) onComplete();
      }}
      onStartShouldSetResponder={() => !disabled}
      onResponderGrant={start}
      onResponderMove={move}
      onResponderRelease={end}
      onResponderTerminate={end}
      style={[styles.hold, disabled && styles.holdOff]}
    >
      <Animated.View style={[styles.holdFill, { width }]} />
      <Text style={type.labelStrong} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/** A cross drawn with two bars (no icon font, no emoji). */
function Cross({ size, tint }: { size: number; tint: string }) {
  const bar = { position: 'absolute' as const, width: size, height: 2, backgroundColor: tint };
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={[bar, { transform: [{ rotate: '45deg' }] }]} />
      <View style={[bar, { transform: [{ rotate: '-45deg' }] }]} />
    </View>
  );
}

/** Round badge: a tick (accent), a cross (outline), or nothing (just the ring). */
export function StatusBadge({
  mark,
  size = 72,
}: {
  mark: 'check' | 'cross' | 'ring';
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: mark === 'check' ? palette.accent : 'transparent',
        borderWidth: mark === 'check' ? 0 : 2,
        borderColor: mark === 'cross' ? color.negative : palette.accent,
      }}
    >
      {mark === 'check' ? <Tick size={size * 0.42} tint={palette.text} /> : null}
      {mark === 'cross' ? <Cross size={size * 0.36} tint={color.negative} /> : null}
    </View>
  );
}

/** A centred moment: badge, title, and an optional line of data under it. */
export function StatusHero({
  mark,
  title,
  detail,
  titleRole = 'label',
}: {
  mark?: 'check' | 'cross' | 'ring';
  title: string;
  detail?: string | undefined;
  /** 'contract' titles ("Declined. Nothing moved.") are full sentences by spec. */
  titleRole?: 'label' | 'contract';
}) {
  return (
    <View style={styles.hero}>
      {mark ? <StatusBadge mark={mark} /> : null}
      <Text
        style={[type.title, styles.heroTitle, titleRole === 'contract' && styles.center]}
        numberOfLines={titleRole === 'contract' ? 2 : 1}
      >
        {title}
      </Text>
      {detail ? (
        <DataText variant="label" muted style={styles.center}>
          {detail}
        </DataText>
      ) : null}
    </View>
  );
}

/** Thin bar at the top while the realtime connection is down (TASKS D5-M2). */
export function ReconnectBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <View style={styles.banner} testID="reconnect-banner">
      <DotsLabel text="Reconnecting" variant="small" />
    </View>
  );
}

// ---------------------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  flex: { flex: 1 },
  muted: { color: palette.textSecondary },
  center: { textAlign: 'center' },
  pressed: { backgroundColor: palette.surface },
  topBar: { height: space.x6 + space.x1, flexDirection: 'row', alignItems: 'center' },
  topSide: { width: space.x8, justifyContent: 'center' },
  topRight: { alignItems: 'flex-end', paddingRight: space.x2 },
  topTitle: { flex: 1, alignItems: 'center' },
  back: { width: space.x6, height: space.x6, alignItems: 'center', justifyContent: 'center' },
  page: { flex: 1, paddingHorizontal: space.page, paddingBottom: space.x2 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  presence: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: palette.background,
  },
  card: { backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.x2 },
  infoRow: {
    minHeight: space.x5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.x2,
  },
  infoValue: { flexShrink: 1, textAlign: 'right' },
  section: { marginTop: space.x3 },
  sectionLabel: { marginBottom: space.x1 },
  bullets: { gap: 6 },
  bullet: { flexDirection: 'row', gap: space.x1 + 2, alignItems: 'flex-start' },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.textSecondary,
    marginTop: 10,
  },
  listRow: {
    minHeight: space.x6 + space.x1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.divider,
  },
  chevronRight: { transform: [{ rotate: '180deg' }], opacity: 0.6 },
  chip: { borderRadius: radius.sm, paddingHorizontal: space.x1, paddingVertical: 2 },
  chipMuted: { borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  chipAccent: { backgroundColor: palette.accent },
  balance: { paddingVertical: space.x2 },
  inBets: { flexDirection: 'row', gap: space.x1, marginTop: 2 },
  dotsRow: { flexDirection: 'row', alignItems: 'center' },
  dots: { width: 18 },
  hold: {
    height: space.control + space.x1,
    borderRadius: radius.md,
    borderWidth: hold.ringStrokeWidth,
    borderColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  holdOff: { borderColor: palette.hairline, opacity: 0.5 },
  holdFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: palette.accent,
  },
  hero: { alignItems: 'center', gap: space.x2, paddingVertical: space.x3 },
  heroTitle: { marginTop: space.x1 },
  banner: {
    height: space.x4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
});
