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
import { faceRoutes } from './face/routes';
import { betsRoutes } from './bets/routes';
import { voiceRoutes } from './voice/routes';
import { chainRoutes } from './chain/routes';
import { lockRoutes } from './lock/routes';
import { termsRoutes } from './terms/routes';
import { payoutRoutes } from './payout/routes';
import { appealRoutes } from './appeal/routes';
import { meRoutes } from './me/routes';
import { demoRoutes } from './demo/routes';
import { judgeRoutes } from './judge/routes';
import { stageRoutes } from './stage/routes';
import { stageAudioRoutes } from './stage/audio';
import { stageStaticRoutes } from './stage/static';
import { marketsRoutes } from './markets/routes';
import { marketBetRoutes } from './markets/bet-routes';
import { replayRoutes } from './replay/routes';

export const routeModules: RouteModule[] = [
  healthRoutes,
  authRoutes,
  realtimeRoutes,
  roomsRoutes,
  faceRoutes,
  betsRoutes,
  voiceRoutes,
  chainRoutes,
  lockRoutes,
  termsRoutes,
  payoutRoutes,
  meRoutes,
  demoRoutes,
  judgeRoutes,
  appealRoutes,
  // hearingRoutes (Beat 5's hearing is cut, D-C)
  stageRoutes,
  // after stageRoutes: its '/v1/stage/*' CORS middleware covers these
  stageAudioRoutes,
  replayRoutes,
  marketsRoutes,
  marketBetRoutes,
  // GET / and /stage/*: the built projector page (apps/stage/dist), same-origin with the API.
  stageStaticRoutes,
];
