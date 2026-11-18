// Zod-validated server environment. Names are exactly SETUP-CHECKLIST §7 ("BUILD" section,
// plus DATABASE_URL_DIRECT from "L's LAPTOP ONLY", which only migrations read).
//
// Rules:
//  - An empty string counts as unset (the .env.example template has blank values).
//  - Only what the running code needs is required. Everything else is optional here and
//    becomes required (move it into REQUIRED_IN_PRODUCTION or make it non-optional) in the
//    PR that lands the feature that reads it.
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
  /** Must equal the phones' pinned ESCROW_ID (packages/shared/src/chain/constants.ts), or every lock is refused on device. */
  PROGRAM_ID: opt(
    pubkey.refine((s) => s === ESCROW_ID, `must equal the pinned ESCROW_ID ${ESCROW_ID}`),
  ),
  USDC_MINT: opt(pubkey),
  MAX_STAKE_MICRO: opt(z.string().regex(/^[1-9][0-9]{0,19}$/)),
  APPEAL_WINDOW_S: opt(intStr),
  LOCK_MODE: z.preprocess(unset, z.enum(['atomic', 'sequential']).default('atomic')),
  /**
   * Who signs the atomic lock (src/lock). 'phones' = API-CONTRACT §2.8 (each phone signs the stored
   * message after hold + Face ID). 'server' = custodial demo path: the server signs create_bet /
   * accept_bet as demo-a / demo-b (DEMO_A/B_SECRET_KEY) right after confirm_terms (D-A).
   */
  LOCK_SIGNER: z.preprocess(unset, z.enum(['phones', 'server']).default('phones')),
  /** Terms.escrow.cluster; 'localnet' only for a local validator (scripts/e2e-local.sh). */
  SOLANA_CLUSTER: z.preprocess(unset, z.enum(['devnet', 'localnet']).default('devnet')),
  DEMO_MODE: z.preprocess(unset, boolStr.default(false)),
  /**
   * SCHEMAS §2.2: real_world (Gemini BTC 5-minute) bets on our escrow are a devnet demo
   * exception. Unset = follow DEMO_MODE. They also need the market relay (MARKETS_FEED).
   */
  ALLOW_P2P_REAL_WORLD: opt(boolStr),
  ELEVENLABS_AGENT_ID: opt(str),
  ELEVENLABS_JUDGE_VOICE_ID: opt(str),
  // --- paid-provider switches (src/providers; SETUP-CHECKLIST §7, planning D14)
  /** Spend guard: any `*_PROVIDER=live` refuses to start unless this is true. Never set in tests/CI. */
  ALLOW_SPEND: z.preprocess(unset, boolStr.default(false)),
  /** mock = deterministic offline LLM; live = Anthropic / OpenAI / Google (needs ALLOW_SPEND). */
  LLM_PROVIDER: z.preprocess(unset, z.enum(['mock', 'live']).default('mock')),
  /** mock = echo transcript; live = ElevenLabs Scribe (needs ALLOW_SPEND + ELEVENLABS_API_KEY). */
  STT_PROVIDER: z.preprocess(unset, z.enum(['mock', 'live']).default('mock')),
  /** mock = generated beeps; live = ElevenLabs Sound Effects (needs ALLOW_SPEND + ELEVENLABS_API_KEY). */
  SFX_PROVIDER: z.preprocess(unset, z.enum(['mock', 'live']).default('mock')),
  // --- judge pipeline (src/judge, Beat 4)
  /** Anthropic model for the attempt ruling (12 frames; Opus is too slow for the 10 s cap). */
  JUDGE_MODEL: z.preprocess(unset, str.default('claude-sonnet-5-5')),
  /** Demo fallback (ARCHITECTURE §7.2 cached_ruling): rule from a stored verdict, no LLM call. */
  CACHED_RULING: z.preprocess(unset, boolStr.default(false)),
  // --- Solana / QuickNode (secret)
  SOLANA_DEVNET_RPC: opt(z.url()),
  SOLANA_DEVNET_WS: opt(z.url()),
  QN_STREAM_SECURITY_TOKEN: opt(str),
  // --- server keypairs (secret; base58 or solana-keygen JSON)
  FEE_PAYER_SECRET_KEY: opt(str),
  JUDGE_AUTHORITY_SECRET_KEY: opt(str),
  APPEAL_AUTHORITY_SECRET_KEY: opt(str),
  TREASURY_SECRET_KEY: opt(str),
  /** Custodial demo party keys (scripts/keys.ts demo-a / demo-b), used when LOCK_SIGNER=server. */
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
  /** Gemini BTC 5-min relay (src/markets; public REST, no key). Unset = on, except NODE_ENV=test. */
  MARKETS_FEED: opt(z.enum(['on', 'off'])),
  DEMO_ADMIN_TOKEN: opt(str),
  FACE_SEAL_SECRET_KEY: opt(str),
  // --- optional
  EXPO_ACCESS_TOKEN: opt(str),
});
export type Env = z.infer<typeof EnvSchema>;

/**
 * Keys the production deploy must have *today*. Grows as features land; keep it honest so a
 * Fly deploy with a missing secret fails at boot instead of mid-demo.
 */
export const REQUIRED_IN_PRODUCTION = [
  'PUBLIC_BASE_URL',
  // chain lifecycle (src/chain/tx.ts, src/lock, src/payout)
  'SOLANA_DEVNET_RPC',
  'FEE_PAYER_SECRET_KEY',
  'JUDGE_AUTHORITY_SECRET_KEY',
  // the judge's tools (ANTHROPIC_API_KEY is required only with LLM_PROVIDER=live, below)
  'ELEVENLABS_TOOL_SECRET',
  // /v1/demo/* (src/demo)
  'DEMO_ADMIN_TOKEN',
] as const satisfies readonly (keyof Env)[];

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid server environment:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

/** Parses and validates `source` (default `process.env`). Throws EnvError listing every problem; never echoes values. */
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
