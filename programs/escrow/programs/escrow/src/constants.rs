//! Seeds, limits and encodings (ESCROW-PROGRAM §2). Values are part of the client contract.

use anchor_lang::prelude::*;

/// Config PDA: `["config"]`.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// Bet PDA: `["bet", bet_id(16)]`.
#[constant]
pub const BET_SEED: &[u8] = b"bet";

/// Vault PDA (token account, authority = Bet PDA): `["vault", bet_id(16)]`.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Upper bound on `Config::allowed_mints` (also its `#[max_len]`).
pub const MAX_ALLOWED_MINTS: usize = 4;

/// Every bet mint has 6 decimals, so `max_stake` always means dollars (1 unit = $0.000001).
#[constant]
pub const REQUIRED_DECIMALS: u8 = 6;

/// `validate_config` bound: `stake_a + stake_b` can never overflow a `u64`.
#[constant]
pub const MAX_STAKE_CEILING: u64 = u64::MAX / 4;

/// `validate_config` window bounds, inclusive (ESCROW §3.1).
pub const APPEAL_WINDOW_SECS_MIN: u32 = 1;
pub const APPEAL_WINDOW_SECS_MAX: u32 = 86_400;
pub const ACCEPT_DEADLINE_SECS_MIN: u32 = 10;
pub const ACCEPT_DEADLINE_SECS_MAX: u32 = 86_400;
pub const RESOLVE_DEADLINE_SECS_MIN: u32 = 60;
pub const RESOLVE_DEADLINE_SECS_MAX: u32 = 604_800;
pub const APPEAL_RESOLVE_SECS_MIN: u32 = 10;
pub const APPEAL_RESOLVE_SECS_MAX: u32 = 86_400;
