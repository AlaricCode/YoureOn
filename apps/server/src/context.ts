// Shared server types: the dependency bag every route module receives, the Hono env, and
// the route-module contract (see routes.ts).
import type { Hono } from 'hono';
import type { Db } from '@youre-on/db';
import type { Env } from './env';
import type { Logger } from './log';
import type { RealtimeHub } from './realtime/hub';
import type { ChallengeStore } from './auth/challenges';
import type { IdempotencyCache } from './http/idempotency';
import type { RateLimiter } from './http/rate-limit';

/** Who is calling, after `requireSession` (bearer) or the WS hello. */
export interface AuthContext {
  session_id: string;
  scopes: readonly ('app' | 'stage' | 'demo')[];
  /** null for stage tokens. */
  user_id: string | null;
  /** null for stage tokens. */
  device_id: string | null;
  /** The device auth key (base58) of device_id; null for stage tokens. */
  device_pubkey: string | null;
  /** Stage tokens only: the room they fan out. */
  room_id: string | null;
  expires_at: Date;
}

/** Narrowed AuthContext for app (phone) sessions. */
export interface AppAuthContext extends AuthContext {
  user_id: string;
  device_id: string;
  device_pubkey: string;
}

export interface AppDeps {
  env: Env;
  db: Db;
  hub: RealtimeHub;
  log: Logger;
  /** Wall clock in ms; injectable for tests. */
  now: () => number;
  challenges: ChallengeStore;
  idempotency: IdempotencyCache;
  /** null disables rate limiting (tests). */
  rateLimit: RateLimiter | null;
}

export type AppVariables = {
  requestId: string;
  deps: AppDeps;
  /** Set by requireSession / requireAppSession / requireSignedRequest. */
  auth: AuthContext;
};
export type AppEnv = { Variables: AppVariables };
export type App = Hono<AppEnv>;

/**
 * A route module. Each stream adds one file under apps/server/src/<area>/routes.ts exporting
 * a RouteModule and appends it to `routeModules` in src/routes.ts — no other core edits.
 */
export interface RouteModule {
  name: string;
  register(app: App, deps: AppDeps): void;
  /**
   * Per-path request-body caps that override the 64 KB JSON default (API-CONTRACT §1.4),
   * e.g. `{ path: /^\/v1\/bets\/[^/]+\/attempts\/\d+\/frames$/, maxBytes: 2 * 1024 * 1024 }`.
   */
  bodyLimits?: ReadonlyArray<{ path: RegExp; maxBytes: number }>;
}
