// The projector page (apps/stage, ARCHITECTURE §2 "served by the server"; API-CONTRACT §1.1
// "It also serves /stage"). Vite builds it with base /stage/ into apps/stage/dist (the Docker
// image builds it too), and this module serves that directory from the API's own origin: any
// laptop opens https://<app>.fly.dev/stage with nothing installed, and the page's REST calls and
// /v1/ws WebSocket are same-origin (no CORS, no server URL to type).
//
//   GET /                    302 -> /stage/
//   GET /stage               308 -> /stage/ (query kept: /stage?preview works)
//   GET /stage/assets/*      Vite's content-hashed bundles: cached a year, immutable
//   GET /stage/, index.html  no-cache, so a redeploy shows on the next load
//   GET /stage/<route>       SPA fallback: index.html for extension-less paths
//   GET /stage/<file>        anything else in dist (replay/beat{n}.mp4 …): 5 min, byte ranges
//                            (Safari will not play a <video> without them)
// Precompressed .br / .gz siblings (written by the stage's Vite build) are sent when the client
// accepts them. A missing file is a plain 404 envelope that is never cached.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppEnv, RouteModule } from '../context';
import { HttpError } from '../errors';

export const STAGE_PREFIX = '/stage';
/** apps/stage/dist, next to this server's source in the repo and in the Docker image. */
export const DEFAULT_STAGE_DIR = fileURLToPath(new URL('../../../stage/dist/', import.meta.url));

export const STAGE_CACHE = {
  immutable: 'public, max-age=31536000, immutable',
  html: 'no-cache',
  file: 'public, max-age=300',
  missing: 'no-store',
} as const;

/**
 * The page's CSP. Scripts and styles come only from this origin (the Vite build emits no inline
 * script); images may be signed evidence-frame URLs or data: URIs (QR codes, preview frames);
 * the API and the WebSocket are same-origin, https:/wss: allows a typed server URL.
 */
export const STAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https: wss: ws:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The last path segment has an extension: a file request, never the SPA fallback. */
const looksLikeFile = (path: string): boolean => /\.[A-Za-z0-9]+$/.test(path.split('/').pop()!);

function cacheControlFor(relPath: string): string {
  if (relPath.startsWith('/assets/')) return STAGE_CACHE.immutable;
  if (relPath === '/' || relPath.endsWith('.html')) return STAGE_CACHE.html;
  return STAGE_CACHE.file;
}

function finish(res: Response, cacheControl: string): Response {
  res.headers.set('Cache-Control', cacheControl);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  if (res.headers.get('Content-Type')?.startsWith('text/html')) {
    res.headers.set('Content-Security-Policy', STAGE_CSP);
    // The page reads secrets from its URL fragment and never needs to leak its URL.
    res.headers.set('Referrer-Policy', 'no-referrer');
  }
  return res;
}

export interface StageStaticOptions {
  /** The built stage (default: apps/stage/dist). Read per request, so a rebuild needs no restart. */
  dir?: string;
}

export function stageStatic(o: StageStaticOptions = {}): RouteModule {
  const dir = o.dir ?? DEFAULT_STAGE_DIR;
  const rel = (c: Context<AppEnv>) => c.req.path.slice(STAGE_PREFIX.length) || '/';
  // Built lazily: serveStatic logs an error when its root is missing at construction time.
  let files: MiddlewareHandler<AppEnv> | null = null;
  let index: MiddlewareHandler<AppEnv> | null = null;

  /** Runs a serveStatic middleware; null when it found nothing (it called next()). */
  async function tryServe(mw: MiddlewareHandler<AppEnv>, c: Context<AppEnv>) {
    let missed = false;
    const res = await mw(c, async () => {
      missed = true;
    });
    return missed || !(res instanceof Response) ? null : res;
  }

  return {
    name: 'stage-static',
    register(app) {
      app.get('/', (c) => c.redirect(`${STAGE_PREFIX}/`, 302));
      app.get(STAGE_PREFIX, (c) => {
        const q = new URL(c.req.url).search;
        return c.redirect(`${STAGE_PREFIX}/${q}`, 308);
      });
      app.get(`${STAGE_PREFIX}/*`, async (c) => {
        if (!isFile(join(dir, 'index.html')))
          throw new HttpError(
            'NOT_FOUND',
            'The stage page is not built on this server (npm run build -w apps/stage).',
            undefined,
            { headers: { 'Cache-Control': STAGE_CACHE.missing } },
          );
        files ??= serveStatic<AppEnv>({
          root: dir,
          precompressed: true,
          rewriteRequestPath: (p) => p.slice(STAGE_PREFIX.length) || '/',
        });
        index ??= serveStatic<AppEnv>({ root: dir, path: 'index.html', precompressed: true });

        const path = rel(c);
        const hit = await tryServe(files, c);
        if (hit) return finish(hit, cacheControlFor(path));
        if (path.startsWith('/assets/') || looksLikeFile(path))
          throw new HttpError('NOT_FOUND', 'Not found.', undefined, {
            headers: { 'Cache-Control': STAGE_CACHE.missing },
          });
        const page = await tryServe(index, c);
        if (!page) throw new HttpError('NOT_FOUND', 'Not found.');
        return finish(page, STAGE_CACHE.html);
      });
    },
  };
}

/** The module routes.ts mounts: apps/stage/dist. */
export const stageStaticRoutes: RouteModule = stageStatic();
