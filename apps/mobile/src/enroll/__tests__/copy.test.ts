import { describe, expect, it } from 'vitest';

import { checkCopy, type CopyRole } from '../../ui/copyRule';
import { FACE_CONSENT_V1_RETENTION, FACE_CONSENT_V1_TEXT } from '../consentText';
import { ENROLL_COPY } from '../copy';
import { enrollErrorLabel, FURTHER_LABEL, PROMPT_LABEL, SERIES_PROBLEM_LABEL } from '../flow';

/** Sentences under a title; everything else is a 1-3 word label. */
const BODY = new Set<keyof typeof ENROLL_COPY>(['faceBody', 'savedBody', 'noneBody', 'deleteBody']);

const all: [string, CopyRole][] = [
  ...Object.entries(ENROLL_COPY).map(
    ([k, v]) =>
      [v, BODY.has(k as keyof typeof ENROLL_COPY) ? 'body' : 'label'] as [string, CopyRole],
  ),
  ...Object.values(PROMPT_LABEL).map((v) => [v, 'label'] as [string, CopyRole]),
  ...Object.values(FURTHER_LABEL).map((v) => [v, 'label'] as [string, CopyRole]),
  ...Object.values(SERIES_PROBLEM_LABEL).map((v) => [v, 'error'] as [string, CopyRole]),
  ...['FACE_CONSENT_REQUIRED', 'FACE_SEAL_INVALID', 'RATE_LIMITED', 'X'].map(
    (c) => [enrollErrorLabel(c), 'error'] as [string, CopyRole],
  ),
  ...['No face found', 'One face only', 'Move closer', 'Camera access needed', 'Try again'].map(
    (v) => [v, 'error'] as [string, CopyRole],
  ),
  ...['Allow camera access', 'Allow camera', 'Open settings', 'Checking', 'Capture'].map(
    (v) => [v, 'label'] as [string, CopyRole],
  ),
  [FACE_CONSENT_V1_TEXT, 'body'],
  [FACE_CONSENT_V1_RETENTION, 'body'],
];

describe('face enrollment copy', () => {
  it.each(all)('%s follows the copy rule', (text, role) => {
    expect(checkCopy(text, role)).toEqual([]);
  });
});
