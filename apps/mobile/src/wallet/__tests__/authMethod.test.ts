import { describe, expect, it } from 'vitest';

import { runAuthorizationGate } from '../authMethod';
import type {
  LocalAuthenticationOptions,
  LocalAuthenticationResult,
  LocalAuthLike,
} from '../platform';

function scriptedAuth(results: (LocalAuthenticationResult | Error)[]) {
  const calls: (LocalAuthenticationOptions | undefined)[] = [];
  const auth: LocalAuthLike = {
    async authenticateAsync(options) {
      calls.push(options);
      const next = results.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('unexpected extra prompt');
      return next;
    },
  };
  return { auth, calls };
}

const PROMPT = 'Lock in $5.00 vs Jake';

describe('runAuthorizationGate (SCHEMAS O8)', () => {
  it('Face ID success on the first, biometrics-only prompt records faceid_hold', async () => {
    const { auth, calls } = scriptedAuth([{ success: true }]);
    await expect(runAuthorizationGate(auth, PROMPT)).resolves.toEqual({
      ok: true,
      method: 'faceid_hold',
      prompts: 1,
    });
    expect(calls).toEqual([
      {
        promptMessage: PROMPT,
        cancelLabel: 'Not now',
        fallbackLabel: 'Use Passcode',
        disableDeviceFallback: true,
      },
    ]);
  });

  it('user_fallback re-prompts with the passcode allowed and records passcode_hold', async () => {
    const { auth, calls } = scriptedAuth([
      { success: false, error: 'user_fallback' },
      { success: true },
    ]);
    await expect(runAuthorizationGate(auth, PROMPT)).resolves.toEqual({
      ok: true,
      method: 'passcode_hold',
      prompts: 2,
    });
    expect(calls.map((c) => c?.disableDeviceFallback)).toEqual([true, false]);
    expect(calls[1]?.promptMessage).toBe(PROMPT);
  });

  it('lockout also re-prompts with the passcode (O8)', async () => {
    const { auth, calls } = scriptedAuth([{ success: false, error: 'lockout' }, { success: true }]);
    await expect(runAuthorizationGate(auth, PROMPT)).resolves.toMatchObject({
      ok: true,
      method: 'passcode_hold',
    });
    expect(calls).toHaveLength(2);
  });

  it.each([
    'user_cancel',
    'system_cancel',
    'not_enrolled',
    'authentication_failed',
    'not_available',
  ] as const)('%s fails with no second prompt', async (error) => {
    const { auth, calls } = scriptedAuth([{ success: false, error }]);
    await expect(runAuthorizationGate(auth, PROMPT)).resolves.toEqual({
      ok: false,
      error,
      stage: 'faceid',
    });
    expect(calls).toHaveLength(1);
  });

  it('a failed passcode prompt fails at the passcode stage', async () => {
    const { auth } = scriptedAuth([
      { success: false, error: 'user_fallback' },
      { success: false, error: 'user_cancel', warning: 'w' },
    ]);
    await expect(runAuthorizationGate(auth, PROMPT)).resolves.toEqual({
      ok: false,
      error: 'user_cancel',
      stage: 'passcode',
      detail: 'w',
    });
  });

  it('a thrown native error is reported, not rethrown', async () => {
    const { auth } = scriptedAuth([new Error('boom')]);
    await expect(runAuthorizationGate(auth, PROMPT)).resolves.toEqual({
      ok: false,
      error: 'exception',
      stage: 'faceid',
      detail: 'boom',
    });
  });

  it('never passes an empty fallbackLabel (that would hide the fallback button)', async () => {
    const { auth, calls } = scriptedAuth([{ success: true }]);
    await runAuthorizationGate(auth, {
      promptMessage: PROMPT,
      fallbackLabel: '',
      cancelLabel: 'Cancel',
    });
    expect(calls[0]).toMatchObject({ fallbackLabel: 'Use Passcode', cancelLabel: 'Cancel' });
  });
});
