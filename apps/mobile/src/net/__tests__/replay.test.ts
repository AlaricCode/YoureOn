// GET /v1/bets/:bet_id/replay through the real HTTP client (bearer, schema parse, error envelope),
// and where a phone loads a replay frame from.
import { replayPath, ReplayResponse } from '@youre-on/shared/replay';
import { describe, expect, it } from 'vitest';

import { FAKE_BET_ID, fakeClipMoment, fakeWinMoment } from '../../replay/fakes';
import { frameImageSource, getReplay } from '../replay';
import {
  ApiClientError,
  createApiClient,
  createClock,
  type FetchLike,
  type SessionRef,
} from '../signedFetch';

const TOKEN = `yo_s_${'r'.repeat(43)}`;
const SESSION: SessionRef = {
  token: TOKEN,
  session_id: '11111111-1111-4111-8111-111111111111',
  device_id: '22222222-2222-4222-8222-222222222222',
};
const OTHER_BET = '99999999-9999-4999-8999-999999999999';

/** The replay route as the server answers it: the party's bet, else 404 (no probing). */
function replayServer(body: unknown) {
  const calls: { method: string; path: string; auth: string | undefined }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method: init.method, path, auth: init.headers.Authorization });
    const json = (status: number, b: unknown) => ({
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(b),
    });
    if (init.headers.Authorization !== `Bearer ${TOKEN}`)
      return json(401, {
        error: { code: 'AUTH_REQUIRED', message: 'x', retryable: false, request_id: 'r1' },
      });
    if (init.method === 'GET' && path === replayPath(FAKE_BET_ID)) return json(200, body);
    return json(404, {
      error: { code: 'NOT_FOUND', message: 'not found', retryable: false, request_id: 'r2' },
    });
  };
  const client = createApiClient({
    baseUrl: 'http://api.test/',
    fetch,
    deviceKey: () => null,
    clock: createClock(() => 0),
    uuid: () => '33333333-3333-4333-8333-333333333333',
    appVersion: '1.0.0+test',
    session: () => SESSION,
  });
  return { client, calls };
}

describe('getReplay', () => {
  it('GETs the replay path with the bearer and parses a ready answer', async () => {
    const body = { replay: fakeWinMoment(), why: 'ready', final: true };
    const s = replayServer(body);
    const res = await getReplay(s.client, FAKE_BET_ID);
    expect(res).toEqual(ReplayResponse.parse(body));
    expect(s.calls).toEqual([
      { method: 'GET', path: `/v1/bets/${FAKE_BET_ID}/replay`, auth: `Bearer ${TOKEN}` },
    ]);
  });

  it('parses a not-ready answer', async () => {
    const s = replayServer({ replay: null, why: 'not_ruled', final: false });
    expect(await getReplay(s.client, FAKE_BET_ID)).toEqual({
      replay: null,
      why: 'not_ruled',
      final: false,
    });
  });

  it('a bet that is not yours surfaces as a NOT_FOUND error', async () => {
    const s = replayServer({ replay: null, why: 'not_ruled', final: false });
    const e = await getReplay(s.client, OTHER_BET).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiClientError);
    expect((e as ApiClientError).status).toBe(404);
    expect((e as ApiClientError).code).toBe('NOT_FOUND');
  });

  it('rejects a body that breaks the contract (why/replay mismatch)', async () => {
    const s = replayServer({ replay: null, why: 'ready', final: true });
    const e = await getReplay(s.client, FAKE_BET_ID).catch((x: unknown) => x);
    expect((e as ApiClientError).code).toBe('BAD_RESPONSE');
  });
});

describe('frameImageSource', () => {
  const f = fakeWinMoment().frames[0]!;

  it('uses the API base + path with the bearer when there is no signed url', () => {
    expect(frameImageSource('http://api.test/', TOKEN, f)).toEqual({
      uri: `http://api.test${f.path}`,
      headers: { Authorization: `Bearer ${TOKEN}` },
      cache: 'force-cache',
    });
  });

  it('prefers the signed url and sends no bearer with it', () => {
    const url = 'https://frames.example.invalid/f0.jpg?sig=1';
    const src = frameImageSource('http://api.test', TOKEN, { ...f, url });
    expect(src).toEqual({ uri: url, cache: 'force-cache' });
    expect(src.headers).toBeUndefined();
  });

  it('leaves the header off when signed out', () => {
    expect(frameImageSource('http://api.test', null, f).headers).toBeUndefined();
  });

  it('every fake path is a server-relative frame route', () => {
    for (const m of [fakeWinMoment(), fakeClipMoment()])
      for (const fr of m.frames)
        expect(fr.path).toMatch(/^\/v1\/bets\/[0-9a-f-]{36}\/attempts\/1\/frames\/\d+$/);
  });
});
