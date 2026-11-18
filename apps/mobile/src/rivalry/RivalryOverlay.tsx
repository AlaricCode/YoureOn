// Draws the live rivalry scan over the camera (or the preview's fake one): the focused known
// face gets a card (name, record, net, streak / "Rivals" / "First bet" chips, Challenge), other
// known faces a small pill, and faces still being checked, too far away or not recognised get a
// ring only (never a name). Layout is pure (src/rivalry/geometry overlayItems); this file only
// renders and animates it: 120 ms position moves, a motion.fastMs crossfade when the focus
// changes, and a 1.08 -> 1 pop when a record changes. Everything runs on the native driver; with
// `reduceMotion` nothing moves but the values.
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { PrimaryButton, StageBubble } from '../ui/kit';
import { motion, palette, radius, space, type } from '../ui/tokens';
import { RIVALRY_COPY, rt } from './copy';
import type { LiveStatus, OverlayItem, Size } from './types';

/** Position moves of cards and pills. */
export const MOVE_MS = 120;
/** The record "pop" when it changes. */
export const POP_SCALE = 1.08;
/** Default sizes until the card has been measured (overlayItems needs one to place it). */
export const DEFAULT_CARD_SIZE: Size = { width: 248, height: 148 };
export const PILL_SIZE: Size = { width: 132, height: 32 };

const easeOut = Easing.bezier(...motion.easing);

type KnownItem = Extract<OverlayItem, { kind: 'known' }>;

export interface RivalryOverlayProps {
  items: readonly OverlayItem[];
  status: LiveStatus;
  /** The face whose Challenge is running (its button shows busy). */
  challengingKey: string | null;
  onChallenge(key: string): void;
  /** The focused card's measured size, for overlayItems' placement. */
  onCardSize?(s: Size): void;
  reduceMotion?: boolean;
}

export function RivalryOverlay({
  items,
  status,
  challengingKey,
  onChallenge,
  onCardSize,
  reduceMotion = false,
}: RivalryOverlayProps) {
  const bubble =
    status === 'point'
      ? rt(RIVALRY_COPY.point)
      : status === 'not_in_room'
        ? rt(RIVALRY_COPY.joinRoom)
        : null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="rivalry-overlay">
      {items.map((item) => (
        <Ring key={`ring-${item.key}`} item={item} reduceMotion={reduceMotion} />
      ))}
      {items.map((item) =>
        item.kind !== 'known' ? null : item.focused ? (
          <Card
            // A new key when the focus changes: the card crossfades in rather than morphing.
            key={`card-${item.key}`}
            item={item}
            busy={challengingKey === item.key}
            disabled={challengingKey !== null}
            onChallenge={onChallenge}
            onSize={onCardSize}
            reduceMotion={reduceMotion}
          />
        ) : (
          <Pill key={`pill-${item.key}`} item={item} reduceMotion={reduceMotion} />
        ),
      )}
      {bubble !== null ? <StageBubble prompt={bubble} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------

/** Moves to (x, y) over MOVE_MS (or jumps there on mount / with reduce motion). */
function useMovingAnchor(x: number, y: number, reduceMotion: boolean) {
  const pos = useRef(new Animated.ValueXY({ x, y })).current;
  useEffect(() => {
    if (reduceMotion) {
      pos.setValue({ x, y });
      return;
    }
    const a = Animated.timing(pos, {
      toValue: { x, y },
      duration: MOVE_MS,
      easing: easeOut,
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [pos, x, y, reduceMotion]);
  return pos;
}

/** 0 -> 1 over motion.fastMs on mount. */
function useFadeIn(reduceMotion: boolean) {
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion) return;
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion.fastMs,
      easing: easeOut,
      useNativeDriver: true,
    }).start();
  }, [opacity, reduceMotion]);
  return opacity;
}

/** POP_SCALE -> 1 whenever `record` changes (not on mount). */
function usePop(record: string, reduceMotion: boolean) {
  const scale = useRef(new Animated.Value(1)).current;
  const last = useRef(record);
  useEffect(() => {
    if (last.current === record) return;
    last.current = record;
    if (reduceMotion) return;
    scale.setValue(POP_SCALE);
    Animated.timing(scale, {
      toValue: 1,
      duration: motion.fastMs,
      easing: easeOut,
      useNativeDriver: true,
    }).start();
  }, [record, scale, reduceMotion]);
  return scale;
}

