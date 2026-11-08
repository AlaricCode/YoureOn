/**
 * Replay booth routes (§10, §12.3) — owned by booth-world-events:
 *   GET /bets/:id/booth          booth record (§10.5); 404 until the booth starts
 *   GET /bets/:id/exhibits/:eid  raw exhibit bytes (Content-Type sniffed from the kind)
 * Both are visible only to bet viewers (participants / confirmed huddle
 * members; World bets: participants), else NOT_FOUND (requireBetViewer).
 * Also wires the booth service: `Disputed` trigger + keeper sweep (§12.6 step 6).
 */
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { BoothService, publicBooth, type BoothServiceOptions } from '../booth/service.js';
import { requireBetViewer } from '../lifecycle/betInfo.js';
import { currentUser, param, type RouteModule } from './util.js';

const services = new WeakMap<AppContext, BoothService>();

/** The booth service of an app context (created on first use). */
export function boothService(ctx: AppContext, opts?: BoothServiceOptions): BoothService {
  let s = services.get(ctx);
  if (!s) {
    s = new BoothService(ctx, opts);
    services.set(ctx, s);
  }
  return s;
}

const MIME: Record<string, string> = {
  clip: 'video/mp4',
  audio: 'audio/wav',
  tracks: 'application/json',
  transcript: 'application/json',
  identity: 'application/json',
  program: 'application/json',
  flags: 'application/json',
  rerun: 'application/json',
  phone: 'application/json',
};

function isMjpeg(b: Uint8Array): boolean {
  // u32 len ‖ u32 t ‖ JPEG SOI (FF D8)
  return b.length > 10 && b[8] === 0xff && b[9] === 0xd8;
}

export const replayBoothRoutes: RouteModule = (app, ctx) => {
  const booth = boothService(ctx);
  booth.register();

  app.get('/v1/bets/:id/booth', async (req) => {
    const id = param(req, 'id');
    await requireBetViewer(ctx, currentUser(ctx, req), id);
    const rec = booth.get(id);
    if (!rec) throw new ApiError('NOT_FOUND', 'no booth for this bet');
    return publicBooth(rec);
  });

  app.get('/v1/bets/:id/exhibits/:eid', async (req, reply) => {
    const id = param(req, 'id');
    const eid = param(req, 'eid');
    await requireBetViewer(ctx, currentUser(ctx, req), id);
    const rec = booth.get(id);
    const ex = rec?.exhibits.find((e) => e.id === eid);
    if (!ex) throw new ApiError('NOT_FOUND');
    const bytes = ctx.blobs.getExhibit(id, eid);
    if (!bytes) throw new ApiError('NOT_FOUND');
    const type = ex.kind === 'clip' && isMjpeg(bytes) ? 'video/x-motion-jpeg' : (MIME[ex.kind] ?? 'application/octet-stream');
    return reply
      .header('content-type', type)
      .header('x-exhibit-sha256', ex.sha256)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(bytes));
  });
};
