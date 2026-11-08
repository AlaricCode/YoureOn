/**
 * Provider registry: builds every §13 provider from the config. The spend
 * guard runs first, so a paid mode without ALLOW_SPEND=1 makes startup fail
 * with SPEND_DISABLED before anything is constructed.
 *
 * `overrides` lets tests and the demo inject specific instances.
 */
import type { MockScenario } from '@verdict/engine';
import type { Config } from '../config/load.js';
import { enforceSpendGuard } from '../config/spend.js';
import type { LlmProviderName } from '../config/schema.js';
import { systemClock, type Clock } from '../util/clock.js';
import { MockAdvocate, MockJudge } from './mock/booth.js';
import { MockCompiler } from './mock/compiler.js';
import { MockDetector } from './mock/detector.js';
import { MockGemini, MockHedge } from './mock/gemini.js';
import { MockIdentity } from './mock/identity.js';
import { MockPerception } from './mock/perception.js';
import { MockProver, MockSp1, OffSp1 } from './mock/prover.js';
import { MockAgent, MockSfx, MockStt, MockTts } from './mock/voice.js';
import { ElevenLabsAgent, ElevenLabsSfx, ElevenLabsStt, ElevenLabsTts } from './real/elevenlabs.js';
import { LlmCompiler } from './real/compilerLlm.js';
import { LlmAdvocate, LlmJudge } from './real/boothLlm.js';
import { llmEndpoint } from './real/llm.js';
import { HttpPerception, NosanaPerception } from './real/perception.js';
import { NetworkSp1, SnarkjsProver } from './real/provers.js';
import { HttpDetector, HttpEmbedder } from './real/sidecars.js';
import { LiveGemini, LiveHedge } from './real/world.js';
import type { JudgeProvider, Providers } from './types.js';

export interface ProviderDeps {
  clock?: Clock;
}

function judge(cfg: Config, p: LlmProviderName, i: number): JudgeProvider {
  return p === 'mock' ? new MockJudge() : new LlmJudge(llmEndpoint(cfg, p, `JUDGE_PROVIDERS[${i}]`));
}

export function createProviders(cfg: Config, deps: ProviderDeps = {}, overrides: Partial<Providers> = {}): Providers {
  enforceSpendGuard(cfg);
  const clock = deps.clock ?? systemClock;
  const lazy = <K extends keyof Providers>(k: K, make: () => Providers[K]): Providers[K] =>
    (overrides[k] as Providers[K] | undefined) ?? make();

  return {
    compiler: lazy('compiler', () =>
      cfg.compilerProvider === 'mock' ? new MockCompiler() : new LlmCompiler(llmEndpoint(cfg, cfg.compilerProvider, 'COMPILER_PROVIDER')),
    ),
    advocate: lazy('advocate', () =>
      cfg.advocateProvider === 'mock'
        ? new MockAdvocate()
        : new LlmAdvocate(llmEndpoint(cfg, cfg.advocateProvider, 'ADVOCATE_PROVIDER')),
    ),
    judges: lazy('judges', () => [
      judge(cfg, cfg.judgeProviders[0], 0),
      judge(cfg, cfg.judgeProviders[1], 1),
      judge(cfg, cfg.judgeProviders[2], 2),
    ]),
    agent: lazy('agent', () => (cfg.agentProvider === 'mock' ? new MockAgent() : new ElevenLabsAgent(cfg))),
    stt: lazy('stt', () => (cfg.sttProvider === 'mock' ? new MockStt() : new ElevenLabsStt(cfg))),
    tts: lazy('tts', () => (cfg.ttsProvider === 'mock' ? new MockTts() : new ElevenLabsTts(cfg))),
    sfx: lazy('sfx', () => (cfg.sfxProvider === 'mock' ? new MockSfx() : new ElevenLabsSfx(cfg))),
    perception: lazy('perception', () => {
      switch (cfg.perceptionProvider) {
        case 'mock':
          return new MockPerception(cfg.mockScenario as MockScenario);
        case 'http':
          return new HttpPerception(cfg, { baseUrl: cfg.perceptionUrl });
        case 'nosana':
          return new NosanaPerception(cfg);
      }
    }),
    detector: lazy('detector', () => (cfg.detectorProvider === 'mock' ? new MockDetector() : new HttpDetector(cfg.detectorUrl))),
    identity: lazy('identity', () => (cfg.identityProvider === 'mock' ? new MockIdentity() : new HttpEmbedder(cfg.embedderUrl))),
    gemini: lazy('gemini', () => (cfg.geminiProvider === 'mock' ? new MockGemini(clock) : new LiveGemini(cfg.geminiBaseUrl, { clock }))),
    hedge: lazy('hedge', () => (cfg.geminiHedge === 'mock' ? new MockHedge() : new LiveHedge(cfg))),
    prover: lazy('prover', () => (cfg.prover === 'mock' ? new MockProver() : new SnarkjsProver())),
    sp1: lazy('sp1', () => {
      switch (cfg.sp1Prover) {
        case 'off':
          return new OffSp1();
        case 'mock':
          return new MockSp1();
        case 'network':
          return new NetworkSp1(cfg);
      }
    }),
    mockScenario: (overrides.mockScenario ?? cfg.mockScenario) as MockScenario,
  };
}
