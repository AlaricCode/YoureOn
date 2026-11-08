/**
 * Builds the typed backend Config from an env map (§13). Pure apart from
 * reading the IDL for the default program ID; `.env` handling lives in
 * dotenv.ts and is applied by the caller before this runs.
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { generateKeypair, type KeyPair, keypairFromSecret } from '../crypto/keys.js';
import { defaultProgramId } from '../chain/idl.js';
import { isPubkey } from '../util/bytes.js';
import {
  DEFAULT_JUDGE_PROVIDERS,
  ENUM_VARS,
  type EnumValue,
  type EnumVarName,
  LLM_PROVIDERS,
  type LlmProviderName,
  STRING_DEFAULTS,
  VIDEO_CAPABLE_JUDGES,
} from './schema.js';

export type Env = Record<string, string | undefined>;

export interface KeySet {
  feePayer: KeyPair;
  /** defaults to feePayer when ORACLE_KEY is unset (§9.1) */
  oracle: KeyPair;
  judges: [KeyPair, KeyPair, KeyPair];
}

export interface ApiKeys {
  anthropic: string | null;
  openai: string | null;
  /** Google AI (LLM provider "gemini"); not the Gemini exchange */
  google: string | null;
  xai: string | null;
  elevenlabs: string | null;
  elevenlabsAgentId: string | null;
  nosana: string | null;
  sp1: string | null;
}

export interface Config {
  port: number;
  host: string;
  /** Externally reachable base URL (no trailing slash), used for upload/download URLs. */
  publicUrl: string;
  dataDir: string;
  logLevel: string;

  solanaMode: EnumValue<'SOLANA_MODE'>;
  chainEventsSource: EnumValue<'CHAIN_EVENTS_SOURCE'>;
  compilerProvider: EnumValue<'COMPILER_PROVIDER'>;
  advocateProvider: EnumValue<'ADVOCATE_PROVIDER'>;
  judgeProviders: [LlmProviderName, LlmProviderName, LlmProviderName];
  agentProvider: EnumValue<'AGENT_PROVIDER'>;
  sttProvider: EnumValue<'STT_PROVIDER'>;
  ttsProvider: EnumValue<'TTS_PROVIDER'>;
  sfxProvider: EnumValue<'SFX_PROVIDER'>;
  perceptionProvider: EnumValue<'PERCEPTION_PROVIDER'>;
  mockScenario: EnumValue<'MOCK_SCENARIO'>;
  detectorProvider: EnumValue<'DETECTOR_PROVIDER'>;
  identityProvider: EnumValue<'IDENTITY_PROVIDER'>;
  geminiProvider: EnumValue<'GEMINI_PROVIDER'>;
  geminiHedge: EnumValue<'GEMINI_HEDGE'>;
  prover: EnumValue<'PROVER'>;
  sp1Prover: EnumValue<'SP1_PROVER'>;

  /** `ALLOW_SPEND=1` */
  allowSpend: boolean;

  programId: string;
  usdcMint: string | null;
  solanaRpcUrl: string;
  solanaWsUrl: string;
  geminiBaseUrl: string;
  perceptionUrl: string;
  embedderUrl: string;
  detectorUrl: string;

