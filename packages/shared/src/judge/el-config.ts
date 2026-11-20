// ElevenLabs agent-as-code (TASKS D0-J2 "agent settings"; API-CONTRACT §4.1–§4.4).
// Pure builders of the JSON bodies scripts/el-agent.ts sends. Field names follow the live
// ElevenLabs OpenAPI (https://api.elevenlabs.io/openapi.json):
//   POST /v1/convai/secrets        PostWorkspaceSecretRequest {type:'new', name, value}
//   POST /v1/convai/tools          ToolRequestModel {tool_config: WebhookToolConfig | ClientToolConfig}
//   POST /v1/convai/agents/create  {name, tags, conversation_config, platform_settings}
// Inline `prompt.tools` is deprecated in that schema ("use tool_ids instead"), so tools are
// standalone resources referenced by `prompt.tool_ids`.
import {
  ID_PROPERTIES,
  PROPOSE_TERMS_BODY_SCHEMA,
  PROPOSE_TERMS_DESCRIPTION,
  type ElObjectProperty,
} from './propose-terms';
import type { ElReasoningEffort, ElTtsModel } from './el-enums';
import { SUGGEST_ODDS_BODY_SCHEMA, SUGGEST_ODDS_DESCRIPTION } from './suggest-odds';
import {
  ASR_KEYWORDS,
  buildJudgePrompt,
  DYNAMIC_VARIABLE_PLACEHOLDERS,
  FIRST_MESSAGE,
  JUDGE_AGENT_NAME,
  SOFT_TIMEOUT_FILLERS,
  type JudgeToolName,
} from './persona';

export const TOOL_SECRET_HEADER = 'X-YO-Tool-Secret';
/**
 * In ElevenLabs' `LLM` enum (./el-enums, read 2026-11-18), so the Agents platform
 * serves it; whether it is really Haiku 5.5 that answers shows in post-call
 * metadata.charging.llm_usage (API-CONTRACT §4.6). el-agent --llm / ELEVENLABS_AGENT_LLM overrides.
 */
export const DEFAULT_AGENT_LLM = 'claude-haiku-5-5';
/**
 * The lowest effort the Anthropic API accepts on Claude Haiku 5.5 ('low'..'max'; it has no
 * 'none' / 'minimal', and its own default is 'medium'). ElevenLabs proxies the value.
 */
export const DEFAULT_REASONING_EFFORT: ElReasoningEffort = 'low';
/**
 * The agent LLM's output cap per turn. Not 300: Claude Haiku 5.5 thinks adaptively by default
 * (reasoning_effort 'low' only lowers it) and thinking counts against max_tokens, on top of the
 * pre-tool speech and a complete propose_terms call (the whole bet as tool arguments, ~170
 * tokens for 01-bottle-flip). A cut-off tool call (stop_reason max_tokens) would break the
 * read-back, and backup_llm_config is disabled. The prompt keeps the spoken reply short.
 */
export const AGENT_MAX_TOKENS = 1024;
export const DEFAULT_TTS_MODEL: ElTtsModel = 'eleven_v4_turbo';
export const TOOL_SECRET_NAME = 'yo-tool-secret';
export const AGENT_TAGS = ['youre-on'];

export type WebhookToolName =
  | 'propose_terms'
  | 'confirm_terms'
  | 'open_hearing'
  | 'get_market_odds'
  | 'request_review'
  | 'suggest_odds';
export type ClientToolName = 'request_attempt' | 'show_terms_card' | 'cue';

/**
 * Webhook tools registered today. Each name here must have a live `/el/tools/<name>` handler,
 * otherwise a call would hit a 404 mid-conversation (apps/server test/el-agent.test.ts checks the
 * route table). propose_terms (D0-J2), confirm_terms (D1-J1), get_market_odds (Beat 6,
 * apps/server/src/markets/voice-tool.ts) and request_review (the spoken "check that again",
 * apps/server/src/review/tool.ts) and suggest_odds (odds, apps/server/src/odds/voice-tool.ts) are
 * live; open_hearing later. There is no
 * file_appeal tool: the mic can't tell who spoke, so the judge only asks the loser's phone
 * (request_review) and the loser files the appeal there (tap + Face ID).
 */
export const DEFAULT_WEBHOOK_TOOLS: readonly WebhookToolName[] = [
  'propose_terms',
  'confirm_terms',
  'get_market_odds',
  'request_review',
  // Odds (apps/server/src/odds/voice-tool.ts, POST /el/tools/suggest_odds).
  'suggest_odds',
];
export const CLIENT_TOOLS: readonly ClientToolName[] = [
  'request_attempt',
  'show_terms_card',
  'cue',
];

interface WebhookSpec {
  description: string;
  pre_tool_speech: 'auto' | 'force' | 'off';
  body: ElObjectProperty;
}

const idsOnly = (
  extra: ElObjectProperty['properties'] = {},
  required: string[] = [],
): ElObjectProperty => ({
  type: 'object',
  required,
  properties: { ...ID_PROPERTIES, ...extra },
});

