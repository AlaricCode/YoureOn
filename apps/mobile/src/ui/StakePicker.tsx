// StakePicker: the row of stake chips ($1 $2 $5 $10) with ONE green pill that slides to the
// chosen chip, instead of each chip snapping its own fill. At rest it looks exactly like the old
// ChoiceChip row: #1C1C1F pills, the selected one green with black ink.
//
// Layers (one coordinate space, the row): grey discs at each chip's measured frame, then the green
// pill, then the chips themselves (transparent, label only) on top. Until every chip has
// measured, each chip draws its own fill, so nothing flashes on first paint. The pill's x, y,
// width and height are shared values animated on the UI thread (200 ms ease-out); a chip's ink
// crossfades white <-> black over 150 ms; a press scales the chip (and the disc or pill under it)
// to 0.95. A user change plays one selection tick.
//
// Accessibility is unchanged: a radiogroup of radios, each `testID={prefix + usd}`, label "$N",
// state {selected, disabled}. Reduce Motion: the pill jumps, the ink swaps, presses only dim.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { feel } from '../device/feedback';
import {
  allMeasured,
  pillFrame,
  pillMove,
  press,
  pressAt,
  sameFrame,
  stakePill,
  stakeTap,
  type Frame,
} from './polish';
import { color, half, motion, palette, radius, space, TABULAR, type } from './tokens';

const easeOut = Easing.bezier(...motion.easing);

/** The selection tick. */
function selectTick(): void {
  feel('select');
}

type Press = { index: SharedValue<number>; amt: SharedValue<number>; reduced: boolean };

/** Scale / dim for whatever sits at option `i` while it is pressed. */
function usePressStyle(i: number, { index, amt, reduced }: Press) {
  // Shared values and primitives only in the closure, so the mapper is not rebuilt per render.
  return useAnimatedStyle(() => {
    const s = pressAt(index.value === i ? amt.value : 0, reduced, press.chipScale);
    return { opacity: s.opacity, transform: [{ scale: s.scale }] };
  });
}

export function StakePicker({
  options,
  value,
  onChange,
  testIDPrefix,
  disabled = false,
  format = (usd: number) => `$${usd}`,
  style,
}: {
  options: readonly number[];
  value: number;
  onChange: (usd: number) => void;
  /** Each chip's testID is `${testIDPrefix}${usd}` ("typed-stake-", "market-stake-"). */
  testIDPrefix: string;
  /** Blocks presses and dims the row to 0.4 (a send or lock in progress). */
  disabled?: boolean;
  /** The chip label (and its accessibility label). */
  format?: (usd: number) => string;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const [frames, setFrames] = useState<Record<number, Frame | undefined>>({});
  const target = pillFrame(options, frames, value);
  const measured = allMeasured(options, frames);

  // The pill.
  const px = useSharedValue(0);
  const py = useSharedValue(0);
  const pw = useSharedValue(0);
  const ph = useSharedValue(0);
  const shown = useSharedValue(0);
  const placed = useRef(false);

  // The press: which option, and how far in (0..1).
  const pressIndex = useSharedValue(-1);
  const pressAmt = useSharedValue(0);
  const pressing: Press = { index: pressIndex, amt: pressAmt, reduced };

  const tx = target?.x ?? 0;
  const ty = target?.y ?? 0;
  const tw = target?.width ?? 0;
  const th = target?.height ?? 0;
  const hasTarget = target !== null;
  useEffect(() => {
    if (!hasTarget) {
      shown.value = 0;
      placed.current = false;
      return;
    }
    if (pillMove(placed.current, reduced) === 'slide') {
      px.value = withTiming(tx, {
        duration: stakePill.slideMs,
        easing: easeOut,
        reduceMotion: ReduceMotion.Never,
      });
      py.value = withTiming(ty, {
        duration: stakePill.slideMs,
        easing: easeOut,
        reduceMotion: ReduceMotion.Never,
      });
      pw.value = withTiming(tw, {
        duration: stakePill.slideMs,
        easing: easeOut,
        reduceMotion: ReduceMotion.Never,
      });
      ph.value = withTiming(th, {
        duration: stakePill.slideMs,
        easing: easeOut,
        reduceMotion: ReduceMotion.Never,
      });
    } else {
      px.value = tx;
      py.value = ty;
      pw.value = tw;
      ph.value = th;
    }
    shown.value = 1;
    placed.current = true;
  }, [hasTarget, tx, ty, tw, th, reduced, px, py, pw, ph, shown]);

  const selectedIndex = options.indexOf(value);
  const pillPress = usePressStyle(selectedIndex, pressing);
  const pillStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    width: pw.value,
    height: ph.value,
    transform: [{ translateX: px.value }, { translateY: py.value }],
  }));

  const onFrame = useCallback((usd: number, f: Frame) => {
    setFrames((prev) => (sameFrame(prev[usd], f) ? prev : { ...prev, [usd]: f }));
  }, []);

  const tap = (usd: number) => {
    const t = stakeTap(value, usd, disabled);
    if (t.haptic) selectTick();
    if (t.report) onChange(usd);
  };

  return (
    <View accessibilityRole="radiogroup" style={[styles.row, disabled && styles.disabled, style]}>
      {measured ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {options.map((usd, i) => {
            const f = frames[usd];
            return f ? <Disc key={usd} frame={f} index={i} pressing={pressing} /> : null;
          })}
          <Animated.View style={[styles.pill, pillStyle]}>
            <Animated.View style={[styles.pillFill, pillPress]} />
          </Animated.View>
        </View>
      ) : null}
      {options.map((usd, i) => (
        <Chip
          key={usd}
          usd={usd}
          index={i}
          label={format(usd)}
          testID={`${testIDPrefix}${usd}`}
          selected={usd === value}
          disabled={disabled}
          ownFill={!measured}
          pressing={pressing}
          onFrame={onFrame}
          onTap={tap}
        />
      ))}
    </View>
  );
}

