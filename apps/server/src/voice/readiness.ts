// Is the voice judge switched on? GET /v1/demo/voice (X-YO-Demo-Key) and the boot log line
// `voice.readiness`, so the operator can confirm activation without a phone. Config only: no
// ElevenLabs call (a minted conversation token is the start of a billable session), no secret
// values, only which of them are set.
//
// `missing` lists exactly what go-live still needs, in the order docs/ELEVENLABS-GO-LIVE.md does
// it, each entry starting with the setting to fix. `judge_ready` is the narrower "phones get a
// judge" (token mint + webhook tools); `ready` adds the post-call webhook (transcripts archived).
// What config cannot show (the agent synced with today's tools, the webhook entered in the
// ElevenLabs dashboard) is in the go-live doc's checks.
import { DEFAULT_WEBHOOK_TOOLS } from '@youre-on/shared/judge/el-config';
import type { Env } from '../env';
import { EL_WEBHOOK_PATH } from './webhook-signature';

export interface VoiceReadiness {
  /** Go-live: the judge works and the post-call webhook can verify (`missing` is empty). */
  ready: boolean;
  /** Phones will get a judge: POST /v1/voice/tokens can mint and the tools will accept calls. */
  judge_ready: boolean;
  /** What go-live still needs, each entry starting with the setting to fix. */
  missing: string[];
  /** Not needed to go live, but the demo wants it (the Voice Design judge voice). */
  optional: string[];
  agent_id: string | null;
  judge_voice_id: string | null;
  /** The webhook URLs scripts/el-agent.ts registers (they must reach this server). */
  tool_urls: string[];
  /** The post-call webhook URL to enter in ElevenLabs (with ELEVENLABS_WEBHOOK_SECRET). */
  webhook_url: string | null;
  set: {
    ELEVENLABS_API_KEY: boolean;
    ELEVENLABS_AGENT_ID: boolean;
    ELEVENLABS_TOOL_SECRET: boolean;
    ELEVENLABS_WEBHOOK_SECRET: boolean;
    PUBLIC_BASE_URL: boolean;
    ALLOW_SPEND: boolean;
  };
}

/**
 * Why ElevenLabs could not call `baseUrl` (the tools and the post-call webhook), or null.
 * Shared with scripts/el-agent.ts (voice/agent-cli.ts).
 */
export function publicBaseUrlProblem(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return `PUBLIC_BASE_URL is not a URL: ${baseUrl}`;
  }
  if (u.protocol !== 'https:')
    return 'PUBLIC_BASE_URL must be https:// (ElevenLabs calls it from the internet)';
  if (/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(u.hostname))
    return `PUBLIC_BASE_URL ${baseUrl} is not reachable from ElevenLabs`;
  return null;
}

/** `hasClient`: the token route has an ElevenLabs client (production: ALLOW_SPEND=true). */
export function voiceReadiness(env: Env, hasClient: boolean): VoiceReadiness {
  const set = {
    ELEVENLABS_API_KEY: !!env.ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID: !!env.ELEVENLABS_AGENT_ID,
    ELEVENLABS_TOOL_SECRET: !!env.ELEVENLABS_TOOL_SECRET,
    ELEVENLABS_WEBHOOK_SECRET: !!env.ELEVENLABS_WEBHOOK_SECRET,
    PUBLIC_BASE_URL: !!env.PUBLIC_BASE_URL,
    ALLOW_SPEND: env.ALLOW_SPEND === true,
  };
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const urlProblem = base ? publicBaseUrlProblem(base) : null;
  const webhookUrl = base ? `${base}${EL_WEBHOOK_PATH}` : null;

  const judge: string[] = [];
  if (!set.ELEVENLABS_API_KEY)
    judge.push('ELEVENLABS_API_KEY (fly secrets set; scripts/el-agent.ts uses it too)');
  if (!set.ELEVENLABS_TOOL_SECRET)
    judge.push(
      'ELEVENLABS_TOOL_SECRET (openssl rand -base64 32; scripts/el-agent.ts stores it in ElevenLabs as yo-tool-secret)',
    );
  if (!set.PUBLIC_BASE_URL)
    judge.push(
      'PUBLIC_BASE_URL (the public https:// URL ElevenLabs calls, https://youre-on.fly.dev)',
    );
  else if (urlProblem) judge.push(urlProblem);
  if (!set.ELEVENLABS_AGENT_ID) judge.push('ELEVENLABS_AGENT_ID (scripts/el-agent.ts prints it)');
  if (!hasClient) judge.push('ALLOW_SPEND=true (a conversation token starts a billed session)');

  const missing = [...judge];
  if (!set.ELEVENLABS_WEBHOOK_SECRET)
    missing.push(
      `ELEVENLABS_WEBHOOK_SECRET (the signing secret ElevenLabs shows for the post-call webhook ${webhookUrl ?? '<PUBLIC_BASE_URL>' + EL_WEBHOOK_PATH}; transcripts are refused (404) until it is set)`,
    );

  const optional: string[] = [];
  if (!env.ELEVENLABS_JUDGE_VOICE_ID)
    optional.push(
      'ELEVENLABS_JUDGE_VOICE_ID (the Voice Design judge voice; unset = the ElevenLabs default voice; re-run scripts/el-agent.ts after setting it)',
    );

  return {
    ready: missing.length === 0,
    judge_ready: judge.length === 0,
    missing,
    optional,
    agent_id: env.ELEVENLABS_AGENT_ID ?? null,
    judge_voice_id: env.ELEVENLABS_JUDGE_VOICE_ID ?? null,
    tool_urls: base ? DEFAULT_WEBHOOK_TOOLS.map((t) => `${base}/el/tools/${t}`) : [],
    webhook_url: webhookUrl,
    set,
  };
}
