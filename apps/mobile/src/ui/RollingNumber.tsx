// Rolling numerals (design §3): money figures that roll like an odometer instead of re-rendering a
// counting string every frame. Every digit is a column clipped to one line, holding a strip of
// digits ("0 1 … 9 0") that slides on the UI thread (Reanimated); $ . , + − stay put. The maths
// lives in ./odometer (pure, tested).
//
// - RollingCents: a cents value (the balance, a payout). It rolls from the old value to the new
//   one over TICKER.rollMs (= payout.countUpMs) with the motion ease-out: the low digits spin,
//   the higher ones carry. A leading digit (crossing $9.99 -> $10.00) opens its width as it
//   carries in. `animate={false}` snaps (the scrub).
// - RollingText: any display string (the live market price). Each changed digit rolls from its
//   old digit to its new one over TICKER.tickMs, up when the number went up.
//
// Both: tabular numerals and the type token's tracking; fit-to-width measured once on layout (a
// re-render only when the scale changes, never per frame) down to `minScale`; a colour change
// (pending grey -> settled white) crossfades over TICKER.colorMs. The wrapper is one accessible
// element labelled with the final value (never an in-between number); the columns are hidden.
// Reduce Motion: values snap, colours swap. Every withTiming passes reduceMotion explicitly
// (Reanimated's System default would finish timings instantly; we decide here).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { centsToUsd } from './money';
import {
  CENTS_STRIP,
  dollarDigits,
  FIXED_COLUMNS,
  leadingReveal,
  odometerRow,
  rollPlan,
  TEXT_STRIP,
  textDirection,
  TICKER,
  type RollColumn,
} from './odometer';
import { motion, TABULAR } from './tokens';

const easeOut = Easing.bezier(...motion.easing);

/**
 * Rows in each digit strip. The strip's Text is given its full height (rows x line height)
 * explicitly: inside a one-line column the new architecture measures a Text "at most" as tall as
 * its parent, clamps it to one line and draws only that line, so every digit but 0 (row 0) came
 * out blank ("$ . 0" for $12.50). A set height is not clamped.
 */
const CENTS_ROWS = CENTS_STRIP.split('\n').length;
const TEXT_ROWS = TEXT_STRIP.split('\n').length;

/** A figure style: a type token (type.balance, type.money, type.value …). */
export type FigureStyle = TextStyle & { readonly fontSize: number; readonly lineHeight: number };

type Align = 'left' | 'center';

/** The token at `scale`, colour removed (it is animated separately), numerals tabular. */
function scaledStyle(style: FigureStyle, scale: number): TextStyle {
  const { color: _color, ...rest } = style;
  return {
    ...rest,
    fontSize: style.fontSize * scale,
    lineHeight: style.lineHeight * scale,
    letterSpacing: (style.letterSpacing ?? 0) * scale,
    fontVariant: TABULAR,
  };
}

/** A colour that crossfades to each new value over TICKER.colorMs (Reduce Motion: swaps). */
function useColorFade(color: string, reduce: boolean): SharedValue<string> {
  const c = useSharedValue(color);
  useEffect(() => {
    c.value = reduce
      ? color
      : withTiming(color, {
          duration: TICKER.colorMs,
          easing: easeOut,
          reduceMotion: ReduceMotion.Never,
        });
  }, [c, color, reduce]);
  return c;
}

/**
 * Fit to width: measures the box and the content (at the current scale) on layout and scales
 * the font down until the content fits, never below `minScale`. Re-renders only when the scale
 * actually changes.
 */
function useFit(minScale: number) {
  const [scale, setScale] = useState(1);
  const current = useRef(1);
  const box = useRef(0);
  const natural = useRef(0);
  const settle = () => {
    if (box.current <= 0 || natural.current <= 0) return;
    const s = Math.min(
      1,
      Math.max(minScale, Math.floor((box.current / natural.current) * 100) / 100),
    );
    if (Math.abs(s - current.current) < 0.005) return;
    current.current = s;
    setScale(s);
  };
  return {
    scale,
    onBox: (e: LayoutChangeEvent) => {
      box.current = e.nativeEvent.layout.width;
      settle();
    },
    onContent: (e: LayoutChangeEvent) => {
      natural.current = e.nativeEvent.layout.width / current.current;
      settle();
    },
  };
}

/** A fixed glyph ($ . , + − or a prefix such as "Balance $"). */
function Glyph({
  text,
  textStyle,
  color,
}: {
  text: string;
  textStyle: TextStyle;
  color: SharedValue<string>;
}) {
  const tint = useAnimatedStyle(() => ({ color: color.value }));
  return (
    <Animated.Text style={[textStyle, tint]} numberOfLines={1}>
      {text}
    </Animated.Text>
  );
}

