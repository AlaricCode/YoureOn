/** Signed one-shot perception uploads (Nosana workers have no bearer token). */
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeypair } from '../src/crypto/keys.js';
import { MEDIA_URL_TTL_MS, perceptionResultSink } from '../src/lifecycle/mediaUrls.js';
import { makeApp, type TestApp } from './appHelpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

describe('POST /v1/media/perception/:bet/:nonce', () => {
  it('stores an upload only with a valid, unexpired signature', async () => {
    t = await makeApp();
    const sink = perceptionResultSink(t.ctx);
    const bet = generateKeypair().publicKey;
    const nonce = 'ab'.repeat(16);
    const url = sink.uploadUrl(bet, nonce);
    const path = url.slice(url.indexOf('/v1/'));
    const body = { model_hash: 'cd'.repeat(32), flags: 1, frame: { width_px: 640, height_px: 480 }, detections_jsonl: '{"t_ms":0}\n' };
    // No bearer token needed, but the signature must match this (bet, nonce).
    expect((await t.app.inject({ method: 'POST', url: path.replace(nonce, 'ef'.repeat(16)), payload: body })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: path, payload: { ...body, model_hash: 'nope' } })).statusCode).toBe(400);
    expect(sink.take(bet, nonce)).toBeNull();
    const ok = await t.app.inject({ method: 'POST', url: path, payload: body });
    expect(ok.statusCode).toBe(200);
    expect(sink.take(bet, nonce)).toEqual(body);
    t.clock.advance(MEDIA_URL_TTL_MS + 1);
    expect((await t.app.inject({ method: 'POST', url: path, payload: body })).statusCode).toBe(401);
  });
});
