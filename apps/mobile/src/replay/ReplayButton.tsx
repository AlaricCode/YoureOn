// "Replay" on the payout screen (winner and loser). Renders nothing until the server has a replay
// for the bet (useReplay moment != null), so there is never a dead button. The secondary style:
// a soft grey pill with a white label and a small play glyph.
import type { ReplayMoment } from '@youre-on/shared/replay';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { REPLAY_COPY } from './copy';
import { font, obsidian } from './theme';

export function ReplayButton({
  moment,
  onPress,
  testID = 'replay-button',
}: {
  moment: ReplayMoment | null;
  onPress: () => void;
  testID?: string;
}) {
  if (!moment) return null;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={REPLAY_COPY.replay}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <View style={styles.play} />
      <Text style={styles.label} numberOfLines={1}>
        {REPLAY_COPY.replay}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 48,
    borderRadius: 999,
    backgroundColor: obsidian.line,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 10,
  },
  pressed: { opacity: 0.7 },
  // A right-pointing triangle from borders.
  play: {
    width: 0,
    height: 0,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderLeftWidth: 10,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: obsidian.white,
  },
  label: { ...font('medium', 15), lineHeight: 20 },
});
