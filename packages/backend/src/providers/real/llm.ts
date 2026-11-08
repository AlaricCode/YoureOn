/**
 * Paid LLM endpoint resolution (anthropic | openai | gemini | xai). This
 * module only resolves the base URL + API key and asserts the spend guard
 * (SPEND_DISABLED unless ALLOW_SPEND=1). The real providers live in
 * compilerLlm.ts (compiler) and boothLlm.ts (advocates + judges).
 */
import { assertSpendAllowed } from '../../config/spend.js';
import type { Config } from '../../config/load.js';
import type { LlmProviderName } from '../../config/schema.js';

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
