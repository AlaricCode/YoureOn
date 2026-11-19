// "Jarvis" strings follow ui/copyRule like every other screen (TASKS D5-M2).
import { describe, expect, it } from 'vitest';

import { checkCopy, type CopyRole } from '../../ui/copyRule';
import { STATUS_COPY, WAKE_COPY, wt } from '../copy';
import { WAKE_WORD } from '../phrase';

const lines = Object.entries(WAKE_COPY).map(
  ([key, [text, role]]) => [key, text, role] as [string, string, CopyRole],
);

describe('wake copy', () => {
  it.each(lines)('%s: "%s"', (_key, text, role) => {
    expect(checkCopy(text, role)).toEqual([]);
  });

  it('the hint names the wake word the detector listens for', () => {
    expect(wt(WAKE_COPY.hint)).toContain(WAKE_WORD);
  });

  it('every status line passes, or the status shows nothing', () => {
    expect(STATUS_COPY.off).toBeNull();
    for (const line of Object.values(STATUS_COPY))
      if (line) expect(checkCopy(line[0], line[1])).toEqual([]);
  });

  it('the heard challenge is data (a sentence is fine)', () => {
    expect(checkCopy("I bet Mo can't do 20 pushups.", 'data')).toEqual([]);
  });
});
