/* eslint-disable @typescript-eslint/no-explicit-any -- test helper: WS frames and JSON bodies are loosely typed on purpose */
// Test helpers: device/wallet keys, the phone side of the auth flow, a running server.
import { randomBytes, randomUUID } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { getAddressDecoder } from '@solana/kit';
import WebSocket from 'ws';
import { describe } from 'vitest';
import {
  authChallengeMessage,
  requestSigningString,
  walletBindMessage,
  type AuthChallengeResponse,
  type Session,
} from '@youre-on/shared/api';
import { sql } from 'drizzle-orm';
import { createDb, runMigrations, type DbHandle } from '@youre-on/db';
import { loadEnv, type Env } from '../src/env';
import { createDeps, startServer, type RunningServer } from '../src/server';
import type { AppDeps, RouteModule } from '../src/context';
import { routeModules } from '../src/routes';
import type { MarketService } from '../src/markets/service';
import { sha256Hex } from '../src/crypto';

export const DB_URL = process.env.DATABASE_URL;

/**
 * A database of our own next to DATABASE_URL's (`<db>_<suffix>`), created and migrated on first
 * use: for suites that own global tables (nonce_pool, gemini_markets) while vitest runs files in
 * parallel.
 */
export async function ownDatabase(url: string, suffix: string): Promise<string> {
  const u = new URL(url);
  const name = `${u.pathname.replace(/^\//, '')}_${suffix}`;
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`unsupported database name ${name}`);
  const admin = createDb({ url, max: 1 });
  try {
    const found = await admin.db.execute(
      sql`SELECT 1 AS ok FROM pg_database WHERE datname = ${name}`,
    );
    if (found.length === 0) {
      try {
        await admin.db.execute(sql.raw(`CREATE DATABASE ${name}`));
      } catch (e) {
        const code =
          (e as { code?: string; cause?: { code?: string } }).code ??
          (e as { cause?: { code?: string } }).cause?.code;
        if (code !== '42P04') throw e; // duplicate_database: a concurrent run made it
      }
    }
  } finally {
    await admin.close();
  }
  u.pathname = `/${name}`;
  await runMigrations(u.toString());
  return u.toString();
}
/** describe() that skips (with a reason in the name) when no DATABASE_URL is set. */
export const describeDb = (name: string, fn: () => void) =>
  DB_URL ? describe(name, fn) : describe.skip(`${name} [SKIPPED: DATABASE_URL unset]`, fn);

export function testEnv(over: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL ?? 'postgres://unused@127.0.0.1:1/none',
    ...over,
  });
}

const b58 = getAddressDecoder();

export interface TestKey {
  secret: Uint8Array;
  pubkey: string;
  sign(msg: string): Uint8Array;
}

export function newKey(): TestKey {
  const secret = new Uint8Array(randomBytes(32));
  const pub = ed.getPublicKey(secret);
  return {
    secret,
    pubkey: b58.decode(pub),
    sign: (msg) => ed.sign(new TextEncoder().encode(msg), secret),
  };
}

export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
export const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

export interface Ctx {
  deps: AppDeps;
  dbHandle: DbHandle;
  server: RunningServer;
  base: string;
  wsUrl: string;
}

