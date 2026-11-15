/**
 * §13 spend guard: every provider mode that can incur cost refuses to start,
 * throwing SPEND_DISABLED, unless `ALLOW_SPEND=1`. Public keyless reads
 * (Gemini events) and Solana devnet are free and allowed.
 */
import { SpendDisabledError } from '../errors.js';
import type { Config } from './load.js';
import { ENUM_VARS } from './schema.js';

export interface SpendingMode {
  /** env var name, e.g. "COMPILER_PROVIDER" or "JUDGE_PROVIDERS[1]" */
  variable: string;
  value: string;
}

const LLM_SPEND: readonly string[] = ENUM_VARS.COMPILER_PROVIDER.spend;

/** Lists every configured mode that can incur cost. */
export function spendingModes(cfg: Config): SpendingMode[] {
  const out: SpendingMode[] = [];
  const add = (variable: string, value: string, spend: readonly string[]) => {
    if (spend.includes(value)) out.push({ variable, value });
  };
  add('COMPILER_PROVIDER', cfg.compilerProvider, ENUM_VARS.COMPILER_PROVIDER.spend);
  add('ADVOCATE_PROVIDER', cfg.advocateProvider, ENUM_VARS.ADVOCATE_PROVIDER.spend);
  cfg.judgeProviders.forEach((j, i) => add(`JUDGE_PROVIDERS[${i}]`, j, LLM_SPEND));
  add('AGENT_PROVIDER', cfg.agentProvider, ENUM_VARS.AGENT_PROVIDER.spend);
  add('STT_PROVIDER', cfg.sttProvider, ENUM_VARS.STT_PROVIDER.spend);
  add('TTS_PROVIDER', cfg.ttsProvider, ENUM_VARS.TTS_PROVIDER.spend);
  add('SFX_PROVIDER', cfg.sfxProvider, ENUM_VARS.SFX_PROVIDER.spend);
  add('PERCEPTION_PROVIDER', cfg.perceptionProvider, ENUM_VARS.PERCEPTION_PROVIDER.spend);
  add('SP1_PROVER', cfg.sp1Prover, ENUM_VARS.SP1_PROVER.spend);
  add('GEMINI_HEDGE', cfg.geminiHedge, ENUM_VARS.GEMINI_HEDGE.spend);
  return out;
}

/** Throws SPEND_DISABLED for `what` unless ALLOW_SPEND=1. Call it in every paid provider's constructor. */
export function assertSpendAllowed(cfg: Pick<Config, 'allowSpend'>, what: string): void {
  if (!cfg.allowSpend) throw new SpendDisabledError(what);
}

/** Startup check: refuses to start if any paid mode is selected without ALLOW_SPEND=1. */
export function enforceSpendGuard(cfg: Config): void {
  if (cfg.allowSpend) return;
  const modes = spendingModes(cfg);
  if (modes.length > 0) {
    throw new SpendDisabledError(modes.map((m) => `${m.variable}=${m.value}`).join(', '));
  }
}
