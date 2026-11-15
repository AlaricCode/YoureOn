// GET /v1/ws (API-CONTRACT §3.1). The bearer token arrives in the first frame (`hello`), never
// in the URL. Requires the server to be started through startServer() (server.ts), which
// attaches the `ws` WebSocketServer to @hono/node-server.
import { upgradeWebSocket } from '@hono/node-server';
import { WS_PATH } from '@youre-on/shared/api';
import type { RouteModule } from '../context';

export const realtimeRoutes: RouteModule = {
  name: 'realtime',
  register(app, deps) {
    app.get(
      WS_PATH,
      upgradeWebSocket(() => deps.hub.events()),
    );
  },
};
