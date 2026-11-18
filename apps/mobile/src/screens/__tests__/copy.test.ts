import { describe, expect, it } from 'vitest';

import { END_COPY } from '../../bets/lock';
import { RESULT_TITLE, signedUsd } from '../../bets/view';
import {
  DANCE_REASON,
  danceOff,
  FILMING_TIP,
  NEGOTIATION_SCRIPT,
  PANEL,
  previewDanceScored,
  RULING_REASON,
} from '../../preview/data';
import { checkCopy, type CopyRole } from '../../ui/copyRule';
import { COPY, fill } from '../copy';

const lines: [string, string, CopyRole][] = Object.entries(COPY).flatMap(([screen, entries]) =>
  Object.entries(entries).map(
    ([key, [text, role]]) => [`${screen}.${key}`, text, role] as [string, string, CopyRole],
  ),
);

describe('every fixed string on the bet screens follows the copy rule', () => {
  it.each(lines)('%s: "%s"', (_key, text, role) => {
    expect(checkCopy(text, role)).toEqual([]);
  });
});

describe('spec sentences are contract copy', () => {
  it.each([
    ...Object.values(END_COPY),
    fill.challenged('Logan'),
    fill.challenged('Eva Santos'),
    fill.challengeName('Jake'),
    fill.holdToLock('$5'),
    fill.holdToLock('$6.20'),
    fill.swipeToLock('$5'),
    fill.swipeToLock('$6.20'),
    fill.youreIn('Jake'),
    fill.theyreIn('Jake'),
    fill.headToHead(4, 7, 'Jake', signedUsd('-7000000')),
  ])('"%s"', (text) => {
    expect(checkCopy(text, 'contract')).toEqual([]);
  });
});

describe('results and data', () => {
  it.each(Object.values(RESULT_TITLE))('title "%s"', (text) => {
    expect(checkCopy(text, 'label')).toEqual([]);
  });
  it.each([fill.turn('Jake'), fill.waitingFor('Jake'), fill.waitingFor('Eva Santos')])(
    'label "%s"',
    (text) => {
      expect(checkCopy(text, 'label')).toEqual([]);
    },
  );
  it('Waiting for <name> keeps to the label limit with a full name', () => {
    expect(fill.waitingFor('Eva Santos')).toBe('Waiting for Eva');
    expect(fill.waitingFor(' ')).toBe('Waiting for them');
  });
  it('preview data has no chain words, addresses or emoji', () => {
    const data = [
      FILMING_TIP,
      RULING_REASON,
      DANCE_REASON,
      previewDanceScored(danceOff('Logan'), true).announcer_line,
      ...NEGOTIATION_SCRIPT.map((l) => l.text),
      ...PANEL.map((p) => p.reason),
    ];
    for (const text of data) expect(checkCopy(text, 'body')).toEqual([]);
  });
});

describe('Dance Off and double or nothing copy', () => {
  it('the tempo is data; the dance lines keep the label rule', () => {
    expect(fill.bpm(120)).toBe('120 bpm');
    expect(fill.bpm(112.4)).toBe('112 bpm');
    expect(checkCopy(fill.bpm(128), 'label')).toEqual([]);
    for (const line of [COPY.dance.open, COPY.rematch.button, COPY.dance.announcer])
      expect(checkCopy(line[0], 'label')).toEqual([]);
  });

  it('a dance off card reads without chain words: claim and rules', () => {
    const { terms } = danceOff('Logan', 'Jake');
    for (const text of [terms.claim, ...terms.success_criteria])
      expect(checkCopy(text, 'data')).toEqual([]);
    // The rule line is a sentence on the card, never a label.
    expect(checkCopy(terms.success_criteria[1]!, 'body')).toEqual([]);
  });
});
