// The per-bet "both players identified by face" note (src/judge/dance-faces): only it lets a
// dance-off upload start A on the right.
import { describe, expect, it } from 'vitest';
import {
  bothPartiesAssigned,
  DANCE_FACES_NOTE_TTL_MS,
  danceFacesIdentified,
  noteDanceFaces,
} from '../src/judge/dance-faces';

describe('dance faces note', () => {
  it('is set by a both-identified answer, dropped by any other, and expires', () => {
    let now = 1_000_000;
    const deps = { now: () => now };
    const other = { now: () => now };
    expect(danceFacesIdentified(deps, 'bet-1')).toBe(false);
    noteDanceFaces(deps, 'bet-1', true);
    expect(danceFacesIdentified(deps, 'bet-1')).toBe(true);
    // Per server (deps), per bet.
    expect(danceFacesIdentified(other, 'bet-1')).toBe(false);
    expect(danceFacesIdentified(deps, 'bet-2')).toBe(false);
    noteDanceFaces(deps, 'bet-1', false);
    expect(danceFacesIdentified(deps, 'bet-1')).toBe(false);
    noteDanceFaces(deps, 'bet-1', true);
    now += DANCE_FACES_NOTE_TTL_MS;
    expect(danceFacesIdentified(deps, 'bet-1')).toBe(true);
    now += 1;
    expect(danceFacesIdentified(deps, 'bet-1')).toBe(false);
  });

  it('both parties means one A and one B in the answer', () => {
    expect(bothPartiesAssigned([{ party: 'B' }, { party: 'A' }])).toBe(true);
    expect(bothPartiesAssigned([{ party: 'A' }])).toBe(false);
    expect(bothPartiesAssigned([])).toBe(false);
  });
});
