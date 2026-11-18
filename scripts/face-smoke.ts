#!/usr/bin/env -S npx tsx
// Beat 1 server smoke: "challenge by face" over the real HTTP API with synthetic embeddings (no
// camera, no model, no images). Two fresh users (random device + wallet keys) sign up, share a
// room, B opts in with a synthetic 512-d embedding, A scans a probe close to it and gets B plus a
// match ticket, a stranger probe gets nothing, A challenges B by face (POST /v1/bets 'face'), B
// declines (cleanup), B deletes the face data and the same probe then finds nobody.
//
//   npm run face-smoke -- [--base-url http://127.0.0.1:8080]
//
// Touches no chain and no paid API. It leaves two signed-up test users and a closed-out
// (declined) bet behind, like cp1-drive does. Needs the face routes (migration 0006) deployed.
import { createHash, generateKeyPairSync, createPrivateKey, randomUUID, sign } from 'node:crypto';

import { getAddressDecoder } from '@solana/kit';

import {
  authChallengeMessage,
  requestSigningString,
  walletBindMessage,
  type Session,
} from '@youre-on/shared/api';
import { embeddingToBytes, FACE_MODEL_W600K, sha256HexOfText } from '@youre-on/shared/face';

import { parseCli, run } from './lib/cli';

const USAGE = `usage: npm run face-smoke -- [--base-url <url>]
Signs up two test users, enrolls a synthetic face for one, and checks face-match (match,
no match, after delete) and a 'face' challenge against a running server.`;

type Key = { d: string; x: string };
type Who = { name: string; device: Key; session: Session };

const sha256Hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { d: jwk.d!, x: jwk.x! };
}
const pubkeyOf = (k: Key) =>
  getAddressDecoder().decode(new Uint8Array(Buffer.from(k.x, 'base64url')));
function signWith(k: Key, msg: string): Uint8Array {
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: k.d, x: k.x },
    format: 'jwk',
  });
  return new Uint8Array(sign(null, Buffer.from(msg, 'utf8'), key));
}

/** A deterministic dense unit vector (xorshift), so the run is repeatable. */
function unitVector(seed: number): Float32Array {
  const v = new Float32Array(FACE_MODEL_W600K.dim);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < v.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    v[i] = (x >>> 0) / 0xffffffff - 0.5;
  }
  const n = Math.hypot(...v);
  return v.map((y) => y / n);
}
/** `cos * a + sqrt(1 - cos²) * (b made orthogonal to a)`: a unit vector at cosine `cos` to a. */
function near(a: Float32Array, b: Float32Array, cos: number): Float32Array {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  const o = b.map((y, i) => y - dot * a[i]!);
  const on = Math.hypot(...o);
  const s = Math.sqrt(1 - cos * cos);
  return a.map((y, i) => cos * y + (s * o[i]!) / on);
}
const sealed = (v: Float32Array) => ({
  alg: 'plain-v0',
  epk_b64: null,
  nonce_b64: null,
  ct_b64: b64(embeddingToBytes(v)),
});

class Api {
  constructor(readonly base: string) {}

  async call(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  signed(who: Who, method: string, path: string, body?: unknown) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Date.now());
    const idem = randomUUID();
    const str = requestSigningString({
      method,
      path_and_query: path,
      timestamp_ms: ts,
      idempotency_key: idem,
      session_id: who.session.session_id,
      body_sha256_hex: sha256Hex(raw),
    });
    return this.call(method, path, raw, {
      Authorization: `Bearer ${who.session.token}`,
      'X-YO-Device': who.session.device_id,
      'X-YO-Timestamp': ts,
      'Idempotency-Key': idem,
      'X-YO-Signature': Buffer.from(signWith(who.device, str)).toString('base64url'),
    });
  }

  get(who: Who, path: string) {
    return this.call('GET', path, undefined, { Authorization: `Bearer ${who.session.token}` });
  }
}

