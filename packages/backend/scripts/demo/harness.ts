/**
 * Demo harness: boots the real backend (Fastify HTTP + WS, keeper, mock
 * chain, every provider = mock) on 127.0.0.1 with a manual clock, and gives
 * the scenario code a way to let time pass. The simulated phones only talk
 * HTTP/WS; the harness only owns the clock (mock-chain time, §12.6 "mock
 * chain: keeper on every mock-clock tick") and the mock Gemini event feed.
 *
 * Never sets ALLOW_SPEND: the environment is built from scratch, so ambient
 * variables (keys, provider modes) cannot leak in.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Env } from '../../src/config/load.js';
import { createContext, type AppContext } from '../../src/context.js';
import { generateKeypair, secretToBase58 } from '../../src/crypto/keys.js';
import { loadGeminiFixtures, MockGemini } from '../../src/providers/mock/gemini.js';
import type { WorldEvent } from '../../src/providers/types.js';
import { ManualClock } from '../../src/util/clock.js';

export const DEMO_START_MS = Date.UTC(2026, 10, 8, 18, 0, 0);

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  clock: ManualClock;
  baseUrl: string;
  /** mutable demo World event (resolve it with `resolveWorldEvent`) */
  worldEvent: WorldEvent;
  close(): Promise<void>;
}

/** All-mock environment (§13 defaults) with fresh backend keys. */
export function demoEnv(extra: Env = {}): Env {
  return {
    SOLANA_MODE: 'mock',
    CHAIN_EVENTS_SOURCE: 'mock',
    COMPILER_PROVIDER: 'mock',
    ADVOCATE_PROVIDER: 'mock',
    JUDGE_PROVIDERS: 'mock,mock,mock',
    AGENT_PROVIDER: 'mock',
    PERCEPTION_PROVIDER: 'mock',
    MOCK_SCENARIO: 'pass',
    FEE_PAYER_KEY: secretToBase58(generateKeypair()),
    JUDGE_KEY_0: secretToBase58(generateKeypair()),
    JUDGE_KEY_1: secretToBase58(generateKeypair()),
    JUDGE_KEY_2: secretToBase58(generateKeypair()),
    BIOMETRIC_KEY: '5a'.repeat(32),
    ELEVENLABS_TOOL_SECRET: 'demo-tool-secret',
    HOST: '127.0.0.1',
    PORT: '0',
    LOG_LEVEL: 'warn',
    ...extra,
  };
}

export const DEMO_WORLD_EVENT_ID = 'DEMO-VAN-RAIN-NOV26';

function demoWorldEvent(nowMs: number): WorldEvent {
  return {
    id: DEMO_WORLD_EVENT_ID,
    title: 'Rain in Vancouver on Nov 9',
    category: 'Weather',
    close_time_ms: nowMs + 86_400_000,
    status: 'open',
    contracts: [{ id: `${DEMO_WORLD_EVENT_ID}-YES`, label: 'Yes', prob_bps: 7000, bid_bps: 6900, ask_bps: 7100 }],
  };
}

export async function startHarness(extra: Env = {}): Promise<Harness> {
  const clock = new ManualClock(DEMO_START_MS);
  const config = loadConfig(demoEnv(extra));
  if (config.allowSpend) throw new Error('demo refuses to run with ALLOW_SPEND');
  const worldEvent = demoWorldEvent(clock.nowMs());
  const gemini = new MockGemini(clock, [worldEvent, ...loadGeminiFixtures()]);
  const ctx = createContext(config, { clock, inMemory: true, providers: { gemini } });
  const app = await buildApp(ctx, { startKeeper: true, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no listen address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    app,
    ctx,
    clock,
    baseUrl,
    worldEvent,
    close: async () => {
      await app.close();
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Lets in-flight async work (chain events, perception, booth) run. */
export async function settle(h: Harness, rounds = 4): Promise<void> {
  const chain = h.ctx.chain as unknown as { flushEvents?: () => Promise<void> };
  for (let i = 0; i < rounds; i++) {
    await chain.flushEvents?.();
    await h.ctx.events.idle();
    await sleep(5);
  }
}

/** Advances mock time (the keeper runs on every tick) and settles. */
export async function passTime(h: Harness, ms: number, step = 1000): Promise<void> {
  for (let done = 0; done < ms; done += step) {
    h.clock.advance(Math.min(step, ms - done));
    await settle(h, 2);
  }
}

/**
 * Polls `probe` until it returns a value; between polls mock time moves
 * `stepMs` (keeper ticks) and async work settles. Throws after `maxSteps`.
 */
export async function waitFor<T>(h: Harness, what: string, probe: () => Promise<T | null | undefined | false>, maxSteps = 120, stepMs = 1000): Promise<T> {
  for (let i = 0; i < maxSteps; i++) {
    await settle(h, 2);
    const v = await probe();
    if (v) return v;
    h.clock.advance(stepMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function resolveWorldEvent(h: Harness, result: 'yes' | 'no'): void {
  h.worldEvent.status = 'resolved';
  h.worldEvent.resolution = [{ contract_id: h.worldEvent.contracts[0]!.id, result }];
}
