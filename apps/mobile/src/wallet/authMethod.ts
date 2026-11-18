// How an authorization is gated and which method is recorded (SCHEMAS §12.3 O8, FINDINGS §7).
//
// `authenticateAsync` resolves only {success, error, warning}: it never says whether Face ID or the
// passcode succeeded. So:
//   1. First prompt with disableDeviceFallback: true (biometrics-only policy). Success -> 'faceid_hold'.
//   2. On 'user_fallback' (the user tapped "Use Passcode") or 'lockout', prompt again with the
//      passcode allowed. Success -> 'passcode_hold' ("the fallback prompt succeeded").
//      Also on 'not_enrolled' (no Face ID set up) and 'not_available' (Face ID off for this app:
//      the person tapped "Don't Allow" on the Face ID permission): without the second prompt such
//      a phone could never authorize, and D2 is "Face ID, then passcode" (O8: a Face ID problem
//      must not end Beat 3). This goes beyond O8's literal list; the method is still recorded.
//   3. Anything else (cancel, not enrolled, ...) fails without a second prompt.
// ESTIMATED behaviour: check it on a device (FINDINGS §6 step 8, TASKS D1-M2).
import type { LocalAuthenticationError, LocalAuthLike } from './platform';

/** Mirrors SCHEMAS `AuthorizationMethod` (packages/shared/src/authorization.ts). */
export type AuthorizationMethod = 'faceid_hold' | 'passcode_hold';

/** Errors from the Face-ID-only prompt that lead to the passcode prompt (O8). */
export const PASSCODE_RETRY_ERRORS: readonly LocalAuthenticationError[] = [
  'user_fallback',
  'lockout',
  'not_enrolled',
  'not_available',
];

export type AuthPrompt = {
  /** Shown next to the system sheet, e.g. "Lock in $5.00 vs Jake". The Face ID sheet itself may not show it. */
  promptMessage: string;
  cancelLabel?: string;
  /** The button that returns 'user_fallback' from the first prompt. Must not be '' (that hides it). */
  fallbackLabel?: string;
};

export const DEFAULT_CANCEL_LABEL = 'Not now';
export const DEFAULT_FALLBACK_LABEL = 'Use Passcode';

export type AuthStage = 'faceid' | 'passcode';

export type AuthOutcome =
  | { ok: true; method: AuthorizationMethod; prompts: 1 | 2 }
  | { ok: false; error: LocalAuthenticationError | 'exception'; stage: AuthStage; detail?: string };

export function normalizePrompt(prompt: string | AuthPrompt): Required<AuthPrompt> {
  const p = typeof prompt === 'string' ? { promptMessage: prompt } : prompt;
  const fallbackLabel =
    p.fallbackLabel === undefined || p.fallbackLabel === ''
      ? DEFAULT_FALLBACK_LABEL
      : p.fallbackLabel;
  return {
    promptMessage: p.promptMessage,
    cancelLabel: p.cancelLabel ?? DEFAULT_CANCEL_LABEL,
    fallbackLabel,
  };
}

async function attempt(
  localAuth: LocalAuthLike,
  prompt: Required<AuthPrompt>,
  disableDeviceFallback: boolean,
): Promise<
  { ok: true } | { ok: false; error: LocalAuthenticationError | 'exception'; detail?: string }
> {
  try {
    const result = await localAuth.authenticateAsync({
      promptMessage: prompt.promptMessage,
      cancelLabel: prompt.cancelLabel,
      fallbackLabel: prompt.fallbackLabel,
      disableDeviceFallback,
    });
    if (result.success) return { ok: true };
    return result.warning === undefined
      ? { ok: false, error: result.error }
      : { ok: false, error: result.error, detail: result.warning };
  } catch (e) {
    return { ok: false, error: 'exception', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Runs the one-or-two-prompt gate and returns the method to record. Never throws. */
export async function runAuthorizationGate(
  localAuth: LocalAuthLike,
  prompt: string | AuthPrompt,
): Promise<AuthOutcome> {
  const p = normalizePrompt(prompt);
  const first = await attempt(localAuth, p, true);
  if (first.ok) return { ok: true, method: 'faceid_hold', prompts: 1 };
  if (first.error === 'exception' || !PASSCODE_RETRY_ERRORS.includes(first.error)) {
    return first.detail === undefined
      ? { ok: false, error: first.error, stage: 'faceid' }
      : { ok: false, error: first.error, stage: 'faceid', detail: first.detail };
  }
  const second = await attempt(localAuth, p, false);
  if (second.ok) return { ok: true, method: 'passcode_hold', prompts: 2 };
  return second.detail === undefined
    ? { ok: false, error: second.error, stage: 'passcode' }
    : { ok: false, error: second.error, stage: 'passcode', detail: second.detail };
}
