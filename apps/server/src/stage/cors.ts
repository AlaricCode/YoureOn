// CORS for the stage laptop's routes (API-CONTRACT §1.2: phones need none; the stage is served
// by Vite on another origin in development). STAGE_ORIGIN is a comma-separated allow-list;
// unset -> the Vite dev origins. Bearer tokens only (no cookies), so no credentials mode.
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import { HDR } from '@youre-on/shared/api';
import type { AppEnv } from '../context';
import type { Env } from '../env';

export const DEFAULT_STAGE_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
] as const;

export function stageOrigins(env: Pick<Env, 'STAGE_ORIGIN'>): string[] {
  const list = (env.STAGE_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_STAGE_ORIGINS];
}

const cache = new WeakMap<object, MiddlewareHandler<AppEnv>>();

/** One middleware per env object (several route modules mount it). */
export function stageCors(env: Pick<Env, 'STAGE_ORIGIN'>): MiddlewareHandler<AppEnv> {
  let mw = cache.get(env);
  if (!mw) {
    const allowed = new Set(stageOrigins(env));
    mw = cors({
      origin: (o) => (allowed.has(o) ? o : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', HDR.requestId],
      exposeHeaders: [HDR.requestId, 'Retry-After'],
      maxAge: 600,
    });
    cache.set(env, mw);
  }
  return mw;
}
