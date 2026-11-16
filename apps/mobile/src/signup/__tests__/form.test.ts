import { describe, expect, it } from 'vitest';

import { checkCopy } from '../../ui/copyRule';
import { createPreviewSignupApi, SignupApiError } from '../api';
import { SIGNUP_COPY } from '../copy';
import {
  MAX_NAME_LENGTH,
  NAME_PROBLEM_LABEL,
  nameProblem,
  normalizeName,
  signupErrorLabel,
  signupFields,
} from '../form';

describe('name', () => {
  it('trims and collapses spaces', () => {
    expect(normalizeName('  Eva   S \n')).toBe('Eva S');
  });
  it('must be 1-32 characters after trimming', () => {
    expect(nameProblem('   ')).toBe('empty');
    expect(nameProblem('a'.repeat(MAX_NAME_LENGTH))).toBeNull();
    expect(nameProblem('a'.repeat(MAX_NAME_LENGTH + 1))).toBe('too_long');
  });
  it('counts characters, not UTF-16 units', () => {
    expect(nameProblem('\u{1D49C}'.repeat(MAX_NAME_LENGTH))).toBeNull();
  });
});

describe('signupFields', () => {
  it('matches the POST /v1/auth/signup user fields', () => {
    const at = new Date('2026-11-16T18:00:00Z');
    expect(signupFields(' Eva ', at)).toEqual({
      display_name: 'Eva',
      age_attestation: { is_18_plus: true, attested_at: '2026-11-16T18:00:00.000Z' },
    });
  });
  it('refuses an invalid name', () => {
    expect(() => signupFields('', new Date())).toThrow();
  });
});

describe('preview signup API', () => {
  it('signs up a valid user', async () => {
    const api = createPreviewSignupApi();
    const user = await api.signup(signupFields('Eva', new Date()));
    expect(user.display_name).toBe('Eva');
    expect(api.users()).toHaveLength(1);
  });
  it('refuses a signup without the 18+ attestation', async () => {
    const api = createPreviewSignupApi();
    const bad = {
      display_name: 'Eva',
      age_attestation: { is_18_plus: false, attested_at: '' },
    } as unknown as Parameters<typeof api.signup>[0];
    await expect(api.signup(bad)).rejects.toEqual(new SignupApiError('AGE_REQUIRED'));
    expect(signupErrorLabel('AGE_REQUIRED')).toBe('Must be 18+');
  });
});

describe('sign-up copy', () => {
  const body = new Set(['body']);
  it.each(Object.entries(SIGNUP_COPY))('%s follows the copy rule', (key, text) => {
    expect(
      checkCopy(text, body.has(key) ? 'body' : key === 'namePlaceholder' ? 'data' : 'label'),
    ).toEqual([]);
  });
  it.each([
    ...Object.values(NAME_PROBLEM_LABEL),
    ...['AGE_REQUIRED', 'VALIDATION_FAILED', 'RATE_LIMITED', 'X'].map(signupErrorLabel),
  ])('error "%s" follows the copy rule', (text) => {
    expect(checkCopy(text, 'error')).toEqual([]);
  });
});
