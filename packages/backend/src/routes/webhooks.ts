/**
 * Webhooks (no bearer auth):
 *   POST /webhooks/quicknode       §12.5 (implemented: HMAC, idempotent handler) → 204
 *   POST /webhooks/elevenlabs/tool header x-verdict-tool-secret (secret check implemented;
 *                                  compile delegated to the drafts service via `compileTool`)
 */
import { timingSafeEqual } from 'node:crypto';
import { QN_HEADER_NONCE, QN_HEADER_SIGNATURE, QN_HEADER_TIMESTAMP, verifyQuickNodeSignature } from '../chain/quicknode.js';
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

export const webhookRoutes: RouteModule = (app, ctx) => {
  app.post('/v1/webhooks/quicknode', { config: { rawBody: true } }, async (req, reply) => {
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
    let batch;
    try {
      batch = streamEvents(req.body);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (batch.rejected.length > 0) req.log.warn({ rejected: batch.rejected }, 'quicknode: events dropped');
    // §12.5: ordered (slot, tx order, index); the handler is idempotent on (signature, index).
    await ctx.events.handle(batch.events);
    return reply.code(204).send();
  });

  app.post('/v1/webhooks/elevenlabs/tool', async (req) => {
    const secret = ctx.config.elevenlabsToolSecret;
    const given = header(req.headers['x-verdict-tool-secret']);
    if (!secret || !given || !secretEquals(secret, given)) throw new ApiError('UNAUTHORIZED');
    const b = bodyObject(req);
    if (typeof b['huddle_id'] !== 'string' || typeof b['transcript'] !== 'string') throw badRequest('huddle_id and transcript required');
    // TODO(huddle/drafts/compiler agent): set ctx.hooks.compileTool (same path as POST /bets/compile → DraftView).
    if (!ctx.hooks.compileTool) throw new NotImplementedError('POST /v1/webhooks/elevenlabs/tool compile');
    return ctx.hooks.compileTool({
      huddle_id: b['huddle_id'],
      transcript: b['transcript'],
      ...(typeof b['draft_id'] === 'string' ? { draft_id: b['draft_id'] } : {}),
    });
  });
};
