/**
 * The application context handed to every route module and service. Built
 * once by `createContext` (wires config → store → chain → providers → hub →
 * event handler → tx service → keeper).
 */
import type { FastifyBaseLogger } from 'fastify';
import { AuthService } from './auth/service.js';
import { createChainClient } from './chain/index.js';
import { ChainEventHandler, type ProcessedEventRecord } from './chain/events.js';
import type { ChainClient } from './chain/types.js';
import type { Config } from './config/load.js';
import { Keeper } from './keeper/keeper.js';
import { BlobStore } from './persistence/blobs.js';
import { COLLECTIONS } from './persistence/records.js';
import { JsonStore } from './persistence/store.js';
import { createProviders } from './providers/registry.js';
import type { Providers } from './providers/types.js';
import { TxService } from './tx/service.js';
import { systemClock, type Clock } from './util/clock.js';
import { WsHub } from './ws/hub.js';

export interface Logger {
  info(o: unknown, msg?: string): void;
  warn(o: unknown, msg?: string): void;
  error(o: unknown, msg?: string): void;
  debug?(o: unknown, msg?: string): void;
}

/** Late-bound service hooks that scaffold routes call into (filled by service agents). */
export interface AppHooks {
  /** ElevenLabs Agent compile tool (POST /webhooks/elevenlabs/tool) → DraftView */
  compileTool: ((body: { draft_id?: string; huddle_id: string; transcript: string }) => Promise<unknown>) | null;
}

export interface AppContext {
  config: Config;
  clock: Clock;
  log: Logger;
  store: JsonStore;
  blobs: BlobStore;
  chain: ChainClient;
  providers: Providers;
  hub: WsHub;
  events: ChainEventHandler;
  auth: AuthService;
  txs: TxService;
  keeper: Keeper;
  hooks: AppHooks;
}

export interface ContextOptions {
  clock?: Clock;
  log?: Logger | FastifyBaseLogger;
  /** keep everything in memory (tests); default: persist under DATA_DIR */
  inMemory?: boolean;
  providers?: Partial<Providers>;
  chain?: ChainClient;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** JSON-lines console logger for services (Fastify keeps its own request logger). */
export function consoleLogger(level = 'info'): Logger {
  const min = Math.max(0, LEVELS.indexOf(level as (typeof LEVELS)[number]));
  const at = (l: (typeof LEVELS)[number]) => (o: unknown, msg?: string) => {
    if (LEVELS.indexOf(l) < min) return;
    const extra = o instanceof Error ? { err: o.message } : (o as Record<string, unknown>);
    const err = (extra as { err?: unknown })?.err;
    const line = JSON.stringify({ level: l, time: Date.now(), msg, ...extra, ...(err instanceof Error ? { err: err.stack ?? err.message } : {}) });
    (l === 'error' || l === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export function createContext(config: Config, opts: ContextOptions = {}): AppContext {
  const clock = opts.clock ?? systemClock;
  const log = (opts.log ?? silentLogger) as Logger;
  const store = new JsonStore({ dataDir: opts.inMemory ? null : config.dataDir });
  const blobs = new BlobStore(opts.inMemory ? null : config.dataDir);
  // Providers first: the spend guard must refuse startup before anything else happens.
  const providers = createProviders(config, { clock }, opts.providers);
  const chain =
    opts.chain ??
    createChainClient(config, {
      clock,
      persist: !opts.inMemory,
      ...(providers.prover.verifier ? { verifyGroth16: providers.prover.verifier } : {}),
      onListenerError: (e) => log.error({ err: e }, 'chain event listener failed'),
    });
  const auth = new AuthService({ store, clock });
  const hub = new WsHub({ authenticate: (t) => auth.authenticate(t), clock, log });
  const events = new ChainEventHandler({
    processed: store.collection<ProcessedEventRecord>(COLLECTIONS.chainEvents),
    hub,
    nowMs: () => clock.nowMs(),
    log,
  });
  // §12.5 mock: the mock chain calls the handler in-process (no HMAC).
  if (config.chainEventsSource === 'mock') chain.onEvents((envs) => events.handleEnvelopes(envs).then(() => undefined));
  const txs = new TxService({ store, chain, clock, log });
  const keeper = new Keeper({ clock, log });
  return { config, clock, log, store, blobs, chain, providers, hub, events, auth, txs, keeper, hooks: { compileTool: null } };
}
