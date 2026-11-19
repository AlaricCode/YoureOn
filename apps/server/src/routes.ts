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
import { oddsRoutes } from './odds/routes';
import { payoutRoutes } from './payout/routes';
import { appealRoutes } from './appeal/routes';
import { reviewRoutes } from './review/routes';
import { meRoutes } from './me/routes';
import { demoRoutes } from './demo/routes';
import { judgeRoutes } from './judge/routes';
import { callOffRoutes } from './judge/call-off';
import { danceIdentifyRoutes } from './judge/dance-identify';
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
  oddsRoutes,
  payoutRoutes,
  meRoutes,
  demoRoutes,
  judgeRoutes,
  // POST /v1/bets/:bet_id/call-off + POST /v1/demo/bets/:bet_id/void (a stuck locked bet -> VOID)
  callOffRoutes,
  // POST /v1/bets/:bet_id/dance/identify (DANCE-OFF §3 face assignment)
  danceIdentifyRoutes,
  appealRoutes,
  // the spoken review request ("check that again") -> the loser's appeal confirm
  reviewRoutes,
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
