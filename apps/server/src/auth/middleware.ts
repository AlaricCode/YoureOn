// Auth middleware for route modules (API-CONTRACT §1.3, §1.6).
//   requireSession       — any valid bearer (app or stage scope)          -> c.get('auth')
//   requireAppSession    — bearer of a phone session (scope 'app')         -> c.get('auth') as AppAuthContext
//   requireSignedRequest — requireAppSession + X-YO-* request signature + Idempotency-Key replay
// Use requireSignedRequest on every POST/PUT/PATCH/DELETE outside /v1/auth/* ("S" routes).
import type { Context, MiddlewareHandler } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { HDR, REQUEST_CLOCK_SKEW_MS, requestSigningString } from '@youre-on/shared/api';
import { Uuid } from '@youre-on/shared/primitives';
import { decodeBase64Url, sha256Hex, verifyEd25519 } from '../crypto';
import { HttpError } from '../errors';
import { BUCKETS } from '../http/rate-limit';
import type { AppAuthContext, AppEnv, AuthContext } from '../context';
import { bearerToken, resolveSession } from './sessions';

async function authenticate(c: Context<AppEnv>): Promise<AuthContext> {
  const token = bearerToken(c.req.header(HDR.authorization));
  if (!token) throw new HttpError('AUTH_REQUIRED');
  const deps = c.get('deps');
  const auth = await resolveSession(deps.db, token, deps.now());
  // §1.7 "everything else": 120/min per session. Route-specific buckets are taken on top.
  deps.rateLimit?.take('session', auth.session_id, BUCKETS.default);
  return auth;
}

function asApp(auth: AuthContext): AppAuthContext {
  if (!auth.scopes.includes('app') || !auth.user_id || !auth.device_id || !auth.device_pubkey) {
    throw new HttpError('AUTH_REQUIRED', 'This endpoint needs a signed-in phone.');
  }
  return auth as AppAuthContext;
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('auth', await authenticate(c));
  await next();
};

export const requireAppSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('auth', asApp(await authenticate(c)));
  await next();
};

/** Typed accessor for handlers behind requireAppSession / requireSignedRequest. */
export const appAuth = (c: Context<AppEnv>): AppAuthContext => asApp(c.get('auth'));

/** The request target exactly as sent (raw Node `incoming.url`), falling back to the parsed URL. */
function pathAndQuery(c: Context<AppEnv>): string {
  const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming;
  if (incoming?.url) return incoming.url;
  const u = new URL(c.req.url);
  return u.pathname + u.search;
}

export const requireSignedRequest: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get('deps');
  const auth = asApp(await authenticate(c));
  c.set('auth', auth);

  const device = c.req.header(HDR.device);
  const ts = c.req.header(HDR.timestamp);
  const idem = c.req.header(HDR.idempotencyKey);
  const sigHdr = c.req.header(HDR.signature);
  if (!idem || !Uuid.safeParse(idem).success) {
    throw new HttpError('VALIDATION_FAILED', 'Idempotency-Key must be a UUIDv4.', {
      issues: [{ path: HDR.idempotencyKey, message: 'UUIDv4 required' }],
    });
  }
  if (device !== auth.device_id || !ts || !/^\d{1,16}$/.test(ts) || !sigHdr) {
    throw new HttpError('SIGNATURE_INVALID');
  }
  const now = deps.now();
  if (Math.abs(now - Number(ts)) > REQUEST_CLOCK_SKEW_MS) {
    throw new HttpError('CLOCK_SKEW', undefined, { server_time: new Date(now).toISOString() });
  }

  const raw = new Uint8Array(await c.req.arrayBuffer());
  const bodySha = sha256Hex(raw);
  const target = pathAndQuery(c);
  const signed = requestSigningString({
    method: c.req.method,
    path_and_query: target,
    timestamp_ms: ts,
    idempotency_key: idem,
    session_id: auth.session_id,
    body_sha256_hex: bodySha,
  });
  if (!verifyEd25519(auth.device_pubkey, signed, decodeBase64Url(sigHdr))) {
    throw new HttpError('SIGNATURE_INVALID');
  }

  // The stored fingerprint covers method + target + body: many S routes have an empty body
  // (invite/accept, lock/decline, …), so a key reused across two of them must be
  // IDEMPOTENCY_KEY_REUSED, never a replay of the other route's response.
  const fingerprint = sha256Hex(`${c.req.method.toUpperCase()}\n${target}\n${bodySha}`);
  const look = deps.idempotency.begin(auth.device_id, idem, fingerprint);
  if (look.kind === 'mismatch') throw new HttpError('IDEMPOTENCY_KEY_REUSED');
  if (look.kind === 'in_flight') {
    throw new HttpError('INVALID_STATE', 'That request is still being processed.', {
      reason: 'in_flight',
    });
  }
  if (look.kind === 'replay') {
    const headers: Record<string, string> = { [HDR.idempotentReplayed]: 'true' };
    if (look.response.contentType) headers['Content-Type'] = look.response.contentType;
    c.res = new Response(look.response.body || null, { status: look.response.status, headers });
    return;
  }

  try {
    await next();
  } catch (err) {
    deps.idempotency.release(auth.device_id, idem);
    throw err;
  }
  // 5xx and 429 mean "not processed": a retry with the same key must run again, not
  // replay the failure for 24 h.
  if (c.res.status >= 500 || c.res.status === 429) {
    deps.idempotency.release(auth.device_id, idem);
    return;
  }
  const body = await c.res.clone().text();
  deps.idempotency.complete(auth.device_id, idem, {
    status: c.res.status,
    body,
    contentType: c.res.headers.get('Content-Type'),
  });
};
