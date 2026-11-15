// End-to-end smoke check against a running server (TASKS D0-L3 DoD helper):
//   npx tsx apps/server/scripts/smoke.ts http://localhost:8080
//   npx tsx apps/server/scripts/smoke.ts https://<app>.fly.dev      (PENDING: Fly)
// GET /health -> challenge -> signup (throwaway keys) -> login -> WS hello/welcome round trip.
// Each step logs its latency. Creates one throwaway user per run (fine on dev/demo DBs).
import { randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { getAddressDecoder } from '@solana/kit';
import WebSocket from 'ws';
import {
  authChallengeMessage,
  walletBindMessage,
  type AuthChallengeResponse,
  type Session,
} from '@youre-on/shared/api';

ed.hashes.sha512 = sha512;
const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
const wsUrl = base.replace(/^http/, 'ws') + '/v1/ws';

const key = () => {
  const secret = new Uint8Array(randomBytes(32));
  return { secret, pubkey: getAddressDecoder().decode(ed.getPublicKey(secret)) };
};
const sign = (secret: Uint8Array, msg: string) =>
  Buffer.from(ed.sign(new TextEncoder().encode(msg), secret)).toString('base64');

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  console.log(`ok  ${name}  ${(performance.now() - t0).toFixed(0)} ms`);
  return out;
}

async function post<T>(path: string, body: unknown, expect: number): Promise<T> {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as T;
  if (r.status !== expect) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function main() {
  await step('GET /health', async () => {
    const r = await fetch(base + '/health');
    if (r.status !== 200) throw new Error(`health ${r.status}`);
    return r.json();
  });
  const device = key();
  const wallet = key();
  const ch = await step('POST /v1/auth/challenge', () =>
    post<AuthChallengeResponse>('/v1/auth/challenge', { device_pubkey: device.pubkey }, 200),
  );
  const session = await step('POST /v1/auth/signup', () =>
    post<Session>(
      '/v1/auth/signup',
      {
        challenge_id: ch.challenge_id,
        display_name: 'Smoke',
        age_attestation: { is_18_plus: true, attested_at: new Date().toISOString() },
        wallet_pubkey: wallet.pubkey,
        device_pubkey: device.pubkey,
        device_sig: sign(
          device.secret,
          authChallengeMessage({
            purpose: 'signup',
            nonce: ch.nonce,
            device_pubkey: device.pubkey,
            wallet_pubkey: wallet.pubkey,
          }),
        ),
        wallet_sig: sign(
          wallet.secret,
          walletBindMessage({
            wallet_pubkey: wallet.pubkey,
            device_pubkey: device.pubkey,
            nonce: ch.nonce,
          }),
        ),
        app_version: 'smoke',
      },
      201,
    ),
  );
  const ch2 = await post<AuthChallengeResponse>(
    '/v1/auth/challenge',
    { device_pubkey: device.pubkey },
    200,
  );
  await step('POST /v1/auth/session (login)', () =>
    post<Session>(
      '/v1/auth/session',
      {
        challenge_id: ch2.challenge_id,
        device_pubkey: device.pubkey,
        device_sig: sign(
          device.secret,
          authChallengeMessage({
            purpose: 'login',
            nonce: ch2.nonce,
            device_pubkey: device.pubkey,
            wallet_pubkey: null,
          }),
        ),
      },
      200,
    ),
  );
  await step(
    'WS hello -> welcome round trip',
    () =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const t = setTimeout(() => reject(new Error('no welcome in 5 s')), 5000);
        ws.on('open', () =>
          ws.send(
            JSON.stringify({
              op: 'hello',
              token: session.token,
              device_id: session.device_id,
              subs: [],
            }),
          ),
        );
        ws.on('message', (d) => {
          const f = JSON.parse(String(d)) as { op?: string };
          if (f.op === 'welcome') {
            clearTimeout(t);
            console.log('    welcome', String(d));
            ws.close();
            resolve();
          }
        });
        ws.on('error', reject);
      }),
  );
  console.log('smoke: all green');
}

main().catch((err: unknown) => {
  console.error('smoke FAILED:', err);
  process.exit(1);
});