function Card({
  item,
  busy,
  disabled,
  onChallenge,
  onSize,
  reduceMotion,
}: {
  item: KnownItem;
  busy: boolean;
  disabled: boolean;
  onChallenge: (key: string) => void;
  onSize: ((s: Size) => void) | undefined;
  reduceMotion: boolean;
}) {
  const pos = useMovingAnchor(item.anchor.x, item.anchor.y, reduceMotion);
  const opacity = useFadeIn(reduceMotion);
  const scale = usePop(item.record, reduceMotion);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    onSize?.({ width: Math.round(width), height: Math.round(height) });
  };
  const chips: string[] = [];
  if (item.firstBet) chips.push(rt(RIVALRY_COPY.firstBet));
  if (item.rival) chips.push(rt(RIVALRY_COPY.rivals));
  if (item.streakLabel) chips.push(item.streakLabel);
  return (
    <Animated.View
      testID={`rivalry-card-${item.key}`}
      onLayout={onLayout}
      style={[styles.card, { opacity, transform: [{ translateX: pos.x }, { translateY: pos.y }] }]}
    >
      <View style={styles.cardHead}>
        <Text style={[type.heading, styles.flex]} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={[type.label, item.net.startsWith('−') ? styles.down : null]}>{item.net}</Text>
      </View>
      <Animated.Text
        testID="rivalry-record"
        style={[type.title, styles.record, { transform: [{ scale }] }]}
      >
        {item.record}
      </Animated.Text>
      {chips.length > 0 ? (
        <View style={styles.chips}>
          {chips.map((c) => (
            <View key={c} style={styles.chip}>
              <Text style={type.small}>{c}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <PrimaryButton
        testID="rivalry-challenge"
        label={rt(RIVALRY_COPY.challenge)}
        busy={busy}
        disabled={disabled && !busy}
        onPress={() => onChallenge(item.key)}
      />
    </Animated.View>
  );
}

function Pill({ item, reduceMotion }: { item: KnownItem; reduceMotion: boolean }) {
  const pos = useMovingAnchor(item.anchor.x, item.anchor.y, reduceMotion);
  const opacity = useFadeIn(reduceMotion);
  const scale = usePop(item.record, reduceMotion);
  return (
    <Animated.View
      testID={`rivalry-pill-${item.key}`}
      pointerEvents="none"
      style={[
        styles.pill,
        {
          opacity: item.hidden ? 0 : opacity,
          transform: [{ translateX: pos.x }, { translateY: pos.y }, { scale }],
        },
      ]}
    >
      <Text style={[type.small, styles.pillName]} numberOfLines={1}>
        {item.name}
      </Text>
      <Text style={type.labelStrong}>{item.record}</Text>
    </Animated.View>
  );
}

/** The ring around a face; "Checking" / "Move closer" under the focused one. */
function Ring({ item, reduceMotion }: { item: OverlayItem; reduceMotion: boolean }) {
  const pulse = useRef(new Animated.Value(1)).current;
  const checking = item.kind === 'checking';
  useEffect(() => {
    if (!checking || reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 450, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 450, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [checking, pulse, reduceMotion]);

  const { box } = item;
  const label = !item.focused
    ? null
    : item.kind === 'checking'
      ? rt(RIVALRY_COPY.checking)
      : item.kind === 'too_far'
        ? rt(RIVALRY_COPY.closer)
        : null;
  return (
    <View pointerEvents="none" testID={`rivalry-ring-${item.key}`}>
      <Animated.View
        style={[
          styles.ring,
          ringStyle(item),
          {
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
            borderRadius: Math.min(box.width, box.height) / 2,
            opacity: pulse,
          },
        ]}
      />
      {label !== null ? (
        <View
          style={[
            styles.ringLabel,
            { left: box.x - 40, width: box.width + 80, top: box.y + box.height + space.x1 },
          ]}
        >
          <View style={styles.ringLabelBg}>
            <Text style={type.small}>{label}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ringStyle(item: OverlayItem) {
  switch (item.kind) {
    case 'known':
      return item.focused ? styles.ringFocused : styles.ringKnown;
    case 'checking':
      return styles.ringChecking;
    case 'too_far':
      return styles.ringFar;
    case 'unknown':
      return styles.ringUnknown;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: DEFAULT_CARD_SIZE.width,
    padding: space.x2,
    borderRadius: radius.lg,
    backgroundColor: palette.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.hairline,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  record: { marginTop: 2, marginBottom: space.x1, alignSelf: 'flex-start' },
  down: { color: palette.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: space.x1 },
  chip: {
    paddingHorizontal: space.x1,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.textSecondary,
  },
  pill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: PILL_SIZE.height,
    maxWidth: PILL_SIZE.width,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.x1 + 4,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
  },
  pillName: { flexShrink: 1, color: palette.text },
  ring: { position: 'absolute', borderWidth: 2 },
  ringFocused: { borderColor: palette.accent },
  ringKnown: { borderColor: palette.text, borderWidth: 1 },
  ringChecking: { borderColor: palette.text },
  ringFar: { borderColor: palette.textSecondary, borderStyle: 'dashed' },
  ringUnknown: { borderColor: palette.hairline, borderWidth: 1 },
  ringLabel: { position: 'absolute', alignItems: 'center' },
  ringLabelBg: {
    paddingHorizontal: space.x1,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: palette.background,
  },
});
