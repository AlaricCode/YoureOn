/**
 * Real LLM providers (anthropic | openai | gemini | xai) for the compiler,
 * advocates and judges. These cost money: constructing one asserts the spend
 * guard (SPEND_DISABLED unless ALLOW_SPEND=1) and requires the API key.
 *
 * TODO(compiler agent): implement LlmCompiler.compile (prompt → surface YAML,
 *   questions ≤ 6 words, labels, title ≤ 40 chars) per §2.5/§12.2.
 * Booth advocates/judges: implemented in boothLlm.ts (the registry uses those;
 *   the classes below are the original scaffold placeholders).
 */
import { assertSpendAllowed } from '../../config/spend.js';
import type { Config } from '../../config/load.js';
import type { LlmProviderName } from '../../config/schema.js';
import { NotImplementedError } from '../../errors.js';
import type {
  AdvocateBrief,
  AdvocateProvider,
  BoothCase,
  CompileRequest,
  CompileResult,
  CompilerProvider,
  JudgeProvider,
  JudgeVote,
} from '../types.js';

export interface LlmEndpoint {
  provider: Exclude<LlmProviderName, 'mock'>;
  apiKey: string;
  baseUrl: string;
}

const BASE_URLS: Record<Exclude<LlmProviderName, 'mock'>, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  xai: 'https://api.x.ai',
};

/** Resolves credentials for a paid LLM provider after checking the spend guard. */
export function llmEndpoint(cfg: Config, provider: Exclude<LlmProviderName, 'mock'>, role: string): LlmEndpoint {
  assertSpendAllowed(cfg, `${role}=${provider}`);
  const key = {
    anthropic: cfg.apiKeys.anthropic,
    openai: cfg.apiKeys.openai,
    gemini: cfg.apiKeys.google,
    xai: cfg.apiKeys.xai,
  }[provider];
  if (!key) throw new Error(`${role}=${provider} requires its API key (see .env.example)`);
  return { provider, apiKey: key, baseUrl: BASE_URLS[provider] };
}

export class LlmCompiler implements CompilerProvider {
  readonly name: string;
  constructor(readonly endpoint: LlmEndpoint) {
    this.name = endpoint.provider;
  }
  async compile(_req: CompileRequest): Promise<CompileResult> {
    throw new NotImplementedError(`COMPILER_PROVIDER=${this.name}`);
  }
}

export class LlmAdvocate implements AdvocateProvider {
  readonly name: string;
  constructor(readonly endpoint: LlmEndpoint) {
    this.name = endpoint.provider;
  }
  async brief(_c: BoothCase, _side: 0 | 1, _slots: number): Promise<AdvocateBrief> {
    throw new NotImplementedError(`ADVOCATE_PROVIDER=${this.name}`);
  }
}

export class LlmJudge implements JudgeProvider {
  readonly name: string;
  readonly videoNative: boolean;
  constructor(readonly endpoint: LlmEndpoint) {
    this.name = endpoint.provider;
    this.videoNative = endpoint.provider === 'gemini';
  }
  async judge(_c: BoothCase, _briefs: AdvocateBrief[], _j: number): Promise<JudgeVote> {
    throw new NotImplementedError(`JUDGE_PROVIDERS ${this.name}`);
  }
}
