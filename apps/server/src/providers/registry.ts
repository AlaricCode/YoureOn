// Provider registry: builds deps.providers from the env. The spend guard runs first, so a paid
// mode without ALLOW_SPEND=true fails at boot with SPEND_DISABLED before anything is built.
// Defaults (LLM_PROVIDER / STT_PROVIDER unset) are the offline mocks. SFX_PROVIDER defaults to
// 'auto': ElevenLabs Sound Effects exactly when the stage's voice is on (ELEVENLABS_API_KEY,
// ALLOW_SPEND=true, not STAGE_TTS=off: voice/tts.ts stageAudioGate), else the mock.
//
// Production fail-closed: with NODE_ENV=production the mock LLM (first enum value, confidence
// 0.9) and the mock STT (echoes a caller-supplied transcript) would issue fake rulings that move
// escrow. So in production they are built as refusing stand-ins: boot still works (nothing may
// need them yet), but any call throws MockProviderInProductionError. Set LLM_PROVIDER=live /
// STT_PROVIDER=live (with ALLOW_SPEND=true), or inject an override. The SFX mock (beeps) is
// harmless and stays.
//
// createProviders + overrides: `overrides` lets tests and the demo inject specific instances; an
// overridden capability is not spend-checked, because the caller built it.
import type { Env } from '../env';
import { LiveLlm, type FetchLike } from './live/llm';
import { LiveSfx, LiveStt } from './live/voice';
import { MockLlm } from './mock/llm';
import { MockSfx, MockStt } from './mock/voice';
import { enforceSpendGuard, type ProviderVar } from './spend';
import { stageAudioGate } from '../voice/tts';
import type { LlmProvider, Providers, SttProvider } from './types';

export class MockProviderInProductionError extends Error {
  readonly code = 'MOCK_PROVIDER_IN_PRODUCTION';
  constructor(readonly variable: ProviderVar) {
    super(
      `MOCK_PROVIDER_IN_PRODUCTION: ${variable} is mock under NODE_ENV=production; ` +
        `set ${variable}=live (and ALLOW_SPEND=true) so no fake ruling or transcript is used.`,
    );
    this.name = 'MockProviderInProductionError';
  }
}

/** A mock that refuses every call: what production gets instead of MockLlm. */
const refusingLlm: LlmProvider = {
  name: 'mock',
  chat: () => Promise.reject(new MockProviderInProductionError('LLM_PROVIDER')),
};
/** A mock that refuses every call: what production gets instead of MockStt. */
const refusingStt: SttProvider = {
  name: 'mock',
  transcribe: () => Promise.reject(new MockProviderInProductionError('STT_PROVIDER')),
};

export interface CreateProvidersOptions {
  overrides?: Partial<Providers>;
  /** Injected into every live client (tests only; live modes still need ALLOW_SPEND). */
  fetch?: FetchLike;
}

const VAR_OF: Record<keyof Providers, ProviderVar> = {
  llm: 'LLM_PROVIDER',
  stt: 'STT_PROVIDER',
  sfx: 'SFX_PROVIDER',
};

export function createProviders(env: Env, o: CreateProvidersOptions = {}): Providers {
  const overrides = o.overrides ?? {};
  const overridden = (Object.keys(overrides) as (keyof Providers)[])
    .filter((k) => overrides[k] !== undefined)
    .map((k) => VAR_OF[k]);
  enforceSpendGuard(env, overridden);
  const production = env.NODE_ENV === 'production';
  return {
    llm:
      overrides.llm ??
      (env.LLM_PROVIDER === 'live'
        ? LiveLlm.fromEnv(env, { fetch: o.fetch })
        : production
          ? refusingLlm
          : new MockLlm()),
    stt:
      overrides.stt ??
      (env.STT_PROVIDER === 'live'
        ? LiveStt.fromEnv(env, { fetch: o.fetch })
        : production
          ? refusingStt
          : new MockStt()),
    sfx: overrides.sfx ?? (sfxLive(env) ? LiveSfx.fromEnv(env, { fetch: o.fetch }) : new MockSfx()),
  };
}

/** SFX_PROVIDER=live, or 'auto' with the stage's voice on (the key is set and spend allowed). */
export const sfxLive = (env: Env): boolean =>
  env.SFX_PROVIDER === 'live' || (env.SFX_PROVIDER === 'auto' && stageAudioGate(env).on);

/** Selected modes for the boot log line (no secrets). */
export function providerModes(p: Providers): Record<keyof Providers, string> {
  return { llm: p.llm.name, stt: p.stt.name, sfx: p.sfx.name };
}
