import type { Session } from '@youre-on/shared/api';
import { describe, expect, it } from 'vitest';

import { resetOnUserSwitch } from '../userSwitch';

const sess = (user_id: string) => ({ user: { user_id } }) as unknown as Session;

describe('user switch', () => {
  it('a different user (demo claim) or sign-out clears ws subs and the bet hub; a re-login does not', () => {
    const listeners: ((s: Session | null) => void)[] = [];
    const calls: string[] = [];
    resetOnUserSwitch(
      { onChange: (l) => (listeners.push(l), () => undefined) },
      { ws: { reset: () => calls.push('ws') }, hub: { clear: () => calls.push('hub') } },
    );
    const emit = (s: Session | null) => listeners.forEach((l) => l(s));
    emit(sess('a')); // first sign-in: nothing to clear
    expect(calls).toEqual([]);
    emit(sess('a')); // silent re-login, same user
    expect(calls).toEqual([]);
    emit(sess('b')); // demo claim as another user
    expect(calls).toEqual(['ws', 'hub']);
    emit(null); // sign-out
    expect(calls).toEqual(['ws', 'hub', 'ws', 'hub']);
    emit(sess('b'));
    expect(calls).toHaveLength(4);
  });
});
