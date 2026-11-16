// The sign-up call behind an interface. The real one (TASKS D0-M4) asks the server for a
// challenge, signs it with the device key and the wallet key, and posts `POST /v1/auth/signup`;
// that needs the session client, which is not built yet. Until then the screen runs on the
// in-memory stand-in below, which applies the server's checks that the screen depends on.
import { MAX_NAME_LENGTH, type SignupFields } from './form';

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
