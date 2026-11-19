// The Dance Off and double-or-nothing facts the store folds (DANCE-OFF §5, §7): dance.scored
// with the ruling, and bet.invited's rematch_of / suggested_stake_usd.
import { describe, expect, it } from 'vitest';

import {
  BET,
  dance,
  danceEnvelope,
  ev,
  ME_A,
  ROOM,
  snapshot,
  stateEv,
} from '../../app/__tests__/fixtures';
import { previewDanceScored } from '../../preview/data';
import { applyBetEvent, emptyBet, fromSnapshot, type BetModel } from '../store';

const fold = (m: BetModel, ...events: ReturnType<typeof ev>[]) => events.reduce(applyBetEvent, m);

describe('dance.scored', () => {
  it('parses as a realtime event and lands on the bet', () => {
    const scored = previewDanceScored(dance);
    let m = fromSnapshot(snapshot({ state: 'JUDGING', envelope: danceEnvelope(), last_seq: 11 }));
    expect(m.danceScored).toBeNull();
    m = fold(m, ev('dance.scored', scored, 12), stateEv('RULED', 13));
    expect(m.danceScored?.evidence.scores).toEqual({ a: 874, b: 712 });
    expect(m.danceScored?.evidence.winner).toBe('A');
    expect(m.danceScored?.validation.verdict).toBe('valid');
  });

  it('a too-close round carries no winner', () => {
    const m = fold(
      fromSnapshot(snapshot({ state: 'JUDGING', last_seq: 11 })),
      ev('dance.scored', previewDanceScored(dance, true), 12),
    );
    expect(m.danceScored?.evidence).toMatchObject({ too_close: true, winner: null });
  });

  it('a new attempt clears the last round', () => {
    let m = fold(
      fromSnapshot(snapshot({ state: 'JUDGING', last_seq: 11 })),
      ev('dance.scored', previewDanceScored(dance), 12),
    );
    m = fold(m, stateEv('ATTEMPT', 13));
    expect(m.danceScored).toBeNull();
  });
});

describe('bet.invited for a double or nothing', () => {
  it('keeps the bet it follows and the suggested stake', () => {
    const m = fold(
      emptyBet(BET),
      ev(
        'bet.invited',
        {
          challenger: ME_A,
          room_id: ROOM,
          rematch_of: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
          suggested_stake_usd: 10,
        },
        1,
      ),
    );
    expect(m).toMatchObject({
      my_party: 'B',
      rematchOf: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
      suggestedStakeUsd: 10,
    });
  });

  it('a plain invite has none', () => {
    const m = fold(emptyBet(BET), ev('bet.invited', { challenger: ME_A, room_id: ROOM }, 1));
    expect([m.rematchOf, m.suggestedStakeUsd]).toEqual([null, null]);
  });
});
