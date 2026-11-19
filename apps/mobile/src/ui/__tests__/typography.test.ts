import { describe, expect, it } from 'vitest';

import { fontFamily, type, type TypeToken } from '../tokens';
import { balance, isVoice, typographic } from '../typography';

describe('isVoice', () => {
  it('is true exactly for the styles set in the serif', () => {
    for (const k of Object.keys(type) as TypeToken[]) {
      const face: string = type[k].fontFamily;
      expect(isVoice(k), k).toBe(face === fontFamily.voice || face === fontFamily.voiceItalic);
    }
    expect(isVoice('moment')).toBe(true);
    expect(isVoice('spoken')).toBe(true);
    expect(isVoice('label')).toBe(false);
    expect(isVoice('balance')).toBe(false);
  });
});

describe('typographic', () => {
  it('turns a typewriter apostrophe after a letter into a real one', () => {
    expect(typographic("You're On")).toBe('You’re On');
    expect(typographic("Couldn't lock it. Nothing moved.")).toBe(
      'Couldn’t lock it. Nothing moved.',
    );
    expect(typographic("Jake's turn")).toBe('Jake’s turn');
    expect(typographic("the players' call")).toBe('the players’ call');
  });

  it('leaves everything else alone', () => {
    expect(typographic('Jake wins')).toBe('Jake wins');
    expect(typographic("'quoted'")).toBe("'quoted’");
    expect(typographic('')).toBe('');
    expect(typographic('You’re On')).toBe('You’re On');
  });

  it('keeps the length, so anything measured in characters still holds', () => {
    const s = "Don't. Can't. Won't.";
    expect(typographic(s)).toHaveLength(s.length);
  });
});

describe('balance', () => {
  it('returns a line that fits unchanged', () => {
    expect(balance('Jake wins', 12)).toBe('Jake wins');
    expect(balance('Locked', 3)).toBe('Locked');
  });

  it('breaks two lines where they come out closest, never one word alone under a full line', () => {
    expect(balance('Logan challenged you', 16)).toBe('Logan\nchallenged you');
    expect(balance('Too close to call', 12)).toBe('Too close\nto call');
    expect(balance('Double or nothing', 12)).toBe('Double or\nnothing');
  });

  it('leaves text that cannot make two fitting lines to wrap by itself', () => {
    expect(balance('Alexandria challenged you again today', 14)).toBe(
      'Alexandria challenged you again today',
    );
  });

  it('respects a break that is already there, and collapses doubled spaces when it breaks', () => {
    expect(balance('Declined.\nNothing moved.', 8)).toBe('Declined.\nNothing moved.');
    expect(balance('Logan  challenged you', 16)).toBe('Logan\nchallenged you');
  });
});
