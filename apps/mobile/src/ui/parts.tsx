// More pieces in the "Limelight" style (./tokens, ./kit), for the bet screens: the page frame and
// top bar, glass monogram avatars, hairline rows, the balance header (big thin numerals, a delta
// line and a sparkline) that counts up on a payout, a countdown hook, the hold-to-confirm control
// (TASKS D1-M5), status heroes, the reconnect banner, and the moment screen: black, one serif
// headline, an aurora of the moment's colour behind it, and for money a giant green (or red)
// figure. Every color, size and duration comes from ./tokens; copy follows ./copyRule.
import { StatusBar } from 'expo-status-bar';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Ellipse, Path, RadialGradient, Stop } from 'react-native-svg';

import { useReconnecting } from './connection';
import { BackButton, BackdropProvider, ChevronLeft, Label, Tick, useBackdropColor } from './kit';
import { centsToUsd, signedCentsToUsd } from './money';
import { SPARK_MIN_POINTS, sparkDirection, sparkGeometry } from './spark';
import { balance, isVoice, typographic } from './typography';
import {
  aurora,
  color,
  fontFamily,
  glow,
  half,
  hold,
  material,
  motion,
  palette,
  payout,
  radius,
  space,
  sparkline,
  TABULAR,
  type,
  type TypeToken,
} from './tokens';

// ---------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------

/**
 * A full screen on black, padded by the safe-area insets. The reconnect banner sits at its top
 * whenever the realtime connection is coming back (./connection), or when `offline`.
 */
export function Screen({ children, offline = false }: { children: ReactNode; offline?: boolean }) {
  const i = useSafeAreaInsets();
  const reconnecting = useReconnecting();
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: i.top, paddingBottom: i.bottom, paddingLeft: i.left, paddingRight: i.right },
      ]}
    >
      <ReconnectBanner visible={offline || reconnecting} />
      {children}
    </View>
  );
}

/**
 * Back chevron on the left (optional, on the page margin), a centred 17/600 title, an optional
 * grey tag on the right. No background band: it is text on black.
 */
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
        {onBack ? <BackButton testID="top-back" onPress={onBack} /> : null}
      </View>
      <View style={styles.topTitle}>{title ? <Label variant="heading">{title}</Label> : null}</View>
      <View style={[styles.topSide, styles.topRight]}>
        {tag ? <Label variant="small">{tag}</Label> : null}
      </View>
    </View>
  );
}

/** Page content with the standard 20 pt side margins. */
export function Page({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.page, style]}>{children}</View>;
}

/**
 * The hidden operator gesture (diagnostics / design preview): hold 1.2 s, then let go. It fires
 * on release: switching screens while the finger is still down unmounts the Pressable that owns
 * the touch, and React Native then spends the next touch on it (the first tap on the new screen
 * did nothing; found on the simulator).
 */
