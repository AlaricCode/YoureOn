import { describe, expect, it } from 'vitest';

import { ApiClientError } from '../../net/signedFetch';
import { checkCopy } from '../../ui/copyRule';
import { homeErrorLabel } from '../homeErrors';

const apiError = (code: string, status: number, details?: Record<string, unknown>) =>
  new ApiClientError(code, status, 'server text', false, details);

describe('homeErrorLabel', () => {
  it('names the open-bet cap (the likeliest demo-day failure)', () => {
    const e = apiError('RATE_LIMITED', 429, {
      bucket: 'bets/open',
      reason: 'too_many_open_bets',
      limit: 3,
    });
    expect(homeErrorLabel('challenge', e)).toBe('Finish open bets');
  });

  it('names a bet already open between the two', () => {
    const e = apiError('INVALID_STATE', 409, {
      reason: 'pair_busy',
      bet_id: 'x',
      state: 'DRAFTING',
    });
    expect(homeErrorLabel('challenge', e)).toBe('Bet already open');
  });

  it('names an opponent who left the room', () => {
    expect(homeErrorLabel('challenge', apiError('NOT_IN_ROOM', 403, { party: 'B' }))).toBe(
      'Not in room',
    );
  });

  it('says the phone is offline on a network failure', () => {
    const e = new ApiClientError('NETWORK', 0, 'Network request failed', true);
    expect(homeErrorLabel('create', e)).toBe("Can't connect");
    expect(homeErrorLabel('challenge', e)).toBe("Can't connect");
  });

  it('asks to wait on the request rate limit', () => {
    const e = apiError('RATE_LIMITED', 429, { bucket: 'rooms' });
    expect(homeErrorLabel('create', e)).toBe('Try again soon');
    expect(homeErrorLabel('challenge', apiError('RATE_LIMITED', 429, {}))).toBe('Try again soon');
  });

  it('falls back to a per-action line for anything else', () => {
    expect(homeErrorLabel('create', apiError('INTERNAL', 500))).toBe('Room not created');
    expect(homeErrorLabel('challenge', apiError('INTERNAL', 500))).toBe('Challenge not sent');
    expect(homeErrorLabel('create', new Error('boom'))).toBe('Room not created');
    expect(homeErrorLabel('challenge', undefined)).toBe('Challenge not sent');
  });

  it('judge cam: names a room the phone is not in, else a short fallback', () => {
    expect(homeErrorLabel('judgeCam', apiError('NOT_IN_ROOM', 403))).toBe('Not in room');
    expect(homeErrorLabel('judgeCam', apiError('VALIDATION_FAILED', 400))).toBe('Camera not set');
    expect(homeErrorLabel('judgeCam', new ApiClientError('NETWORK', 0, 'x', true))).toBe(
      "Can't connect",
    );
  });

  it('a create never reports a challenge-only reason', () => {
    const e = apiError('INVALID_STATE', 409, { reason: 'pair_busy' });
    expect(homeErrorLabel('create', e)).toBe('Room not created');
  });

  it('every label it can return passes the copy rule as an error', () => {
    const samples = [
      apiError('RATE_LIMITED', 429, { reason: 'too_many_open_bets' }),
      apiError('INVALID_STATE', 409, { reason: 'pair_busy' }),
      apiError('NOT_IN_ROOM', 403),
      apiError('RATE_LIMITED', 429),
      new ApiClientError('NETWORK', 0, 'x', true),
      new Error('x'),
    ];
    for (const action of ['create', 'challenge', 'judgeCam'] as const)
      for (const e of samples) expect(checkCopy(homeErrorLabel(action, e), 'error')).toEqual([]);
  });
});
