import { describe, expect, it } from 'vitest';

import { checkCopy, type CopyRole } from '../../ui/copyRule';
import { rivalryFill, RIVALRY_COPY } from '../copy';
import { recordText, statsOf } from '../format';

const lines = Object.entries(RIVALRY_COPY).map(
  ([key, [text, role]]) => [key, text, role] as [string, string, CopyRole],
);

describe('every fixed string on the rivalry overlay follows the copy rule', () => {
  it.each(lines)('%s: "%s"', (_key, text, role) => {
    expect(checkCopy(text, role)).toEqual([]);
  });
});

describe('filled lines', () => {
  it.each(
    [2, 3, 12, 140].flatMap((n) => [rivalryFill.streak('me', n), rivalryFill.streak('them', n)]),
  )('streak "%s" is a 3-word label', (text) => {
    expect(checkCopy(text, 'label')).toEqual([]);
  });

  it('records and nets are clean data', () => {
    const s = statsOf({ wins: 4, losses: 7, pushes: 1, net: '-7000000' });
    expect(checkCopy(recordText(s), 'data')).toEqual([]);
    expect(checkCopy(s.netDisplay, 'data')).toEqual([]);
  });
});
