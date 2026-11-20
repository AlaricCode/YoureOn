// Zod-validated server environment. An empty string counts as unset (the .env.example template
// has blank values). Only what the running code needs is required; everything else is optional.
import { z } from 'zod/v4';
import { isAddress } from '@solana/kit';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';

const unset = (v: unknown) => (v === '' ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(unset, s.optional());
const req = <T extends z.ZodType>(s: T) => z.preprocess(unset, s);
const str = z.string().min(1);
const pubkey = z.string().refine((s) => isAddress(s), 'not a base58 32-byte address');
const intStr = z.coerce.number().int().nonnegative();
const boolStr = z.enum(['true', 'false']).transform((s) => s === 'true');

export const EnvSchema = z.object({
  // --- non-secret config (fly.toml [env])
  NODE_ENV: z.preprocess(
    unset,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: z.preprocess(unset, z.coerce.number().int().min(1).max(65535).default(8080)),
  PUBLIC_BASE_URL: opt(z.url()),
  /** Must equal the phones' pinned ESCROW_ID, or every lock is refused on device. */
  PROGRAM_ID: opt(
    pubkey.refine((s) => s === ESCROW_ID, `must equal the pinned ESCROW_ID ${ESCROW_ID}`),
  ),
  USDC_MINT: opt(pubkey),
  MAX_STAKE_MICRO: opt(z.string().regex(/^[1-9][0-9]{0,19}$/)),
  APPEAL_WINDOW_S: opt(intStr),
  LOCK_MODE: z.preprocess(unset, z.enum(['atomic', 'sequential']).default('atomic')),
  /**
   * Who signs for the parties: 'phones' (each phone, after Face ID) or 'server' (the custodial
   * demo-a / demo-b keys sign the lock, and any GG or appeal sent unsigned; the demo appeal route
   * POST /v1/demo/bets/:bet_id/appeal needs it).
   */
  LOCK_SIGNER: z.preprocess(unset, z.enum(['phones', 'server']).default('phones')),
  /**
   * Priority fee (micro-lamports per CU) on the server-only txs (resolve, finalize, refunds,
   * orphan exits, nonce advances, rebalance). Unset = none; devnet congestion insurance. The
   * phone-signed lock and concede are never changed.
   */
  CU_PRICE_MICROLAMPORTS: opt(intStr),
  /** Terms.escrow.cluster; 'localnet' only for a local validator (scripts/e2e-local.sh). */
  SOLANA_CLUSTER: z.preprocess(unset, z.enum(['devnet', 'localnet']).default('devnet')),
  DEMO_MODE: z.preprocess(unset, boolStr.default(false)),
  /** Under DEMO_MODE, the billed voice judge (and Jarvis) is for demo players only; false = all. */
  VOICE_DEMO_ONLY: z.preprocess(unset, boolStr.default(true)),
  /** real_world bets on our escrow (devnet demo exception, needs the relay); unset = DEMO_MODE. */
  ALLOW_P2P_REAL_WORLD: opt(boolStr),
  ELEVENLABS_AGENT_ID: opt(str),
  ELEVENLABS_JUDGE_VOICE_ID: opt(str),
  /**
   * The agent's LLM: scripts/el-agent.ts sets it on the agent unless --llm is given (unset =
   * DEFAULT_AGENT_LLM); the post-call webhook warns `voice.llm_mismatch` when another model billed.
   */
  ELEVENLABS_AGENT_LLM: opt(str),
  /**
   * The projector's ElevenLabs voice (and, with SFX_PROVIDER=auto, its cues): on whenever
   * ELEVENLABS_API_KEY is set and ALLOW_SPEND=true. 'off' is the kill switch (browser voice).
   */
  STAGE_TTS: opt(z.enum(['on', 'off'])),
  /** The stage TTS model (default eleven_v4_turbo). */
  STAGE_TTS_MODEL: opt(str),
  /** Three distinct comma-separated voice ids, appeal panel seats 1-3; unset = premade voices. */
  ELEVENLABS_PANEL_VOICE_IDS: opt(
    z.string().refine((s) => {
      const ids = s.split(',').map((x) => x.trim());
      return ids.length === 3 && ids.every(Boolean) && new Set(ids).size === 3;
    }, 'three distinct comma-separated voice ids'),
  ),
  // --- paid-provider switches
  /** Spend guard: any `*_PROVIDER=live` refuses to start unless true. Never set in tests or CI. */
  ALLOW_SPEND: z.preprocess(unset, boolStr.default(false)),
  /** mock = deterministic offline LLM; live = Anthropic / OpenAI / Google (needs ALLOW_SPEND). */
  LLM_PROVIDER: z.preprocess(unset, z.enum(['mock', 'live']).default('mock')),
  /** mock = echo transcript; live = ElevenLabs Scribe (needs ALLOW_SPEND + ELEVENLABS_API_KEY). */
  STT_PROVIDER: z.preprocess(unset, z.enum(['mock', 'live']).default('mock')),
  /**
   * mock = beeps; live = ElevenLabs Sound Effects (needs ALLOW_SPEND + ELEVENLABS_API_KEY);
   * auto (default) = live exactly when the stage voice is on (STAGE_TTS), else mock.
   */
  SFX_PROVIDER: z.preprocess(unset, z.enum(['mock', 'live', 'auto']).default('auto')),
  // --- judge pipeline
  /** Anthropic model for the attempt ruling (12 frames; Opus is too slow for the 10 s cap). */
  JUDGE_MODEL: z.preprocess(unset, str.default('claude-sonnet-5-5')),
  /**
   * Anthropic model that words the judge's odds suggestion (default claude-opus-5-5 at effort low,
   * 3 s deadline; claude-haiku-5-5 if that is too slow). Only used with LLM_PROVIDER=live.
   */
  ODDS_LLM_MODEL: opt(str),
  /** Anthropic model for the SAM camera-check specs; off the critical path, so the stronger one. */
  CHECKS_MODEL: z.preprocess(unset, str.default('claude-opus-5-5')),
  /**
   * Camera checks (SAM 3.1) kill switch; they also need SAM3_URL + SAM3_API_TOKEN. Non-binding:
   * the spec is never in the hashed Terms, and a check can only turn a decisive verdict into REDO.
   */
  CHECKS_ENABLED: z.preprocess(unset, boolStr.default(false)),
  /** The shared lobby (POST /v1/rooms/lobby, the stage's ?room=LOBBY); false = both answer 404. */
  LOBBY_ENABLED: z.preprocess(unset, boolStr.default(true)),
  /** The deployed SAM 3.1 service, e.g. https://<ws>--sam3-…modal.run. */
  SAM3_URL: opt(z.url()),
  /** Bearer token for POST /segment (secret; never logged). */
  SAM3_API_TOKEN: opt(str),
  /**
   * SAM deadline per attempt (retry included) from the start of the ruling job. SAM runs beside
   * the vision call (10 s cap) and the ruling waits for both, so the 10 s default never makes a
   * ruling wait past the judge's own budget; a late SAM is 'unavailable' (no veto). Capped at
   * 15 s, under STUCK_JUDGING_MS (20 s).
   */
  SAM_TIMEOUT_MS: z.preprocess(
    unset,
    z.coerce.number().int().min(1000).max(15_000).default(10_000),
  ),
  /** Demo fallback: rule from a stored verdict, no LLM call. A runtime toggle can override it. */
  CACHED_RULING: z.preprocess(unset, boolStr.default(false)),
  // --- Solana / QuickNode (secret)
  SOLANA_DEVNET_RPC: opt(z.url()),
  SOLANA_DEVNET_WS: opt(z.url()),
  QN_STREAM_SECURITY_TOKEN: opt(str),
  /** Stream wait before RPC-polling a server tx; unset = 30 s with a Stream token, else 5 s. */
  RPC_POLL_FALLBACK_MS: opt(intStr),
  // --- server keypairs (secret; base58 or solana-keygen JSON)
  FEE_PAYER_SECRET_KEY: opt(str),
  JUDGE_AUTHORITY_SECRET_KEY: opt(str),
  APPEAL_AUTHORITY_SECRET_KEY: opt(str),
  TREASURY_SECRET_KEY: opt(str),
  /** Treasury address, for the /v1/demo/health USDC check when its secret is not on the server. */
  TREASURY_PUBKEY: opt(pubkey),
  /**
   * Custodial demo-a/b keys (scripts/keys.ts): demo claim, rebalance, seed-h2h and
   * LOCK_SIGNER=server; their wallets also mark who counts as a demo player (demo/players.ts).
   */
  DEMO_A_SECRET_KEY: opt(str),
  DEMO_B_SECRET_KEY: opt(str),
  // --- AI providers (secret)
  ANTHROPIC_API_KEY: opt(str),
  OPENAI_API_KEY: opt(str),
  GOOGLE_GENERATIVE_AI_API_KEY: opt(str),
  // --- ElevenLabs (secret)
  ELEVENLABS_API_KEY: opt(str),
  ELEVENLABS_TOOL_SECRET: opt(str),
  ELEVENLABS_WEBHOOK_SECRET: opt(str),
  // --- data (secret)
  /** Neon POOLED url for the app (local: the docker-compose db). Required. */
  DATABASE_URL: req(str),
  /** Neon DIRECT url, migrations only (packages/db). Never on Fly. */
  DATABASE_URL_DIRECT: opt(str),
  S3_ENDPOINT: opt(z.url()),
  S3_REGION: opt(str),
  S3_ACCESS_KEY_ID: opt(str),
  S3_SECRET_ACCESS_KEY: opt(str),
  S3_BUCKET_EVIDENCE: opt(str),
  S3_BUCKET_AVATARS: opt(str),
  // --- app secrets (secret)
  FACE_KEK_ACTIVE: opt(str),
  FACE_KEK_2026_11_A: opt(str),
  DEMO_SEED_KEK: opt(str),
  SESSION_SECRET: opt(str),
  STAGE_KEY: opt(str),
  /** Comma-separated origins allowed to call the stage routes (CORS); unset = Vite dev origins. */
  STAGE_ORIGIN: opt(str),
  /**
   * The Gemini BTC 5-minute relay. Unset = on, except NODE_ENV=test; 'replay' serves the recorded
   * round, labelled REPLAY (POST /v1/demo/gemini switches live <-> replay at runtime).
   */
  MARKETS_FEED: opt(z.enum(['on', 'off', 'replay'])),
  DEMO_ADMIN_TOKEN: opt(str),
  FACE_SEAL_SECRET_KEY: opt(str),
  /** HMAC key for face match tickets; falls back to SESSION_SECRET. */
  FACE_TICKET_SECRET: opt(str),
  /** When true, `plain-v0` embeddings are refused (sealing is not built). */
  FACE_SEAL_REQUIRED: z.preprocess(unset, boolStr.default(false)),
  // --- optional
  EXPO_ACCESS_TOKEN: opt(str),
});
export type Env = z.infer<typeof EnvSchema>;

/**
 * Keys a production deploy must have. Grows as features land; keep it honest so a Fly deploy with
 * a missing secret fails at boot instead of mid-demo.
 */
export const REQUIRED_IN_PRODUCTION = [
  'PUBLIC_BASE_URL',
  // the chain lifecycle (locks, payouts)
  'SOLANA_DEVNET_RPC',
  'FEE_PAYER_SECRET_KEY',
  'JUDGE_AUTHORITY_SECRET_KEY',
  // the judge's tools (ANTHROPIC_API_KEY is required only with LLM_PROVIDER=live, below)
  'ELEVENLABS_TOOL_SECRET',
  // /v1/demo/*
  'DEMO_ADMIN_TOKEN',
] as const satisfies readonly (keyof Env)[];

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid server environment:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

/** Parses `source` (default `process.env`); throws EnvError listing every problem, never values. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = EnvSchema.safeParse(source);
  if (!r.success) {
    throw new EnvError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const env = r.data;
  if (env.NODE_ENV === 'production') {
    const missing: string[] = REQUIRED_IN_PRODUCTION.filter((k) => env[k] === undefined);
    // A mock LLM refuses every call in production (providers/registry.ts), so without the
    // key the judge only works with CACHED_RULING=true; the live judge needs both.
    if (env.LLM_PROVIDER === 'live' && env.ANTHROPIC_API_KEY === undefined) {
      missing.push('ANTHROPIC_API_KEY');
    }
    if (missing.length) throw new EnvError(missing.map((k) => `${k}: required in production`));
  }
  return env;
}