/** The accessible, fit-to-width frame both modes share. */
function Frame({
  align,
  minScale,
  label,
  testID,
  children,
}: {
  align: Align;
  minScale: number;
  label: string;
  testID?: string | undefined;
  children: (scale: number) => ReactNode;
}) {
  const fit = useFit(minScale);
  return (
    <View
      testID={testID}
      style={[styles.box, align === 'center' && styles.boxCenter]}
      onLayout={fit.onBox}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <View
        style={styles.row}
        onLayout={fit.onContent}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {children(fit.scale)}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Cents mode
// ---------------------------------------------------------------------------------------

/** One digit column of a cents figure: column `k` (0 = cents ones) of the rolling value `v`. */
function CentsColumn({
  v,
  k,
  restingCents,
  textStyle,
  lineHeight,
  color,
  digitWidth,
  onDigitWidth,
  reduce,
}: {
  v: SharedValue<number>;
  k: number;
  /** Where `v` rests as this column mounts (decides whether a leading column starts open). */
  restingCents: number;
  textStyle: TextStyle;
  lineHeight: number;
  color: SharedValue<string>;
  digitWidth: number;
  onDigitWidth?: ((e: LayoutChangeEvent) => void) | undefined;
  reduce: boolean;
}) {
  const lead = k >= FIXED_COLUMNS;
  const open = useSharedValue(lead && leadingReveal(restingCents, k) <= 0 ? 0 : 1);
  useAnimatedReaction(
    () => (lead && leadingReveal(v.value, k) <= 0 ? 0 : 1),
    (on, prev) => {
      if (!lead || prev === null || on === prev) return;
      open.value = reduce
        ? on
        : withTiming(on, {
            duration: TICKER.leadMs,
            easing: easeOut,
            reduceMotion: ReduceMotion.Never,
          });
    },
    [lead, k, reduce],
  );
  const strip = useAnimatedStyle(() => ({
    color: color.value,
    transform: [{ translateY: -odometerRow(v.value, k) * lineHeight }],
  }));
  const reveal = useAnimatedStyle(() => {
    if (!lead) return {};
    // Before the digit width is measured, a closed column is simply collapsed.
    return digitWidth > 0
      ? { width: open.value * digitWidth, opacity: open.value }
      : { maxWidth: open.value > 0 ? 9999 : 0, opacity: open.value };
  });
  return (
    <Animated.View style={[styles.column, { height: lineHeight }, reveal]} onLayout={onDigitWidth}>
      <Animated.Text style={[textStyle, { height: lineHeight * CENTS_ROWS }, strip]}>
        {CENTS_STRIP}
      </Animated.Text>
    </Animated.View>
  );
}

/**
 * A rolling dollar figure from whole cents: `${prefix}12.50`. Shows |cents| (like centsToUsd).
 * - Mount: rests at `fromCents` (if given) and rolls to `cents`; otherwise shows `cents`.
 * - Change: rolls over TICKER.rollMs when `animate`, else snaps.
 * - `color`: crossfades on change (pending grey -> settled white).
 * - `accessibilityLabel` (default `${prefix}${centsToUsd(cents)}` without the "$" doubled): the
 *   final value; the wrapper carries `testID`.
 */
export function RollingCents({
  cents,
  fromCents,
  prefix = '$',
  style,
  color,
  animate = true,
  align = 'left',
  minScale = TICKER.minScale,
  testID,
  accessibilityLabel,
}: {
  cents: number;
  fromCents?: number | undefined;
  /** Static text before the dollar digits, including the "$" ("$", "+$", "Balance $"). */
  prefix?: string;
  style: FigureStyle;
  color: string;
  animate?: boolean;
  align?: Align;
  minScale?: number;
  testID?: string | undefined;
  accessibilityLabel?: string | undefined;
}) {
  const reduce = useReducedMotion();
  const target = Math.abs(Math.trunc(cents));
  const start =
    animate && !reduce && fromCents !== undefined ? Math.abs(Math.trunc(fromCents)) : target;
  const v = useSharedValue(start);
  const tint = useColorFade(color, reduce);

  // Where v rested before the latest change (state from props, so no ref is read in render):
  // the column count covers both ends of a roll, and a leading column that mounts mid-change
  // knows whether it starts closed.
  const [last, setLast] = useState(target);
  const [resting, setResting] = useState(start);
  if (target !== last) {
    setResting(last);
    setLast(target);
  }

  useEffect(() => {
    v.value =
      animate && !reduce
        ? withTiming(target, {
            duration: TICKER.rollMs,
            easing: easeOut,
            reduceMotion: ReduceMotion.Never,
          })
        : target;
  }, [v, target, animate, reduce]);

  const [digitWidth, setDigitWidth] = useState(0);
  const onDigitWidth = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - digitWidth) > 0.25) setDigitWidth(w);
  };

  const dollars = Math.max(dollarDigits(resting), dollarDigits(target));
  // Column indices, most significant first: dollars (k = dollars + 1 … 2), then cents (1, 0).
  const dollarKs = Array.from({ length: dollars }, (_, i) => dollars + 1 - i);
  const label = accessibilityLabel ?? `${prefix.replace(/\$$/, '')}${centsToUsd(target)}`;

  return (
    <Frame align={align} minScale={minScale} label={label} testID={testID}>
      {(scale) => {
        const textStyle = scaledStyle(style, scale);
        const lineHeight = style.lineHeight * scale;
        const column = (k: number) => (
          <CentsColumn
            key={`k${k}`}
            v={v}
            k={k}
            restingCents={resting}
            textStyle={textStyle}
            lineHeight={lineHeight}
            color={tint}
            digitWidth={digitWidth}
            onDigitWidth={k === FIXED_COLUMNS - 1 ? onDigitWidth : undefined}
            reduce={reduce}
          />
        );
        return (
          <>
            {prefix ? <Glyph text={prefix} textStyle={textStyle} color={tint} /> : null}
            {dollarKs.map(column)}
            <Glyph text="." textStyle={textStyle} color={tint} />
            {column(1)}
            {column(0)}
          </>
        );
      }}
    </Frame>
  );
}