/** The grey pill behind an unselected chip (the green pill slides over these). */
function Disc({ frame, index, pressing }: { frame: Frame; index: number; pressing: Press }) {
  const pressStyle = usePressStyle(index, pressing);
  return (
    <Animated.View
      style={[
        styles.disc,
        { left: frame.x, top: frame.y, width: frame.width, height: frame.height },
        pressStyle,
      ]}
    />
  );
}

function Chip({
  usd,
  index,
  label,
  testID,
  selected,
  disabled,
  ownFill,
  pressing,
  onFrame,
  onTap,
}: {
  usd: number;
  index: number;
  label: string;
  testID: string;
  selected: boolean;
  disabled: boolean;
  /** Before the row is measured: draw this chip's own fill (grey, or green when selected). */
  ownFill: boolean;
  pressing: Press;
  onFrame: (usd: number, f: Frame) => void;
  onTap: (usd: number) => void;
}) {
  const { reduced, index: pressIndex, amt } = pressing;
  const ink = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    const to = selected ? 1 : 0;
    ink.value = reduced
      ? to
      : withTiming(to, {
          duration: stakePill.inkMs,
          easing: easeOut,
          reduceMotion: ReduceMotion.Never,
        });
  }, [selected, reduced, ink]);

  const pressStyle = usePressStyle(index, pressing);
  const inkStyle = useAnimatedStyle(() => ({
    color: interpolateColor(ink.value, [0, 1], [palette.text, color.onAccent]),
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    onFrame(usd, { x, y, width, height });
  };

  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={label}
      onPress={disabled ? undefined : () => onTap(usd)}
      onPressIn={() => {
        if (disabled) return;
        pressIndex.value = index;
        amt.value = reduced
          ? 1
          : withTiming(1, {
              duration: press.inMs,
              easing: easeOut,
              reduceMotion: ReduceMotion.Never,
            });
      }}
      onPressOut={() => {
        amt.value = reduced
          ? 0
          : withTiming(0, {
              duration: press.outMs,
              easing: easeOut,
              reduceMotion: ReduceMotion.Never,
            });
      }}
      onLayout={onLayout}
    >
      <Animated.View
        style={[
          styles.chip,
          ownFill && { backgroundColor: selected ? color.selected : palette.fill },
          pressStyle,
        ]}
      >
        <Animated.Text style={[type.rowMedium, styles.ink, inkStyle]}>{label}</Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x1 },
  disabled: { opacity: stakePill.disabledOpacity },
  // ChoiceChip's box: 44 pt pill, at least 64 wide, 20 pt sides.
  chip: {
    minWidth: space.x8,
    height: 44,
    borderRadius: radius.pill,
    paddingHorizontal: space.x2 + half.x05,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ink: { fontVariant: TABULAR },
  disc: { position: 'absolute', borderRadius: radius.pill, backgroundColor: palette.fill },
  pill: { position: 'absolute', left: 0, top: 0 },
  pillFill: { flex: 1, borderRadius: radius.pill, backgroundColor: color.selected },
});
