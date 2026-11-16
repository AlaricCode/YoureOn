// Sign-up form rules (TASKS D0-M4, API-CONTRACT §2.1): a display name of 1-32 characters and
// the 18+ attestation. Pure logic, so it is tested in node.

/** DATA-MODEL `users.display_name`: 1-32 chars; shown on the stage view. */
export const MAX_NAME_LENGTH = 32;

export type NameProblem = 'empty' | 'too_long';

/** Collapse runs of whitespace and trim, so "  Eva   S " is stored as "Eva S". */
export const normalizeName = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

/** Counts characters, not UTF-16 units, so an accented or non-Latin name is measured fairly. */
export function nameProblem(raw: string): NameProblem | null {
  const name = normalizeName(raw);
  if (name.length === 0) return 'empty';
  if ([...name].length > MAX_NAME_LENGTH) return 'too_long';
  return null;
}

export const NAME_PROBLEM_LABEL: Readonly<Record<NameProblem, string>> = {
  empty: 'Enter your name',
  too_long: 'Name too long',
};

export interface AgeAttestation {
  is_18_plus: true;
  attested_at: string;
}

/** The user-entered part of `POST /v1/auth/signup`; keys and signatures are added by D0-M4. */
export interface SignupFields {
  display_name: string;
  age_attestation: AgeAttestation;
}

export function signupFields(rawName: string, attestedAt: Date): SignupFields {
  const problem = nameProblem(rawName);
  if (problem) throw new Error(`invalid name: ${problem}`);
  return {
    display_name: normalizeName(rawName),
    age_attestation: { is_18_plus: true, attested_at: attestedAt.toISOString() },
  };
}

export function signupErrorLabel(code: string): string {
  switch (code) {
    case 'AGE_REQUIRED':
      return 'Must be 18+';
    case 'VALIDATION_FAILED':
      return 'Check your name';
    case 'RATE_LIMITED':
      return 'Try again later';
    default:
      return "Couldn't sign up";
  }
}
