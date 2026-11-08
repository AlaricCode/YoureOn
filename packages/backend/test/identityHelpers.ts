/**
 * Helpers for the identity / huddle / drafts tests: fake JPEGs and WAVs,
 * full enrollment, tx submission, huddle setup.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Env } from '../src/config/load.js';
import { createContext, type ContextOptions } from '../src/context.js';
import { toBase64, fromBase64 } from '../src/util/bytes.js';
import { ManualClock } from '../src/util/clock.js';
import { encodeWav } from '../src/util/wav.js';
import { auth, login, type TestApp, type TestUser } from './appHelpers.js';
import { testEnv } from './helpers.js';

/** A byte string the liveness check accepts as a JPEG (SOI … EOI), unique per call. */
export function fakeJpeg(size = 256): Uint8Array {
  const b = new Uint8Array(randomBytes(size));
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
}

/** A 16 kHz PCM16 WAV of low noise, unique per call. */
export function fakeWav(ms = 1500): Uint8Array {
  const n = Math.round((ms * 16000) / 1000);
  const pcm = new Int16Array(n);
  const r = randomBytes(n);
  for (let i = 0; i < n; i++) pcm[i] = (r[i]! - 128) * 4;
  return encodeWav(pcm, 16000);
}

export const b64 = toBase64;

export async function makeAppWith(extra: Env = {}, opts: Omit<ContextOptions, 'clock' | 'inMemory'> = {}): Promise<TestApp> {
  const clock = new ManualClock(1_760_000_000_000);
  const config = loadConfig(testEnv(extra));
  const ctx = createContext(config, { clock, inMemory: true, ...opts });
  const app = await buildApp(ctx, { startKeeper: false });
  await app.ready();
  return { app, ctx, clock };
}

/** Signs and submits a §12.1 sign payload with the user's wallet. */
export async function submitSign(app: FastifyInstance, u: TestUser, sign: { tx_id: string; message_b64: string }): Promise<{ status: string; signature: string | null; error: unknown }> {
  const sig = u.wallet.sign(fromBase64(sign.message_b64));
  const r = await app.inject({ method: 'POST', url: `/v1/tx/${sign.tx_id}/submit`, headers: auth(u), payload: { signature_b64: toBase64(sig) } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

export async function post(app: FastifyInstance, u: TestUser, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { ...auth(u), ...headers }, payload: payload as Record<string, unknown> });
}

export async function get(app: FastifyInstance, u: TestUser, url: string) {
  return app.inject({ method: 'GET', url, headers: auth(u) });
}

/** Full enrollment (face + voice + complete + init_profile submitted). */
export async function enroll(app: FastifyInstance, u: TestUser, name: string, modalities: ('face' | 'voice')[] = ['face', 'voice']) {
  const ch = (await get(app, u, '/v1/enroll/challenge')).json();
  if (modalities.includes('face')) {
    const r = await post(app, u, '/v1/enroll/face', { challenge_id: ch.challenge_id, frames_b64: [fakeJpeg(), fakeJpeg(), fakeJpeg()].map(b64) });
    expect(r.statusCode, r.body).toBe(200);
  }
  if (modalities.includes('voice')) {
    const r = await post(app, u, '/v1/enroll/voice', { challenge_id: ch.challenge_id, clips_b64: [fakeWav(), fakeWav(), fakeWav()].map(b64) });
    expect(r.statusCode, r.body).toBe(200);
  }
  const c = await post(app, u, '/v1/enroll/complete', { consent: true, display_name: name });
  expect(c.statusCode, c.body).toBe(200);
  const body = c.json();
  const s = await submitSign(app, u, body.sign);
  expect(s.status).toBe('confirmed');
  return body as { face_commit: string; voice_commit: string };
}

export interface Crew {
  t: TestApp;
  users: TestUser[];
  huddleId: string;
  code: string;
}

/** Logs in + enrolls `names`, creates a huddle (names[0] creator), joins and confirms everyone by face scan. */
export async function crew(t: TestApp, names: string[], confirm = true): Promise<Crew> {
  const users: TestUser[] = [];
  for (const n of names) {
    const u = await login(t.app, `${n.toLowerCase()}@example.com`);
    await enroll(t.app, u, n);
    users.push(u);
  }
  const h = (await post(t.app, users[0]!, '/v1/huddles', {})).json();
  for (const u of users.slice(1)) {
    const r = await post(t.app, u, '/v1/huddles/join', { code: h.code });
    expect(r.statusCode, r.body).toBe(200);
  }
  if (confirm && users.length > 1) {
    const faces = users.slice(1).map((_, i) => ({ crop_b64: b64(fakeJpeg()), bbox: [i * 1000, 0, i * 1000 + 900, 900] }));
    const r = await post(t.app, users[0]!, `/v1/huddles/${h.huddle_id}/scan`, { faces });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().matches.every((m: { matched: boolean }) => m.matched)).toBe(true);
  }
  return { t, users, huddleId: h.huddle_id, code: h.code };
}
