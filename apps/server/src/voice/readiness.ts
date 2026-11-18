// Is the voice judge switched on? GET /v1/demo/voice (X-YO-Demo-Key) and the boot log line
// `voice.readiness`, so the operator can confirm activation without a phone. Config only: no
// ElevenLabs call (a minted conversation token is the start of a billable session), no secret
// values, only which of them are set.
import { DEFAULT_WEBHOOK_TOOLS } from '@youre-on/shared/judge/el-config';
import type { Env } from '../env';

export interface VoiceReadiness {
  /** Phones will get a judge: POST /v1/voice/tokens can mint and the tools will accept calls. */
  ready: boolean;
  /** What is missing, as the env setting to fix. */
  missing: string[];
  agent_id: string | null;
  judge_voice_id: string | null;
  /** The webhook URLs scripts/el-agent.ts registers (they must reach this server). */
  tool_urls: string[];
  set: {
    ELEVENLABS_API_KEY: boolean;
    ELEVENLABS_AGENT_ID: boolean;
    ELEVENLABS_TOOL_SECRET: boolean;
    PUBLIC_BASE_URL: boolean;
    ALLOW_SPEND: boolean;
  };
}

/** `hasClient`: the token route has an ElevenLabs client (production: ALLOW_SPEND=true). */
export function voiceReadiness(env: Env, hasClient: boolean): VoiceReadiness {
  const set = {
    ELEVENLABS_API_KEY: !!env.ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID: !!env.ELEVENLABS_AGENT_ID,
    ELEVENLABS_TOOL_SECRET: !!env.ELEVENLABS_TOOL_SECRET,
    PUBLIC_BASE_URL: !!env.PUBLIC_BASE_URL,
    ALLOW_SPEND: env.ALLOW_SPEND === true,
  };
  const missing: string[] = [];
  if (!set.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
  if (!set.ELEVENLABS_AGENT_ID) missing.push('ELEVENLABS_AGENT_ID (scripts/el-agent.ts prints it)');
  if (!set.ELEVENLABS_TOOL_SECRET) missing.push('ELEVENLABS_TOOL_SECRET');
  if (!set.PUBLIC_BASE_URL) missing.push('PUBLIC_BASE_URL');
  if (!hasClient) missing.push('ALLOW_SPEND=true');
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return {
    ready: missing.length === 0,
    missing,
    agent_id: env.ELEVENLABS_AGENT_ID ?? null,
    judge_voice_id: env.ELEVENLABS_JUDGE_VOICE_ID ?? null,
    tool_urls: base ? DEFAULT_WEBHOOK_TOOLS.map((t) => `${base}/el/tools/${t}`) : [],
    set,
  };
}
