/**
 * Fastify application: `{API}/v1` JSON API (§12), auth, §12.8 error mapping,
 * raw-body parsers, the WebSocket hub (§12.4) and the keeper (§12.6).
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { MAX_CHUNK_BODY_BYTES } from '@verdict/engine';
import type { AppContext } from './context.js';
import { ApiError, errorBody, toApiError } from './errors.js';
import { ROUTE_MODULES } from './routes/index.js';
import { badRequest } from './routes/util.js';
import { RateLimiter } from './util/rateLimit.js';
import { jsonReplacer } from './util/bytes.js';

/** Routes that do not need a bearer token (§12: `/auth/*` and `/webhooks/*`). */
const PUBLIC_PREFIXES = ['/v1/auth/', '/v1/webhooks/', '/v1/health'];
/** JSON requests may carry base64 frames (practice: ≤ 50 JPEGs). */
export const JSON_BODY_LIMIT = 48 * 1024 * 1024;
const AUTH_RATE_LIMIT = 60;
const AUTH_RATE_WINDOW_MS = 60_000;

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** start the keeper loop on ready (default true) */
  startKeeper?: boolean;
}

export async function buildApp(ctx: AppContext, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: JSON_BODY_LIMIT,
    // ws upgrades are handled by the hub on the same server
    forceCloseConnections: true,
  });
  const authLimiter = new RateLimiter(ctx.clock, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS);

  app.decorateRequest('userId', null);
  app.decorateRequest('rawBody', undefined);

  // JSON with the raw bytes kept (QuickNode HMAC is over the raw body).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch {
      done(badRequest('invalid JSON'), undefined);
    }
  });
  // Raw uploads: chunk bodies, scene crops, audio.
  for (const ct of ['application/octet-stream', 'image/jpeg', 'audio/wav', 'audio/x-wav', 'video/mp4']) {
    app.addContentTypeParser(ct, { parseAs: 'buffer', bodyLimit: MAX_CHUNK_BODY_BYTES }, (_req, body, done) => done(null, body));
  }

  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/v1/auth/') && !authLimiter.hit(req.ip)) throw new ApiError('RATE_LIMITED');
    if (!path.startsWith('/v1/') || PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return;
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const userId = m ? ctx.auth.authenticate(m[1]!) : null;
    if (!userId) throw new ApiError('UNAUTHORIZED');
    req.userId = userId;
  });

  app.setErrorHandler((err, req, reply) => {
    let e: ApiError;
    const code = (err as { code?: string }).code;
    if (err instanceof ApiError) e = err;
    else if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new ApiError('CHUNK_TOO_LARGE');
    else if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_VALIDATION') {
      e = badRequest(err instanceof Error ? err.message : String(err));
    } else e = toApiError(err);
    if (e.status >= 500) req.log.error({ err, detail: e.detail }, 'request failed');
    else if (e.detail) req.log.debug({ code: e.code, detail: e.detail }, 'request refused');
    void reply.code(e.status).send(e.toBody());
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send(errorBody('NOT_FOUND'));
  });

  app.get('/v1/health', async () => ({
    ok: true,
    solana_mode: ctx.config.solanaMode,
    chain_events_source: ctx.config.chainEventsSource,
    program_id: ctx.config.programId,
    spend_allowed: ctx.config.allowSpend,
  }));

  for (const m of ROUTE_MODULES) await m.register(app, ctx);

  app.addHook('onReady', async () => {
    ctx.hub.attach(app.server);
    if (opts.startKeeper ?? true) ctx.keeper.start();
  });
  app.addHook('onClose', async () => {
    ctx.keeper.stop();
    await ctx.hub.close();
    await ctx.events.idle();
    await ctx.chain.close();
  });

  return app;
}
