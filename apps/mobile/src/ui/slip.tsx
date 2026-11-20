// The bet slip (Limelight): the terms as an object you could hold. A soft ticket with the claim
// in bold, the two stakes either side of the pot, and the conditions under perforations, like
// the stub you keep. Used by the terms card; the pieces are plain Views and one SVG line.
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { BackdropProvider } from './kit';
import { dp, half, material, palette, radius, space, type } from './tokens';

/** The ticket: a soft panel, radius 32. It clips, so a Perforation's notches bite its edge. */
export function Slip({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <BackdropProvider value="raised">
      <View testID={testID} style={[styles.slip, style]}>
        {children}
      </View>
    </BackdropProvider>
  );
}

/**
 * The tear line across a slip: a row of round dots from edge to edge with a half-round notch
 * bitten out of each side (a page-black disc, clipped by the slip). Decorative.
 */
export function Perforation() {
  return (
    <View
      style={styles.perforation}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <Svg width="100%" height={2}>
        <Line
          x1="0"
          y1="1"
          x2="100%"
          y2="1"
          stroke={palette.rim}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="1 8"
        />
      </Svg>
      <View style={[styles.notch, styles.notchLeft]} />
      <View style={[styles.notch, styles.notchRight]} />
    </View>
  );
}

/**
 * The slip's serial: the terms code in spaced tabular capitals, dim. The same code shows on the
 * other phone and on the stage, so both sides can see they hold the same slip.
 */
export function Serial({ code, label }: { code: string; label: string }) {
  return (
    <Text
      style={styles.serial}
      numberOfLines={1}
      accessibilityLabel={`${label} ${code}`}
      allowFontScaling={false}
    >
      {code}
    </Text>
  );
}

/**
 * Conditions with a mark in front: a green tick for what counts, a red cross for what does not.
 * The mark sits on the first line's centre.
 */
export function Criteria({ items, tone }: { items: readonly string[]; tone: 'yes' | 'no' }) {
  return (
    <View style={styles.criteria}>
      {items.map((text, i) => (
        <View key={i} style={styles.criterion}>
          <View style={[styles.mark, tone === 'yes' ? styles.markYes : styles.markNo]}>
            {tone === 'yes' ? (
              <View style={styles.tick} />
            ) : (
              <>
                <View style={[styles.crossBar, styles.crossA]} />
                <View style={[styles.crossBar, styles.crossB]} />
              </>
            )}
          </View>
          <Text style={[type.label, styles.criterionText]}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

const NOTCH = dp(20);
const MARK = dp(20);

const styles = StyleSheet.create({
  slip: {
    backgroundColor: palette.surface,
    backgroundImage: material.glass,
    borderRadius: radius.xl,
    boxShadow: material.highlight,
    padding: space.page,
    overflow: 'hidden',
  },
  perforation: {
    height: NOTCH,
    marginHorizontal: -space.page,
    marginVertical: half.x15,
    justifyContent: 'center',
  },
  notch: {
    position: 'absolute',
    top: 0,
    width: NOTCH,
    height: NOTCH,
    borderRadius: NOTCH / 2,
    backgroundColor: palette.background,
  },
  // Half of each disc hangs outside the slip, which clips it: what is left is the bite.
  notchLeft: { left: -NOTCH / 2 - 1 },
  notchRight: { right: -NOTCH / 2 - 1 },
  serial: {
    ...type.small,
    color: palette.textTertiary,
    fontFamily: type.smallStrong.fontFamily,
    fontWeight: type.smallStrong.fontWeight,
    letterSpacing: 1.4,
    fontVariant: ['tabular-nums'],
    textTransform: 'uppercase',
  },
  criteria: { gap: half.x15 },
  criterion: { flexDirection: 'row', alignItems: 'flex-start', gap: half.x15 },
  criterionText: { flex: 1 },
  mark: {
    width: MARK,
    height: MARK,
    borderRadius: MARK / 2,
    marginTop: (type.label.lineHeight - MARK) / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markYes: { backgroundColor: 'rgba(0, 212, 122, 0.16)' },
  markNo: { backgroundColor: 'rgba(255, 79, 69, 0.16)' },
  // A tick: a box's left and bottom edges, rotated.
  tick: {
    width: dp(8.5),
    height: dp(5),
    borderLeftWidth: 2.25,
    borderBottomWidth: 2.25,
    borderColor: palette.accent,
    transform: [{ translateY: -1 }, { rotate: '-45deg' }],
  },
  crossBar: {
    position: 'absolute',
    width: dp(9.5),
    height: 2.25,
    borderRadius: 1.25,
    backgroundColor: palette.danger,
  },
  crossA: { transform: [{ rotate: '45deg' }] },
  crossB: { transform: [{ rotate: '-45deg' }] },
});
