// A standalone screen for the slow-mo player with drawn frames (no server, no assets): pick the
// winning moment or the foul preview and watch it on the device. The integrator adds a PreviewApp
// menu entry for it; until then it can be rendered directly in place of the app root.
import type { ReplayFrame, ReplayMoment } from '@youre-on/shared/replay';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { REPLAY_COPY } from './copy';
import { FakeFrame } from './FakeFrame';
import { FAKE_NAMES, fakeFoulMoment, fakeWinMoment } from './fakes';
import { ReplayButton } from './ReplayButton';
import { SlowMoPlayer } from './SlowMoPlayer';
import { font, obsidian } from './theme';

const WIN = fakeWinMoment();
const FOUL = fakeFoulMoment();

export function ReplayPreview({ onBack }: { onBack?: () => void }) {
  const [open, setOpen] = useState<ReplayMoment | null>(null);
  const draw = (m: ReplayMoment) => (f: ReplayFrame, i: number) => (
    <FakeFrame frame={f} i={i} count={m.frames.length} foul={m.kind === 'foul'} />
  );
  return (
    <View style={styles.root} testID="replay-preview">
      <View style={styles.list}>
        <Text style={styles.heading}>{REPLAY_COPY.badge}</Text>
        <Row label={REPLAY_COPY.win} onPress={() => setOpen(WIN)} testID="replay-preview-win" />
        <Row label={REPLAY_COPY.foul} onPress={() => setOpen(FOUL)} testID="replay-preview-foul" />
        <View style={styles.gap} />
        <ReplayButton moment={WIN} onPress={() => setOpen(WIN)} />
        {onBack ? (
          <Row label={REPLAY_COPY.done} onPress={onBack} testID="replay-preview-back" />
        ) : null}
      </View>
      {open ? (
        <SlowMoPlayer
          moment={open}
          visible
          onClose={() => setOpen(null)}
          renderFrame={draw(open)}
          names={FAKE_NAMES}
        />
      ) : null}
    </View>
  );
}

function Row({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.rowText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: obsidian.black, justifyContent: 'center' },
  list: { paddingHorizontal: 24 },
  heading: { ...font('semibold', 28), lineHeight: 36, marginBottom: 16 },
  row: {
    height: 56,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: obsidian.line,
  },
  rowText: { ...font('regular', 17), lineHeight: 24 },
  gap: { height: 32 },
});
