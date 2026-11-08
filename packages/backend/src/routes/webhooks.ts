/**
 * Webhooks (no bearer auth):
 *   POST /webhooks/quicknode       §12.5 (implemented: HMAC, idempotent handler) → 204
 *   POST /webhooks/elevenlabs/tool header x-verdict-tool-secret (secret check implemented;
 *                                  compile delegated to the drafts service via `compileTool`)
 */
import { timingSafeEqual } from 'node:crypto';
import { QN_HEADER_NONCE, QN_HEADER_SIGNATURE, QN_HEADER_TIMESTAMP, QN_MAX_SKEW_S, verifyQuickNodeSignature } from '../chain/quicknode.js';
import { streamEvents } from '../chain/streams.js';
import { ApiError, NotImplementedError } from '../errors.js';
import { badRequest, bodyObject, type RouteModule } from './util.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

function header(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** QuickNode Streams batches can exceed 1 MiB; still far below the global 48 MiB. */
export const QUICKNODE_BODY_LIMIT = 8 * 1024 * 1024;
/** A transcript + ids. */
export const TOOL_BODY_LIMIT = 1024 * 1024;

export const webhookRoutes: RouteModule = (app, ctx) => {
  app.post(
    '/v1/webhooks/quicknode',
    {
      config: { rawBody: true },
      bodyLimit: QUICKNODE_BODY_LIMIT,
      // Cheap rejection before any body byte is buffered: source on, headers present, timestamp fresh.
      onRequest: async (req) => {
        if (ctx.config.chainEventsSource !== 'quicknode' || !ctx.config.quicknodeSecret) throw new ApiError('NOT_FOUND');
        const ts = header(req.headers[QN_HEADER_TIMESTAMP]);
        if (!header(req.headers[QN_HEADER_NONCE]) || !ts || !header(req.headers[QN_HEADER_SIGNATURE])) {
          throw new ApiError('UNAUTHORIZED', 'quicknode: missing');
        }
        if (!/^\d{1,12}$/.test(ts) || Math.abs(ctx.clock.nowMs() / 1000 - Number(ts)) > QN_MAX_SKEW_S) {
          throw new ApiError('UNAUTHORIZED', 'quicknode: stale');
        }
      },
    },
    async (req, reply) => {
      if (ctx.config.chainEventsSource !== 'quicknode' || !ctx.config.quicknodeSecret) throw new ApiError('NOT_FOUND');
      const v = verifyQuickNodeSignature({
        secret: ctx.config.quicknodeSecret,
        nonce: header(req.headers[QN_HEADER_NONCE]),
        timestamp: header(req.headers[QN_HEADER_TIMESTAMP]),
        signature: header(req.headers[QN_HEADER_SIGNATURE]),
        rawBody: req.rawBody ?? Buffer.alloc(0),
        nowMs: ctx.clock.nowMs(),
      });
      if (!v.ok) throw new ApiError('UNAUTHORIZED', `quicknode: ${v.reason}`);
      // JSON is parsed only after the HMAC over the raw bytes verified.
      let body: unknown;
      try {
        body = req.rawBody && req.rawBody.length > 0 ? JSON.parse(req.rawBody.toString('utf8')) : undefined;
      } catch {
        throw badRequest('invalid JSON');
      }
      let batch;
      try {
        batch = streamEvents(body);
      } catch (e) {
        throw badRequest((e as Error).message);
      }
      if (batch.rejected.length > 0) req.log.warn({ rejected: batch.rejected }, 'quicknode: events dropped');
      // §12.5: ordered (slot, tx order, index); the handler is idempotent on (signature, index).
      await ctx.events.handle(batch.events);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/webhooks/elevenlabs/tool',
    {
      bodyLimit: TOOL_BODY_LIMIT,
      // The secret is header-only: refuse before the body is read.
      onRequest: async (req) => {
        const secret = ctx.config.elevenlabsToolSecret;
        const given = header(req.headers['x-verdict-tool-secret']);
        if (!secret || !given || !secretEquals(secret, given)) throw new ApiError('UNAUTHORIZED');
      },
    },
    async (req) => {
      const secret = ctx.config.elevenlabsToolSecret;
      const given = header(req.headers['x-verdict-tool-secret']);
      if (!secret || !given || !secretEquals(secret, given)) throw new ApiError('UNAUTHORIZED');
      const b = bodyObject(req);
      if (typeof b['huddle_id'] !== 'string' || typeof b['transcript'] !== 'string') throw badRequest('huddle_id and transcript required');
      // ctx.hooks.compileTool is set by huddles/services.ts (same path as POST /bets/compile → DraftView);
      // it defaults to null in context.ts, hence the guard.
      if (!ctx.hooks.compileTool) throw new NotImplementedError('POST /v1/webhooks/elevenlabs/tool compile');
      return ctx.hooks.compileTool({
        huddle_id: b['huddle_id'],
        transcript: b['transcript'],
        ...(typeof b['draft_id'] === 'string' ? { draft_id: b['draft_id'] } : {}),
      });
    },
  );
};
