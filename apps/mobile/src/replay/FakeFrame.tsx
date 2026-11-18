// A drawn stand-in for one evidence frame, for ReplayPreview and the simulator: a floor, the
// taped line, and a bottle that tumbles toward upright as the frames go by (the landing crop is
// the last pose, closer). Plain Views, no image assets. Not used with real frames.
import type { ReplayFrame } from '@youre-on/shared/replay';
import { StyleSheet, View } from 'react-native';

import { obsidian } from './theme';

/** Bottle angle (deg) for frame `i` of `count`: a flip that settles upright on the last one. */
export function fakeBottleAngle(i: number, count: number): number {
  if (count <= 1) return 0;
  const p = Math.min(1, Math.max(0, i / (count - 1)));
  // Ease-out: big rotation early, small corrections at the landing.
  return Math.round(540 * Math.pow(1 - p, 2)) % 360;
}

export function FakeFrame({
  frame,
  i,
  count,
  foul = false,
}: {
  frame: ReplayFrame;
  i: number;
  count: number;
  /** Draw a foot over the taped line (the foul preview). */
  foul?: boolean;
}) {
  const angle = frame.landing_crop ? 0 : fakeBottleAngle(i, count);
  const lift = frame.landing_crop
    ? 0
    : Math.round(120 * Math.pow(1 - i / Math.max(1, count - 1), 2));
  const zoom = frame.landing_crop ? 1.6 : 1;
  return (
    <View style={styles.root}>
      <View style={[styles.scene, { transform: [{ scale: zoom }] }]}>
        <View style={styles.floor} />
        <View style={styles.tape} />
        {foul ? <View style={styles.foot} /> : null}
        <View
          style={[styles.bottle, { transform: [{ translateY: -lift }, { rotate: `${angle}deg` }] }]}
        >
          <View style={styles.cap} />
          <View style={styles.neck} />
          <View style={styles.body} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#17171A', overflow: 'hidden' },
  scene: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  floor: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '38%',
    backgroundColor: '#2A2622',
  },
  tape: {
    position: 'absolute',
    left: '8%',
    right: '8%',
    bottom: '30%',
    height: 6,
    backgroundColor: '#E8E2C8',
  },
  foot: {
    position: 'absolute',
    left: '18%',
    bottom: '27%',
    width: 64,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#5B4A3E',
  },
  bottle: { position: 'absolute', bottom: '34%', alignItems: 'center' },
  cap: { width: 14, height: 8, borderRadius: 2, backgroundColor: obsidian.white },
  neck: { width: 12, height: 16, backgroundColor: '#7FB9A8' },
  body: { width: 34, height: 70, borderRadius: 8, backgroundColor: '#7FB9A8' },
});
