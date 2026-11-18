import { describe, expect, it } from 'vitest';

import { camRetryAction } from '../retry';

describe('judge cam "Try again"', () => {
  it('armed + recorded clip -> resend that clip; armed + no clip -> retake', () => {
    expect(camRetryAction({ armed: true, hasClip: true })).toBe('resend');
    expect(camRetryAction({ armed: true, hasClip: false })).toBe('retake');
  });
  it('preview or the server moved on -> standby', () => {
    expect(camRetryAction({ armed: false, hasClip: true })).toBe('standby');
    expect(camRetryAction({ armed: false, hasClip: false })).toBe('standby');
  });
});