/** API-CONTRACT §4.3, per tool. */
export const WEBHOOK_TOOL_SPECS: Record<WebhookToolName, WebhookSpec> = {
  propose_terms: {
    description: PROPOSE_TERMS_DESCRIPTION,
    pre_tool_speech: 'force',
    body: PROPOSE_TERMS_BODY_SCHEMA,
  },
  confirm_terms: {
    description:
      'After the read-back, when both parties said yes out loud. Not binding: both must still confirm on their own phones.',
    pre_tool_speech: 'off',
    body: idsOnly(
      {
        heard: {
          type: 'string',
          enum: ['A', 'B', 'both', 'none'],
          description: "Who said 'accept' out loud. Theatre only; it is logged, not binding.",
        },
      },
      ['heard'],
    ),
  },
  open_hearing: {
    description: 'Right after [EVENT] HEARING_REQUIRED: opens the first argument turn.',
    pre_tool_speech: 'off',
    body: idsOnly(),
  },
  get_market_odds: {
    description: 'Quote the Gemini Bitcoin 5-minute odds before proposing a real_world bet.',
    pre_tool_speech: 'force',
    body: idsOnly(
      {
        asset: { type: 'string', enum: ['BTC'], description: 'Always BTC.' },
        horizon: { type: 'string', enum: ['5m'], description: 'Always 5m.' },
        a_side: {
          type: 'string',
          enum: ['YES', 'NO'],
          description: "A's side. YES = Bitcoin finishes at or above the line.",
        },
        amount_usd: { type: 'string', description: "Even-money stake per person, e.g. '5'." },
      },
      ['asset', 'horizon', 'a_side', 'amount_usd'],
    ),
  },
  request_review: {
    description:
      'After [EVENT] RULING, when anyone asks to check the ruling again ("check that again", "that\'s wrong, review it", "replay", "I appeal"). Files and decides nothing: the court asks the losing player\'s phone to confirm. Speak the reply\'s "say". Never after [EVENT] PAID or [EVENT] VOIDED: the bet is over.',
    pre_tool_speech: 'off',
    body: idsOnly(
      {
        heard: {
          type: 'string',
          description: 'What you heard, a few words, e.g. "check that again".',
        },
      },
      ['heard'],
    ),
  },
  suggest_odds: {
    description: SUGGEST_ODDS_DESCRIPTION,
    pre_tool_speech: 'force',
    body: SUGGEST_ODDS_BODY_SCHEMA,
  },
};

/**
 * Built-in system tool (prompt.built_in_tools.skip_turn): the judge stays quiet for room noise in
 * the ruling window. wait_timeout_secs -1: silent until someone speaks again.
 */
export const SKIP_TURN_TOOL = {
  type: 'system',
  name: 'skip_turn',
  description:
    'Stay silent this turn: the room is only celebrating or chatting after a ruling, or the camera is counting down.',
  pre_tool_speech: 'off',
  params: { system_tool_type: 'skip_turn', wait_timeout_secs: -1 },
} as const;

/** API-CONTRACT §4.2 tool settings + §4.3 schema. `baseUrl` = PUBLIC_BASE_URL. */
export function webhookToolConfig(name: WebhookToolName, baseUrl: string, secretId: string) {
  const spec = WEBHOOK_TOOL_SPECS[name];
  return {
    type: 'webhook' as const,
    name,
    description: spec.description,
    response_timeout_secs: 5,
    interruption_mode: 'allow' as const,
    pre_tool_speech: spec.pre_tool_speech,
    tool_error_handling_mode: 'passthrough' as const,
    execution_mode: 'immediate' as const,
    api_schema: {
      url: `${baseUrl.replace(/\/+$/, '')}/el/tools/${name}`,
      method: 'POST' as const,
      content_type: 'application/json' as const,
      request_headers: { [TOOL_SECRET_HEADER]: { secret_id: secretId } },
      request_body_schema: spec.body,
    },
  };
}

/** API-CONTRACT §4.4 client tools (handled on A's phone). */
export function clientToolConfig(name: ClientToolName) {
  switch (name) {
    case 'request_attempt':
      return {
        type: 'client' as const,
        name,
        description:
          'Arms the judge camera. Only right after [EVENT] LOCKED or [EVENT] REDO, with the attempt number it gives.',
        expects_response: true,
        response_timeout_secs: 5,
        parameters: {
          type: 'object' as const,
          required: ['attempt_no'],
          properties: {
            attempt_no: {
              type: 'integer' as const,
              description: '1 for the first try; +1 after Run it back',
            },
          },
        },
      };
    case 'show_terms_card':
      return {
        type: 'client' as const,
        name,
        description: "Brings the terms card to the front of A's phone and the stage.",
        expects_response: false,
      };
    case 'cue':
      return {
        type: 'client' as const,
        name,
        description: 'Plays a sound effect on the stage.',
        expects_response: false,
        parameters: {
          type: 'object' as const,
          required: ['kind'],
          properties: {
            kind: {
              type: 'string' as const,
              enum: ['gavel', 'drumroll', 'buzzer', 'cheer'],
              description:
                'gavel for a ruling, drumroll before a reveal, buzzer for a foul, cheer for a payout.',
            },
          },
        },
      };
  }
}

