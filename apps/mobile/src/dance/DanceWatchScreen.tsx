// "Dance off live" (DANCE-OFF §6.2): a phone that neither records nor displays the round (A's
// phone while the room's judge cam films), and B's phone once the round is judged (during it,
// B's phone is the display, DanceDisplayScreen). It shows where the round is (getting ready,
// live, judging) and then the server's scores, the per-move grid and the announcer line.
// Native-free.
import { routineDisplayTitle } from '@youre-on/shared/dance/routine';
import { parseDanceTermsRoutine } from '@youre-on/shared/dance/terms';
import type { DanceScoredPayload } from '@youre-on/shared/realtime';
import type { Terms } from '@youre-on/shared/terms';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { DotsLabel, Screen, TopBar } from '../ui/parts';
import { half, palette, space, type } from '../ui/tokens';
import { DANCE_COPY, danceLabels, dt } from './copy';
import { DanceResultBreakdown } from './DanceResultBreakdown';
import { PLAYER_TINT } from './theme';

export type DanceWatchScreenProps = {
  terms: Terms;
  me: 'A' | 'B';
  names: { a: string; b: string };
  phase: 'waiting' | 'dancing' | 'judging';
  scored: DanceScoredPayload | null;
};

function Versus({ names, me }: { names: { a: string; b: string }; me: 'A' | 'B' }) {
  const you = dt(DANCE_COPY.you);
  const side = (p: 'A' | 'B') => (
    <View style={styles.vsSide}>
      <View style={[styles.swatch, { backgroundColor: PLAYER_TINT[p] }]} />
      <Text style={styles.vsName} numberOfLines={1}>
        {danceLabels(names)[p === 'A' ? 'a' : 'b']}
      </Text>
      {me === p ? <Text style={styles.tag}>{you}</Text> : null}
    </View>
  );
  return (
    <View style={styles.vs}>
      {side('A')}
      <Text style={styles.vsWord}>{dt(DANCE_COPY.versus)}</Text>
      {side('B')}
    </View>
  );
}

export function DanceWatchScreen({ terms, me, names, phase, scored }: DanceWatchScreenProps) {
  const parsed = parseDanceTermsRoutine(terms);
  const title = parsed.ok ? routineDisplayTitle(parsed.routine) : null;
  return (
    <Screen>
      <TopBar title={dt(DANCE_COPY.title)} tag={title ?? undefined} />
      <ScrollView contentContainerStyle={styles.body}>
        <Versus names={names} me={me} />
        {scored ? (
          <DanceResultBreakdown scored={scored} names={names} me={me} />
        ) : (
          <View style={styles.status}>
            {phase === 'dancing' ? (
              <View style={styles.liveRow}>
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>{dt(DANCE_COPY.live)}</Text>
              </View>
            ) : phase === 'judging' ? (
              <DotsLabel text={dt(DANCE_COPY.judging)} variant="subtitle" />
            ) : (
              <DotsLabel text={dt(DANCE_COPY.gettingReady)} variant="subtitle" />
            )}
            {title ? <Text style={styles.routine}>{title}</Text> : null}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.page, paddingVertical: space.x3, gap: space.x4 },
  vs: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.x2 },
  vsSide: { flexDirection: 'row', alignItems: 'center', gap: space.x1, flexShrink: 1 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  vsName: { ...type.subtitle, flexShrink: 1 },
  vsWord: { ...type.section },
  tag: { ...type.small },
  status: { alignItems: 'center', gap: space.x2, paddingVertical: space.x6 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: half.x15 },
  liveDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: palette.accent },
  liveText: { ...type.subtitle },
  routine: { ...type.statement, color: palette.textSecondary },
});
