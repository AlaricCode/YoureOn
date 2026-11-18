// The GG moment and review sheet strings follow ui/copyRule like every bet screen (TASKS D5-M2).
import { describe, expect, it } from 'vitest';

import { checkCopy, type CopyRole } from '../../ui/copyRule';
import { FAILURE_COPY, GG_COPY, saidGG, streakLabel } from '../copy';
import { recordLabel } from '../model';

const lines = Object.entries(GG_COPY).map(
  ([key, [text, role]]) => [key, text, role] as [string, string, CopyRole],
);

describe('GG / review copy', () => {
  it.each(lines)('%s: "%s"', (_key, text, role) => {
    expect(checkCopy(text, role)).toEqual([]);
  });

  it.each(['Jake', 'Eva Santos', '  Mo  '])('"<name> said GG" is a label for %s', (name) => {
    expect(checkCopy(saidGG(name), 'label')).toEqual([]);
  });

  it('keeps the first name only', () => {
    expect(saidGG('Eva Santos')).toBe('Eva said GG');
    expect(saidGG(' ')).toBe('They said GG');
  });

  it('record and streak values are data (no emoji, no addresses)', () => {
    expect(checkCopy(recordLabel({ mine: 5, theirs: 7 }), 'data')).toEqual([]);
    expect(checkCopy(`${GG_COPY.streak[0]} ${streakLabel(3)}`, 'label')).toEqual([]);
  });

  it('every confirm failure has a line or is silent (a cancelled prompt)', () => {
    expect(FAILURE_COPY.cancelled).toBeNull();
    for (const line of Object.values(FAILURE_COPY))
      if (line) expect(checkCopy(line[0], line[1])).toEqual([]);
  });
});
