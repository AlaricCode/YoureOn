import { describe, expect, it } from 'vitest';
import { FACE_CONSENT_V1_SHA256, FACE_CONSENT_V1_TEXT } from '@youre-on/shared/face';

import { createServerFaceApi, FaceApiError, type FaceHttp } from '../api';

const consent = {
  consent_version: 'face-consent-v1',
  text: FACE_CONSENT_V1_TEXT,
  text_sha256: FACE_CONSENT_V1_SHA256,
  retention_summary: 'Deleted after 180 days',
  face_seal_pubkey: null,
  accepted_models: [{ name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 }],
};

function fakeHttp(routes: Record<string, unknown | (() => unknown)>) {
  const calls: { method: string; path: string; json?: unknown }[] = [];
  const http: FaceHttp = {
    async request(method, path, opts) {
      calls.push({ method, path, ...(opts?.json !== undefined ? { json: opts.json } : {}) });
      const r = routes[`${method} ${path}`];
      if (typeof r === 'function') return (r as () => unknown)();
      return r;
    },
  };
  return { http, calls };
}

const fail = (code?: string) => () => {
  throw Object.assign(new Error('x'), code ? { code } : {});
};

describe('server face api', () => {
  it('reads the consent and checks that the text hashes to text_sha256', async () => {
    const ok = createServerFaceApi(fakeHttp({ 'GET /v1/face/consent': consent }).http);
    expect(await ok.getConsent()).toEqual({
      consent_version: 'face-consent-v1',
      text: FACE_CONSENT_V1_TEXT,
      text_sha256: FACE_CONSENT_V1_SHA256,
      retention_summary: 'Deleted after 180 days',
    });
    const tampered = createServerFaceApi(
      fakeHttp({ 'GET /v1/face/consent': { ...consent, text: `${FACE_CONSENT_V1_TEXT}!` } }).http,
    );
    await expect(tampered.getConsent()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    const junk = createServerFaceApi(fakeHttp({ 'GET /v1/face/consent': { nope: 1 } }).http);
    await expect(junk.getConsent()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('status comes from GET /v1/face/enrollment', async () => {
    const api = createServerFaceApi(
      fakeHttp({
        'GET /v1/face/enrollment': {
          status: 'disabled',
          consent_version: 'face-consent-v1',
          model: { name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 },
          enrolled_at: '2026-11-18T10:00:00.000Z',
          disabled_at: '2026-11-18T11:00:00.000Z',
        },
      }).http,
    );
    expect(await api.getStatus()).toBe('disabled');
  });

  it('writes go to the enrollment route; error codes pass through, unknowns are NETWORK', async () => {
    const f = fakeHttp({
      'POST /v1/face/enrollment': { status: 'active', enrolled_at: '2026-11-18T10:00:00.000Z' },
      'PATCH /v1/face/enrollment': fail('FACE_NOT_ENROLLED'),
      'DELETE /v1/face/enrollment': fail(),
    });
    const api = createServerFaceApi(f.http);
    const req = { shots: 3 } as never;
    expect(await api.enroll(req)).toEqual({
      status: 'active',
      enrolled_at: '2026-11-18T10:00:00.000Z',
    });
    await expect(api.setStatus('disabled')).rejects.toEqual(new FaceApiError('FACE_NOT_ENROLLED'));
    await expect(api.remove()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(f.calls).toEqual([
      { method: 'POST', path: '/v1/face/enrollment', json: req },
      { method: 'PATCH', path: '/v1/face/enrollment', json: { status: 'disabled' } },
      { method: 'DELETE', path: '/v1/face/enrollment' },
    ]);
  });
});
