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
import type { Keeper } from './keeper/keeper';
import type { MarketService } from './markets/service';
import type { Providers } from './providers/types';
import type { StageVoice } from './stage/voice';
import type { Ruling } from '@youre-on/shared/ruling';
import type { ReplayFoulSource } from './replay/fouls';
import type { SamClient } from './judge/sam';

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
  /** Paid external capabilities (LLM, STT, SFX), built from the env by providers/registry.ts. */
  providers: Providers;
  /** Periodic Postgres sweeps; started/stopped by startServer. Absent in tests by default. */
  keeper?: Keeper;
  /**
   * Called by the judge pipeline (src/judge) after every persisted attempt ruling has been
   * committed and pushed, REDO included. createDeps points it at the payout service, which sends
   * `resolve` for decisive / VOID rulings. Unset = no-op. Errors are logged, never surfaced to
   * the uploader.
   */
  onRuling?: (betId: string, ruling: Ruling) => Promise<void> | void;
  /** Gemini BTC 5-min relay; started/stopped by startServer. Absent in tests by default. */
  markets?: MarketService;
  /**
   * The projector's ElevenLabs voice: stage.voice clips for the judge's spoken moments and the
   * cues' Sound Effects. createDeps builds it; absent = off.
   */
  stageVoice?: StageVoice;
  /**
   * The slow-mo replay's confirmed-foul source (replay/fouls.ts). Absent = no foul replay is ever
   * shown (GET /v1/bets/:bet_id/replay serves the win).
   */
  replayFouls?: ReplayFoulSource;
  /**
   * The SAM 3.1 service for the camera checks: built by createDeps when SAM3_URL and
   * SAM3_API_TOKEN are set. Absent = no camera checks.
   */
  sam?: SamClient;
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
 * A route module: a named set of routes. buildApp registers every module listed in
 * `routeModules` (routes.ts), in order.
 */
export interface RouteModule {
  name: string;
  register(app: App, deps: AppDeps): void;
  /**
   * Per-path request-body caps that override the 64 KB JSON default, e.g. the judge's 3 MiB
   * frames upload.
   */
  bodyLimits?: ReadonlyArray<{ path: RegExp; maxBytes: number }>;
}