export function OperatorHold({
  onHold,
  style,
  children,
}: {
  onHold?: (() => void) | undefined;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const held = useRef(false);
  return (
    <Pressable
      style={style}
      accessible={false}
      delayLongPress={1200}
      onLongPress={() => {
        held.current = onHold !== undefined;
      }}
      onPressOut={() => {
        if (!held.current) return;
        held.current = false;
        onHold?.();
      }}
    >
      {children}
    </Pressable>
  );
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

/**
 * The monogram on a disc: Instrument Serif at half the disc (a touch smaller for two letters),
 * one line, so it reads as a monogram at 32 pt and at 112 pt alike.
 */
function initialsStyle(size: number, letters: number): TextStyle {
  const fontSize = Math.round(size * (letters > 1 ? 0.42 : 0.5));
  return {
    fontFamily: fontFamily.voice,
    fontWeight: '400',
    fontSize,
    lineHeight: Math.round(fontSize * 1.12),
    color: palette.text,
  };
}

/**
 * A serif monogram on a glass disc, lit from the upper left (no per-person colours). `online`
 * adds a presence dot (green online, dim offline) cut out of the backdrop. `accent` rings the
 * disc in white (you, or whose turn it is); `lit` rings it in green light (who just won).
 */
export function Avatar({
  name,
  size = 40,
  online,
  accent = false,
  lit = false,
}: {
  name: string;
  size?: number;
  online?: boolean;
  accent?: boolean;
  lit?: boolean;
}) {
  const cutout = useBackdropColor();
  const ring = Math.max(1.5, Math.round(size * 0.03));
  const dot = Math.max(10, Math.round(size * 0.24));
  const letters = initials(name);
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.avatar,
          { width: size, height: size, borderRadius: size / 2 },
          accent && { borderWidth: ring, borderColor: palette.text },
          lit && { borderColor: palette.accent, boxShadow: material.ringOn },
        ]}
      >
        <Text style={initialsStyle(size, [...letters].length)} allowFontScaling={false}>
          {letters}
        </Text>
      </View>
      {online !== undefined ? (
        <View
          style={[
            styles.presence,
            {
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              borderColor: cutout,
              backgroundColor: online ? color.online : color.offline,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

/** A presence dot on its own (green online, dim offline). Also the "live" dot. */
export function PresenceDot({ online, size = 8 }: { online: boolean; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: online ? color.online : color.offline,
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Blocks and rows
// ---------------------------------------------------------------------------------------

/**
 * A group of content. Flat by default: no fill, no box, content on black at the page margin (8 pt
 * above and below). `raised` makes it a glass object (top-lit, a 1 pt rim, radius 28, 20 pt
 * padding): use that only for things you could hold (a slip, a roster, a sheet-like panel);
 * children then see a 'raised' backdrop (./kit).
 */
export function Card({
  children,
  style,
  raised = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  raised?: boolean;
}) {
  if (!raised) return <View style={[styles.cardFlat, style]}>{children}</View>;
  return (
    <BackdropProvider value="raised">
      <View style={[styles.card, style]}>{children}</View>
    </BackdropProvider>
  );
}

/**
 * Plain data text (names, claims, amounts): exempt from the label word limit. In a serif
 * variant (a claim, the judge's words) it is set with real apostrophes; VoiceOver and the e2e
 * flows still get the text as written.
 */
export function DataText({
  children,
  variant = 'label',
  muted = false,
  style,
  lines,
}: {
  children: string;
  variant?: TypeToken;
  /** Grey (secondary) instead of the style's own colour. */
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  lines?: number;
}) {
  const shown = isVoice(variant) ? typographic(children) : children;
  return (
    <Text
      numberOfLines={lines}
      style={[type[variant], muted && { color: palette.textSecondary }, style]}
      accessibilityLabel={shown === children ? undefined : children}
    >
      {shown}
    </Text>
  );
}

/** A grey label on the left and its white value on the right, on one line. */
export function InfoRow({
  label,
  value,
  divider = false,
}: {
  label: string;
  value: string;
  /** A hairline under the row (for a run of rows). */
  divider?: boolean;
}) {
  return (
    <View style={[styles.infoRow, divider && styles.divider]}>
      <Label variant="value">{label}</Label>
      <DataText variant="labelMedium" style={styles.infoValue} lines={1}>
        {value}
      </DataText>
    </View>
  );
}

/**
 * A section: its grey 15/500 header (sentence case), then its content. `flush` drops the 32 pt
 * lead, for a section that opens right under a rule or a perforation.
 */
export function Section({
  label,
  children,
  flush = false,
}: {
  label: string;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <View style={flush ? undefined : styles.section}>
      <Label variant="section" style={styles.sectionLabel}>
        {label}
      </Label>
      {children}
    </View>
  );
}

/** Lines with a small grey dot in front (criteria). */
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

/**
 * A tappable list row: optional left node, title (17/400), optional grey value, a grey chevron;
 * a hairline under it (`divider`, default on).
 */
export function ListRow({
  title,
  value,
  onPress,
  left,
  testID,
  divider = true,
}: {
  title: string;
  value?: string;
  onPress?: () => void;
  left?: ReactNode;
  testID?: string;
  divider?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.listRow,
        divider && styles.divider,
        pressed && onPress && styles.rowPressed,
      ]}
    >
      {left}
      <DataText variant="row" style={styles.flex} lines={1}>
        {title}
      </DataText>
      {value ? (
        <DataText muted lines={1}>
          {value}
        </DataText>
      ) : null}
      {onPress ? (
        <View style={styles.chevronRight}>
          <ChevronLeft tint={palette.textSecondary} />
        </View>
      ) : null}
    </Pressable>
  );
}

export type ChipTone = 'muted' | 'accent' | 'win' | 'danger';

/**
 * A small glass pill ("Mic on", "Replay", "Paid"). muted: grey text; accent / win: green text
 * (a state that is on); danger: red text.
 */
export function Chip({
  label,
  tone = 'muted',
  testID,
  style,
}: {
  label: string;
  tone?: ChipTone;
  testID?: string;
  /** Overrides, e.g. `{ alignSelf: 'center' }` in a row or a centred column. */
  style?: StyleProp<ViewStyle>;
}) {
  const ink =
    tone === 'muted' ? palette.textSecondary : tone === 'danger' ? palette.danger : palette.accent;
  return (
    <View style={[styles.chip, style]}>
      <Text testID={testID} style={[type.smallStrong, { color: ink }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A selectable pill (the $1 / $5 / $10 / $20 stake picker): glass, white text; selected, a
 * white fill with black text. A radio by default; put the set in a View with
 * accessibilityRole="radiogroup".
 */
export function ChoiceChip({
  label,
  selected,
  onPress,
  testID,
  role = 'radio',
  disabled = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
  role?: 'radio' | 'button';
  /** Blocks presses and dims to 0.4 (e.g. while a send or lock is in progress). */
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={label}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.choice,
        selected ? styles.choiceOn : null,
        disabled && styles.choiceDisabled,
        pressed && !disabled && styles.pressedDim,
      ]}
    >
      <Text
        style={[
          type.rowMedium,
          { color: selected ? color.onPrimary : palette.text, fontVariant: TABULAR },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------

/** Cents, counting from the previous value to the new one over `payout.countUpMs`. */
export function useCountUp(cents: number, fromCents?: number): number {
  const [shown, setShown] = useState(fromCents ?? cents);
  const from = useRef(fromCents ?? cents);
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

/** "$12.50", "+$12.50" / "−$3.00" (U+2212 minus) / "$0.00": the one result format (./money). */
export { centsToUsd, signedCentsToUsd };

const MONEY_STYLE = {
  balance: type.balance,
  money: type.money,
  title: type.figure,
  figure: type.figure,
  amount: type.amount,
} as const;

/**
 * A dollar figure in Geist Light with tabular numerals ("$12.50"), one size throughout, one Text.
 * `size`: 'balance' / 'money' 56, 'figure' (alias 'title') 34, 'amount' 22 Regular.
 */
export function MoneyText({
  cents,
  size = 'balance',
  tint,
  accessibilityLabel,
  testID,
}: {
  cents: number;
  size?: keyof typeof MONEY_STYLE;
  tint?: string;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const usd = centsToUsd(cents);
  return (
    <Text
      testID={testID}
      style={[MONEY_STYLE[size], { color: tint ?? palette.text }]}
      accessibilityLabel={accessibilityLabel ?? usd}
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.6}
    >
      {usd}
    </Text>
  );
}

/**
 * A thin line chart of `points` (oldest first), react-native-svg: a 2 pt stroke, no axes, no
 * grid, a monotone-cubic smoothed curve with round joins and caps, a small dot at the end with a
 * soft halo. Green when the series ended up, red when down, grey when flat (or `tint`). Fills its
 * container's width unless `width` is given. Renders nothing under SPARK_MIN_POINTS (three). Decorative: hidden from VoiceOver (the figures carry the meaning).
 */
export function Sparkline({
  points,
  width,
  height = sparkline.height,
  tint,
  testID,
}: {
  points: readonly number[];
  width?: number;
  height?: number;
  tint?: string;
  testID?: string;
}) {
  const [measured, setMeasured] = useState(0);
  if (points.length < SPARK_MIN_POINTS) return null;
  const w = width ?? measured;
  const dir = sparkDirection(points);
  const stroke =
    tint ?? (dir > 0 ? color.positive : dir < 0 ? color.negative : palette.textSecondary);
  // The line starts on the page margin (half the stroke in, so the round cap ends on it); only
  // the right, top and bottom keep room for the end dot's halo.
  const pad = sparkline.haloRadius;
  const g = sparkGeometry(points, w, height, pad, sparkline.strokeWidth / 2);
  return (
    <View
      testID={testID}
      style={{ width: width ?? '100%', height }}
      onLayout={width === undefined ? (e) => setMeasured(e.nativeEvent.layout.width) : undefined}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {g.d ? (
        <Svg width={w} height={height}>
          <Path
            d={g.d}
            stroke={stroke}
            strokeWidth={sparkline.strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
          />
          {g.end ? (
            <>
              <Circle
                cx={g.end.x}
                cy={g.end.y}
                r={sparkline.haloRadius}
                fill={stroke}
                opacity={sparkline.haloOpacity}
              />
              <Circle cx={g.end.x} cy={g.end.y} r={sparkline.endDot} fill={stroke} />
            </>
          ) : null}
        </Svg>
      ) : null}
    </View>
  );
}

/**
 * The balance header, the payout's balance line and the moment's money figure now roll
 * (odometer numerals) and the header's sparkline scrubs: they live in ./figures. Re-exported
 * here under the same names and props, so screens (and src/gg) import them from ./parts as before.
 */
export { BalanceHeader, BalanceLine, MomentMoney } from './figures';

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

/**
 * "Checking", "Locking", "Judging"… with dots cycling . → .. → ... `align="end"` is for a label
 * on the right edge of a row: the first dot ends on the margin and the other two cycle into it,
 * overlaying instead of reserving a slot that leaves the text short of the margin.
 */
export function DotsLabel({
  text,
  variant = 'heading',
  align = 'start',
}: {
  text: string;
  variant?: TypeToken;
  align?: 'start' | 'end';
}) {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d % 3) + 1), 400);
    return () => clearInterval(t);
  }, []);
  if (align === 'end') {
    return (
      <View style={styles.dotsRow} accessibilityLabel={text}>
        <Text style={type[variant]}>{`${text}.`}</Text>
        <Text style={[type[variant], styles.dotsOverflow]}>{'.'.repeat(dots - 1)}</Text>
      </View>
    );
  }
  return (
    <View style={styles.dotsRow} accessibilityLabel={text}>
      <Text style={type[variant]}>{text}</Text>
      {/* A fixed slot sized to the font (three dots), so the text does not shift as they cycle. */}
      <Text style={[type[variant], { width: Math.ceil((type[variant].fontSize ?? 17) * 0.9) }]}>
        {'.'.repeat(dots)}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Hold to confirm (TASKS D1-M5)
// ---------------------------------------------------------------------------------------

/**
 * The commit pill (56 pt, green with a bloom under it, black 17/600 label). Press and hold for
 * `hold.durationMs`: a black overlay at `hold.progressOpacity` sweeps across it left to right.
 * Disabled, it is the disabled primary (#1C1C1F, dim label). Releasing early, or moving
 * more than `hold.maxDistance`, returns it to empty over `hold.releaseMs` and nothing happens. A
 * full hold calls `onComplete` (which opens Face ID). VoiceOver users get an "activate" action
 * instead of the hold. No springs (tokens.motion).
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

  const sweep = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

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
      {/* The progress: a translucent black sweep under the label. */}
      <Animated.View style={[styles.holdSweep, { width: sweep }]} pointerEvents="none" />
      <Text
        style={[type.button, { color: disabled ? palette.textTertiary : color.onAccent }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Motion (tokens.motion: functional, <= 200 ms per step, ease-out, no springs)
// ---------------------------------------------------------------------------------------

const easeOut = Easing.bezier(...motion.easing);

/**
 * iOS "Reduce Motion". null until the first answer arrives (a few ms), so a caller can hold an
 * animation back instead of starting it and snapping.
 */
export function useReduceMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (v) => live && setReduced(v),
      () => live && setReduced(false),
    );
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/** Fades and scales its child in on mount (0.96 → 1 over one standard transition). */
export function Appear({
  children,
  delayMs = 0,
  style,
}: {
  children: ReactNode;
  delayMs?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const k = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(k, {
      toValue: 1,
      duration: motion.fastMs,
      delay: delayMs,
      easing: easeOut,
      useNativeDriver: true,
    }).start();
  }, [k, delayMs]);
  const scale = k.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });
  return (
    <Animated.View style={[style, { opacity: k, transform: [{ scale }] }]}>
      {children}
    </Animated.View>
  );
}

/**
 * The moment reveal (the one orchestrated motion): fade in and rise `motion.momentRise` pt over
 * `motion.momentMs` (<= 300 ms), ease-out, after `delayMs`. With Reduce Motion on it simply
 * appears. Wrap the moment's words (MomentHeadline already uses it).
 */
export function Reveal({
  children,
  delayMs = 0,
  style,
}: {
  children: ReactNode;
  delayMs?: number;
  style?: StyleProp<ViewStyle>;
}) {
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
      easing: easeOut,
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [k, reduced, delayMs]);
  const translateY = k.interpolate({ inputRange: [0, 1], outputRange: [motion.momentRise, 0] });
  return (
    <Animated.View style={[style, { opacity: k, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

/**
 * Two quick beats (scale 1 → 1.12 → 1, twice): the on-screen double haptic for LOCKED, for when
 * the camera or mic has silenced haptics (ARCHITECTURE §7.1 Beat 3).
 */
function useDoublePulse(on: boolean): Animated.Value {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!on) return;
    const beat = [
      Animated.timing(v, { toValue: 1.12, duration: 110, easing: easeOut, useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: 110, easing: easeOut, useNativeDriver: true }),
    ];
    Animated.sequence([
      Animated.delay(motion.fastMs),
      ...beat,
      Animated.delay(20),
      ...beat,
    ]).start();
  }, [on, v]);
  return v;
}

// ---------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------

/** A 2 pt bar that drains as a window closes (the 10 s appeal window, the accept window). */
export function CountdownBar({ fraction }: { fraction: number }) {
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <View style={styles.barTrack} accessibilityElementsHidden importantForAccessibility="no">
      <View style={[styles.barFill, { width: `${f * 100}%` }]} />
    </View>
  );
}

/** One dot per allowed attempt: done ones grey, the current one white, the rest dim. */
export function AttemptDots({ current, total }: { current: number; total: number }) {
  return (
    <View style={styles.dotsTrack} accessible accessibilityLabel={`${current} / ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={[
            styles.attemptDot,
            i + 1 < current && styles.attemptDone,
            i + 1 === current && styles.attemptNow,
          ]}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/** A cross drawn with two bars (no icon font, no emoji). */
function Cross({ size, tint, bar = 3 }: { size: number; tint: string; bar?: number }) {
  const b = { position: 'absolute' as const, width: size, height: bar, borderRadius: bar / 2 };
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={[b, { backgroundColor: tint, transform: [{ rotate: '45deg' }] }]} />
      <View style={[b, { backgroundColor: tint, transform: [{ rotate: '-45deg' }] }]} />
    </View>
  );
}

/**
 * Round badge on a glass disc. check: a green tick in a ring of green light; cross: a red cross
 * (a loss, a failure); `neutral` greys the cross for endings where nothing moved; ring: an empty
 * dim outline (waiting, empty).
 */
export function StatusBadge({
  mark,
  size = 64,
  neutral = false,
}: {
  mark: 'check' | 'cross' | 'ring';
  size?: number;
  neutral?: boolean;
}) {
  const stroke = Math.max(2, Math.round(size * 0.035));
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: mark === 'ring' ? 'transparent' : palette.fill,
          borderWidth: mark === 'ring' ? 1.5 : 1,
          borderColor: mark === 'ring' ? palette.textTertiary : palette.rim,
        },
        mark === 'ring' ? null : { backgroundImage: material.disc },
        mark === 'check' ? { borderColor: palette.accent, boxShadow: material.ringOn } : null,
      ]}
    >
      {mark === 'check' ? <Tick size={size * 0.4} tint={palette.accent} /> : null}
      {mark === 'cross' ? (
        <Cross
          size={size * 0.36}
          tint={neutral ? palette.textSecondary : color.negative}
          bar={stroke}
        />
      ) : null}
    </View>
  );
}

/**
 * A centred status: badge, title, and an optional grey line of data under it. The badge scales
 * in and the words follow one beat later; `pulse` adds the LOCKED double beat. Titles are Geist
 * 22/600 (quiet); `loud` sets them in the serif at 52 instead. For the big moments, use
 * MomentScreen + MomentHeadline.
 */
export function StatusHero({
  mark,
  title,
  detail,
  titleRole = 'label',
  pulse = false,
  loud = false,
  end = false,
  neutral = false,
}: {
  mark?: 'check' | 'cross' | 'ring';
  title: string;
  detail?: string | undefined;
  /** 'contract' titles ("Declined. Nothing moved.") are full sentences by spec. */
  titleRole?: 'label' | 'contract';
  pulse?: boolean;
  loud?: boolean;
  /** An end state ("Declined. Nothing moved.", "Payout failed"): serif 40, the moment voice. */
  end?: boolean;
  /** A grey cross instead of red (nothing moved). */
  neutral?: boolean;
}) {
  const beat = useDoublePulse(pulse);
  // End titles break at their sentence / clause boundaries ("Declined." / "Nothing moved."),
  // never mid-phrase, in a 280 pt column. One Text, so VoiceOver and the e2e flows still read
  // the whole title as written.
  const lines = end ? endTitleLines(title) : null;
  return (
    <View style={styles.hero} accessibilityLiveRegion="polite">
      {mark ? (
        <Appear>
          <Animated.View style={{ transform: [{ scale: beat }] }}>
            <StatusBadge mark={mark} neutral={neutral} />
          </Animated.View>
        </Appear>
      ) : null}
      <Appear delayMs={mark ? 60 : 0} style={styles.heroWords}>
        {lines ? (
          <Text
            style={[type.endTitle, styles.heroTitle, styles.center, styles.endTitle]}
            accessibilityLabel={title}
            numberOfLines={lines.length}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          >
            {typographic(lines.join('\n'))}
          </Text>
        ) : (
          <Text
            style={[loud ? type.momentSmall : type.subtitle, styles.heroTitle, styles.center]}
            numberOfLines={titleRole === 'contract' ? 2 : 1}
            adjustsFontSizeToFit={loud}
            minimumFontScale={0.6}
            accessibilityLabel={title}
          >
            {loud ? typographic(title) : title}
          </Text>
        )}
        {detail ? (
          <DataText variant="label" muted style={styles.center}>
            {detail}
          </DataText>
        ) : null}
      </Appear>
    </View>
  );
}

/**
 * An end title's lines: split after each "." or "," that is followed by more words, so
 * "Couldn't lock it. Nothing moved." is two lines and "Terms changed, review again" breaks after
 * the comma. Exported for tests.
 */
export function endTitleLines(title: string): string[] {
  return title
    .replace(/([.,])\s+(?=\S)/g, '$1\n')
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Slim row at the top while the realtime connection is down (TASKS D5-M2). */
export function ReconnectBanner({ visible }: { visible: boolean }) {
  const k = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(k, {
      toValue: visible ? 1 : 0,
      duration: motion.fastMs,
      easing: Easing.bezier(...motion.easing),
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, k]);
  if (!mounted) return null;
  const height = k.interpolate({ inputRange: [0, 1], outputRange: [0, space.x5] });
  return (
    <Animated.View
      style={[styles.banner, { height, opacity: k }]}
      testID="reconnect-banner"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={styles.bannerDot} />
      <DotsLabel text="Reconnecting" variant="smallStrong" />
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------------------
// Moments: the challenge arriving, "You're on", the ruling, the payout. Black, centred, one serif
// headline, an aurora of the moment's colour hung from the top of the screen, and for money a
// giant green (or red) figure.
// ---------------------------------------------------------------------------------------

export type AuroraTone = 'in' | 'out' | 'neutral';

/** How a MomentGroup (deep in the screen) asks its MomentScreen for the aurora. */
const AuroraContext = createContext<((tone: AuroraTone | null) => void) | null>(null);

/**
 * The aurora (tokens `aurora`): a wide ellipse of light hung from the top of the screen, green
 * for money in / locked, red for money out, white for a neutral moment. It fades in once, then
 * swells and dims very slowly for as long as the moment is up (Reduce Motion: it is simply
 * there, still). Put it first inside a full-screen View; it takes no touches.
 */
export function Aurora({ tone }: { tone: AuroraTone }) {
  const { width, height } = useWindowDimensions();
  const reduced = useReduceMotion();
  const k = useRef(new Animated.Value(0)).current;
  const swell = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced === null) return;
    if (reduced) {
      k.setValue(1);
      return;
    }
    const slow = Easing.inOut(Easing.quad);
    const up = Animated.timing(k, {
      toValue: 1,
      duration: aurora.fadeMs,
      easing: easeOut,
      useNativeDriver: true,
    });
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(swell, {
          toValue: 1,
          duration: aurora.swellMs,
          easing: slow,
          useNativeDriver: true,
        }),
        Animated.timing(swell, {
          toValue: 0,
          duration: aurora.swellMs,
          easing: slow,
          useNativeDriver: true,
        }),
      ]),
    );
    up.start(({ finished }) => {
      if (finished) breathe.start();
    });
    return () => {
      up.stop();
      breathe.stop();
    };
  }, [k, swell, reduced, tone]);
  const id = `aurora${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const tint = tone === 'in' ? color.positive : tone === 'out' ? color.negative : palette.text;
  const peak =
    tone === 'in' ? aurora.opacity : tone === 'out' ? aurora.lossOpacity : aurora.neutralOpacity;
  const w = Math.round(width * aurora.width);
  const h = Math.round(height * aurora.height);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.aurora,
        {
          width: w,
          height: h,
          left: (width - w) / 2,
          top: height * aurora.top,
          opacity: Animated.multiply(
            k,
            swell.interpolate({ inputRange: [0, 1], outputRange: [1, aurora.swellDim] }),
          ),
          transform: [
            {
              scale: swell.interpolate({ inputRange: [0, 1], outputRange: [1, aurora.swellTo] }),
            },
          ],
        },
      ]}
    >
      <Svg width={w} height={h}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={tint} stopOpacity={peak} />
            <Stop offset="0.55" stopColor={tint} stopOpacity={peak * 0.3} />
            <Stop offset="1" stopColor={tint} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

/**
 * A moment screen: black, safe-area padded, light status bar. Children are centred; `footer`
 * sits at the bottom (buttons); `top` above (e.g. a TopBar with the user tag). The only colour
 * field is the aurora: pass `aurora`, or let a MomentGroup inside ask for it (its `glow`).
 */
export function MomentScreen({
  children,
  footer,
  top,
  offline = false,
  aurora: fixedTone,
  testID,
}: {
  children: ReactNode;
  footer?: ReactNode;
  top?: ReactNode;
  offline?: boolean;
  /** The aurora's tone; omit to take it from the MomentGroup inside (or to have none). */
  aurora?: AuroraTone | undefined;
  testID?: string;
}) {
  const i = useSafeAreaInsets();
  const reconnecting = useReconnecting();
  const [asked, setAsked] = useState<AuroraTone | null>(null);
  const tone = fixedTone ?? asked;
  return (
    <View
      testID={testID}
      style={[
        styles.moment,
        { paddingTop: i.top, paddingBottom: i.bottom, paddingLeft: i.left, paddingRight: i.right },
      ]}
    >
      <StatusBar style="light" />
      {tone ? <Aurora tone={tone} /> : null}
      <ReconnectBanner visible={offline || reconnecting} />
      <AuroraContext.Provider value={setAsked}>
        {top}
        {/* Centred while it fits; a moment with more to show than the screen holds (a dance
            off's move-by-move table) scrolls from its top instead of spilling under the status
            bar and the buttons. */}
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.momentBody}
          bounces={false}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
        {footer ? <View style={styles.momentFooter}>{footer}</View> : null}
      </AuroraContext.Provider>
    </View>
  );
}

/** Instrument Serif's average advance per character (~0.4 em: it is a narrow face), with margin. */
const HEADLINE_EM_PER_CHAR = 0.46;
/** The same without the margin: how many characters of a headline fit on one line. */
const HEADLINE_EM_AVERAGE = 0.41;

/**
 * The moment headline: Instrument Serif, white, centred, shrinking to fit (`lines`, default 2).
 * size 'xl' is 64, 'lg' 52 (longer lines). It plays the one reveal (Reveal: fade and a 12 pt rise
 * over 280 ms, ease-out, after `delayMs`; Reduce Motion: it simply appears).
 */
export function MomentHeadline({
  children,
  size = 'xl',
  lines = 2,
  delayMs = 0,
  inset = space.page,
  letterSpacing,
  testID,
}: {
  children: string;
  size?: 'xl' | 'lg';
  lines?: number;
  delayMs?: number;
  /** Side inset from the screen edge (default the 20 pt page margin); wider keeps lines short. */
  inset?: number;
  /** Tracking override (the token's own is -2.8% of the size). */
  letterSpacing?: number;
  testID?: string;
}) {
  // iOS shrink-to-fit only counts lines, so a word wider than the line is split mid-word and
  // still "fits". Size down first so the longest word fits on one line.
  const { width } = useWindowDimensions();
  const base = size === 'xl' ? type.moment : type.momentSmall;
  const column = width - 2 * inset;
  const longest = Math.max(1, ...children.split(/\s+/).map((w) => w.length));
  const fitted = Math.min(base.fontSize, Math.floor(column / (longest * HEADLINE_EM_PER_CHAR)));
  const sized =
    fitted < base.fontSize
      ? { fontSize: fitted, lineHeight: Math.round((base.lineHeight * fitted) / base.fontSize) }
      : null;
  const narrow = inset > space.page ? { alignSelf: 'center' as const, width: column } : null;
  // Two lines break where they balance ("Logan / challenged you"), never one word alone.
  const size1 = sized?.fontSize ?? base.fontSize;
  const fits = Math.floor(column / (size1 * HEADLINE_EM_AVERAGE));
  const shown = typographic(lines >= 2 ? balance(children, fits) : children);
  return (
    <Reveal delayMs={delayMs} style={[styles.headline, narrow]}>
      <Text
        testID={testID}
        accessibilityRole="header"
        accessibilityLabel={children}
        style={[base, sized, letterSpacing !== undefined && { letterSpacing }, styles.center]}
        numberOfLines={lines}
        adjustsFontSizeToFit
        minimumFontScale={0.4}
      >
        {shown}
      </Text>
    </Reveal>
  );
}

/**
 * A soft radial glow (react-native-svg RadialGradient): `tint` at `glow.opacity` in the centre,
 * fading to nothing at the edge of a `size` disc. Absolutely centred in its parent, behind the
 * content, no touches. Put it first inside a centred View.
 */
export function Glow({
  tint = palette.accent,
  size = glow.size,
  opacity = glow.opacity,
}: {
  tint?: string;
  size?: number;
  opacity?: number;
}) {
  const id = `glow${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.glow,
        { width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2 },
      ]}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={tint} stopOpacity={opacity} />
            <Stop offset="0.45" stopColor={tint} stopOpacity={opacity * 0.45} />
            <Stop offset="1" stopColor={tint} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/**
 * A moment's words (headline, money, status), centred in a column. `glow` lights the moment:
 * 'in' green, 'out' red (the won / lost pair is symmetrical), omitted for none. Inside a
 * MomentScreen the light is the screen's aurora, hung from the top; anywhere else it is the soft
 * glow drawn behind the words.
 */
export function MomentGroup({
  glow: tone,
  children,
  style,
}: {
  glow?: 'in' | 'out';
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const askAurora = useContext(AuroraContext);
  useEffect(() => {
    if (!askAurora) return;
    askAurora(tone ?? null);
    return () => askAurora(null);
  }, [askAurora, tone]);
  return (
    <View style={[styles.momentGroup, style]} accessibilityLiveRegion="polite">
      {tone && !askAurora ? (
        <Glow
          tint={tone === 'in' ? color.positive : color.negative}
          opacity={tone === 'in' ? glow.opacity : glow.lossOpacity}
        />
      ) : null}
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------------------

const styles = StyleSheet.create({
  // A screen is its own stacking context: a control inside that raises itself (the swipe pill's
  // zIndex) stays under anything layered over the whole screen (the review sheet).
  screen: { flex: 1, backgroundColor: palette.background, isolation: 'isolate' },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  rowPressed: { opacity: 0.6 },
  pressedDim: { opacity: 0.7 },
  choiceDisabled: { opacity: 0.4 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.divider },
  topBar: {
    height: space.x7 - space.x1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.page,
  },
  topSide: { width: space.x8, justifyContent: 'center' },
  topRight: { alignItems: 'flex-end' },
  topTitle: { flex: 1, alignItems: 'center' },
  page: { flex: 1, paddingHorizontal: space.page, paddingBottom: space.x2 },
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.avatar,
    backgroundImage: material.disc,
    borderWidth: 1,
    borderColor: palette.rim,
  },
  presence: { position: 'absolute', right: -1, bottom: -1, borderWidth: 2.5 },
  cardFlat: { paddingVertical: space.x1 },
  card: {
    backgroundColor: palette.surface,
    backgroundImage: material.glass,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: palette.rim,
    boxShadow: material.highlight,
    padding: space.page,
  },
  infoRow: {
    minHeight: space.x6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.x2,
  },
  infoValue: { flexShrink: 1, textAlign: 'right', fontVariant: TABULAR },
  section: { marginTop: space.x3 },
  sectionLabel: { marginBottom: space.x1 },
  bullets: { gap: space.x1 },
  bullet: { flexDirection: 'row', gap: half.x15, alignItems: 'flex-start' },
  bulletDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.textSecondary,
    marginTop: 9,
  },
  listRow: {
    minHeight: space.row + space.x1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: half.x15 + half.x05,
  },
  chevronRight: { transform: [{ rotate: '180deg' }] },
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: palette.fill,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: palette.rim,
    paddingHorizontal: half.x15,
    paddingVertical: half.x05,
  },
  choice: {
    minWidth: space.x8,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: palette.rim,
    backgroundColor: palette.fill,
    paddingHorizontal: space.x2 + half.x05,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceOn: { backgroundColor: color.selected, borderColor: color.selected },
  dotsRow: { flexDirection: 'row', alignItems: 'center' },
  dotsOverflow: { position: 'absolute', left: '100%' },
  hold: {
    height: space.control,
    borderRadius: radius.pill,
    backgroundColor: color.commit,
    boxShadow: material.bloomOn,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: space.x3,
  },
  holdOff: { backgroundColor: palette.fill, boxShadow: 'none' },
  holdSweep: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: palette.black,
    opacity: hold.progressOpacity,
  },
  hero: { alignItems: 'center', gap: space.x2, paddingVertical: space.x3 },
  heroWords: { alignItems: 'center', gap: space.x1, alignSelf: 'stretch' },
  heroTitle: { marginTop: space.x1 },
  endTitle: { alignSelf: 'center', maxWidth: 280 },
  barTrack: {
    height: 2,
    borderRadius: 1,
    backgroundColor: palette.rim,
    overflow: 'hidden',
    marginTop: half.x05,
  },
  barFill: { height: 2, borderRadius: 1, backgroundColor: palette.text },
  dotsTrack: { flexDirection: 'row', justifyContent: 'center', gap: space.x1 },
  attemptDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.hairline,
  },
  attemptDone: { backgroundColor: palette.textSecondary },
  attemptNow: { backgroundColor: palette.text },
  banner: {
    flexDirection: 'row',
    gap: space.x1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
    overflow: 'hidden',
  },
  bannerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.textSecondary },
  moment: { flex: 1, backgroundColor: palette.background, isolation: 'isolate' },
  momentBody: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.page,
    paddingVertical: space.x2,
    gap: space.x3,
  },
  momentFooter: { paddingHorizontal: space.page, paddingBottom: space.x2, gap: half.x15 },
  headline: { alignSelf: 'stretch' },
  momentGroup: { alignSelf: 'stretch', alignItems: 'center', gap: space.x2 },
  glow: { position: 'absolute', left: '50%', top: '50%' },
  aurora: { position: 'absolute' },
});
