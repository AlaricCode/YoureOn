import { authRoutes } from './auth.js';
import { betRoutes } from './bets.js';
import { boothRoutes } from './booth.js';
import { replayBoothRoutes } from './replayBooth.js';
import { receiptRoutes } from './receipt.js';
import { chainEventRoutes } from './chainEvents.js';
import { huddleRoutes } from './huddles.js';
import { identityRoutes } from './identity.js';
import { lifecycleRoutes } from './lifecycle.js';
import { txRoutes } from './tx.js';
import type { RouteModule } from './util.js';
import { walletRoutes } from './wallet.js';
import { webhookRoutes } from './webhooks.js';
import { worldRoutes } from './world.js';

/** Every route module, in registration order. Service agents fill in their module. */
export const ROUTE_MODULES: { name: string; register: RouteModule }[] = [
  { name: 'auth', register: authRoutes },
  { name: 'tx', register: txRoutes },
  { name: 'wallet', register: walletRoutes },
  { name: 'webhooks', register: webhookRoutes },
  { name: 'chain-events', register: chainEventRoutes },
  { name: 'identity', register: identityRoutes },
  { name: 'huddles', register: huddleRoutes },
  { name: 'bets', register: betRoutes },
  { name: 'bet-lifecycle', register: lifecycleRoutes },
  { name: 'booth', register: boothRoutes },
  { name: 'replay-booth', register: replayBoothRoutes },
  { name: 'receipt', register: receiptRoutes },
  { name: 'world', register: worldRoutes },
];

export { STUBS, type RouteModule } from './util.js';
