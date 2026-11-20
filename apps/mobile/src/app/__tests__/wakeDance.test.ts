// "Jarvis, dance off" opens the Dance off panel instead of going to the voice judge
// (app/wakeDance). The regression: the judge can only write camera bets, so a dance battle asked
// for out loud came back as a bottle flip.
import { describe, expect, it } from 'vitest';

import {
  DANCE_ROUTINE_CHOICES,
  DANCE_STAKES_USD,
  DEFAULT_DANCE_STAKE_USD,
  danceReducer,
  initialDance,
  type DanceState,
} from '../danceTerms';
import { danceEventsFor, danceRequest } from '../wakeDance';

const ask = (text: string) => danceRequest(text, DANCE_ROUTINE_CHOICES, DANCE_STAKES_USD);

describe('danceRequest', () => {
  it('hears a Dance Off however it is said or transcribed', () => {
    for (const text of [
      'dance off',
      'Dance-off against Eva',
      "let's do a dance battle",
      'I challenge Eva to a danceoff',
      'do a dance of with Jake',
      'dance competition for five bucks',
      'I want a dance contest',
      'dance against Eva',
      'I bet I can out dance Jake',
      'Dance Off.',
    ])
      expect(ask(text), text).not.toBeNull();
  });

  it('leaves everything else to the judge', () => {
    for (const text of [
      '',
      "bet you can't land a bottle flip",
      "I bet Jake can't dance on the table for ten seconds",
      'Jake has to do a little dance if he misses',
      'bet he will bounce back',
      'I bet Eva five bucks she drops it',
    ])
      expect(ask(text), text).toBeNull();
  });

  it('knows the first routine by the name on screen, Bye Bye Bye', () => {
    expect(DANCE_ROUTINE_CHOICES.find((r) => r.id === 'bye-bye-shuffle')!.title).toBe(
      'Bye Bye Bye',
    );
    expect(ask('dance off to bye bye bye for five bucks')).toEqual({
      routineId: 'bye-bye-shuffle',
      stakeUsd: 5,
    });
  });

  it('picks the routine that was named, and none on a tie or when none was', () => {
    expect(ask('dance off, the bye bye shuffle')?.routineId).toBe('bye-bye-shuffle');
    expect(ask('dance battle to bye bye bye')?.routineId).toBe('bye-bye-shuffle');
    expect(ask('dance off with the shuffle')?.routineId).toBe('bye-bye-shuffle');
    expect(ask('wave pop dance off against Eva')?.routineId).toBe('wave-pop');
    expect(ask('dance off, bounce back')?.routineId).toBe('bounce-back');
    expect(ask('dance off against Eva')?.routineId).toBeNull();
    // one word of each: no way to tell
    expect(ask('dance off, wave or shuffle')?.routineId).toBeNull();
  });

  it('never picks a routine from a word as common as "back"', () => {
    expect(ask("dance off, I'll win my money back")?.routineId).toBeNull();
  });

  it('takes a stake only when it is one the panel offers', () => {
    expect(ask('dance off for five bucks')?.stakeUsd).toBe(5);
    expect(ask('dance off for $10')?.stakeUsd).toBe(10);
    expect(ask('dance battle, 20 dollars each')?.stakeUsd).toBe(20);
    expect(ask('dance off for a buck')?.stakeUsd).toBe(1);
    expect(ask('dance off for seven dollars')?.stakeUsd).toBeNull();
    expect(ask('dance off for $500')?.stakeUsd).toBeNull();
    expect(ask('dance off, best of 5')?.stakeUsd).toBeNull();
    expect(ask('dance off')?.stakeUsd).toBeNull();
  });
});

describe('danceEventsFor on the panel', () => {
  const fresh = (): DanceState =>
    danceReducer(initialDance, { type: 'init', bet_id: 'bet-1', shown: null });
  const apply = (s: DanceState, text: string) => danceEventsFor(ask(text)!).reduce(danceReducer, s);

  it('opens the panel on its own routine and stake when neither was said', () => {
    const s = apply(fresh(), 'dance off against Eva');
    expect(s.phase).toBe('browsing');
    expect(s.routineId).toBe(DANCE_ROUTINE_CHOICES[0]!.id);
    expect(s.stakeUsd).toBe(DEFAULT_DANCE_STAKE_USD);
    expect(s.proposedHash).toBeNull();
  });

  it('opens it with the routine and the stake that were said', () => {
    const s = apply(fresh(), 'dance battle, wave pop, for ten bucks');
    expect(s.phase).toBe('browsing');
    expect(s.routineId).toBe('wave-pop');
    expect(s.stakeUsd).toBe(10);
  });

  it('opens it even when the routine said is the one already picked', () => {
    const s = apply(fresh(), 'dance off, bye bye shuffle');
    expect(s.phase).toBe('browsing');
    expect(s.routineId).toBe('bye-bye-shuffle');
  });

  it('sends nothing by itself: the terms still wait for "Send terms"', () => {
    const s = apply(fresh(), 'dance off for five bucks');
    expect(s.phase).not.toBe('sending');
    expect(s.phase).not.toBe('sent');
  });

  it('does nothing before the panel knows the bet', () => {
    expect(apply(initialDance, 'dance off').phase).toBe('closed');
  });
});

describe('danceRequest: said loosely, as the recognizer hands it over', () => {
  it('a routine and "dance" or "battle" anywhere is a Dance Off (seen on an iPad)', () => {
    for (const text of [
      'do a dance to bye bye bye for one dollar',
      'a battle to bye-bye bye for one dollar',
      'Alaric does a dance to bye-bye bye-bye for one dollar',
      'I want to dance to Bye Bye Bye by NSYNC for one dollar',
      'a battle with Alaric a dancing one',
    ]) {
      expect(ask(text), text).not.toBeNull();
    }
    expect(ask('a battle to bye bye bye for one dollar')).toEqual({
      routineId: 'bye-bye-shuffle',
      stakeUsd: 1,
    });
  });

  it('a camera bet that only mentions dancing or a battle is still a camera bet', () => {
    for (const text of [
      "bet you can't dance on the table",
      'I bet Eva dances at the party',
      'a thumb battle for five dollars',
      'bet you wave bye bye to the bus',
    ]) {
      expect(ask(text), text).toBeNull();
    }
  });
});
