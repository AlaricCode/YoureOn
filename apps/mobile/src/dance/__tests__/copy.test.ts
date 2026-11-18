// The Dance Off strings follow ui/copyRule like every bet screen (TASKS D5-M2).
import { describe, expect, it } from 'vitest';

import { checkCopy, type CopyRole } from '../../ui/copyRule';
import {
  DANCE_COPY,
  ERROR_COPY,
  firstName,
  FRAMING_COPY,
  GRADE_COPY,
  meterText,
  scoreText,
  winsLabel,
} from '../copy';
import { DANCE_ROUTINE_CHOICES } from '../routines';

const lines = Object.entries(DANCE_COPY).map(
  ([key, [text, role]]) => [key, text, role] as [string, string, CopyRole],
);

describe('Dance Off copy', () => {
  it.each(lines)('%s: "%s"', (_key, text, role) => {
    expect(checkCopy(text, role)).toEqual([]);
  });

  it('every framing reason, grade and error has a line', () => {
    for (const r of ['ok', 'need_two', 'too_many', 'feet', 'head', 'same_side', 'too_close'] as const)
      expect(checkCopy(FRAMING_COPY[r][0], FRAMING_COPY[r][1])).toEqual([]);
    for (const g of ['PERFECT', 'GOOD', 'MISS'] as const)
      expect(checkCopy(GRADE_COPY[g][0], 'label')).toEqual([]);
    for (const line of Object.values(ERROR_COPY)) {
      expect(line[1]).toBe('error');
      expect(checkCopy(line[0], 'error')).toEqual([]);
    }
  });

  it.each(['Logan', 'Eva Santos', '  Mo  '])('"<name> wins" is a label for %s', (name) => {
    expect(checkCopy(winsLabel(name), 'label')).toEqual([]);
  });

  it('keeps the first name only', () => {
    expect(winsLabel('Eva Santos')).toBe('Eva wins');
    expect(firstName(' ')).toBe('They');
  });

  it('scores are tenths shown with one decimal; meters are whole numbers (data)', () => {
    expect(scoreText(874)).toBe('87.4');
    expect(scoreText(1_000)).toBe('100.0');
    expect(scoreText(0)).toBe('0.0');
    expect(scoreText(5)).toBe('0.5');
    expect(scoreText(-3)).toBe('0.0');
    expect(meterText(87.6)).toBe('88');
    expect(meterText(140)).toBe('100');
    for (const v of [scoreText(874), meterText(50)]) expect(checkCopy(v, 'data')).toEqual([]);
  });

  it('the routine cards are the three bundled routines, with clean data', () => {
    expect(DANCE_ROUTINE_CHOICES.map((r) => r.id)).toEqual([
      'wave-pop',
      'bounce-back',
      'side-shuffle',
    ]);
    for (const r of DANCE_ROUTINE_CHOICES) {
      expect(checkCopy(r.title, 'data')).toEqual([]);
      expect(checkCopy(r.song, 'data')).toEqual([]);
      expect(r.bpm).toBeGreaterThan(0);
    }
  });
});
