import { describe, expect, it } from 'vitest';

import {
  declineEnabled,
  holdEnabled,
  initialLock,
  lockReducer,
  type LockEvent,
  type LockState,
} from '../lock';

const run = (...events: LockEvent[]): LockState => events.reduce(lockReducer, initialLock);

describe('terms card lock state (SCHEMAS §9.4)', () => {
  it('keeps the hold off until the device policy passes', () => {
    expect(holdEnabled(initialLock)).toBe(false);
    expect(holdEnabled(run({ type: 'policy', ok: true }))).toBe(true);
    const refused = run({ type: 'policy', ok: false });
    expect(refused.phase).toBe('refused');
    expect(holdEnabled(lockReducer(refused, { type: 'hold_complete' }))).toBe(false);
  });

  it('A first: hold, Face ID, signed, then the second signature locks', () => {
    const s = run(
      { type: 'policy', ok: true },
      { type: 'hold_complete' },
      { type: 'auth_result', ok: true },
    );
    expect(s.phase).toBe('signed');
    expect(declineEnabled(s)).toBe(true);
    const locked = run(
      { type: 'policy', ok: true },
      { type: 'hold_complete' },
      { type: 'auth_result', ok: true },
      { type: 'their_signature' },
      { type: 'submitted' },
      { type: 'confirmed' },
    );
    expect(locked.phase).toBe('locked');
  });

  it('B first: their signature shows, and this phone can still sign', () => {
    const s = run({ type: 'policy', ok: true }, { type: 'their_signature' });
    expect(s.theirsIn).toBe(true);
    expect(holdEnabled(s)).toBe(true);
  });

  it('a cancelled Face ID goes back to the hold and flags it', () => {
    const s = run(
      { type: 'policy', ok: true },
      { type: 'hold_complete' },
      { type: 'auth_result', ok: false },
    );
    expect(s.phase).toBe('ready');
    expect(s.authFailed).toBe(true);
  });

  it('decline works after signing, but not once the lock is sent', () => {
    const signed = run(
      { type: 'policy', ok: true },
      { type: 'hold_complete' },
      { type: 'auth_result', ok: true },
    );
    expect(lockReducer(signed, { type: 'end', reason: 'declined' }).endReason).toBe('declined');
    const sending = lockReducer(signed, { type: 'submitted' });
    expect(declineEnabled(sending)).toBe(false);
    expect(lockReducer(sending, { type: 'end', reason: 'declined' }).phase).toBe('locking');
  });

  it('ended and locked are final until a new request resets the card', () => {
    const ended = run({ type: 'policy', ok: true }, { type: 'end', reason: 'expired' });
    expect(lockReducer(ended, { type: 'confirmed' }).phase).toBe('ended');
    expect(lockReducer(ended, { type: 'reset' })).toEqual(initialLock);
  });
});
