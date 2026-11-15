// Builds the Hono app from route modules (routes.ts). Cross-cutting behaviour lives here:
// X-Request-Id (echo or mint), deps injection, body-size caps (64 KB JSON default, per-path
// overrides from RouteModule.bodyLimits), the §1.5 error envelope, and 404 NOT_FOUND.
import { randomBytes } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { HDR } from '@youre-on/shared/api';
import type { App, AppDeps, AppEnv, RouteModule } from './context';
import { errorBody, HttpError } from './errors';
import { routeModules as defaultModules } from './routes';

export const JSON_BODY_LIMIT = 64 * 1024;

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const mintRequestId = () => `req_${randomBytes(12).toString('base64url')}`;

function bodyLimits(modules: readonly RouteModule[]): MiddlewareHandler<AppEnv> {
  const tooLarge = (): Response => {
    throw new HttpError('PAYLOAD_TOO_LARGE');
  };
  const overrides = modules.flatMap((m) => m.bodyLimits ?? []);
  const cache = new Map<number, MiddlewareHandler>();
  const limiter = (max: number) => {
    let mw = cache.get(max);
    if (!mw) cache.set(max, (mw = bodyLimit({ maxSize: max, onError: tooLarge })));
    return mw;
  };
  return (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const path = c.req.path;
    const hit = overrides.find((o) => o.path.test(path));
    return limiter(hit?.maxBytes ?? JSON_BODY_LIMIT)(c, next);
  };
}

export function buildApp(deps: AppDeps, modules: readonly RouteModule[] = defaultModules): App {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const given = c.req.header(HDR.requestId);
    const id = given && REQUEST_ID_RE.test(given) ? given : mintRequestId();
    c.set('requestId', id);
    c.set('deps', deps);
    await next();
    try {
      c.res.headers.set(HDR.requestId, id);
    } catch {
      /* immutable headers (e.g. a WebSocket upgrade response) */
    }
  });

  app.use('*', bodyLimits(modules));

  for (const m of modules) m.register(app, deps);

  app.notFound((c) =>
    c.json(errorBody('NOT_FOUND', 'Not found.', false, c.get('requestId') ?? mintRequestId()), 404),
  );

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? mintRequestId();
    let res: Response;
    if (err instanceof HttpError) {
      res = c.json(
        errorBody(err.code, err.message, err.retryable, requestId, err.details),
        err.status as 400,
      );
      for (const [k, v] of Object.entries(err.headers ?? {})) res.headers.set(k, v);
    } else if (err instanceof HTTPException && err.status === 413) {
      res = c.json(
        errorBody('PAYLOAD_TOO_LARGE', 'That upload is too large.', false, requestId),
        413,
      );
    } else {
      deps.log.error('http.unhandled', { request_id: requestId, path: c.req.path, err });
      res = c.json(
        errorBody('INTERNAL', 'Something went wrong on our side. Try again.', true, requestId),
        500,
      );
    }
    res.headers.set(HDR.requestId, requestId);
    return res;
  });

  return app;
}
