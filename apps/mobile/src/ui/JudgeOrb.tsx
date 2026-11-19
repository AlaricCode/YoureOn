// The judge's presence (tokens `orb`): a pearl sphere, lit from the upper left, inside two faint
// orbit rings, with a halo of its own light. It is still when nobody is talking, breathes slowly
// while it listens and beats faster while it speaks. Everything else on a screen is a control or
// a fact; this is the one thing that reads as someone.
//
// Drawn with react-native-svg (the same radial-gradient technique as parts' Glow), animated with
// transforms and opacity on the native driver. Reduce Motion: no breathing; speaking is shown by
// the brighter halo alone. Decorative to VoiceOver apart from its one label.
import { useEffect, useId, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { useReduceMotion } from './parts';
import { orb } from './tokens';

export function JudgeOrb({
  size = orb.size,
  speaking = false,
  listening = false,
  label,
  testID,
}: {
  /** The sphere's diameter; the rings and halo scale with it. */
  size?: number;
  /** The judge is talking: a faster, larger beat and a full halo. */
  speaking?: boolean;
  /** The judge is listening: a slow breath. */
  listening?: boolean;
  /** What VoiceOver reads ("Judge"). */
  label: string;
  testID?: string;
}) {
  const reduced = useReduceMotion();
  const k = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const alive = speaking || listening;
    if (!alive || reduced !== false) {
      k.stopAnimation();
      k.setValue(speaking ? 1 : 0);
      return;
    }
    const half = (speaking ? orb.speakMs : orb.breatheMs) / 2;
    const ease = Easing.inOut(Easing.quad);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(k, { toValue: 1, duration: half, easing: ease, useNativeDriver: true }),
        Animated.timing(k, { toValue: 0, duration: half, easing: ease, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [speaking, listening, reduced, k]);

  const uid = useId().replace(/[^A-Za-z0-9]/g, '');
  const box = Math.round(size * orb.haloSize);
  const height = Math.round(size * (orb.rings.at(-1) ?? 1));
  /** Where a centred `d`-wide square sits in the wrap (absolute children are placed by hand). */
  const centred = (d: number) => ({ left: (box - d) / 2, top: (height - d) / 2 });
  const scale = k.interpolate({
    inputRange: [0, 1],
    outputRange: [1, speaking ? orb.speakTo : orb.breatheTo],
  });
  const haloOpacity = k.interpolate({ inputRange: [0, 1], outputRange: [orb.restOpacity, 1] });
  // The outer ring answers the beat one step behind the sphere: it opens a little and fades.
  const ringScale = k.interpolate({ inputRange: [0, 1], outputRange: [1, speaking ? 1.06 : 1.02] });
  const ringOpacity = k.interpolate({
    inputRange: [0, 1],
    outputRange: [1, speaking ? 0.35 : 0.7],
  });
  const edge = 0.5 / orb.haloSize;

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[styles.wrap, { width: box, height }]}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.layer, centred(box), { width: box, height: box, opacity: haloOpacity }]}
      >
        <Svg width={box} height={box}>
          <Defs>
            <RadialGradient id={`halo${uid}`} cx="50%" cy="50%" r="50%">
              <Stop offset={0} stopColor={orb.halo} stopOpacity={orb.haloOpacity} />
              <Stop offset={edge} stopColor={orb.halo} stopOpacity={orb.haloOpacity} />
              <Stop
                offset={edge + 0.18}
                stopColor={orb.halo}
                stopOpacity={orb.haloOpacity * 0.32}
              />
              <Stop offset={1} stopColor={orb.halo} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={box / 2} cy={box / 2} r={box / 2} fill={`url(#halo${uid})`} />
        </Svg>
      </Animated.View>
      {orb.rings.map((r, i) => (
        <Animated.View
          key={r}
          pointerEvents="none"
          style={[
            styles.layer,
            styles.ring,
            centred(size * r),
            {
              width: size * r,
              height: size * r,
              borderRadius: (size * r) / 2,
              opacity: i === 0 ? 1 : ringOpacity,
              transform: [{ scale: i === 0 ? 1 : ringScale }],
            },
            i === 0 ? styles.ringNear : styles.ringFar,
          ]}
        />
      ))}
      <Animated.View style={{ transform: [{ scale }] }}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient
              id={`orb${uid}`}
              cx={`${orb.light.x * 100}%`}
              cy={`${orb.light.y * 100}%`}
              r="98%"
            >
              {orb.stops.map(([offset, tint]) => (
                <Stop key={offset} offset={offset} stopColor={tint} />
              ))}
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2 - 0.5} fill={`url(#orb${uid})`} />
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={size / 2 - 0.5}
            fill="none"
            stroke="#FFFFFF"
            strokeOpacity={0.2}
            strokeWidth={1}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  layer: { position: 'absolute' },
  ring: { borderWidth: 1 },
  ringNear: { borderColor: 'rgba(255, 255, 255, 0.11)' },
  ringFar: { borderColor: 'rgba(255, 255, 255, 0.06)' },
});
