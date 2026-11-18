// The sign-up call behind an interface. The real one (TASKS D0-M4, createServerSignupApi) asks
// the server for a challenge, signs it with the device key and the wallet key, and posts
// `POST /v1/auth/signup` through ../net/session. The preview runs on the in-memory stand-in,
// which applies the server's checks that the screen depends on.
import { MAX_NAME_LENGTH, type SignupFields } from './form';

/** The real sign-up over the session manager; server error codes reach the screen unchanged. */
export function createServerSignupApi(sessions: {
  signup(fields: SignupFields): Promise<{ user: { user_id: string; display_name: string } }>;
}): SignupApi {
  return {
    async signup(fields) {
      try {
        const s = await sessions.signup(fields);
        return { user_id: s.user.user_id, display_name: s.user.display_name };
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        throw new SignupApiError(typeof code === 'string' ? code : 'NETWORK');
      }
    },
  };
}

export class SignupApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SignupApiError';
  }
}

export interface SignedUpUser {
  user_id: string;
  display_name: string;
}

export interface SignupApi {
  signup(fields: SignupFields): Promise<SignedUpUser>;
}

export function createPreviewSignupApi(opts: { delayMs?: number } = {}): SignupApi & {
  readonly users: () => readonly SignedUpUser[];
} {
  const users: SignedUpUser[] = [];
  return {
    users: () => users,
    async signup(fields) {
      await new Promise<void>((r) => setTimeout(r, opts.delayMs ?? 0));
      if (fields.age_attestation?.is_18_plus !== true) throw new SignupApiError('AGE_REQUIRED');
      const n = [...fields.display_name].length;
      if (n < 1 || n > MAX_NAME_LENGTH) throw new SignupApiError('VALIDATION_FAILED');
      const user = { user_id: `preview-${users.length + 1}`, display_name: fields.display_name };
      users.push(user);
      return user;
    },
  };
}
