/**
 * Shared helpers for route modules.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { ApiError, NotImplementedError } from '../errors.js';
import type { UserRecord } from '../persistence/records.js';
import { fromBase64 } from '../util/bytes.js';

export type RouteModule = (app: FastifyInstance, ctx: AppContext) => void | Promise<void>;

declare module 'fastify' {
  interface FastifyRequest {
    /** set by the auth hook on authenticated routes */
    userId: string | null;
  }
}

/** The authenticated user (UNAUTHORIZED if missing). */
export function currentUser(ctx: AppContext, req: FastifyRequest): UserRecord {
  if (!req.userId) throw new ApiError('UNAUTHORIZED');
  return ctx.auth.requireUser(req.userId);
}

/** Registry of scaffold stubs (so tests can assert every §12.3 route exists). */
export const STUBS: { method: string; url: string; owner: string }[] = [];

/**
 * Registers a route that answers 501 + INTERNAL until the owning service
 * agent replaces it. Auth still applies, so the stub behaves like the real
 * route for unauthenticated callers.
 */
export function stub(app: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, owner: string): void {
  if (!STUBS.some((s) => s.method === method && s.url === url)) STUBS.push({ method, url, owner });
  app.route({
    method,
    url,
    handler: async (_req: FastifyRequest, _reply: FastifyReply) => {
      throw new NotImplementedError(`${method} ${url} (TODO: ${owner})`);
    },
  });
}

// ---- body parsing ------------------------------------------------------------------
// Malformed requests are HTTP 400 with code WRONG_STATE (no dedicated §12.8 code; see errata).

export function badRequest(detail: string): ApiError {
  return new ApiError('WRONG_STATE', detail, 400);
}

export function bodyObject(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw badRequest('body must be a JSON object');
  return b as Record<string, unknown>;
}

export function reqString(o: Record<string, unknown>, k: string, max = 4096): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length > max) throw badRequest(`${k} must be a string`);
  return v;
}

export function optString(o: Record<string, unknown>, k: string, max = 4096): string | undefined {
  return o[k] === undefined || o[k] === null ? undefined : reqString(o, k, max);
}

export function reqInt(o: Record<string, unknown>, k: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[k];
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw badRequest(`${k} must be an integer`);
  return v as number;
}

export function reqBase64(o: Record<string, unknown>, k: string): Uint8Array {
  try {
    return fromBase64(reqString(o, k, 64 * 1024 * 1024));
  } catch {
    throw badRequest(`${k} must be base64`);
  }
}

export function param(req: FastifyRequest, k: string): string {
  const v = (req.params as Record<string, string | undefined>)[k];
  if (!v) throw badRequest(`missing :${k}`);
  return v;
}
