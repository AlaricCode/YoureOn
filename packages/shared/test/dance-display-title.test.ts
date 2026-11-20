// A routine's display name (dance/routine routineDisplayTitle). "Bye Bye Shuffle" is shown as the
// song it is danced to, "Bye Bye Bye", WITHOUT touching the routine's data: its title is part of
// routine_sha256, which every locked bet and every installed build is bound to.
import { describe, expect, it } from 'vitest';
import {
  getRoutine,
  ROUTINES,
  ROUTINE_SHA256_PINS,
  routineDisplayTitle,
  routineSha256,
} from '../src/dance/routine';
import { danceClaim, danceRoutineLine, parseDanceTermsRoutine } from '../src/dance/terms';
import { danceTermsArgs } from '../src/judge/dance-terms';

const BYE = getRoutine('bye-bye-shuffle')!;

describe('routine display names', () => {
  it('shows the Bye Bye Shuffle routine as the song, Bye Bye Bye', () => {
    expect(routineDisplayTitle(BYE)).toBe('Bye Bye Bye');
  });

  it('shows every other routine by its own title', () => {
    for (const r of ROUTINES)
      if (r.id !== 'bye-bye-shuffle') expect(routineDisplayTitle(r)).toBe(r.title);
    expect(routineDisplayTitle({ id: 'not-bundled', title: 'Something New' })).toBe(
      'Something New',
    );
  });

  it('leaves the hashed data alone: the title, the id and the sha256 are what they were', () => {
    expect(BYE.title).toBe('Bye Bye Shuffle');
    expect(BYE.version).toBe(1);
    expect(routineSha256(BYE)).toBe(ROUTINE_SHA256_PINS['bye-bye-shuffle']);
    expect(danceRoutineLine(BYE)).toBe(
      `Routine bye-bye-shuffle v1 sha256:${ROUTINE_SHA256_PINS['bye-bye-shuffle']!.slice(0, 16)}`,
    );
  });

  it('writes the display name into the claim, and the routine is still found from the terms', () => {
    expect(danceClaim(BYE, '5000000')).toBe(
      'Dance Off: Bye Bye Bye, 33 seconds, higher match score wins, $5 each',
    );
    const args = danceTermsArgs({ routine_id: 'bye-bye-shuffle', amount_usd: '5' });
    expect(args).not.toBeNull();
    const parsed = parseDanceTermsRoutine({
      type: 'dance_off',
      success_criteria: args!.success_criteria,
    });
    expect(parsed).toMatchObject({ ok: true, routine_id: 'bye-bye-shuffle', version: 1 });
  });
});