function must<T>(r: { status: number; json: T }, ok: number, what: string): T {
  if (r.status !== ok) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function signUp(api: Api, name: string): Promise<Who> {
  const device = newKey();
  const wallet = newKey();
  const devicePub = pubkeyOf(device);
  const walletPub = pubkeyOf(wallet);
  const ch = must(
    await api.call('POST', '/v1/auth/challenge', JSON.stringify({ device_pubkey: devicePub })),
    200,
    'challenge',
  );
  const body = {
    challenge_id: ch.challenge_id,
    display_name: name,
    age_attestation: { is_18_plus: true, attested_at: new Date().toISOString() },
    wallet_pubkey: walletPub,
    device_pubkey: devicePub,
    device_sig: b64(
      signWith(
        device,
        authChallengeMessage({
          purpose: 'signup',
          nonce: ch.nonce,
          device_pubkey: devicePub,
          wallet_pubkey: walletPub,
        }),
      ),
    ),
    wallet_sig: b64(
      signWith(
        wallet,
        walletBindMessage({ wallet_pubkey: walletPub, device_pubkey: devicePub, nonce: ch.nonce }),
      ),
    ),
    app_version: '0.1.0+1',
  };
  const s = must(await api.call('POST', '/v1/auth/signup', JSON.stringify(body)), 201, 'signup');
  return { name, device, session: s as Session };
}

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(what);
  console.log(`  ok  ${what}`);
}

run(async () => {
  const { values } = parseCli(USAGE, { 'base-url': { type: 'string' } });
  const base = (values['base-url'] ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
  const api = new Api(base);
  const tag = randomUUID().slice(0, 4);
  console.log(`face smoke against ${base}`);

  const A = await signUp(api, `Face A ${tag}`);
  const B = await signUp(api, `Face B ${tag}`);
  const room = must(await api.signed(A, 'POST', '/v1/rooms', { kind: 'session' }), 201, 'room');
  must(await api.signed(B, 'POST', '/v1/rooms/join', { code: room.code }), 200, 'join');
  console.log(`  room ${room.code}: ${A.name}, ${B.name}`);

  const consent = must(await api.get(B, '/v1/face/consent'), 200, 'consent');
  check(
    sha256HexOfText(consent.text) === consent.text_sha256,
    'consent text hashes to text_sha256',
  );

  const faceB = unitVector(0xb0b);
  const enrolled = must(
    await api.signed(B, 'POST', '/v1/face/enrollment', {
      consent: {
        consent_version: consent.consent_version,
        consent_text_sha256: consent.text_sha256,
        consent_at: new Date(Date.now() - 20_000).toISOString(),
      },
      liveness: { method: 'head_turn', passed_at: new Date(Date.now() - 1_000).toISOString() },
      model: FACE_MODEL_W600K,
      embedding: sealed(faceB),
      shots: 3,
    }),
    201,
    'enroll',
  );
  check(enrolled.status === 'active', `${B.name} enrolled (synthetic embedding)`);

  const scan = async (probe: Float32Array) => {
    const t0 = performance.now();
    const r = must(
      await api.signed(A, 'POST', `/v1/rooms/${room.room_id}/face-match`, {
        probe: sealed(probe),
        model: FACE_MODEL_W600K,
      }),
      200,
      'face-match',
    );
    return { match: r.match, ms: Math.round(performance.now() - t0) };
  };

  const hit = await scan(near(faceB, unitVector(0x5ca), 0.6));
  check(hit.match?.user?.user_id === B.session.user.user_id, `scan found ${B.name} (${hit.ms} ms)`);
  check(!JSON.stringify(hit).includes('score'), 'no score in the response');
  const stranger = await scan(unitVector(0x57a));
  check(stranger.match === null, `a stranger finds nobody (${stranger.ms} ms)`);

  const bet = must(
    await api.signed(A, 'POST', '/v1/bets', {
      room_id: room.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'face',
      match_ticket: hit.match.match_ticket,
    }),
    201,
    'face challenge',
  );
  check(bet.bet.state === 'DRAFTING', `face challenge created bet ${bet.bet.bet_id}`);
  const forged = await api.signed(A, 'POST', '/v1/bets', {
    room_id: room.room_id,
    opponent_user_id: B.session.user.user_id,
    challenge_method: 'face',
    match_ticket: `${hit.match.match_ticket}x`,
  });
  check(forged.status === 422, 'a tampered ticket is refused');
  must(
    await api.signed(B, 'POST', `/v1/bets/${bet.bet.bet_id}/invite/decline`),
    200,
    'decline (cleanup)',
  );

  must(await api.signed(B, 'DELETE', '/v1/face/enrollment'), 204, 'delete');
  const after = await scan(near(faceB, unitVector(0x5ca), 0.6));
  check(after.match === null, 'after delete, the same probe finds nobody');
  const status = must(await api.get(B, '/v1/face/enrollment'), 200, 'status');
  check(status.status === 'none', 'enrollment status is none');

  await api.signed(A, 'POST', `/v1/rooms/${room.room_id}/leave`);
  await api.signed(B, 'POST', `/v1/rooms/${room.room_id}/leave`);
  console.log('face smoke passed');
});
