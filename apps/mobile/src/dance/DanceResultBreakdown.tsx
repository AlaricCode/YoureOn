// The server's verdict on a round (`dance.scored`, DANCE-OFF §5): the recomputed scores, the
// winner or "Too close to call", the per-move grid, a "Round not counted" line when Claude's
// check found a problem, and the announcer line. Native-free (the design preview renders it).
import { getRoutine } from '@youre-on/shared/dance/routine';
import type { DanceScoredPayload } from '@youre-on/shared/realtime';
import { StyleSheet, Text, View } from 'react-native';

import { isCopyOk } from '../ui/copyRule';
import { half, palette, space, type } from '../ui/tokens';
import { DANCE_COPY, dt } from './copy';
import { ResultCard, type ResultData } from './ResultCard';

/** Server text shown on a party screen: only if it passes the data rule (no addresses, emoji). */
export const safeLine = (text: string | null | undefined): string | null => {
  const t = (text ?? '').trim();
  return t !== '' && isCopyOk(t, 'data') ? t : null;
};

/** The evidence record → what the result card draws (move names from the bundled routine). */
export function resultFromScored(scored: DanceScoredPayload): ResultData {
  const e = scored.evidence;
  const routine = getRoutine(e.routine.id);
  const nameOf = (id: string) => routine?.key_moves.find((m) => m.id === id)?.name ?? id;
  const invalid = scored.validation.verdict === 'invalid';
  return {
    scores: e.scores,
    winner: invalid ? null : e.winner,
    tooClose: invalid || e.too_close || e.failed !== null,
    moves: e.key_moves.map((m) => ({ id: m.id, name: nameOf(m.id), a: m.a, b: m.b })),
  };
}

export function DanceResultBreakdown({
  scored,
  names,
  me,
  omitLine,
}: {
  scored: DanceScoredPayload;
  names: { a: string; b: string };
  me?: 'A' | 'B';
  /** A line already on screen (the ruling's reason is the announcer's line): not drawn twice. */
  omitLine?: string | null | undefined;
}) {
  const data = resultFromScored(scored);
  const invalid = scored.validation.verdict === 'invalid';
  const announced = safeLine(scored.announcer_line);
  const line = announced !== null && announced === omitLine?.trim() ? null : announced;
  const notes = invalid ? safeLine(scored.validation.notes) : null;
  return (
    <View style={styles.wrap}>
      <ResultCard data={data} names={names} me={me} />
      {invalid ? (
        <View style={styles.block}>
          <Text style={styles.problem}>{dt(DANCE_COPY.notCounted)}</Text>
          {notes ? <Text style={styles.notes}>{notes}</Text> : null}
        </View>
      ) : null}
      {line ? <Text style={styles.announcer}>{line}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.x3 },
  block: { gap: half.x05 },
  problem: { ...type.labelStrong, color: palette.danger },
  notes: { ...type.body },
  announcer: { ...type.statement, textAlign: 'center' },
});