export async function startTestServer(
  opts: {
    modules?: RouteModule[];
    now?: () => number;
    heartbeatMs?: number;
    helloTimeoutMs?: number;
    env?: Record<string, string>;
    /** The Gemini relay (e.g. over a fake fetch); default off under NODE_ENV=test. */
    markets?: MarketService;
  } = {},
): Promise<Ctx> {
  const env = testEnv(opts.env);
  const dbHandle = createDb({ url: env.DATABASE_URL, max: 4 });
  const { deps } = createDeps({
    env,
    dbHandle,
    rateLimit: false,
    now: opts.now,
    heartbeatMs: opts.heartbeatMs,
    helloTimeoutMs: opts.helloTimeoutMs,
    ...(opts.markets ? { markets: opts.markets } : {}),
  });
  const server = await startServer(deps, {
    port: 0,
    hostname: '127.0.0.1',
    modules: opts.modules ?? routeModules,
    onClose: () => dbHandle.close(),
  });
  return {
    deps,
    dbHandle,
    server,
    base: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/v1/ws`,
  };
}

export async function postJson(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { res, status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
}

export async function getChallenge(base: string, device: TestKey): Promise<AuthChallengeResponse> {
  const r = await postJson(base, '/v1/auth/challenge', { device_pubkey: device.pubkey });
  if (r.status !== 200) throw new Error(`challenge ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as AuthChallengeResponse;
}

export function signupBody(
  ch: AuthChallengeResponse,
  device: TestKey,
  wallet: TestKey,
  over: Record<string, unknown> = {},
) {
  return {
    challenge_id: ch.challenge_id,
    display_name: 'Jake',
    age_attestation: { is_18_plus: true, attested_at: new Date().toISOString() },
    wallet_pubkey: wallet.pubkey,
    device_pubkey: device.pubkey,
    device_sig: b64(
      device.sign(
        authChallengeMessage({
          purpose: 'signup',
          nonce: ch.nonce,
          device_pubkey: device.pubkey,
          wallet_pubkey: wallet.pubkey,
        }),
      ),
    ),
    wallet_sig: b64(
      wallet.sign(
        walletBindMessage({
          wallet_pubkey: wallet.pubkey,
          device_pubkey: device.pubkey,
          nonce: ch.nonce,
        }),
      ),
    ),
    app_version: '0.1.0+1',
    ...over,
  };
}

export function loginBody(ch: AuthChallengeResponse, device: TestKey, signer: TestKey = device) {
  return {
    challenge_id: ch.challenge_id,
    device_pubkey: device.pubkey,
    device_sig: b64(
      signer.sign(
        authChallengeMessage({
          purpose: 'login',
          nonce: ch.nonce,
          device_pubkey: device.pubkey,
          wallet_pubkey: null,
        }),
      ),
    ),
  };
}

export interface SignedUp {
  device: TestKey;
  wallet: TestKey;
  session: Session;
}

export async function signUp(base: string, name = 'Jake'): Promise<SignedUp> {
  const device = newKey();
  const wallet = newKey();
  const ch = await getChallenge(base, device);
  const r = await postJson(
    base,
    '/v1/auth/signup',
    signupBody(ch, device, wallet, { display_name: name }),
  );
  if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.json)}`);
  return { device, wallet, session: r.json as unknown as Session };
}

/** The phone side of §1.3 request signing. */
export function signedHeaders(
  u: SignedUp,
  method: string,
  pathAndQuery: string,
  body: string,
  over: { ts?: number; idem?: string; signer?: TestKey } = {},
): Record<string, string> {
  const ts = String(over.ts ?? Date.now());
  const idem = over.idem ?? randomUUID();
  const str = requestSigningString({
    method,
    path_and_query: pathAndQuery,
    timestamp_ms: ts,
    idempotency_key: idem,
    session_id: u.session.session_id,
    body_sha256_hex: sha256Hex(body),
  });
  return {
    Authorization: `Bearer ${u.session.token}`,
    'X-YO-Device': u.session.device_id,
    'X-YO-Timestamp': ts,
    'Idempotency-Key': idem,
    'X-YO-Signature': b64url((over.signer ?? u.device).sign(str)),
    'Content-Type': 'application/json',
  };
}

// ---- WebSocket client ----------------------------------------------------------------

export interface WsClient {
  ws: WebSocket;
  frames: any[];
  send(frame: unknown): void;
  /** Resolves with the first frame (from the start of the connection) matching `pred` not yet consumed. */
  next(pred: (f: any) => boolean, timeoutMs?: number): Promise<any>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

export function connectWs(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: any[] = [];
    const consumed = new Set<number>();
    const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
    let closeResolve!: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((r) => (closeResolve = r));
    ws.on('message', (data) => {
      const f = JSON.parse(String(data));
      const idx = frames.push(f) - 1;
      const w = waiters.findIndex((x) => x.pred(f));
      if (w >= 0) {
        consumed.add(idx);
        waiters.splice(w, 1)[0]!.resolve(f);
      }
    });
    ws.on('close', (code, reason) => closeResolve({ code, reason: String(reason) }));
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        closed,
        send: (f) => ws.send(JSON.stringify(f)),
        close: () => ws.close(),
        next(pred, timeoutMs = 3000) {
          const i = frames.findIndex((f, k) => !consumed.has(k) && pred(f));
          if (i >= 0) {
            consumed.add(i);
            return Promise.resolve(frames[i]);
          }
          return new Promise((res, rej) => {
            const t = setTimeout(
              () =>
                rej(
                  new Error(
                    `ws: no matching frame in ${timeoutMs} ms; got ${JSON.stringify(frames)}`,
                  ),
                ),
              timeoutMs,
            );
            waiters.push({
              pred,
              resolve: (f) => {
                clearTimeout(t);
                res(f);
              },
            });
          });
        },
      }),
    );
  });
}
