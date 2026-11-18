// An in-memory stand-in for the auth routes and one signed-write route, verifying requests with
// the SERVER's own crypto (apps/server/src/crypto.ts) and the shared signing-string builders,
// step for step as apps/server/src/auth/middleware.ts requireSignedRequest and auth/routes.ts do.
// If the phone's signing drifts from the server's verifier, these tests fail.
import { randomBytes, randomUUID } from 'node:crypto';

import {
  HDR,
  REQUEST_CLOCK_SKEW_MS,
  authChallengeMessage,
  requestSigningString,
  walletBindMessage,
} from '@youre-on/shared/api';

import {
  decodeBase64,
  decodeBase64Url,
  sha256Hex,
  verifyEd25519,
} from '../../../../server/src/crypto';
import type { FetchLike, FetchResponseLike } from '../signedFetch';

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

const res = (status: number, body: unknown): FetchResponseLike => ({
  status,
  headers: { get: () => null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});
const err = (status: number, code: string, details?: Record<string, unknown>) =>
  res(status, { error: { code, message: code, retryable: false, details, request_id: 'r1' } });

export function createFakeServer(o: {
  now: () => number;
  demoSeed?: Uint8Array;
  demoPubkey?: string;
}) {
  const challenges = new Map<string, { nonce: string; device: string }>();
  const devices = new Map<
    string,
    { user_id: string; device_id: string; wallet: string; name: string }
  >();
  const sessions = new Map<
    string,
    { session_id: string; device_id: string; device_pubkey: string; expired?: boolean }
  >();
  const seenIdem = new Map<string, string>();
  const calls: Call[] = [];
  let skewNext = false;
  let expireNext = false;

  const session = (
    u: { user_id: string; device_id: string; wallet: string; name: string },
    devicePubkey: string,
  ) => {
    const token = `yo_s_${randomBytes(32).toString('base64url')}`;
    const session_id = randomUUID();
    sessions.set(token, { session_id, device_id: u.device_id, device_pubkey: devicePubkey });
    return {
      token,
      session_id,
      user: { user_id: u.user_id, pubkey: u.wallet, display_name: u.name, avatar_url: null },
      device_id: u.device_id,
      expires_at: new Date(o.now() + 7 * 86400_000).toISOString(),
      server_time: new Date(o.now()).toISOString(),
    };
  };

  const consume = (id: string, device: string) => {
    const c = challenges.get(id);
    challenges.delete(id);
    return c && c.device === device ? c : null;
  };

  const fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method: init.method, path, headers: init.headers, body: init.body });
    const text =
      typeof init.body === 'string'
        ? init.body
        : init.body
          ? new TextDecoder().decode(init.body)
          : '';
    const json = (
      text && init.headers['Content-Type'] === 'application/json' ? JSON.parse(text) : {}
    ) as Record<string, string>;

    if (path === '/v1/auth/challenge') {
      const id = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      challenges.set(id, { nonce, device: json.device_pubkey as string });
      return res(200, {
        challenge_id: id,
        nonce,
        expires_at: new Date(o.now() + 60_000).toISOString(),
        server_time: new Date(o.now()).toISOString(),
      });
    }
    if (path === '/v1/auth/signup') {
      const c = consume(json.challenge_id as string, json.device_pubkey as string);
      if (!c) return err(401, 'CHALLENGE_EXPIRED');
      const msg = authChallengeMessage({
        purpose: 'signup',
        nonce: c.nonce,
        device_pubkey: json.device_pubkey!,
        wallet_pubkey: json.wallet_pubkey!,
      });
      const bind = walletBindMessage({
        wallet_pubkey: json.wallet_pubkey!,
        device_pubkey: json.device_pubkey!,
        nonce: c.nonce,
      });
      if (
        !verifyEd25519(json.device_pubkey!, msg, decodeBase64(json.device_sig!)) ||
        !verifyEd25519(json.wallet_pubkey!, bind, decodeBase64(json.wallet_sig!))
      )
        return err(401, 'SIGNATURE_INVALID');
      const u = {
        user_id: randomUUID(),
        device_id: randomUUID(),
        wallet: json.wallet_pubkey!,
        name: json.display_name!,
      };
      devices.set(json.device_pubkey!, u);
      return res(201, session(u, json.device_pubkey!));
    }
    if (path === '/v1/auth/session' && init.method === 'POST') {
      const c = consume(json.challenge_id as string, json.device_pubkey as string);
      if (!c) return err(401, 'CHALLENGE_EXPIRED');
      const msg = authChallengeMessage({
        purpose: 'login',
        nonce: c.nonce,
        device_pubkey: json.device_pubkey!,
        wallet_pubkey: null,
      });
      if (!verifyEd25519(json.device_pubkey!, msg, decodeBase64(json.device_sig!)))
        return err(401, 'SIGNATURE_INVALID');
      const u = devices.get(json.device_pubkey!);
      if (!u) return err(401, 'SIGNATURE_INVALID', { reason: 'unknown_device' });
      return res(200, session(u, json.device_pubkey!));
    }
    if (path === '/v1/auth/demo-claim') {
      const c = consume(json.challenge_id as string, json.device_pubkey as string);
      if (!c || !o.demoSeed || !o.demoPubkey) return err(404, 'NOT_FOUND');
      const msg = authChallengeMessage({
        purpose: 'demo-claim',
        nonce: c.nonce,
        device_pubkey: json.device_pubkey!,
        wallet_pubkey: null,
      });
      if (!verifyEd25519(json.device_pubkey!, msg, decodeBase64(json.device_sig!)))
        return err(401, 'SIGNATURE_INVALID');
      if (json.claim_token !== 'demo-a-token') return err(404, 'NOT_FOUND');
      const u = {
        user_id: randomUUID(),
        device_id: randomUUID(),
        wallet: o.demoPubkey,
        name: 'Logan',
      };
      devices.set(json.device_pubkey!, u);
      return res(200, {
        ...session(u, json.device_pubkey!),
        wallet_seed_b64: Buffer.from(o.demoSeed).toString('base64'),
      });
    }

    // ---- requireSignedRequest, as in apps/server/src/auth/middleware.ts ----
    const auth = init.headers[HDR.authorization]?.replace(/^Bearer /, '') ?? '';
    const s = sessions.get(auth);
    if (!s) return err(401, 'AUTH_REQUIRED');
    if (expireNext) {
      expireNext = false;
      sessions.delete(auth);
      return err(401, 'SESSION_EXPIRED');
    }
    if (init.method === 'GET') return res(200, { ok: true, path });
    const ts = init.headers[HDR.timestamp];
    const idem = init.headers[HDR.idempotencyKey];
    const sig = init.headers[HDR.signature];
    if (!idem || !/^[0-9a-f-]{36}$/.test(idem)) return err(422, 'VALIDATION_FAILED');
    if (init.headers[HDR.device] !== s.device_id || !ts || !/^\d{1,16}$/.test(ts) || !sig)
      return err(401, 'SIGNATURE_INVALID');
    if (skewNext || Math.abs(o.now() - Number(ts)) > REQUEST_CLOCK_SKEW_MS) {
      skewNext = false;
      return err(401, 'CLOCK_SKEW', { server_time: new Date(o.now()).toISOString() });
    }
    const raw =
      typeof init.body === 'string'
        ? new TextEncoder().encode(init.body)
        : (init.body ?? new Uint8Array(0));
    const signed = requestSigningString({
      method: init.method,
      path_and_query: path,
      timestamp_ms: ts,
      idempotency_key: idem,
      session_id: s.session_id,
      body_sha256_hex: sha256Hex(raw),
    });
    if (!verifyEd25519(s.device_pubkey, signed, decodeBase64Url(sig)))
      return err(401, 'SIGNATURE_INVALID');
    const fp = sha256Hex(`${init.method}\n${path}\n${sha256Hex(raw)}`);
    const prev = seenIdem.get(idem);
    if (prev && prev !== fp) return err(409, 'IDEMPOTENCY_KEY_REUSED');
    seenIdem.set(idem, fp);
    return res(201, { ok: true, path, body_sha256: sha256Hex(raw) });
  };

  return {
    fetch,
    calls,
    devices,
    skewOnce: () => (skewNext = true),
    expireOnce: () => (expireNext = true),
    /** A DB reseed: every token unknown (AUTH_REQUIRED); with devices too, logins are unknown_device. */
    reseed: (o2: { devices?: boolean } = {}) => {
      sessions.clear();
      if (o2.devices) devices.clear();
    },
  };
}