  quicknodeSecret: string | null;
  elevenlabsToolSecret: string | null;
  biometricKey: Uint8Array;
  keys: KeySet;
  apiKeys: ApiKeys;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export interface LoadOptions {
  /**
   * Generate missing keys in memory instead of failing (tests). The server
   * entry point writes them to `.env` first (dotenv.ts), so this is off there.
   */
  ephemeralKeys?: boolean;
  /** Base directory for a relative DATA_DIR (default: process.cwd()). */
  cwd?: string;
}

const str = (env: Env, k: string): string | null => {
  const v = env[k];
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

export function loadConfig(env: Env, opts: LoadOptions = {}): Config {
  const problems: string[] = [];

  const enumVar = <N extends EnumVarName>(n: N): EnumValue<N> => {
    const spec = ENUM_VARS[n];
    const v = str(env, n);
    if (v === null) return spec.values[0] as EnumValue<N>;
    if (!(spec.values as readonly string[]).includes(v)) {
      problems.push(`${n}=${v} is not one of ${spec.values.join('|')}`);
      return spec.values[0] as EnumValue<N>;
    }
    return v as EnumValue<N>;
  };
  const s = (k: keyof typeof STRING_DEFAULTS): string => str(env, k) ?? STRING_DEFAULTS[k];

  // ALLOW_SPEND: unset | 1. Anything else is a mistake, never an implicit "yes".
  const allowRaw = str(env, 'ALLOW_SPEND');
  if (allowRaw !== null && allowRaw !== '1') problems.push(`ALLOW_SPEND=${allowRaw} must be unset or 1`);
  const allowSpend = allowRaw === '1';

  // JUDGE_PROVIDERS: comma list of exactly 3; J0 must be video-capable (§10.3).
  const judgesRaw = str(env, 'JUDGE_PROVIDERS') ?? DEFAULT_JUDGE_PROVIDERS;
  const judgeList = judgesRaw.split(',').map((x) => x.trim());
  let judgeProviders: [LlmProviderName, LlmProviderName, LlmProviderName] = ['mock', 'mock', 'mock'];
  if (judgeList.length !== 3) {
    problems.push(`JUDGE_PROVIDERS must list exactly 3 providers, got "${judgesRaw}"`);
  } else if (judgeList.some((j) => !(LLM_PROVIDERS as readonly string[]).includes(j))) {
    problems.push(`JUDGE_PROVIDERS entries must be one of ${LLM_PROVIDERS.join('|')}, got "${judgesRaw}"`);
  } else {
    judgeProviders = judgeList as typeof judgeProviders;
    if (!VIDEO_CAPABLE_JUDGES.includes(judgeProviders[0])) {
      problems.push(`JUDGE_PROVIDERS: J0 (${judgeProviders[0]}) must be video-capable (${VIDEO_CAPABLE_JUDGES.join('|')})`);
    }
  }

  const portRaw = s('PORT');
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push(`PORT=${portRaw} is not a valid port`);

  const programId = str(env, 'VERDICT_PROGRAM_ID') ?? defaultProgramId();
  if (!isPubkey(programId)) problems.push(`VERDICT_PROGRAM_ID=${programId} is not a base58 public key`);
  const usdcMint = str(env, 'USDC_MINT');
  if (usdcMint !== null && !isPubkey(usdcMint)) problems.push(`USDC_MINT=${usdcMint} is not a base58 public key`);

  // Keys (§13): base58 64-byte secret keys; ORACLE_KEY defaults to FEE_PAYER_KEY.
  const key = (k: string, required: boolean): KeyPair | null => {
    const v = str(env, k);
    if (v === null) {
      if (!required) return null;
      if (opts.ephemeralKeys) return generateKeypair();
      problems.push(`${k} is missing (run the server once to generate .env, or set it)`);
      return null;
    }
    try {
      return keypairFromSecret(v);
    } catch (e) {
      problems.push(`${k}: ${(e as Error).message}`);
      return null;
    }
  };
  const feePayer = key('FEE_PAYER_KEY', true);
  const oracle = key('ORACLE_KEY', false) ?? feePayer;
  const judges = [key('JUDGE_KEY_0', true), key('JUDGE_KEY_1', true), key('JUDGE_KEY_2', true)];

  let biometricKey = new Uint8Array(32);
  const bk = str(env, 'BIOMETRIC_KEY');
  if (bk === null) {
    if (opts.ephemeralKeys) biometricKey = new Uint8Array(randomBytes(32));
    else problems.push('BIOMETRIC_KEY is missing (32-byte hex)');
  } else if (!/^[0-9a-fA-F]{64}$/.test(bk)) {
    problems.push('BIOMETRIC_KEY must be 32-byte hex (64 hex chars)');
  } else {
    biometricKey = new Uint8Array(Buffer.from(bk, 'hex'));
  }

  const cfg = {
    port,
    host: s('HOST'),
    publicUrl: '',
    dataDir: '',
    logLevel: s('LOG_LEVEL'),
    solanaMode: enumVar('SOLANA_MODE'),
    chainEventsSource: enumVar('CHAIN_EVENTS_SOURCE'),
    compilerProvider: enumVar('COMPILER_PROVIDER'),
    advocateProvider: enumVar('ADVOCATE_PROVIDER'),
    judgeProviders,
    agentProvider: enumVar('AGENT_PROVIDER'),
    sttProvider: enumVar('STT_PROVIDER'),
    ttsProvider: enumVar('TTS_PROVIDER'),
    sfxProvider: enumVar('SFX_PROVIDER'),
    perceptionProvider: enumVar('PERCEPTION_PROVIDER'),
    mockScenario: enumVar('MOCK_SCENARIO'),
    detectorProvider: enumVar('DETECTOR_PROVIDER'),
    identityProvider: enumVar('IDENTITY_PROVIDER'),
    geminiProvider: enumVar('GEMINI_PROVIDER'),
    geminiHedge: enumVar('GEMINI_HEDGE'),
    prover: enumVar('PROVER'),
    sp1Prover: enumVar('SP1_PROVER'),
    allowSpend,
    programId,
    usdcMint,
    solanaRpcUrl: s('SOLANA_RPC_URL'),
    solanaWsUrl: s('SOLANA_WS_URL'),
    geminiBaseUrl: s('GEMINI_BASE_URL').replace(/\/+$/, ''),
    perceptionUrl: s('PERCEPTION_URL').replace(/\/+$/, ''),
    embedderUrl: s('EMBEDDER_URL').replace(/\/+$/, ''),
    detectorUrl: s('DETECTOR_URL').replace(/\/+$/, ''),
    quicknodeSecret: str(env, 'QUICKNODE_SECRET'),
    elevenlabsToolSecret: str(env, 'ELEVENLABS_TOOL_SECRET'),
    biometricKey,
    keys: undefined as unknown as KeySet,
    apiKeys: {
      anthropic: str(env, 'ANTHROPIC_API_KEY'),
      openai: str(env, 'OPENAI_API_KEY'),
      google: str(env, 'GOOGLE_API_KEY'),
      xai: str(env, 'XAI_API_KEY'),
      elevenlabs: str(env, 'ELEVENLABS_API_KEY'),
      elevenlabsAgentId: str(env, 'ELEVENLABS_AGENT_ID'),
      nosana: str(env, 'NOSANA_API_KEY'),
      sp1: str(env, 'SP1_PRIVATE_KEY'),
    },
  } satisfies Config;

  // Mode-specific requirements.
  if (cfg.chainEventsSource === 'quicknode' && !cfg.quicknodeSecret) {
    problems.push('CHAIN_EVENTS_SOURCE=quicknode requires QUICKNODE_SECRET');
  }
  if (cfg.solanaMode === 'mock' && cfg.chainEventsSource !== 'mock') {
    problems.push(`SOLANA_MODE=mock requires CHAIN_EVENTS_SOURCE=mock (got ${cfg.chainEventsSource})`);
  }
  if (cfg.perceptionProvider === 'http' && !cfg.perceptionUrl) {
    problems.push('PERCEPTION_PROVIDER=http requires PERCEPTION_URL');
  }

  // Judges must be distinct keys, and none equal to the oracle (§9.4 create_bet).
  if (judges.every((j) => j) && oracle) {
    const ks = judges.map((j) => j!.publicKey);
    if (new Set(ks).size !== 3) problems.push('JUDGE_KEY_0..2 must be distinct');
    if (ks.includes(oracle.publicKey)) problems.push('a judge key equals the oracle key');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  cfg.keys = { feePayer: feePayer!, oracle: oracle!, judges: judges as [KeyPair, KeyPair, KeyPair] };
  const dataDir = s('DATA_DIR');
  cfg.dataDir = isAbsolute(dataDir) ? dataDir : resolve(opts.cwd ?? process.cwd(), dataDir);
  cfg.publicUrl = (str(env, 'PUBLIC_URL') ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  return cfg;
}
