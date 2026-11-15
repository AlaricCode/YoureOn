/**
 * §13 configuration table. Every external dependency is selected by an env
 * var whose default is `mock`/`off`, so tests and the demo run offline with no
 * keys and no money.
 *
 * Rows marked `spend` list the values that can incur cost; selecting one of
 * them without `ALLOW_SPEND=1` makes the backend refuse to start
 * (`SPEND_DISABLED`, see spend.ts).
 */

export const LLM_PROVIDERS = ['mock', 'anthropic', 'openai', 'gemini', 'xai'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/** Judge providers whose model takes clips as video (J0 must be one, §10.3). */
export const VIDEO_CAPABLE_JUDGES: readonly LlmProviderName[] = ['mock', 'gemini'];

export const MOCK_SCENARIOS = [
  'pass',
  'fail',
  'cross_fail',
  'motion',
  'low_conf',
  'no_identity',
  'oversize',
  'occlusion',
] as const;
export type MockScenarioName = (typeof MOCK_SCENARIOS)[number];

export interface EnumVar {
  name: string;
  values: readonly string[];
  /** values[0] is the default */
  spend: readonly string[];
  doc: string;
}

/** Single-valued enum rows of the §13 table (+ GEMINI_HEDGE for §11.6). */
export const ENUM_VARS = {
  SOLANA_MODE: {
    name: 'SOLANA_MODE',
    values: ['mock', 'devnet'],
    spend: [],
    doc: 'In-memory chain implementing §9 with the engine chainModel, or Solana devnet (free)',
  },
  CHAIN_EVENTS_SOURCE: {
    name: 'CHAIN_EVENTS_SOURCE',
    values: ['mock', 'quicknode', 'rpc_ws'],
    spend: [],
    doc: 'Where chain events come from (§12.5)',
  },
  COMPILER_PROVIDER: {
    name: 'COMPILER_PROVIDER',
    values: LLM_PROVIDERS,
    spend: ['anthropic', 'openai', 'gemini', 'xai'],
    doc: 'Speech → YAML compiler (mock = keyword templates)',
  },
  ADVOCATE_PROVIDER: {
    name: 'ADVOCATE_PROVIDER',
    values: LLM_PROVIDERS,
    spend: ['anthropic', 'openai', 'gemini', 'xai'],
    doc: 'Replay-booth advocates (§10.2)',
  },
  AGENT_PROVIDER: {
    name: 'AGENT_PROVIDER',
    values: ['mock', 'elevenlabs'],
    spend: ['elevenlabs'],
    doc: 'Conversational agent for dictation',
  },
  STT_PROVIDER: { name: 'STT_PROVIDER', values: ['mock', 'elevenlabs'], spend: ['elevenlabs'], doc: 'Speech to text' },
  TTS_PROVIDER: { name: 'TTS_PROVIDER', values: ['mock', 'elevenlabs'], spend: ['elevenlabs'], doc: 'Text to speech' },
  SFX_PROVIDER: { name: 'SFX_PROVIDER', values: ['mock', 'elevenlabs'], spend: ['elevenlabs'], doc: 'Start sound' },
  PERCEPTION_PROVIDER: {
    name: 'PERCEPTION_PROVIDER',
    values: ['mock', 'nosana', 'http'],
    spend: ['nosana', 'http'],
    doc: 'Perception jobs (§6.0); mock = engine.simulate',
  },
  MOCK_SCENARIO: {
    name: 'MOCK_SCENARIO',
    values: MOCK_SCENARIOS,
    spend: [],
    doc: 'Drives engine.simulate and the booth paths',
  },
  DETECTOR_PROVIDER: {
    name: 'DETECTOR_PROVIDER',
    values: ['mock', 'http'],
    spend: [],
    doc: 'Scene-check detector (local sidecar when http)',
  },
  IDENTITY_PROVIDER: {
    name: 'IDENTITY_PROVIDER',
    values: ['mock', 'http'],
    spend: [],
    doc: 'Face/voice embedder (local sidecar services/embedder when http, free)',
  },
  GEMINI_PROVIDER: {
    name: 'GEMINI_PROVIDER',
    values: ['mock', 'live'],
    spend: [],
    doc: 'Gemini prediction-market events (live = public keyless REST/WS, free)',
  },
  GEMINI_HEDGE: {
    name: 'GEMINI_HEDGE',
    values: ['mock', 'live'],
    spend: ['live'],
    doc: 'World hedge orders (§11.6); live targets the Gemini demo environment via OAuth',
  },
  PROVER: {
    name: 'PROVER',
    values: ['mock', 'snarkjs'],
    spend: [],
    doc: 'Biometric Groth16 prover (snarkjs = in-process, offline, needs circuits/build)',
  },
  SP1_PROVER: {
    name: 'SP1_PROVER',
    values: ['off', 'mock', 'network'],
    spend: ['network'],
    doc: 'SP1 prover: not implemented (D-9); any value is treated as off with a startup warning (network still needs ALLOW_SPEND)',
  },
} as const satisfies Record<string, EnumVar>;

export type EnumVarName = keyof typeof ENUM_VARS;
export type EnumValue<N extends EnumVarName> = (typeof ENUM_VARS)[N]['values'][number];

/** Default judge triple (§13 `JUDGE_PROVIDERS`). */
export const DEFAULT_JUDGE_PROVIDERS = 'mock,mock,mock';

/** Keys generated into `.env` on first run (§13). BIOMETRIC_KEY is generated too (see errata). */
export const GENERATED_KEY_VARS = ['FEE_PAYER_KEY', 'JUDGE_KEY_0', 'JUDGE_KEY_1', 'JUDGE_KEY_2'] as const;
export const GENERATED_HEX_VARS = ['BIOMETRIC_KEY'] as const;

/** Defaults for plain string variables. */
export const STRING_DEFAULTS = {
  PORT: '8787',
  HOST: '0.0.0.0',
  PUBLIC_URL: '',
  DATA_DIR: './.data',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  SOLANA_WS_URL: '',
  GEMINI_BASE_URL: 'https://api.gemini.com',
  PERCEPTION_URL: '',
  NOSANA_API_URL: '',
  NOSANA_PERCEPTION_IMAGE: '',
  NOSANA_MARKETS: '',
  EMBEDDER_URL: 'http://127.0.0.1:8090',
  DETECTOR_URL: 'http://127.0.0.1:8091',
  LOG_LEVEL: 'info',
} as const;
