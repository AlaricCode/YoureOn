// Process wiring: deps from env, the Node HTTP server with WebSocket support, keepalive,
// heartbeat and graceful shutdown. `main.ts` calls startServer(); tests call it too with
// injected deps (port 0).
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { createDb, type DbHandle } from '@youre-on/db';
import { buildApp } from './app';
import { ChallengeStore } from './auth/challenges';
import type { AppDeps, RouteModule } from './context';
import type { Env } from './env';
import { IdempotencyCache } from './http/idempotency';
import { RateLimiter } from './http/rate-limit';
import { createLogger, type Logger } from './log';
import { dbHubAccess } from './realtime/access';
import { RealtimeHub } from './realtime/hub';

export interface CreateDepsOptions {
  env: Env;
  dbHandle?: DbHandle;
  log?: Logger;
  now?: () => number;
  /** Default true. */
  rateLimit?: boolean;
  heartbeatMs?: number;
  helloTimeoutMs?: number;
}

export function createDeps(o: CreateDepsOptions): { deps: AppDeps; dbHandle: DbHandle } {
  const now = o.now ?? Date.now;
  const log = o.log ?? createLogger(o.env.NODE_ENV === 'test' ? 'silent' : 'info');
  const dbHandle = o.dbHandle ?? createDb({ url: o.env.DATABASE_URL });
  const hub = new RealtimeHub({
    access: dbHubAccess(dbHandle.db, now),
    now,
    log,
    heartbeatMs: o.heartbeatMs,
    helloTimeoutMs: o.helloTimeoutMs,
  });
  const deps: AppDeps = {
    env: o.env,
    db: dbHandle.db,
    hub,
    log,
    now,
    challenges: new ChallengeStore(now),
    idempotency: new IdempotencyCache({ now }),
    rateLimit: o.rateLimit === false ? null : new RateLimiter(now),
  };
  return { deps, dbHandle };
}

export interface RunningServer {
  server: ServerType;
  port: number;
  deps: AppDeps;
  close(): Promise<void>;
}

export async function startServer(
  deps: AppDeps,
  opts: {
    port: number;
    hostname?: string;
    modules?: readonly RouteModule[];
    onClose?: () => Promise<void>;
  },
): Promise<RunningServer> {
  const app = buildApp(deps, opts.modules);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve(
      {
        fetch: app.fetch,
        port: opts.port,
        hostname: opts.hostname ?? '0.0.0.0',
        websocket: { server: wss },
      },
      () => resolve(s),
    );
  });
  deps.hub.start();
  const port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | null = null;
  return {
    server,
    port,
    deps,
    close() {
      closing ??= (async () => {
        deps.hub.stop();
        for (const client of wss.clients) client.terminate();
        wss.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
        await opts.onClose?.();
      })();
      return closing;
    },
  };
}
