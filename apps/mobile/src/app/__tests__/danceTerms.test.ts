import { describe, expect, it } from 'vitest';

import { ROUTINES } from '@youre-on/shared/dance/routine';
import { danceTermsArgs } from '@youre-on/shared/judge/dance-terms';

import { bottleFlip, danceOff } from '../../preview/data';
import { ApiClientError } from '../../net/signedFetch';
import { checkCopy } from '../../ui/copyRule';
import {
  amountUsd,
  canConfirmDance,
  canSubmitDance,
  DANCE_ROUTINE_CHOICES,
  danceCardOf,
  danceClaimPreview,
  danceOpen,
  danceReducer,
  DEFAULT_DANCE_STAKE_USD,
  initialDance,
  stakeChips,
  submitDanceTerms,
  waitingForAcceptDance,
  type DanceEvent,
  type DanceState,
} from '../danceTerms';

const run = (s: DanceState, ...events: DanceEvent[]) => events.reduce(danceReducer, s);
const open = () => run(initialDance, { type: 'init', bet_id: 'b1' }, { type: 'open' });
const HASH = 'ab'.repeat(32);

describe('dance panel reducer', () => {
  it('opens on a bet, with the first routine and the default stake', () => {
    expect(run(initialDance, { type: 'open' })).toBe(initialDance); // no bet yet
    const s = open();
    expect(s).toMatchObject({ bet_id: 'b1', phase: 'browsing', stakeUsd: DEFAULT_DANCE_STAKE_USD });
    expect(s.routineId).toBe(ROUTINES[0]?.id);
    expect(danceOpen(s)).toBe(true);
    expect(danceOpen(run(s, { type: 'close' }))).toBe(false);
  });

  it('picks a bundled routine and a stake; an unknown routine or a bad stake is ignored', () => {
    const s = run(open(), { type: 'routine', id: 'bounce-back' }, { type: 'stake', usd: 10 });
    expect([s.routineId, s.stakeUsd]).toEqual(['bounce-back', 10]);
    expect(run(s, { type: 'routine', id: 'moonwalk' })).toBe(s);
    expect(run(s, { type: 'stake', usd: 0 })).toBe(s);
    expect(run(s, { type: 'stake', usd: 2.555 })).toBe(s);
    expect(run(s, { type: 'stake', usd: 0.29 }).stakeUsd).toBe(0.29);
  });

  it('submit -> sent -> confirm -> confirmed; frozen while busy', () => {
    let s = open();
    expect(canSubmitDance(s)).toBe(true);
    s = run(s, { type: 'submit' });
    expect(s.phase).toBe('sending');
    expect(run(s, { type: 'routine', id: 'bounce-back' })).toBe(s);
    expect(run(s, { type: 'close' })).toBe(s);
    s = run(s, { type: 'submitted', outcome: { kind: 'proposed', terms_hash: HASH } });
    expect([s.phase, s.proposedHash]).toEqual(['sent', HASH]);
    expect(canConfirmDance(s, HASH, 'accepted')).toBe(true);
    expect(canConfirmDance(s, HASH, null)).toBe(false);
    expect(waitingForAcceptDance(s, HASH, null)).toBe(true);
    // Another card on screen (a newer proposal) is not this panel's to lock.
    expect(canConfirmDance(s, 'cd'.repeat(32), 'accepted')).toBe(false);
    s = run(s, { type: 'confirm' }, { type: 'confirmed' });
    expect(s.phase).toBe('confirmed');
    expect(run(s, { type: 'close' })).toBe(s);
  });

  it('a refusal goes back to browsing with its note; a failed confirm keeps the card', () => {
    const refused = run(
      open(),
      { type: 'submit' },
      { type: 'submitted', outcome: { kind: 'error', note: 'Try again' } },
    );
    expect([refused.phase, refused.note]).toEqual(['browsing', 'Try again']);
    const sent = run(
      open(),
      { type: 'submit' },
      { type: 'submitted', outcome: { kind: 'proposed', terms_hash: HASH } },
      { type: 'confirm' },
      { type: 'confirm_failed', note: 'Not accepted yet' },
    );
    expect([sent.phase, sent.note, sent.proposedHash]).toEqual(['sent', 'Not accepted yet', HASH]);
  });

  it('closing over a sent card and opening again lands on it; a new pick needs a resend', () => {
    const sent = run(
      open(),
      { type: 'submit' },
      { type: 'submitted', outcome: { kind: 'proposed', terms_hash: HASH } },
    );
    const back = run(sent, { type: 'close' }, { type: 'open' });
    expect(back.phase).toBe('sent');
    const changed = run(sent, { type: 'stake', usd: 20 });
    expect([changed.phase, changed.proposedHash]).toEqual(['browsing', null]);
    expect(canConfirmDance(changed, HASH, 'accepted')).toBe(false);
  });

  it('init: a shown card (a restart) reopens ready to lock; a rematch sets the stake', () => {
    const shown = { terms_hash: HASH, routineId: 'bounce-back', stakeUsd: 10 };
    const s = run(initialDance, { type: 'init', bet_id: 'b2', shown });
    expect(s).toMatchObject({ phase: 'sent', routineId: 'bounce-back', stakeUsd: 10 });
    expect(run(s, { type: 'init', bet_id: 'b2' })).toBe(s); // same bet: kept
    const re = run(initialDance, { type: 'init', bet_id: 'b3', stakeUsd: 10 });
    expect([re.phase, re.stakeUsd]).toEqual(['closed', 10]);
    expect(run(initialDance, { type: 'init', bet_id: 'b4', stakeUsd: -1 }).stakeUsd).toBe(
      DEFAULT_DANCE_STAKE_USD,
    );
  });
});

