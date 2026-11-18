// The HTTP client (API-CONTRACT §1.3, §1.5, §1.6). Every POST/PUT/PATCH/DELETE outside
// /v1/auth/* is a signed write: bearer token + X-YO-Device + X-YO-Timestamp (device clock
// corrected by the server_time offset) + Idempotency-Key (UUIDv4, also the nonce) +
// X-YO-Signature = base64url(ed25519_device(requestSigningString(...))). GETs carry the bearer
// only. The signing string comes from packages/shared (requestSigningString), the same builder
// the server's requireSignedRequest verifies with.
//
// Retries (each at most once, with the SAME Idempotency-Key, so a write is never duplicated):
//   401 CLOCK_SKEW      -> re-sync the clock from details.server_time, re-sign, resend.
//   401 SESSION_EXPIRED -> silent re-login with the device key (no prompt), re-sign, resend.
//   401 AUTH_REQUIRED   -> the same (the server forgot the token: DB reseed, revoked session).
//   A refresh that finds the device unknown signs out (session.ts), so the app goes to signup.
// Pure TS (fetch, clock, keys injected): tested in node.
import { bytesToHex } from '@noble/hashes/utils.js';
import { ApiError, HDR, requestSigningString } from '@youre-on/shared/api';
import { SCHEMA_VERSION } from '@youre-on/shared/constants';
import type { z } from 'zod/v4';

import { utf8 } from '../wallet/bytes';
import { sha256 } from '../wallet/noble';
import type { DeviceKey } from './deviceKey';
import { bytesToBase64Url } from './encoding';

export interface SessionRef {
  token: string;
  session_id: string;
  device_id: string;
}

/** A failed call: the §1.5 code, or NETWORK / BAD_RESPONSE from this client. */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> | undefined = undefined,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** Device clock corrected by the server's clock (§1.3 "device clock corrected by server_time"). */
export interface Clock {
  now(): number;
  /** Re-sync from a server timestamp received at local time `localNow` (default: now). */
  sync(serverTimeIso: string, localNow?: number): void;
  readonly offsetMs: number;
}

export function createClock(localNow: () => number = Date.now): Clock {
  let offset = 0;
  return {
    now: () => localNow() + offset,
    sync(iso, at = localNow()) {
      const t = Date.parse(iso);
      if (Number.isFinite(t)) offset = t - at;
    },
    get offsetMs() {
      return offset;
    },
  };
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
) => Promise<FetchResponseLike>;

export const sha256HexOf = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

/** The five §1.3 headers for one signed write. */
export function signedHeaders(a: {
  method: string;
  pathAndQuery: string;
  body: Uint8Array;
  session: SessionRef;
  key: DeviceKey;
  timestampMs: number;
  idempotencyKey: string;
}): Record<string, string> {
  const ts = String(Math.floor(a.timestampMs));
  const signing = requestSigningString({
    method: a.method,
    path_and_query: a.pathAndQuery,
    timestamp_ms: ts,
    idempotency_key: a.idempotencyKey,
    session_id: a.session.session_id,
    body_sha256_hex: sha256HexOf(a.body),
  });
  return {
    [HDR.authorization]: `Bearer ${a.session.token}`,
    [HDR.device]: a.session.device_id,
    [HDR.timestamp]: ts,
    [HDR.idempotencyKey]: a.idempotencyKey,
    [HDR.signature]: bytesToBase64Url(a.key.sign(utf8(signing))),
  };
}

export type AuthMode = 'none' | 'bearer' | 'signed';

export interface RequestOptions<S extends z.ZodType | undefined = undefined> {
  auth?: AuthMode;
  /** JSON body (sent as its UTF-8 string, which is exactly the signed bytes). */
  json?: unknown;
  /** A pre-built body (multipart): signed and sent byte-for-byte. */
  raw?: { bytes: Uint8Array; contentType: string };
  /** Response schema; the parsed value is returned. */
  schema?: S;
  /** Pin the key to resend the same write after a lost response (§1.6 "never re-sign on retry" is about wallet signatures; the request key repeats too). */
  idempotencyKey?: string;
}

export interface ApiClientDeps {
  baseUrl: string;
  fetch: FetchLike;
  deviceKey: () => DeviceKey | null;
  clock: Clock;
  uuid: () => string;
  appVersion: string;
  session: () => SessionRef | null;
  /** Silent re-login after SESSION_EXPIRED; resolves the new session or null. */
  refreshSession?: () => Promise<SessionRef | null>;
}

