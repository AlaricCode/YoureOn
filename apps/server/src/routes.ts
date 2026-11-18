// The route modules the server mounts, in order. Other streams register here:
//   1. create apps/server/src/<area>/routes.ts exporting `export const <area>Routes: RouteModule`
//   2. import it below and append it to `routeModules`.
// That is the only core edit a new route module needs (buildApp, middleware, errors, the WS hub
// and the deps bag are shared).
import type { RouteModule } from './context';
import { authRoutes } from './auth/routes';
import { healthRoutes } from './health/routes';
import { realtimeRoutes } from './realtime/routes';
import { roomsRoutes } from './rooms/routes';
import { betsRoutes } from './bets/routes';
import { voiceRoutes } from './voice/routes';
import { chainRoutes } from './chain/routes';
import { judgeRoutes } from './judge/routes';

export const routeModules: RouteModule[] = [
  healthRoutes,
  authRoutes,
  realtimeRoutes,
  roomsRoutes,
  betsRoutes,
  voiceRoutes,
  chainRoutes,
  judgeRoutes,
  // hearingRoutes, appealsRoutes, geminiRoutes, …
];