// ---------------------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------------------

/** One digit of a rolling string: rolls fromRow -> toRow on the two-turn strip per change. */
function TextColumn({
  col,
  change,
  textStyle,
  lineHeight,
  color,
  reduce,
}: {
  col: Extract<RollColumn, { kind: 'digit' }>;
  /** Bumps on every text change, so an identical plan still restarts. */
  change: number;
  textStyle: TextStyle;
  lineHeight: number;
  color: SharedValue<string>;
  reduce: boolean;
}) {
  const { fromRow, toRow } = col;
  const row = useSharedValue(toRow);
  useEffect(() => {
    row.value =
      fromRow === toRow || reduce
        ? toRow
        : withSequence(
            withTiming(fromRow, { duration: 0, reduceMotion: ReduceMotion.Never }),
            withTiming(toRow, {
              duration: TICKER.tickMs,
              easing: easeOut,
              reduceMotion: ReduceMotion.Never,
            }),
          );
  }, [row, fromRow, toRow, change, reduce]);
  const strip = useAnimatedStyle(() => ({
    color: color.value,
    transform: [{ translateY: -row.value * lineHeight }],
  }));
  return (
    <View style={[styles.column, { height: lineHeight }]}>
      <Animated.Text style={[textStyle, { height: lineHeight * TEXT_ROWS }, strip]}>
        {TEXT_STRIP}
      </Animated.Text>
    </View>
  );
}

/**
 * A rolling display string ("$97,120.50"): each changed digit rolls to its new digit over
 * TICKER.tickMs, up when the number went up, down when it went down. Glyphs and new columns just
 * appear. The wrapper is accessible, labelled `accessibilityLabel ?? text`, and carries `testID`.
 */
export function RollingText({
  text,
  style,
  color,
  align = 'left',
  minScale = TICKER.minScale,
  testID,
  accessibilityLabel,
}: {
  text: string;
  style: FigureStyle;
  color?: string | undefined;
  align?: Align;
  minScale?: number;
  testID?: string | undefined;
  accessibilityLabel?: string | undefined;
}) {
  const reduce = useReducedMotion();
  const tint = useColorFade(color ?? (style.color as string | undefined) ?? '#FFFFFF', reduce);
  const [shown, setShown] = useState(text);
  const [plan, setPlan] = useState(() => ({ change: 0, cols: rollPlan(text, text, 0) }));
  if (text !== shown) {
    setShown(text);
    setPlan((p) => ({
      change: p.change + 1,
      cols: rollPlan(shown, text, textDirection(shown, text)),
    }));
  }
  const n = plan.cols.length;
  return (
    <Frame align={align} minScale={minScale} label={accessibilityLabel ?? text} testID={testID}>
      {(scale) => {
        const textStyle = scaledStyle(style, scale);
        const lineHeight = style.lineHeight * scale;
        // Keyed from the right, so digits keep their columns when the string grows on the left.
        return plan.cols.map((col, i) =>
          col.kind === 'digit' ? (
            <TextColumn
              key={`d${n - 1 - i}`}
              col={col}
              change={plan.change}
              textStyle={textStyle}
              lineHeight={lineHeight}
              color={tint}
              reduce={reduce}
            />
          ) : (
            <Glyph key={`g${n - 1 - i}`} text={col.ch} textStyle={textStyle} color={tint} />
          ),
        );
      }}
    </Frame>
  );
}

const styles = StyleSheet.create({
  box: { alignSelf: 'stretch', flexDirection: 'row' },
  boxCenter: { justifyContent: 'center' },
  row: { flexDirection: 'row' },
  column: { overflow: 'hidden' },
});
