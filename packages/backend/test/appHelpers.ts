import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Env } from '../src/config/load.js';
import { createContext, type AppContext } from '../src/context.js';
import { generateKeypair, type KeyPair } from '../src/crypto/keys.js';
import { loginMessage } from '../src/auth/service.js';
import { toBase64 } from '../src/util/bytes.js';
import { ManualClock } from '../src/util/clock.js';
import { testEnv } from './helpers.js';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  clock: ManualClock;
}

export async function makeApp(extra: Env = {}, clock = new ManualClock(1_760_000_000_000)): Promise<TestApp> {
  const config = loadConfig(testEnv(extra));
  const ctx = createContext(config, { clock, inMemory: true });
  const app = await buildApp(ctx, { startKeeper: false });
  await app.ready();
  return { app, ctx, clock };
}

export interface TestUser {
  token: string;
  wallet: KeyPair;
  user: { id: string; wallet: string; display_name: string };
}

/** Full §12.1 login: nonce → wallet signature → session. */
export async function login(app: FastifyInstance, email: string, wallet: KeyPair = generateKeypair()): Promise<TestUser> {
  const { nonce } = (await app.inject({ method: 'GET', url: '/v1/auth/nonce' })).json() as { nonce: string };
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/session',
    payload: {
      provider: 'google',
      credential: `mock:${email}`,
      wallet: wallet.publicKey,
      nonce,
      wallet_sig_b64: toBase64(wallet.sign(loginMessage(nonce))),
    },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const j = res.json() as { token: string; user: TestUser['user'] };
  return { token: j.token, wallet, user: j.user };
}

export const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
