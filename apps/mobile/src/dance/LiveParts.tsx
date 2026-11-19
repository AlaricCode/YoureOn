// The live pieces of the dance display, each subscribed to the live store on its own (so a pose
// frame re-renders a meter, not the screen): the two match meters, the PERFECT / GOOD / MISS
// popups over the camera panel, the skeleton overlay on the camera, and the debug readout.
// Colours: ./theme.
import { LIMB_IDS } from '@youre-on/shared/dance/joints';
import type { LivePlayerState } from '@youre-on/shared/dance/score';
import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { half, motion, palette, radius, space, TABULAR, type } from '../ui/tokens';
import { useReduceMotion } from '../ui/parts';
import { DANCE_COPY, dt, firstName, GRADE_COPY, meterText } from './copy';
import { useLive } from './hooks';
import { POPUP_TTL_MS, type LiveStore, type Popup } from './model/liveStore';
import { popupAnchor, type Size } from './model/overlay';
import { SkeletonLayer, type SkeletonFigure } from './SkeletonLayer';
import { GRADE_TINT, OTHER_TINT, PLAYER_TINT } from './theme';

const easeOut = Easing.bezier(...motion.easing);

// ---------------------------------------------------------------------------------------
// Match meters
// ---------------------------------------------------------------------------------------

/** A name, a big live number and a bar that follows it (eased, ≤ one transition per update). */
export function MatchMeter({
  name,
  value,
  tint,
  align,
  tag,
}: {
  name: string;
  /** 0..100. */
  value: number;
  tint: string;
  align: 'left' | 'right';
  tag?: string | undefined;
}) {
  const reduced = useReduceMotion();
  const v = useRef(new Animated.Value(0)).current;
  const clamped = Math.max(0, Math.min(100, value));
  useEffect(() => {
    if (reduced !== false) {
      v.setValue(clamped);
      return;
    }
    const a = Animated.timing(v, {
      toValue: clamped,
      duration: motion.fastMs,
      easing: easeOut,
      useNativeDriver: false,
    });
    a.start();
    return () => a.stop();
  }, [v, clamped, reduced]);
  const width = v.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
  const right = align === 'right';
  return (
    <View style={[styles.meter, right && styles.meterRight]}>
      <View style={[styles.meterHead, right && styles.rowReverse]}>
        <View style={[styles.nameRow, right && styles.rowReverse]}>
          <View style={[styles.swatch, { backgroundColor: tint }]} />
          <Text style={styles.meterName} numberOfLines={1}>
            {firstName(name)}
          </Text>
          {tag ? <Text style={styles.meterTag}>{tag}</Text> : null}
        </View>
        <Text style={[styles.meterValue, { color: tint }]}>{meterText(clamped)}</Text>
      </View>
      <View style={[styles.track, right && styles.trackRight]}>
        <Animated.View style={[styles.fill, { width, backgroundColor: tint }]} />
      </View>
    </View>
  );
}

/** Both meters, from the live store. */
export function LiveMeters({
  store,
  names,
  me,
}: {
  store: LiveStore;
  names: { a: string; b: string };
  me?: 'A' | 'B' | undefined;
}) {
  const a = useLive(store, (v) => Math.round(v.meterA));
  const b = useLive(store, (v) => Math.round(v.meterB));
  const you = dt(DANCE_COPY.you);
  return (
    <View style={styles.meters}>
      <MatchMeter
        name={names.a}
        value={a}
        tint={PLAYER_TINT.A}
        align="left"
        tag={me === 'A' ? you : undefined}
      />
      <MatchMeter
        name={names.b}
        value={b}
        tint={PLAYER_TINT.B}
        align="right"
        tag={me === 'B' ? you : undefined}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------------------

function PopupBadge({
  popup,
  at,
  width,
}: {
  popup: Popup;
  at: { x: number; y: number };
  /** Half the camera panel: a popup stays over its player's side. */
  width: number;
}) {
  const reduced = useReduceMotion();
  const k = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced === null) return;
    if (reduced) {
      k.setValue(1);
      const t = setTimeout(() => k.setValue(0), POPUP_TTL_MS - motion.fastMs);
      return () => clearTimeout(t);
    }
    const a = Animated.sequence([
      Animated.timing(k, {
        toValue: 1,
        duration: motion.momentMs,
        easing: easeOut,
        useNativeDriver: true,
      }),
      Animated.delay(POPUP_TTL_MS - motion.momentMs - motion.fastMs),
      Animated.timing(k, {
        toValue: 0,
        duration: motion.fastMs,
        easing: easeOut,
        useNativeDriver: true,
      }),
    ]);
    a.start();
    return () => a.stop();
  }, [k, reduced]);
  const translateY = k.interpolate({ inputRange: [0, 1], outputRange: [motion.momentRise, 0] });
  const tint = GRADE_TINT[popup.grade];
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.popup,
        { left: at.x - width / 2, top: at.y, width, opacity: k, transform: [{ translateY }] },
      ]}
    >
      <Text
        style={[styles.popupGrade, { color: tint }]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.5}
      >
        {dt(GRADE_COPY[popup.grade])}
      </Text>
      <Text style={styles.popupName} numberOfLines={1}>
        {popup.name}
      </Text>
    </Animated.View>
  );
}

