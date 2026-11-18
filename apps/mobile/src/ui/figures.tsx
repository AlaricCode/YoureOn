// The money figures (design §2 and §3): the Home balance header (rolling numerals, a delta /
// change line and a scrubbable sparkline), the quiet balance line on a payout moment, and the
// moment's giant money figure. Same names and props as the ones they replace in ./parts, which
// re-exports these, so every screen (and feat/gg-moment's src/gg) gets them unchanged.
//
// Imports only kit, tokens, money, spark and siblings, never ./parts (no import cycle). Every
// timing passes reduceMotion explicitly; Reduce Motion comes from Reanimated's useReducedMotion
// (synchronous, so nothing waits on a first answer).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Label } from './kit';
import { centsToUsd, signedCentsToUsd } from './money';
import { RollingCents } from './RollingNumber';
import { balanceA11yValue, scrubDelta, scrubStep } from './scrub';
import { ScrubSparkline } from './ScrubSparkline';
import { SPARK_MIN_POINTS } from './spark';
import { color, half, moneyColor, motion, palette, payout, space, type } from './tokens';

const easeOut = Easing.bezier(...motion.easing);

/**
 * The balance header (TASKS D3-M2), the Home signature: "Balance" in grey 15, the figure in Geist
 * Light 56 with tabular numerals, then one line under it and an optional sparkline.
 * - The figure rolls (odometer) from the old value to the new one over payout.countUpMs, at
 *   `processed` and back again on a revert. While a payout is processed but not yet confirmed
 *   it is grey (pending), crossfading to white.
 * - `delta` ("+$5" at a payout) shows on the line under the figure in green, fading in over
 *   `payout.revealMs`.
 * - Otherwise `change` shows there: the signed amount in green / red, plus an optional grey
 *   `caption` (screen copy; it must pass ui/copyRule). Omit it when there is no real data.
 * - `series` (balance points, oldest first; app/history balanceSeries) draws the scrubbable
 *   sparkline (testID 'balance-spark') under it; hidden under three points. While a finger is
 *   on it the figure snaps to that point's balance and the change line to the change from the
 *   first point up to it (same caption); on release both snap back to live. No scrub while
 *   `pending` or while a `delta` shows.
 *
 * VoiceOver: the figure, the line under it and "In bets" are one element labelled "Balance"
 * whose value reads "$32.15, +$2.15"; with three or more points it is adjustable (swipe up /
 * down steps through the points, changing only what is read). The "Balance" text above is not
 * read separately; `trailing` (Home's avatar) stays its own element. `balance-header` stays on
 * the outer View.
 */
