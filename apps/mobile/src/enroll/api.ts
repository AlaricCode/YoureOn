// The face routes the enroll screens call (API-CONTRACT §2.2), behind an interface:
// `createPreviewFaceApi()` is an in-memory stand-in with the same shapes and error codes (the
// offline preview); `createServerFaceApi()` is the real one over the signed client.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  FACE_CONSENT_PATH,
  FACE_ENROLLMENT_PATH,
  FaceConsentResponse,
  FaceEnrollmentResponse,
  FaceEnrollmentStatusResponse,
} from '@youre-on/shared/face';

import type { FaceConsent, FaceEnrollmentRequest } from './flow';
import {
  FACE_CONSENT_V1_RETENTION,
  FACE_CONSENT_V1_TEXT,
  FACE_CONSENT_VERSION,
} from './consentText';

export type FaceStatus = 'none' | 'active' | 'disabled';

/** A failed face request with its API-CONTRACT §1.6 code (or NETWORK / BAD_RESPONSE). */
export class FaceApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FaceApiError';
  }
}

export interface FaceApi {
  /** `GET /v1/face/consent` */
  getConsent(): Promise<FaceConsent>;
  /** `GET /v1/face/enrollment` → `status` */
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
    consent_version: FACE_CONSENT_VERSION,
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

/** The subset of the signed client (../net/signedFetch) the face routes need. */
export interface FaceHttp {
  request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts?: { json?: unknown },
  ): Promise<unknown>;
}

interface Parser<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

/**
 * The real face routes (API-CONTRACT §2.2) over the signed client: GETs carry the bearer,
 * writes are signed. Same interface and error codes as the preview stand-in. The consent is
 * checked here: the text shown must hash to the `text_sha256` the enrollment echoes back, so
 * the phone never agrees to a text it did not show.
 */
export function createServerFaceApi(http: FaceHttp): FaceApi {
  const call = async (f: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await f();
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      throw new FaceApiError(typeof code === 'string' ? code : 'NETWORK');
    }
  };
  const parse = <T>(schema: Parser<T>, v: unknown): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw new FaceApiError('BAD_RESPONSE');
    return r.data;
  };
  return {
    async getConsent() {
      const c = parse(
        FaceConsentResponse,
        await call(() => http.request('GET', FACE_CONSENT_PATH)),
      );
      if (sha256Hex(c.text) !== c.text_sha256) throw new FaceApiError('BAD_RESPONSE');
      return {
        consent_version: c.consent_version,
        text: c.text,
        text_sha256: c.text_sha256,
        retention_summary: c.retention_summary,
      };
    },
    async getStatus() {
      const s = parse(
        FaceEnrollmentStatusResponse,
        await call(() => http.request('GET', FACE_ENROLLMENT_PATH)),
      );
      return s.status;
    },
    async enroll(req) {
      return parse(
        FaceEnrollmentResponse,
        await call(() => http.request('POST', FACE_ENROLLMENT_PATH, { json: req })),
      );
    },
    async setStatus(status) {
      await call(() => http.request('PATCH', FACE_ENROLLMENT_PATH, { json: { status } }));
    },
    async remove() {
      await call(() => http.request('DELETE', FACE_ENROLLMENT_PATH));
    },
  };
}