export interface ApiClient {
  request<S extends z.ZodType | undefined = undefined>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    opts?: RequestOptions<S>,
  ): Promise<S extends z.ZodType ? z.infer<S> : unknown>;
  readonly clock: Clock;
}

const defaultAuth = (method: string, path: string): AuthMode =>
  path.startsWith('/v1/auth/') ? 'none' : method === 'GET' ? 'bearer' : 'signed';

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const base = deps.baseUrl.replace(/\/+$/, '');

  async function once(
    method: string,
    path: string,
    auth: AuthMode,
    body: { sent: string | Uint8Array; bytes: Uint8Array; contentType: string } | null,
    idem: string,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      [HDR.appVersion]: deps.appVersion,
      [HDR.schemaVersion]: String(SCHEMA_VERSION),
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = body.contentType;
    if (auth !== 'none') {
      const s = deps.session();
      if (!s) throw new ApiClientError('AUTH_REQUIRED', 401, 'not signed in', false);
      if (auth === 'bearer') headers[HDR.authorization] = `Bearer ${s.token}`;
      else {
        const key = deps.deviceKey();
        if (!key) throw new ApiClientError('AUTH_REQUIRED', 401, 'no device key', false);
        Object.assign(
          headers,
          signedHeaders({
            method,
            pathAndQuery: path,
            body: body?.bytes ?? new Uint8Array(0),
            session: s,
            key,
            timestampMs: deps.clock.now(),
            idempotencyKey: idem,
          }),
        );
      }
    }
    try {
      return await deps.fetch(base + path, {
        method,
        headers,
        ...(body ? { body: body.sent } : {}),
      });
    } catch (cause) {
      throw new ApiClientError(
        'NETWORK',
        0,
        cause instanceof Error ? cause.message : 'network error',
        true,
      );
    }
  }

  async function toError(res: FetchResponseLike): Promise<ApiClientError> {
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const parsed = ApiError.safeParse(json);
    if (parsed.success) {
      const e = parsed.data.error;
      return new ApiClientError(
        e.code,
        res.status,
        e.message,
        e.retryable,
        e.details,
        e.request_id,
      );
    }
    return new ApiClientError(
      'HTTP_' + res.status,
      res.status,
      text.slice(0, 200),
      res.status >= 500,
    );
  }

  const client: ApiClient = {
    clock: deps.clock,
    async request(method, path, opts = {}) {
      const auth = opts.auth ?? defaultAuth(method, path);
      let body: { sent: string | Uint8Array; bytes: Uint8Array; contentType: string } | null = null;
      if (opts.raw)
        body = { sent: opts.raw.bytes, bytes: opts.raw.bytes, contentType: opts.raw.contentType };
      else if (opts.json !== undefined) {
        const s = JSON.stringify(opts.json);
        body = { sent: s, bytes: utf8(s), contentType: 'application/json' };
      }
      const idem = opts.idempotencyKey ?? deps.uuid();

      let res = await once(method, path, auth, body, idem);
      let refreshed = false;
      for (let retry = 0; retry < 2 && res.status === 401 && auth !== 'none'; retry++) {
        const err = await toError(res);
        if (err.code === 'CLOCK_SKEW' && typeof err.details?.server_time === 'string') {
          deps.clock.sync(err.details.server_time);
        } else if (
          (err.code === 'SESSION_EXPIRED' || err.code === 'AUTH_REQUIRED') &&
          deps.refreshSession &&
          !refreshed
        ) {
          refreshed = true;
          if (!(await deps.refreshSession())) throw err;
        } else {
          throw err;
        }
        res = await once(method, path, auth, body, idem);
      }
      if (res.status < 200 || res.status >= 300) throw await toError(res);
      if (res.status === 204) return undefined as never;
      const text = await res.text();
      if (!opts.schema) {
        try {
          return (text ? JSON.parse(text) : undefined) as never;
        } catch {
          return text as never;
        }
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiClientError('BAD_RESPONSE', res.status, 'response is not JSON', false);
      }
      const r = opts.schema.safeParse(json);
      if (!r.success) {
        throw new ApiClientError(
          'BAD_RESPONSE',
          res.status,
          `response failed validation: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? ''}`,
          false,
        );
      }
      return r.data as never;
    },
  };
  return client;
}