/** The newest popup per player, over their half of the camera panel. */
export function PopupLayer({ store, size }: { store: LiveStore; size: Size }) {
  const popups = useLive(store, (v) => v.popups);
  const latest = (p: 'A' | 'B') => {
    for (let i = popups.length - 1; i >= 0; i--) if (popups[i]!.player === p) return popups[i]!;
    return null;
  };
  const shown = [latest('A'), latest('B')].filter((p): p is Popup => p !== null);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {shown.map((p) => (
        <PopupBadge
          key={p.id}
          popup={p}
          at={popupAnchor(size, p.player)}
          width={Math.max(60, size.width / 2 - 8)}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Camera overlay
// ---------------------------------------------------------------------------------------

/**
 * The live skeletons on the camera panel: A green, B white, anyone else dim. While framing the
 * tracker has not started, so A / B are the framing check's left / right.
 */
export const CameraSkeletons = memo(function CameraSkeletons({
  store,
  size,
}: {
  store: LiveStore;
  size: Size;
}) {
  const view = useLive(store, (v) => v);
  const figures: SkeletonFigure[] = [];
  for (const k of view.people) {
    if (k === view.a || k === view.b) continue;
    figures.push({ k, tint: OTHER_TINT });
  }
  if (view.b) figures.push({ k: view.b, tint: PLAYER_TINT.B });
  if (view.a) figures.push({ k: view.a, tint: PLAYER_TINT.A });
  return <SkeletonLayer size={size} image={{ width: view.w, height: view.h }} figures={figures} />;
});

// ---------------------------------------------------------------------------------------
// Debug readout (settings.debugOverlay, and the calibration screen)
// ---------------------------------------------------------------------------------------

const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);

/** Short limb names for the readout, LIMB_IDS order. */
const LIMB_SHORT: Readonly<Record<(typeof LIMB_IDS)[number], string>> = {
  l_upper_arm: 'LUA',
  r_upper_arm: 'RUA',
  l_forearm: 'LFA',
  r_forearm: 'RFA',
  l_thigh: 'LTH',
  r_thigh: 'RTH',
  l_shin: 'LSH',
  r_shin: 'RSH',
  torso: 'TOR',
};

function PlayerDebug({
  label,
  s,
  tint,
}: {
  label: string;
  s: LivePlayerState | null;
  tint: string;
}) {
  const head =
    `${label}  meter ${fmt(s?.meter, 1)}  sim ${fmt(s?.sim)}  ` +
    `lag ${s?.lagMs ?? '–'} ms  ${s?.convention ?? ''}`;
  return (
    <View style={styles.debugCol}>
      <Text style={[styles.debugHead, { color: tint }]}>{head}</Text>
      <View style={styles.limbs}>
        {LIMB_IDS.map((id, i) => {
          const val = s?.limbs[i] ?? null;
          return (
            <View key={id} style={styles.limb}>
              <View style={styles.limbTrack}>
                <View
                  style={[
                    styles.limbFill,
                    { height: `${Math.round((val ?? 0) * 100)}%`, backgroundColor: tint },
                    val === null && styles.limbMissing,
                  ]}
                />
              </View>
              <Text style={styles.limbLabel}>{LIMB_SHORT[id]}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Raw scores, per-limb similarity, lag, convention, FPS and frame count. */
export function DebugReadout({ store, syncOffsetMs }: { store: LiveStore; syncOffsetMs: number }) {
  const view = useLive(store, (v) => v);
  return (
    <View style={styles.debug} pointerEvents="none">
      <Text style={styles.debugHead}>
        {`fps ${fmt(view.fps, 1)}  frames ${view.frames}  people ${view.people.length}  ` +
          `sync ${syncOffsetMs} ms`}
      </Text>
      <PlayerDebug label="A" s={view.liveA} tint={PLAYER_TINT.A} />
      <PlayerDebug label="B" s={view.liveB} tint={PLAYER_TINT.B} />
    </View>
  );
}

const styles = StyleSheet.create({
  meters: { flexDirection: 'row', gap: space.x2 },
  meter: { flex: 1, gap: half.x05 },
  meterRight: { alignItems: 'flex-end' },
  meterHead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    gap: space.x1,
  },
  rowReverse: { flexDirection: 'row-reverse' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.x1, flexShrink: 1 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  meterName: { ...type.heading, flexShrink: 1 },
  meterTag: { ...type.small },
  meterValue: { ...type.figure, fontVariant: TABULAR },
  track: {
    alignSelf: 'stretch',
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: palette.fill,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  trackRight: { flexDirection: 'row-reverse' },
  fill: { height: '100%', borderRadius: radius.pill },
  popup: { position: 'absolute', alignItems: 'center' },
  popupGrade: { ...type.figure, letterSpacing: 1 },
  popupName: { ...type.smallStrong, color: palette.textSecondary },
  debug: {
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    padding: half.x15,
    gap: space.x1,
    opacity: 0.92,
  },
  debugCol: { gap: half.x05 },
  debugHead: { ...type.small, color: palette.text, fontVariant: TABULAR },
  limbs: { flexDirection: 'row', gap: half.x05 },
  limb: { alignItems: 'center', gap: 2 },
  limbTrack: {
    width: 22,
    height: 28,
    borderRadius: 3,
    backgroundColor: palette.fill,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  limbFill: { width: '100%' },
  limbMissing: { height: 2, backgroundColor: palette.textTertiary },
  limbLabel: { ...type.small },
});
