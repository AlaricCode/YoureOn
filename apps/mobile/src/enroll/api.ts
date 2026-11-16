// The face routes the enroll screens call (API-CONTRACT §2.2), behind an interface so the screens
// run before the server routes exist: `createPreviewFaceApi()` is an in-memory stand-in with the
// same shapes and error codes. The HTTP client lands with the session and request-signing layer
// (D0-M4); it implements this same interface.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import type { FaceConsent, FaceEnrollmentRequest } from './flow';
import { FACE_CONSENT_V1_RETENTION, FACE_CONSENT_V1_TEXT } from './consentText';

export type FaceStatus = 'none' | 'active' | 'disabled';

/** A failed face request with its API-CONTRACT §1.6 code. */
export class FaceApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FaceApiError';
  }
}

export interface FaceApi {
  /** `GET /v1/face/consent` */
  getConsent(): Promise<FaceConsent>;
  /** `GET /v1/me` → `face.status` */
  getStatus(): Promise<FaceStatus>;
  /** `POST /v1/face/enrollment` */
  enroll(req: FaceEnrollmentRequest): Promise<{ status: 'active'; enrolled_at: string }>;
  /** `PATCH /v1/face/enrollment` */
  setStatus(status: 'active' | 'disabled'): Promise<void>;
  /** `DELETE /v1/face/enrollment` (204 even when nothing was enrolled) */
  remove(): Promise<void>;
}

export const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/**
 * In-memory stand-in for the face routes, with the server's checks that matter to the screens:
 * the consent hash must match the text, the model must be the bundled one, and `plain-v0` is
 * accepted (FACE_SEAL_REQUIRED=false). `delayMs` simulates the network so "Checking…" shows.
 */
export function createPreviewFaceApi(opts: { delayMs?: number } = {}): FaceApi & {
  readonly enrolled: () => FaceEnrollmentRequest | null;
} {
  const delay = () => new Promise<void>((r) => setTimeout(r, opts.delayMs ?? 0));
  const consent: FaceConsent = {
    consent_version: 'face-consent-v1',
    text: FACE_CONSENT_V1_TEXT,
    text_sha256: sha256Hex(FACE_CONSENT_V1_TEXT),
    retention_summary: FACE_CONSENT_V1_RETENTION,
  };
  let status: FaceStatus = 'none';
  let last: FaceEnrollmentRequest | null = null;

  return {
    enrolled: () => last,
    async getConsent() {
      await delay();
      return consent;
    },
    async getStatus() {
      await delay();
      return status;
    },
    async enroll(req) {
      await delay();
      if (
        req.consent.consent_version !== consent.consent_version ||
        req.consent.consent_text_sha256 !== consent.text_sha256 ||
        Date.parse(req.consent.consent_at) > Date.now() + 60_000
      ) {
        throw new FaceApiError('FACE_CONSENT_REQUIRED');
      }
      if (req.model.name !== 'w600k_mbf' || req.model.dim !== 512) {
        throw new FaceApiError('FACE_MODEL_UNSUPPORTED');
      }
      if (req.embedding.alg !== 'plain-v0' && req.embedding.epk_b64 === null) {
        throw new FaceApiError('FACE_SEAL_INVALID');
      }
      last = req;
      status = 'active';
      return { status: 'active', enrolled_at: new Date().toISOString() };
    },
    async setStatus(next) {
      await delay();
      if (status === 'none') throw new FaceApiError('FACE_NOT_ENROLLED');
      status = next;
    },
    async remove() {
      await delay();
      last = null;
      status = 'none';
    },
  };
}
