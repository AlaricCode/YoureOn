// The round's result: both final scores (rolling up from 0 on the first reveal), the winner or "Too close to call",
// and the per-move breakdown grid (PERFECT / GOOD / MISS for each player). Used by the judge-cam
// phone right after the round (local scores) and by DanceResultBreakdown (the server's record).
// Native-free, so the design preview can render it.
import type { KeyMoveGrade } from '@youre-on/shared/dance/score';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { RollingText } from '../ui/RollingNumber';
import { half, palette, radius, space, TABULAR, type } from '../ui/tokens';
import {
  DANCE_COPY,
  danceLabels,
  dt,
  firstScoreX10,
  GRADE_COPY,
  scoreText,
  winsLabel,
} from './copy';
import { GRADE_TINT, PLAYER_TINT } from './theme';

export interface ResultMove {
  id: string;
  name: string;
  a: KeyMoveGrade;
  b: KeyMoveGrade;
}

export interface ResultData {
  /** Tenths, 0..1000. */
  scores: { a: number; b: number };
  winner: 'A' | 'B' | null;
  /** Too close, or failed: no winner, both refunded. */
  tooClose: boolean;
  moves: ResultMove[];
}

/**
 * A score that rolls up from 0.0 once (the odometer), then follows the value. `roll={false}`
 * starts on the score itself (the ruling: the scores were already on screen).
 */
function RollingScore({
  x10,
  tint,
  label,
  roll,
}: {
  x10: number;
  tint: string;
  label: string;
  roll: boolean;
}) {
  const [shown, setShown] = useState(() => firstScoreX10(x10, roll));
  useEffect(() => {
    const t = setTimeout(() => setShown(x10), 120);
    return () => clearTimeout(t);
  }, [x10]);
  return (
    <RollingText
      text={scoreText(shown)}
      style={{ ...type.balance, color: tint }}
      color={tint}
      align="center"
      accessibilityLabel={`${label} ${scoreText(x10)}`}
    />
  );
}

function GradeCell({ grade }: { grade: KeyMoveGrade }) {
  return (
    <View style={styles.cell}>
      <Text style={[styles.grade, { color: GRADE_TINT[grade] }]} numberOfLines={1}>
        {dt(GRADE_COPY[grade])}
      </Text>
    </View>
  );
}

export function ResultCard({
  data,
  names,
  me,
  roll = true,
}: {
  data: ResultData;
  names: { a: string; b: string };
  me?: 'A' | 'B' | undefined;
  /** Roll the scores up from 0.0 (default, the first reveal); false shows them from the first frame. */
  roll?: boolean;
}) {
  const verdict = data.tooClose || data.winner === null;
  const labels = danceLabels(names);
  const headline = verdict
    ? dt(DANCE_COPY.tooCloseToCall)
    : data.winner === 'A'
      ? winsLabel(names.a, labels.a)
      : winsLabel(names.b, labels.b);
  const tint = verdict ? palette.text : data.winner === 'A' ? PLAYER_TINT.A : PLAYER_TINT.B;
  const you = dt(DANCE_COPY.you);
  const side = (p: 'A' | 'B') => {
    const name = p === 'A' ? labels.a : labels.b;
    const won = !verdict && data.winner === p;
    return (
      <View style={styles.side}>
        <View style={styles.sideHead}>
          <View style={[styles.swatch, { backgroundColor: PLAYER_TINT[p] }]} />
          <Text style={styles.sideName} numberOfLines={1}>
            {name}
          </Text>
          {me === p ? <Text style={styles.tag}>{you}</Text> : null}
        </View>
        <RollingScore
          x10={p === 'A' ? data.scores.a : data.scores.b}
          tint={won ? palette.accent : palette.text}
          label={name}
          roll={roll}
        />
      </View>
    );
  };
  return (
    <View style={styles.card}>
      <View style={styles.scores}>
        {side('A')}
        <View style={styles.divider} />
        {side('B')}
      </View>
      <Text style={[styles.headline, { color: tint }]} accessibilityRole="header" numberOfLines={1}>
        {headline}
      </Text>
      {data.moves.length > 0 ? (
        <View style={styles.grid}>
          <View style={styles.row}>
            <Text style={[styles.moveName, styles.gridHead]}>{dt(DANCE_COPY.moves)}</Text>
            <Text style={[styles.cell, styles.gridHead, styles.center]} numberOfLines={1}>
              {labels.a}
            </Text>
            <Text style={[styles.cell, styles.gridHead, styles.center]} numberOfLines={1}>
              {labels.b}
            </Text>
          </View>
          {data.moves.map((m) => (
            <View key={m.id} style={styles.row}>
              <Text style={styles.moveName} numberOfLines={1}>
                {m.name}
              </Text>
              <GradeCell grade={m.a} />
              <GradeCell grade={m.b} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.x3 },
  scores: { flexDirection: 'row', alignItems: 'stretch' },
  side: { flex: 1, alignItems: 'center', gap: half.x05 },
  sideHead: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  sideName: { ...type.heading, flexShrink: 1 },
  tag: { ...type.small },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: palette.hairline },
  headline: { ...type.display, textAlign: 'center' },
  grid: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    paddingVertical: space.x1,
    paddingHorizontal: space.x2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 32,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.hairline,
  },
  gridHead: { ...type.section },
  moveName: { ...type.label, flex: 1 },
  cell: { width: 88, alignItems: 'center' },
  center: { textAlign: 'center' },
  grade: { ...type.smallStrong, fontVariant: TABULAR, letterSpacing: 0.5 },
});
