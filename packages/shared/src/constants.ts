// SCHEMAS §0.1 — shared constants. Money is micro-USDC (6 dp) as bigint for arithmetic only.

export const SCHEMA_VERSION = 1 as const;
export const MICRO_PER_USD = 1_000_000n;
/** $0.01 in micro-USDC. */
export const CENT = 10_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;
/** $20 per side = Config.max_stake (demo); the server re-reads Config. */
export const MAX_STAKE = 20_000_000n;
/** $0.10 per side (offchain rule only). */
export const MIN_STAKE = 100_000n;
/** Skill odds: the larger stake is at most this many times the smaller (SCHEMAS §2.1). */
export const MAX_ODDS_RATIO = 10n;
/** Judge confidence < 0.8 → REDO. */
export const REDO_BELOW = 0.8;
/** Appeal vote confidence < 0.6 → ABSTAIN. */
export const PANEL_ABSTAIN_BELOW = 0.6;
/** A 3rd non-decisive recording → HEARING (D7). */
export const MAX_REDOS = 2;
export const MAX_CLARIFICATIONS = 2;
/** terms.deadline + this ≤ created_at + Config.resolve_deadline_secs (§9.3). */
export const RESOLVE_GRACE_SECS = 600;
/** create_bet accept_deadline arg for skill bets (§9.3). */
export const ACCEPT_WINDOW_SKILL_SECS = 300;
/** create_bet accept_deadline arg for gemini bets = unix(quotedAt) + this. */
export const QUOTE_TTL_SECS = 60;
/** Device policy: lock accept_deadline ≤ device now + this (= Config.accept_deadline_secs). */
export const LOCK_SIGNATURE_MAX_SECS = 600;
/** The server never submits a lock within 5 s of accept_deadline: it revokes instead. */
export const LOCK_SUBMIT_MARGIN_SECS = 5;
/** Durable-nonce accounts, authority = server fee payer. */
export const NONCE_POOL_SIZE = 5;
/** Pool addresses = createWithSeed(fee payer, `yo-nonce-${k}`, System), k < 16 (ESCROW §5.0.1). */
export const NONCE_SEED_MAX = 16;
/** After lock_failed: re-propose the same terms under a new bet_id once, then stop. */
export const MAX_LOCK_REBUILDS = 1;
/** LOCK_MODE=sequential only: re-prompt B if create_bet hasn't confirmed by then. */
export const HELD_SIGNATURE_MAX_SECS = 30;
/** RPC-confirmed tx with no Streams event after this → rpc_poll. */
export const STREAM_FALLBACK_MS = 5_000;
