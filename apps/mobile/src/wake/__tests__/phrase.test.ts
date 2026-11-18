import { describe, expect, it } from 'vitest';

import {
  boundedLevenshtein,
  cleanTail,
  findWakes,
  hasWake,
  isWakeKey,
  normalizeTranscript,
  splitAfterWake,
  tokenize,
  wordKey,
} from '../phrase';

describe('normalize', () => {
  it('lowercases, strips punctuation, diacritics and apostrophes', () => {
    expect(normalizeTranscript('Hey, JARVIS!  I bet… Zoë can’t do it.')).toBe(
      'hey jarvis i bet zoe cant do it',
    );
    expect(normalizeTranscript('  ')).toBe('');
  });

  it('drops a possessive s', () => {
    expect(wordKey("Jarvis's")).toBe('jarvis');
    expect(wordKey('Jarvis’s')).toBe('jarvis');
    expect(wordKey('Jarvís')).toBe('jarvis');
  });

  it('keeps original offsets', () => {
    const text = 'ok, Jarvis: go';
    for (const t of tokenize(text)) expect(text.slice(t.start, t.end)).toBe(t.raw);
  });

  it('handles decomposed diacritics', () => {
    expect(normalizeTranscript('Jarvís')).toBe('jarvis');
    expect(hasWake('Jarvís, go')).toBe(true);
  });
});

describe('boundedLevenshtein', () => {
  it.each([
    ['jarvis', 'jarvis', 0],
    ['jervis', 'jarvis', 1],
    ['javis', 'jarvis', 1],
    ['jarviss', 'jarvis', 1],
    ['travis', 'jarvis', 3],
  ])('%s vs %s', (a, b, d) => {
    expect(boundedLevenshtein(a, b, 3)).toBe(d);
  });

  it('gives up above the bound', () => {
    expect(boundedLevenshtein('service', 'jarvis', 1)).toBe(2);
    expect(boundedLevenshtein('a', 'jarvis', 1)).toBe(2);
  });
});

describe('wake word', () => {
  it.each([
    'jarvis',
    'jervis',
    'jarvas',
    'jarvus',
    'jarves',
    'javis',
    'jarvs',
    'jarviz',
    'jarviss',
    'garvis',
    'charvis',
  ])('accepts %s', (key) => {
    expect(isWakeKey(key)).toBe(true);
  });

  // Real words and names must never wake the judge mid-conversation.
  it.each([
    'travis',
    'davis',
    'service',
    'harvest',
    'nervous',
    'jars',
    'jar',
    'java',
    'javascript',
    'jarring',
    'marvis',
    'parvis',
    'garvey',
    'chargers',
    'jovial',
    'jasper',
    'jarvisville',
  ])('rejects %s', (key) => {
    expect(isWakeKey(key)).toBe(false);
  });

  it.each([
    'Jarvis',
    'jarvis',
    'JARVIS!',
    'Hey Jarvis, I bet',
    'hey, Jarvis.',
    "Jarvis's turn",
    'Jervis what is up',
    'jar vis I bet you',
    'Jar-vis go',
  ])('finds it in "%s"', (text) => {
    expect(hasWake(text)).toBe(true);
  });

  it.each([
    '',
    'I bet Travis cannot do ten pushups',
    'Davis is faster',
    'the customer service was slow',
    'harvest moon',
    'the jar is full',
    'jar of pickles',
    'I am nervous',
    'Java is a language',
  ])('does not find it in "%s"', (text) => {
    expect(hasWake(text)).toBe(false);
  });

  it('reports every occurrence with offsets, a split word as one span', () => {
    const text = 'Jarvis, jar vis, ok';
    expect(findWakes(text)).toEqual([
      { start: 0, end: 6 },
      { start: 8, end: 15 },
    ]);
  });
});

describe('cleanTail', () => {
  it.each([
    [', I bet you', 'I bet you'],
    [' — um, ok so I bet', 'I bet'],
    ['  hey   I bet   Mo ', 'I bet Mo'],
    ['... uh, erm. Okay, bet', 'bet'],
    ['?!', ''],
    ['um', ''],
    ['', ''],
  ])('"%s" -> "%s"', (raw, out) => {
    expect(cleanTail(raw)).toBe(out);
  });

  it('only strips fillers at the front, as whole words', () => {
    expect(cleanTail('hey Okafor, so what')).toBe('Okafor, so what');
    expect(cleanTail('Sofia bets um ten')).toBe('Sofia bets um ten');
    expect(cleanTail('okayish bet')).toBe('okayish bet');
  });
});

describe('splitAfterWake', () => {
  it('returns the challenge after the wake word, as said', () => {
    expect(splitAfterWake("Hey Jarvis, um, I bet Mo can't do 20 pushups.")).toEqual({
      found: true,
      tail: "I bet Mo can't do 20 pushups.",
    });
  });

  it('uses the last wake word', () => {
    expect(splitAfterWake('Jarvis. Jarvis, Jake owes me if he misses')).toEqual({
      found: true,
      tail: 'Jake owes me if he misses',
    });
  });

  it('an empty tail when only the wake word was said', () => {
    expect(splitAfterWake('Hey Jarvis')).toEqual({ found: true, tail: '' });
    expect(splitAfterWake('Jarvis, um…')).toEqual({ found: true, tail: '' });
  });

  it('not found', () => {
    expect(splitAfterWake('Travis, I bet you')).toEqual({ found: false, tail: '' });
  });

  it('ignores what was said before the wake word', () => {
    expect(splitAfterWake('so anyway Jarvis bet Sam twenty bucks')).toEqual({
      found: true,
      tail: 'bet Sam twenty bucks',
    });
  });

  it('works with a split or misheard wake word', () => {
    expect(splitAfterWake('jar vis, race to the door').tail).toBe('race to the door');
    expect(splitAfterWake('Jervis race to the door').tail).toBe('race to the door');
    expect(splitAfterWake("Jarvis's bet: race to the door").tail).toBe('bet: race to the door');
  });
});
