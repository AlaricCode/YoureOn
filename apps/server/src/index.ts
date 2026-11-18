// Public surface of @youre-on/server for other streams and tests.
export { buildApp, JSON_BODY_LIMIT } from './app';
export { createDeps, startServer, type RunningServer, type CreateDepsOptions } from './server';
export { loadEnv, EnvSchema, EnvError, REQUIRED_IN_PRODUCTION, type Env } from './env';
export type {
  App,
  AppDeps,
  AppEnv,
  AppVariables,
  AuthContext,
  AppAuthContext,
  RouteModule,
} from './context';
export { HttpError, errorBody, validationError, zodIssues } from './errors';
export { readBody, readJsonBody, parseWith } from './http/body';
export { RateLimiter, BUCKETS, type BucketSpec } from './http/rate-limit';
export { IdempotencyCache } from './http/idempotency';
export {
  requireSession,
  requireAppSession,
  requireSignedRequest,
  appAuth,
} from './auth/middleware';
export { resolveSession, issueAppSession, revokeSession, bearerToken } from './auth/sessions';
export { RealtimeHub, HUB_CLOSE, type BetEnvelope, type HubAccess } from './realtime/hub';
export { appendBetEvent, emitBetEvent, type BetEventEnvelope } from './realtime/events';
export { verifyEd25519, sha256Hex, decodeBase64, decodeBase64Url, pubkeyBytes } from './crypto';
export { createLogger, silentLogger, type Logger } from './log';
export { routeModules } from './routes';
export {
  stageStatic,
  stageStaticRoutes,
  STAGE_CACHE,
  STAGE_CSP,
  STAGE_PREFIX,
  type StageStaticOptions,
} from './stage/static';
export { Keeper, createServerKeeper, expireIdleDrafts, type KeeperTask } from './keeper';
export {
  ClipCache,
  DEFAULT_STAGE_VOICES,
  StageTts,
  stageAudioGate,
  type StageClip,
} from './voice/tts';
export { createElevenLabsClient, type FetchLike as ElevenLabsFetch } from './voice/elevenlabs';
