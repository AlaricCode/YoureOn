// GET /health — liveness for Fly and the cellular smoke check (TASKS D0-L3). No DB call
// (API-CONTRACT §2.0), so a cold Neon never fails the Fly health check.
import type { RouteModule } from '../context';

export const healthRoutes: RouteModule = {
  name: 'health',
  register(app, deps) {
    app.get('/health', (c) =>
      c.json({
        ok: true,
        server_time: new Date(deps.now()).toISOString(),
        ws_connections: deps.hub.connectionCount,
      }),
    );
  },
};
