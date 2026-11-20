// Face ID with the passcode as fallback, recording which one succeeded (ARCHITECTURE §3.3):
// try Face ID alone first; if the person taps "Use Passcode", ask again with the
// passcode allowed and record `passcode_hold`. Signing itself is the wallet module (D0-M3,
// D2-M2); this only answers "did the owner approve".
import * as LocalAuthentication from 'expo-local-authentication';

import type { AuthorizationMethod } from '@youre-on/shared/authorization';

export type AuthorizeResult =
  | { ok: true; method: AuthorizationMethod }
  | { ok: false; reason: 'cancelled' | 'failed' | 'unavailable' };

export async function authorizeOwner(
  promptMessage: string,
  opts: { simulateIfUnavailable?: boolean } = {},
): Promise<AuthorizeResult> {
  const [hardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]).catch(() => [false, false]);
  if (!hardware || !enrolled) {
    if (!opts.simulateIfUnavailable) return { ok: false, reason: 'unavailable' };
    await new Promise<void>((r) => setTimeout(r, 500));
    return { ok: true, method: 'faceid_hold' };
  }

  const first = await LocalAuthentication.authenticateAsync({
    promptMessage,
    disableDeviceFallback: true,
    cancelLabel: 'Cancel',
    fallbackLabel: 'Use Passcode',
  });
  if (first.success) return { ok: true, method: 'faceid_hold' };
  if (first.error === 'user_fallback') {
    const second = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: false,
    });
    if (second.success) return { ok: true, method: 'passcode_hold' };
    return { ok: false, reason: second.error === 'user_cancel' ? 'cancelled' : 'failed' };
  }
  return { ok: false, reason: first.error === 'user_cancel' ? 'cancelled' : 'failed' };
}
