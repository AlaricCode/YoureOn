// The full-screen slow-mo replay on a phone (opened from "Replay" on the payout screen). Black
// Modal; every frame is mounted as a stacked Image at opacity 0 and preloaded, then RN Animated
// (native driver) crossfades through them with a slow push-in, ending on the held frame: the
// judge's decisive cited frame for a win (a thin green ring and "Judge's frame"), or the
// detector's frozen moment for a foul (red ring, "Foul" and its measurement). With a live clip it
// plays the real video slowed instead (ClipPlayer), falling back to the frames if it fails.
//
// All decisions (preload policy, which frames play, timings, copy) are in ./model, tested in node;
// the timeline is the shared slowmoTimeline the stage plays from. Silent: no audio, no haptics.
import { SLOWMO_HOLD_MS, type ReplayFrame, type ReplayMoment } from '@youre-on/shared/replay';
import {
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  Modal,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ImageSourcePropType,
} from 'react-native';
import { initialWindowMetrics, SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { ClipPlayer } from './ClipPlayer';
import { REPLAY_COPY } from './copy';
import {
  clipRun,
  framesPlan,
  heldFrame,
  initPlayer,
  playableFrames,
  playbackSchedule,
  playerReducer,
  PRELOAD_TIMEOUT_MS,
  replayCopy,
} from './model';
import { accentFor, font, obsidian } from './theme';

export interface SlowMoPlayerProps {
  moment: ReplayMoment;
  visible: boolean;
  onClose: () => void;
  /** Real app: (f) => frameImageSource(API_BASE_URL, token, f). Preview: omit and pass renderFrame. */
  source?: (f: ReplayFrame) => ImageSourcePropType;
  /** Preview / tests: draw a fake frame instead of an Image. */
  renderFrame?: (f: ReplayFrame, i: number) => ReactNode;
  names: { A: string; B: string };
  /** Default true. False: wait on the first frame with a "Replay" button. */
  autoPlay?: boolean;
  /** Default: AccessibilityInfo.isReduceMotionEnabled(). */
  reduceMotion?: boolean;
  testID?: string;
}

export function SlowMoPlayer(p: SlowMoPlayerProps) {
  return (
    <Modal
      visible={p.visible}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      supportedOrientations={['portrait']}
      onRequestClose={p.onClose}
    >
      {/* Mounted per open, so every open starts from a fresh preload and run. */}
      {p.visible ? <PlayerBody {...p} /> : null}
    </Modal>
  );
}

const FALLBACK_INSETS = { top: 47, bottom: 34, left: 0, right: 0 };

function PlayerBody({
  moment,
  onClose,
  source,
  renderFrame,
  names,
  autoPlay = true,
  reduceMotion,
  testID = 'slowmo-player',
}: SlowMoPlayerProps) {
  const insets =
    useContext(SafeAreaInsetsContext) ?? initialWindowMetrics?.insets ?? FALLBACK_INSETS;
  const win = useWindowDimensions();
  const drawn = renderFrame !== undefined && source === undefined;

  const [rm, setRm] = useState(reduceMotion ?? false);
  useEffect(() => {
    if (reduceMotion !== undefined) {
      setRm(reduceMotion);
      return;
    }
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (v) => alive && setRm(v),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [reduceMotion]);

  const [s, dispatch] = useReducer(playerReducer, undefined, () =>
    initPlayer(moment, { nowMs: Date.now(), preloaded: drawn }),
  );
  const [armed, setArmed] = useState(autoPlay);

  // One opacity + scale per moment.frames entry.
  const n = moment.frames.length;
  const opacity = useRef<Animated.Value[]>([]).current;
  const scale = useRef<Animated.Value[]>([]).current;
  while (opacity.length < n) opacity.push(new Animated.Value(0));
  while (scale.length < n) scale.push(new Animated.Value(1));
  const progress = useRef(new Animated.Value(0)).current;
  const holdFx = useRef(new Animated.Value(0)).current;

  const [aspect, setAspect] = useState(3 / 4);

  // Preload timeout (frames mode only).
  useEffect(() => {
    if (s.phase !== 'loading' || s.mode !== 'frames') return;
    const t = setTimeout(() => dispatch({ type: 'preload_timeout' }), PRELOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [s.phase, s.mode]);

  const play = useMemo(() => playableFrames(moment, s.loaded), [moment, s.loaded]);
  const held = s.mode === 'frames' ? heldFrame(play) : null;
  const copy = replayCopy(moment, names, { mode: s.mode, held });
  const accent = accentFor(moment.kind);
  const running = s.phase === 'playing' && armed;
  // A run lasts through its hold: the hold zoom and the end timer must not be cut at 'holding'.
  const inRun = armed && (s.phase === 'playing' || s.phase === 'holding');

  // Frames mode: one run of crossfades, push-in and timers per `run`.
  useEffect(() => {
    if (!inRun || s.mode !== 'frames') return;
    const plan = framesPlan(moment, s.loaded, { reduceMotion: rm });
    for (let i = 0; i < n; i++) {
      opacity[i]!.setValue(0);
      scale[i]!.setValue(1);
    }
    progress.setValue(0);
    holdFx.setValue(0);
    const nd = { useNativeDriver: true } as const;
    const anims = plan.anims.map((a) => {
      scale[a.at]!.setValue(a.scaleFrom);
      const fade: Animated.CompositeAnimation[] = [
        Animated.delay(a.fadeInAt),
        Animated.timing(opacity[a.at]!, {
          toValue: 1,
          duration: a.fadeMs,
          easing: Easing.out(Easing.quad),
          ...nd,
        }),
      ];
      if (a.fadeOutAt !== null) {
        fade.push(
          Animated.delay(Math.max(0, a.fadeOutAt - a.fadeInAt - a.fadeMs)),
          Animated.timing(opacity[a.at]!, { toValue: 0, duration: 0, ...nd }),
        );
      }
      return Animated.parallel([
        Animated.sequence(fade),
        Animated.sequence([
          Animated.delay(a.scaleAt),
          Animated.timing(scale[a.at]!, {
            toValue: a.scaleTo,
            duration: Math.max(0, a.scaleMs),
            easing: Easing.linear,
            ...nd,
          }),
        ]),
      ]);
    });
    anims.push(
      Animated.timing(progress, {
        toValue: 1,
        duration: Math.max(1, plan.holdAt),
        easing: Easing.linear,
        ...nd,
      }),
    );
    const all = Animated.parallel(anims);
    all.start();
    const timers = playbackSchedule(plan).map((x) =>
      setTimeout(() => dispatch({ type: x.action }), x.at_ms),
    );
    return () => {
      all.stop();
      timers.forEach(clearTimeout);
    };
    // Deps: one run per `run` (and per start / mode switch), not per render.
  }, [inRun, s.run, s.mode]);

  // Clip mode: the progress bar over the slowed run; the hold and end follow onFreeze.
  const clip = useMemo(() => clipRun(moment), [moment]);
  useEffect(() => {
    if (!inRun || s.mode !== 'clip' || !clip) return;
    progress.setValue(0);
    holdFx.setValue(0);
    const a = Animated.timing(progress, {
      toValue: 1,
      duration: Math.max(1, clip.playMs),
      easing: Easing.linear,
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
    // Deps: one run per `run` (and per start / mode switch), not per render.
  }, [inRun, s.run, s.mode]);
  useEffect(() => {
    if (s.phase !== 'holding' || s.mode !== 'clip') return;
    const t = setTimeout(() => dispatch({ type: 'end' }), SLOWMO_HOLD_MS);
    return () => clearTimeout(t);
  }, [s.phase, s.mode]);

  // The ring and tags fade in on the hold.
  useEffect(() => {
    if (s.phase !== 'holding' && s.phase !== 'ended') return;
    progress.setValue(1);
    const a = Animated.timing(holdFx, {
      toValue: 1,
      duration: rm ? 0 : 200,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [s.phase, rm, holdFx, progress]);

  // Not auto-playing: show the held frame still until "Replay" is pressed.
  useEffect(() => {
    if (armed || s.phase !== 'playing' || s.mode !== 'frames' || !held) return;
    opacity[held.at]!.setValue(1);
  }, [armed, s.phase, s.mode, held, opacity]);

  // Frame box: as wide as the screen, at most ~62 % of its height, in the frames' aspect.
  const maxH = win.height * 0.62;
  const boxW = Math.min(win.width, maxH * aspect);
  const boxH = boxW / aspect;

  const showHold = (s.phase === 'holding' || s.phase === 'ended') && !copy.badgeOnly;
  const showEnd = s.phase === 'ended' || (s.phase === 'playing' && !armed);
  const again = () => {
    if (!armed) setArmed(true);
    dispatch({ type: 'again' });
  };

  return (
    <View
      testID={testID}
      style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }]}
      accessibilityLabel={`${copy.title}, ${copy.chip}`}
    >
      <StatusBar barStyle="light-content" />

      {/* Top: the badge and speed, the close cross. */}
      <View style={styles.top}>
        <View style={styles.badge} testID={`${testID}-badge`}>
          <View style={[styles.dot, { backgroundColor: accent }]} />
          <Text style={styles.badgeText}>{copy.badge}</Text>
          <Text style={styles.speed}>{copy.speed}</Text>
        </View>
        <Pressable
          testID={`${testID}-close`}
          accessibilityRole="button"
          accessibilityLabel={REPLAY_COPY.close}
          hitSlop={12}
          onPress={onClose}
          style={styles.close}
        >
          <View style={[styles.crossBar, { transform: [{ rotate: '45deg' }] }]} />
          <View style={[styles.crossBar, { transform: [{ rotate: '-45deg' }] }]} />
        </Pressable>
      </View>

      {/* The frame. */}
      <View style={styles.middle}>
        <View
          style={[styles.box, { width: boxW, height: boxH }]}
          testID={`${testID}-frame`}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {s.mode === 'clip' ? (
            <ClipPlayer
              moment={moment}
              run={s.run}
              playing={running}
              onReady={() => dispatch({ type: 'clip_ready' })}
              onFailed={() => dispatch({ type: 'clip_failed' })}
              onFreeze={() => dispatch({ type: 'hold' })}
            />
          ) : (
            moment.frames.map((f, i) => (
              <Animated.View
                key={`${i}-${f.idx ?? 'still'}-${f.t_ms}`}
                style={[
                  StyleSheet.absoluteFill,
                  { opacity: opacity[i]!, transform: [{ scale: scale[i]! }] },
                ]}
              >
                {drawn ? (
                  renderFrame!(f, i)
                ) : source ? (
                  <Image
                    source={source(f)}
                    style={StyleSheet.absoluteFill}
                    resizeMode="cover"
                    fadeDuration={0}
                    onLoad={(e) => {
                      const src = e.nativeEvent.source;
                      if (i === 0 && src?.width && src?.height) setAspect(src.width / src.height);
                      dispatch({ type: 'frame_loaded', i });
                    }}
                    onError={() => dispatch({ type: 'frame_failed', i })}
                  />
                ) : null}
              </Animated.View>
            ))
          )}

          {showHold ? (
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.ring,
                { borderColor: accent, opacity: holdFx },
              ]}
            />
          ) : null}
          {showHold && copy.holdTag ? (
            <Animated.View style={[styles.tagRow, { opacity: holdFx }]}>
              <View
                style={[styles.tag, moment.kind === 'foul' && { backgroundColor: obsidian.red }]}
              >
                <Text
                  style={[styles.tagText, moment.kind === 'foul' && { color: obsidian.black }]}
                  testID={`${testID}-hold-tag`}
                >
                  {copy.holdTag}
                </Text>
              </View>
              {copy.holdData ? (
                <View style={styles.tag}>
                  <Text style={styles.tagText} testID={`${testID}-hold-data`}>
                    {copy.holdData}
                  </Text>
                </View>
              ) : null}
            </Animated.View>
          ) : null}

          {s.phase === 'loading' ? (
            <View style={[StyleSheet.absoluteFill, styles.center]}>
              <Dots />
            </View>
          ) : null}
          {s.phase === 'error' ? (
            <View style={[StyleSheet.absoluteFill, styles.center]}>
              <Text style={styles.error} testID={`${testID}-error`}>
                {REPLAY_COPY.error}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Progress: a hairline that fills in green over the slowed run. */}
        <View style={[styles.track, { width: boxW }]}>
          <Animated.View
            style={[styles.fill, { backgroundColor: accent, transform: [{ scaleX: progress }] }]}
          />
        </View>
      </View>

      {/* Bottom: what this is and who won, then the end controls. */}
      <View style={styles.bottom}>
        {s.phase !== 'error' ? (
          <View style={styles.titleRow}>
            <Text style={styles.title} testID={`${testID}-title`}>
              {copy.title}
            </Text>
            <Text style={styles.chip} numberOfLines={1} testID={`${testID}-chip`}>
              {copy.chip}
            </Text>
          </View>
        ) : null}
        <View style={styles.actions}>
          {showEnd ? (
            <Pressable
              testID={`${testID}-again`}
              accessibilityRole="button"
              accessibilityLabel={armed ? REPLAY_COPY.again : REPLAY_COPY.replay}
              onPress={again}
              style={({ pressed }) => [styles.btn, styles.btnQuiet, pressed && styles.pressed]}
            >
              <Text style={styles.btnQuietText}>
                {armed ? REPLAY_COPY.again : REPLAY_COPY.replay}
              </Text>
            </Pressable>
          ) : null}
          {showEnd || s.phase === 'error' ? (
            <Pressable
              testID={`${testID}-done`}
              accessibilityRole="button"
              accessibilityLabel={REPLAY_COPY.done}
              onPress={onClose}
              style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}
            >
              <Text style={styles.btnPrimaryText}>{REPLAY_COPY.done}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Loading: three dots, no text. */
function Dots() {
  const [k, setK] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setK((d) => (d % 3) + 1), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={styles.dots} accessibilityRole="progressbar">
      {[1, 2, 3].map((d) => (
        <View key={d} style={[styles.loadDot, d <= k && styles.loadDotOn]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: obsidian.black },
  top: {
    height: 44,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 28,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: obsidian.line,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { ...font('medium', 13), lineHeight: 16 },
  speed: { ...font('regular', 13, obsidian.grey), lineHeight: 16, fontVariant: ['tabular-nums'] },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  crossBar: {
    position: 'absolute',
    width: 18,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: obsidian.white,
  },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  box: { overflow: 'hidden', backgroundColor: obsidian.raised, borderRadius: 12 },
  ring: { borderWidth: 2, borderRadius: 12 },
  tagRow: { position: 'absolute', left: 12, top: 12, flexDirection: 'row', gap: 6 },
  tag: {
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 999,
    justifyContent: 'center',
    backgroundColor: obsidian.scrim,
  },
  tagText: { ...font('medium', 13), lineHeight: 16 },
  center: { alignItems: 'center', justifyContent: 'center' },
  error: { ...font('regular', 15), lineHeight: 20 },
  track: { height: 2, marginTop: 12, backgroundColor: obsidian.line, overflow: 'hidden' },
  fill: { height: 2, width: '100%', transformOrigin: 'left' },
  bottom: { paddingHorizontal: 16, gap: 16 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { ...font('semibold', 22), lineHeight: 28, letterSpacing: -0.3 },
  chip: { ...font('regular', 15, obsidian.grey), lineHeight: 20, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 12, minHeight: 48 },
  btn: { flex: 1, height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  btnQuiet: { backgroundColor: obsidian.line },
  btnQuietText: { ...font('medium', 15), lineHeight: 20 },
  btnPrimary: { backgroundColor: obsidian.green },
  btnPrimaryText: { ...font('semibold', 15, obsidian.onGreen), lineHeight: 20 },
  pressed: { opacity: 0.7 },
  dots: { flexDirection: 'row', gap: 6 },
  loadDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: obsidian.dim },
  loadDotOn: { backgroundColor: obsidian.white },
});
