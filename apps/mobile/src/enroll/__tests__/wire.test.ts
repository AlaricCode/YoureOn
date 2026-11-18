// The phone's face requests against the server's own schemas (packages/shared/src/face.ts,
// which apps/server/src/face/routes.ts parses strictly): a drift here is a 400 on the phone.
import { describe, expect, it } from 'vitest';

import {
  FACE_CONSENT_V1,
  FACE_CONSENT_V1_SHA256,
  FaceEnrollmentRequest,
  isAcceptedModel,
} from '@youre-on/shared/face';

import { FACE_MODEL } from '../../face/model';
import { createPreviewFaceApi, sha256Hex } from '../api';
import { FACE_CONSENT_V1_TEXT } from '../consentText';
import { buildEnrollmentRequest, plainEmbedding } from '../flow';

describe('face wire format (phone ↔ server)', () => {
  it('the consent the phone shows is the one the server serves, with the same hash', async () => {
    expect(FACE_CONSENT_V1_TEXT).toBe(FACE_CONSENT_V1.text);
    const consent = await createPreviewFaceApi().getConsent();
    expect(consent.text_sha256).toBe(FACE_CONSENT_V1_SHA256);
    expect(sha256Hex(consent.text)).toBe(FACE_CONSENT_V1_SHA256);
  });

  it('the enrollment request passes the server’s strict schema, with an accepted model', async () => {
    const consent = await createPreviewFaceApi().getConsent();
    const v = new Float32Array(FACE_MODEL.dim).fill(1 / Math.sqrt(FACE_MODEL.dim));
    const req = buildEnrollmentRequest({
      consent,
      consentAt: new Date('2026-11-18T05:00:00.000Z'),
      passedAt: new Date('2026-11-18T05:00:30.000Z'),
      embedding: plainEmbedding(v),
    });
    const parsed = FaceEnrollmentRequest.parse(req);
    expect(isAcceptedModel(parsed.model)).toBe(true);
    expect(parsed.consent.consent_text_sha256).toBe(FACE_CONSENT_V1_SHA256);
    expect(atob(parsed.embedding.ct_b64)).toHaveLength(FACE_MODEL.dim * 4);
  });
});