export function BalanceHeader({
  cents,
  pending = false,
  inBetsUsd,
  delta,
  change,
  series,
  trailing,
}: {
  cents: number;
  pending?: boolean;
  inBetsUsd?: string | null;
  /** Right-aligned on the "Balance" label row, centred on it (Home: your avatar). */
  trailing?: ReactNode;
  /** "+$5" under the number at a payout; fades in over `payout.revealMs`. */
  delta?: string | null;
  /** The net change to show under the figure when there is no payout delta. */
  change?: { readonly cents: number; readonly caption?: string } | null;
  /** Balance points for the sparkline, oldest first. */
  series?: readonly number[] | null;
}) {
  // One stable array per series: the scrub's layout (and its UI-thread copy) recompute only when
  // the series does, not on every scrub step.
  const points = useMemo(() => series?.filter((p) => Number.isFinite(p)) ?? [], [series]);
  const hasSpark = points.length >= SPARK_MIN_POINTS;
  const scrubOff = pending || Boolean(delta);

  // The point under the finger (null: live). Dropped when scrubbing turns off (a payout lands
  // mid-scrub), so it cannot come back stale.
  const [touched, setTouched] = useState<number | null>(null);
  if (scrubOff && touched !== null) setTouched(null);
  const scrub =
    !scrubOff && hasSpark && touched !== null && touched < points.length ? touched : null;
  // The figure snaps while scrubbing and on the commit that releases back to live (the ref still
  // holds the last render's state); every other change rolls.
  const scrubbed = useRef(false);
  const snap = scrub !== null || scrubbed.current;
  useEffect(() => {
    scrubbed.current = scrub !== null;
  });

  // VoiceOver's reading position (null: live). Changes only what is read.
  const [readAt, setReadAt] = useState<number | null>(null);
  const reading = hasSpark && readAt !== null && readAt < points.length ? readAt : null;

  const deltaShown = useSharedValue(0);
  useEffect(() => {
    deltaShown.value = withTiming(delta ? 1 : 0, {
      duration: payout.revealMs,
      easing: easeOut,
      reduceMotion: ReduceMotion.Never,
    });
  }, [delta, deltaShown]);
  const deltaStyle = useAnimatedStyle(() => ({ opacity: deltaShown.value }));

  const figureCents = scrub !== null ? (points[scrub] as number) : cents;
  const lineChange =
    scrub !== null
      ? { cents: scrubDelta(points, scrub), caption: change?.caption }
      : (change ?? null);

  const onA11yAction = (e: AccessibilityActionEvent) => {
    const name = e.nativeEvent.actionName;
    if (name === 'increment') setReadAt((at) => scrubStep(at, points.length, 1));
    if (name === 'decrement') setReadAt((at) => scrubStep(at, points.length, -1));
  };

  return (
    <View style={styles.balance} testID="balance-header">
      <View style={trailing ? styles.balanceLabelRow : undefined}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Label variant="value">Balance</Label>
        </View>
        {trailing}
      </View>
      <View
        style={styles.figureBlock}
        accessible
        accessibilityLabel="Balance"
        accessibilityRole={hasSpark ? 'adjustable' : 'text'}
        accessibilityValue={{
          text: balanceA11yValue({
            cents,
            series: points,
            at: reading,
            changeCents: change?.cents,
            delta,
            inBetsUsd,
          }),
        }}
        accessibilityActions={hasSpark ? [{ name: 'increment' }, { name: 'decrement' }] : undefined}
        onAccessibilityAction={hasSpark ? onA11yAction : undefined}
      >
        <RollingCents
          cents={figureCents}
          style={type.balance}
          color={pending ? payout.pendingColor : payout.settledColor}
          animate={!snap}
          accessibilityLabel={centsToUsd(cents)}
        />
        {delta && scrub === null ? (
          <Animated.Text style={[type.labelMedium, styles.delta, deltaStyle]}>
            {delta}
          </Animated.Text>
        ) : lineChange ? (
          <View style={styles.changeRow}>
            <Text
              style={[type.labelMedium, styles.tabular, { color: moneyColor(lineChange.cents) }]}
            >
              {signedCentsToUsd(lineChange.cents)}
            </Text>
            {lineChange.caption ? <Label variant="value">{lineChange.caption}</Label> : null}
          </View>
        ) : null}
        {inBetsUsd ? (
          <View style={styles.inBets}>
            <Label variant="small">In bets</Label>
            <Text style={[type.smallStrong, styles.tabular]}>{inBetsUsd}</Text>
          </View>
        ) : null}
      </View>
      {hasSpark ? (
        <View style={styles.spark}>
          <ScrubSparkline points={points} onScrub={setTouched} disabled={scrubOff} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The balance on a moment (the payout): one quiet grey 15/400 tabular line, "Balance $47.50",
 * under the hero amount, so the hero stays the only large figure. It rolls like the Home
 * figure; while the payout is processed but not confirmed it is dim (pending), then grey.
 */
export function BalanceLine({ cents, pending = false }: { cents: number; pending?: boolean }) {
  return (
    <View
      style={styles.balanceLine}
      testID="balance-header"
      accessible
      accessibilityLabel={`Balance ${centsToUsd(cents)}`}
    >
      <RollingCents
        cents={cents}
        prefix="Balance $"
        style={type.value}
        color={pending ? palette.textTertiary : palette.textSecondary}
        align="center"
        accessibilityLabel={`Balance ${centsToUsd(cents)}`}
      />
    </View>
  );
}

/**
 * The money on a moment: a giant Geist Light 56 figure, green with "+" for money in, red with
 * "−" for money out. Its glow is drawn by the enclosing MomentGroup (behind the headline too).
 * - `direction="in"` with `cents`: rolls up from +$0.00 over `payout.countUpMs` (Reduce
 *   Motion: static) and reads "+$5.00".
 * - `direction="out"` with `cents`: static "−$5.00".
 * - `text`: a ready string (e.g. "+$5" from BetView) shown as is, no roll.
 */
export function MomentMoney({
  direction,
  cents,
  text,
  testID,
}: {
  direction: 'in' | 'out';
  cents?: number;
  text?: string;
  testID?: string;
}) {
  const target = cents ?? 0;
  const tint = direction === 'in' ? color.positive : color.negative;
  const sign = direction === 'in' ? '+' : '−';
  const label = text ?? `${sign}${centsToUsd(target)}`;
  if (text === undefined && direction === 'in') {
    // fromCents applies at mount only (Reduce Motion: RollingCents starts on the value).
    return (
      <View style={styles.money}>
        <RollingCents
          cents={target}
          fromCents={0}
          prefix="+$"
          style={type.money}
          color={tint}
          align="center"
          minScale={0.5}
          testID={testID}
          accessibilityLabel={label}
        />
      </View>
    );
  }
  return (
    <View style={styles.money}>
      <Text
        testID={testID}
        style={[type.money, styles.center, { color: tint }]}
        accessibilityLabel={label}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.5}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  tabular: { fontVariant: ['tabular-nums'] },
  balance: { paddingVertical: space.x2, gap: half.x05 },
  balanceLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  figureBlock: { gap: half.x05 },
  delta: { color: payout.deltaColor, fontVariant: ['tabular-nums'] },
  changeRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.x1 },
  inBets: { flexDirection: 'row', gap: space.x1, marginTop: half.x05 },
  spark: { marginTop: space.x3 },
  balanceLine: { alignSelf: 'stretch', alignItems: 'center' },
  money: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
});
