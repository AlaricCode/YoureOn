// The live pieces of the dance display, each subscribed to the live store on its own (so a pose
// frame re-renders a tag, not the screen): the players' name tags (with the live match score),
// the PERFECT / GOOD / MISS popups over the camera panel, the skeleton overlay on the camera, and
// the debug readout.
// Colours: ./theme.
import { LIMB_IDS } from '@youre-on/shared/dance/joints';
import type { LivePlayerState } from '@youre-on/shared/dance/score';
import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { color, half, motion, palette, radius, space, TABULAR, type } from '../ui/tokens';
import { useReduceMotion } from '../ui/parts';
import { danceLabels, dt, GRADE_COPY } from './copy';
import { nowMs, useLive } from './hooks';
import { POPUP_TTL_MS, type LiveStore, type Popup } from './model/liveStore';
import {
  createTagSmoother,
  tagScore,
  type PlacedTag,
  type TagInput,
  type TagSmoother,
  NAME_TAG,
} from './model/nameTags';
import { aRightOfB, containRect, popupAnchor, type Size } from './model/overlay';
import { SkeletonLayer, type SkeletonFigure } from './SkeletonLayer';
import { GRADE_TINT, OTHER_TINT, PLAYER_TINT } from './theme';

const easeOut = Easing.bezier(...motion.easing);

// ---------------------------------------------------------------------------------------
// Name tags: a small pill in each player's colour above their head, "Logan · 87" while the round
// scores (just the name while framing, shown only once the players are identified by face), a
// tiny face mark when that player was identified by face. They are the live match readout (no
// separate meters), placed and smoothed by ./model/nameTags.
// ---------------------------------------------------------------------------------------

/** A 9 pt face mark (outline, eyes, smile) in `color`. */
function FaceMark({ color }: { color: string }) {
  return (
    <Svg width={10} height={10} viewBox="0 0 10 10">
      <Circle cx={5} cy={5} r={4.2} stroke={color} strokeWidth={1.2} fill="none" />
      <Circle cx={3.5} cy={4} r={0.7} fill={color} />
      <Circle cx={6.5} cy={4} r={0.7} fill={color} />
      <Path d="M3.2 6.2 Q5 7.8 6.8 6.2" stroke={color} strokeWidth={1} fill="none" />
    </Svg>
  );
}

const TAG_INK = { A: color.onAccent, B: palette.black } as const;

function NameTag({ tag, player }: { tag: PlacedTag; player: 'A' | 'B' }) {
  return (
    <View
      style={[
        styles.tag,
        {
          left: tag.x,
          top: tag.y,
          width: tag.width,
          opacity: tag.opacity,
          backgroundColor: PLAYER_TINT[player],
        },
      ]}
    >
      {tag.icon ? <FaceMark color={TAG_INK[player]} /> : null}
      {/* A long name is cut with an ellipsis inside the pill (capped at the panel's width); the
          score after it always shows. */}
      <Text
        style={[styles.tagText, styles.tagName, { color: TAG_INK[player] }]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {tag.label}
      </Text>
      {tag.score !== null ? (
        <Text style={[styles.tagText, { color: TAG_INK[player] }]} numberOfLines={1}>
          {` ${tag.score}`}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Both tags over the camera panel. A player's tag shows while the round scores them, or, while
 * framing, once both were identified by face (else the "A ← | → B" hint says who is who).
 */
export function NameTags({
  store,
  size,
  names,
}: {
  store: LiveStore;
  size: Size;
  names: { a: string; b: string };
}) {
  const view = useLive(store, (v) => v);
  const smoother = useRef<TagSmoother | null>(null);
  smoother.current ??= createTagSmoother();
  if (size.width <= 0 || size.height <= 0) return null;
  const rect = containRect(size, { width: view.w, height: view.h });
  const labels = danceLabels(names);
  const input = (k: number[] | null, live: LivePlayerState | null, label: string): TagInput => ({
    k: live !== null || view.byFace ? k : null,
    label,
    score: tagScore(live ? live.meter : null),
    icon: view.byFace,
  });
  const tags = smoother.current.step(view.version, nowMs(), rect, size, {
    A: input(view.a, view.liveA, labels.a),
    B: input(view.b, view.liveB, labels.b),
  });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" accessible={false}>
      {tags.B ? <NameTag tag={tags.B} player="B" /> : null}
      {tags.A ? <NameTag tag={tags.A} player="A" /> : null}
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

/** The newest popup per player, over their half of the camera panel (wherever A stands). */
export function PopupLayer({ store, size }: { store: LiveStore; size: Size }) {
  const popups = useLive(store, (v) => v.popups);
  const side = useLive(store, (v) => aRightOfB(v.a, v.b));
  // Hold the last known sides through a frame where one player is not seen.
  const aOnRight = useRef(false);
  if (side !== null) aOnRight.current = side;
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
          at={popupAnchor(size, p.player, aOnRight.current)}
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
  tag: {
    position: 'absolute',
    height: NAME_TAG.HEIGHT,
    borderRadius: radius.pill,
    paddingHorizontal: NAME_TAG.PAD_X,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  tagText: { ...type.smallStrong, fontVariant: TABULAR },
  tagName: { flexShrink: 1 },
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