describe('the card, chips and preview', () => {
  it('reads a dance card back (routine id, even stake); never a skill card', () => {
    const d = danceOff('Logan', 'Jake', 'bounce-back', '10000000');
    expect(danceCardOf({ terms: d.terms, terms_hash: d.termsHash })).toEqual({
      terms_hash: d.termsHash,
      routineId: 'bounce-back',
      stakeUsd: 10,
    });
    const b = bottleFlip('Logan');
    expect(danceCardOf({ terms: b.terms, terms_hash: b.termsHash })).toBeNull();
    expect(danceCardOf(null)).toBeNull();
  });

  it('offers every bundled routine, with copy-safe titles', () => {
    expect(DANCE_ROUTINE_CHOICES.map((r) => r.id)).toEqual(ROUTINES.map((r) => r.id));
    for (const r of DANCE_ROUTINE_CHOICES) {
      expect(checkCopy(r.title, 'data')).toEqual([]);
      expect(checkCopy(r.song, 'data')).toEqual([]);
    }
  });

  it('adds a double or nothing suggestion to the chips, sorted, once', () => {
    expect(stakeChips([1, 5, 10, 20])).toEqual([1, 5, 10, 20]);
    expect(stakeChips([1, 5, 10, 20], 2)).toEqual([1, 2, 5, 10, 20]);
    expect(stakeChips([1, 5, 10, 20], 10)).toEqual([1, 5, 10, 20]);
    expect(stakeChips([1, 5, 10, 20], null)).toEqual([1, 5, 10, 20]);
  });

  it('previews the exact claim the server composes', () => {
    const proj = danceTermsArgs({ routine_id: 'wave-pop', amount_usd: '5' });
    expect(danceClaimPreview('wave-pop', 5)).toBe(proj?.claim);
    expect(danceClaimPreview('wave-pop', 2.5)).toContain('$2.50 each');
    expect(danceClaimPreview('moonwalk', 5)).toBeNull();
    expect([amountUsd(5), amountUsd(2.5), amountUsd(0.29)]).toEqual(['5', '2.50', '0.29']);
  });
});

describe('submitDanceTerms', () => {
  it('POSTs the routine and the stake; a proposal returns its hash', async () => {
    const sent: unknown[] = [];
    const out = await submitDanceTerms(
      {
        api: {
          proposeDanceTerms: async (betId, body) => {
            sent.push([betId, body]);
            return {
              ok: true as const,
              kind: 'proposed' as const,
              state: 'TERMS_PROPOSED' as const,
              terms_hash: HASH,
              code: 'abab·abab',
              say: 'Dance off.',
            };
          },
        },
      },
      { betId: 'b1', routineId: 'wave-pop', stakeUsd: 10 },
    );
    expect(out).toEqual({ kind: 'proposed', terms_hash: HASH });
    expect(sent).toEqual([['b1', { routine_id: 'wave-pop', amount_usd: '10' }]]);
  });

  it('a draft answer or an error is a short note, never a throw', async () => {
    const draft = await submitDanceTerms(
      {
        api: {
          proposeDanceTerms: async () => ({
            ok: false as const,
            kind: 'draft' as const,
            fix: null,
            missing: [],
            say: 'That stake is over the limit.',
          }),
        },
      },
      { betId: 'b1', routineId: 'wave-pop', stakeUsd: 40 },
    );
    expect(draft).toEqual({ kind: 'error', note: 'That stake is over the limit.' });
    const missing = await submitDanceTerms(
      {
        api: {
          proposeDanceTerms: async () => {
            throw new ApiClientError('NOT_FOUND', 404, 'no routine', false);
          },
        },
      },
      { betId: 'b1', routineId: 'wave-pop', stakeUsd: 5 },
    );
    expect(missing).toEqual({ kind: 'error', note: 'Routine not found' });
  });
});