/** `{tool_config}` body for POST/PATCH /v1/convai/tools. */
export const toolRequest = (tool_config: object) => ({ tool_config });

/** The client_events the phone needs (API-CONTRACT §4.1 list, plus the SDK's own plumbing). */
export const CLIENT_EVENTS = [
  // API-CONTRACT §4.1 "must include"
  'agent_response',
  'user_transcript',
  'agent_tool_request',
  'agent_tool_response',
  'client_tool_call',
  'interruption',
  'vad_score',
  // Listing client_events replaces the default set (client_events must be listed
  // explicitly to arrive), so the session plumbing is kept explicitly too.
  'conversation_initiation_metadata',
  'ping',
  'audio',
  'agent_response_correction',
] as const;

export interface AgentOptions {
  toolIds: string[];
  /** ELEVENLABS_JUDGE_VOICE_ID (Voice Design voice). Omitted -> the ElevenLabs default voice. */
  voiceId?: string;
  /** Default DEFAULT_AGENT_LLM unless the caller picks another. */
  llm?: string;
  /** Default DEFAULT_REASONING_EFFORT; null omits the field (the model's own default). */
  reasoningEffort?: ElReasoningEffort | null;
  /** The tools the prompt mentions (registered webhook tools + client tools). */
  promptTools: ReadonlySet<JudgeToolName>;
  /** DATA-MODEL §10 "minimum available" retention (PENDING-KEY: check the dashboard minimum). */
  retentionDays?: number;
  /** Default DEFAULT_TTS_MODEL (A/B: eleven_flash_v2). */
  ttsModel?: ElTtsModel;
  /**
   * Default JUDGE_AGENT_NAME / AGENT_TAGS. Only a throwaway test agent sets these
   * (scripts/el-agent.ts --agent-name, scripts/el-review-eval.ts); the live judge never does.
   */
  name?: string;
  tags?: readonly string[];
}

/** Body for POST /v1/convai/agents/create and PATCH /v1/convai/agents/{id}. */
export function agentBody(o: AgentOptions) {
  const prompt: Record<string, unknown> = {
    prompt: buildJudgePrompt(o.promptTools),
    llm: o.llm ?? DEFAULT_AGENT_LLM,
    // Explicit null: the schema default is 0.0, and "null omits the parameter from the LLM
    // request entirely". Claude 5.x rejects non-default sampling values, which
    // would otherwise silently cascade to a backup model.
    temperature: null,
    max_tokens: AGENT_MAX_TOKENS,
    enable_parallel_tool_calls: false,
    backup_llm_config: { preference: 'disabled' },
    tool_ids: o.toolIds,
    ignore_default_personality: true,
  };
  const effort = o.reasoningEffort === undefined ? DEFAULT_REASONING_EFFORT : o.reasoningEffort;
  if (effort !== null) prompt.reasoning_effort = effort;
  if (o.promptTools.has('skip_turn')) prompt.built_in_tools = { skip_turn: SKIP_TURN_TOOL };

  const tts: Record<string, unknown> = {
    model_id: o.ttsModel ?? DEFAULT_TTS_MODEL,
    agent_output_audio_format: 'pcm_16000',
    speed: 1.05,
  };
  if (o.voiceId) tts.voice_id = o.voiceId;

  return {
    name: o.name ?? JUDGE_AGENT_NAME,
    tags: [...(o.tags ?? AGENT_TAGS)],
    conversation_config: {
      agent: {
        first_message: FIRST_MESSAGE,
        language: 'en',
        dynamic_variables: { dynamic_variable_placeholders: { ...DYNAMIC_VARIABLE_PLACEHOLDERS } },
        prompt,
      },
      tts,
      asr: {
        provider: 'scribe_realtime',
        quality: 'high',
        user_input_audio_format: 'pcm_16000',
        keywords: [...ASR_KEYWORDS],
      },
      turn: {
        turn_eagerness: 'eager',
        speculative_turn: true,
        turn_timeout: 25,
        soft_timeout_config: {
          timeout_seconds: 1.1,
          message: SOFT_TIMEOUT_FILLERS[0],
          additional_soft_timeout_messages: SOFT_TIMEOUT_FILLERS.slice(1),
          max_soft_timeouts_per_generation: 2,
        },
      },
      conversation: {
        max_duration_seconds: 1200,
        client_events: [...CLIENT_EVENTS],
      },
    },
    platform_settings: {
      auth: { enable_auth: true },
      call_limits: { bursting_enabled: false },
      privacy: { record_voice: false, retention_days: o.retentionDays ?? 1 },
      // No client overrides: the app sends only the token and dynamic variables, and a token
      // holder must not pick a costlier LLM / TTS model or rewrite the opening line. Explicit
      // false, so a sync also turns them off on the existing agent.
      overrides: {
        conversation_config_override: {
          agent: { first_message: false, prompt: { llm: false } },
          tts: { model_id: false },
        },
      },
    },
  };
}
