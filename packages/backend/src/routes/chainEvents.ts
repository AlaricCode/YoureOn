/**
 * Chain event sources and notifications (§12.5) — owned by booth-world-events.
 *  - mock:      wired in context.ts (the mock chain calls the handler in-process);
 *  - quicknode: POST /webhooks/quicknode (webhooks.ts → chain/streams.ts);
 *  - rpc_ws:    `logsSubscribe` on the devnet connection, started when the
 *               server is ready and stopped on close; the backend's own
 *               transactions are also fed in directly (idempotent).
 * Registers the WS notifications for the trigger table (chain/notify.ts).
 */
import { DevnetChain } from '../chain/devnet.js';
import { ChainNotifier } from '../chain/notify.js';
import { startRpcWsSource, type RpcWsSource } from '../chain/rpcWs.js';
import type { RouteModule } from './util.js';

export const chainEventRoutes: RouteModule = (app, ctx) => {
  new ChainNotifier(ctx).register();

  if (ctx.config.chainEventsSource !== 'rpc_ws') return;
  let source: RpcWsSource | null = null;
  let detach: (() => void) | null = null;
  app.addHook('onReady', async () => {
    const chain = ctx.chain;
    if (!(chain instanceof DevnetChain)) {
      ctx.log.warn({ mode: chain.mode }, 'CHAIN_EVENTS_SOURCE=rpc_ws needs SOLANA_MODE=devnet; not subscribing');
      return;
    }
    detach = chain.onEvents((envs) => ctx.events.handleEnvelopes(envs).then(() => undefined));
    source = startRpcWsSource({ connection: chain.connection, programId: chain.programId, handler: ctx.events, log: ctx.log });
  });
  app.addHook('onClose', async () => {
    detach?.();
    await source?.stop();
  });
};
