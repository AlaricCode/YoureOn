//! Accounts and enums (ESCROW-PROGRAM §3, §4). Borsh layout: field order is part of the
//! client contract (append only). Enum variant order is the wire format (frozen).

use anchor_lang::prelude::*;

use crate::{constants::*, error::EscrowError};

/// Global config, PDA `["config"]`. INIT_SPACE = 254; account = 262 bytes.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Config {
    /// May call `update_config`.
    pub admin: Pubkey,
    /// Copied into each new Bet.
    pub judge_authority: Pubkey,
    /// Copied into each new Bet; must differ from `judge_authority`.
    pub appeal_authority: Pubkey,
    /// Per-side stake cap, micro-units.
    pub max_stake: u64,
    pub appeal_window_secs: u32,
    /// Max accept window: `create_bet`'s `accept_deadline` must be ≤ now + this.
    pub accept_deadline_secs: u32,
    /// Locked → must resolve within (snapshotted as `Bet::resolve_window_secs`).
    pub resolve_deadline_secs: u32,
    /// Appealed → must resolve within.
    pub appeal_resolve_secs: u32,
    #[max_len(4)]
    pub allowed_mints: Vec<Pubkey>,
    /// Blocks `create_bet` and `accept_bet` only (I14).
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    /// `validate_config()` (ESCROW §3.1). Runs on init and after every update.
    pub fn validate(&self) -> Result<()> {
        let default = Pubkey::default();
        let in_range = |v: u32, lo: u32, hi: u32| v >= lo && v <= hi;
        let ok = self.admin != default
            && self.judge_authority != default
            && self.appeal_authority != default
            && self.judge_authority != self.appeal_authority
            && self.max_stake > 0
            && self.max_stake <= MAX_STAKE_CEILING
            && in_range(
                self.appeal_window_secs,
                APPEAL_WINDOW_SECS_MIN,
                APPEAL_WINDOW_SECS_MAX,
            )
            && in_range(
                self.accept_deadline_secs,
                ACCEPT_DEADLINE_SECS_MIN,
                ACCEPT_DEADLINE_SECS_MAX,
            )
            && in_range(
                self.resolve_deadline_secs,
                RESOLVE_DEADLINE_SECS_MIN,
                RESOLVE_DEADLINE_SECS_MAX,
            )
            && in_range(
                self.appeal_resolve_secs,
                APPEAL_RESOLVE_SECS_MIN,
                APPEAL_RESOLVE_SECS_MAX,
            )
            && valid_mint_list(&self.allowed_mints);
        require!(ok, EscrowError::InvalidConfig);
        Ok(())
    }
}

/// Non-empty, ≤ MAX_ALLOWED_MINTS, no duplicates, no default key.
fn valid_mint_list(mints: &[Pubkey]) -> bool {
    if mints.is_empty() || mints.len() > MAX_ALLOWED_MINTS {
        return false;
    }
    for (i, m) in mints.iter().enumerate() {
        if *m == Pubkey::default() || mints[i + 1..].contains(m) {
            return false;
        }
    }
    true
}

/// One bet, PDA `["bet", bet_id]`. INIT_SPACE = 401; account = 409 bytes.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Bet {
    /// = Postgres `bets.id` (UUID bytes, RFC 4122 order).
    pub bet_id: [u8; 16],
    /// Challenger; signs `create_bet`.
    pub party_a: Pubkey,
    /// Challenged; fixed at create, signs `accept_bet`.
    pub party_b: Pubkey,
    /// Allowlisted at create.
    pub mint: Pubkey,
    /// = `create_bet` payer; receives all rent on close.
    pub rent_payer: Pubkey,
    /// Snapshot of `config.judge_authority`.
    pub judge_authority: Pubkey,
    /// Snapshot of `config.appeal_authority`.
    pub appeal_authority: Pubkey,
    pub stake_a: u64,
    pub stake_b: u64,
    /// Written once, in `create_bet` (I3).
    pub terms_hash: [u8; 32],
    /// Zero until resolve.
    pub evidence_hash: [u8; 32],
    /// Zero until resolve.
    pub ruling_hash: [u8; 32],
    pub status: BetStatus,
    /// None until resolve.
    pub outcome: Option<Outcome>,
    /// Snapshot of `config.appeal_window_secs`.
    pub appeal_window_secs: u32,
    /// Snapshot of `config.resolve_deadline_secs`.
    pub resolve_window_secs: u32,
    /// Snapshot of `config.appeal_resolve_secs`.
    pub appeal_resolve_secs: u32,
    pub created_at: i64,
    /// `created_at < accept_deadline ≤ created_at + config.accept_deadline_secs`.
    pub accept_deadline: i64,
    /// 0 until Locked.
    pub locked_at: i64,
    /// `locked_at + resolve_window_secs` (0 until Locked).
    pub resolve_deadline: i64,
    pub resolved_at: i64,
    /// `resolved_at + appeal_window_secs`.
    pub appeal_deadline: i64,
    pub appealed_at: i64,
    /// `appealed_at + appeal_resolve_secs`.
    pub appeal_resolve_deadline: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Borsh u8 0..=6. Variant order is frozen after the first deploy.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum BetStatus {
    Open,
    Locked,
    Resolved,
    Appealed,
    Settled,
    Refunded,
    Cancelled,
}

impl BetStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            BetStatus::Settled | BetStatus::Refunded | BetStatus::Cancelled
        )
    }
}

/// Borsh u8 0..=3. Variant order is frozen after the first deploy.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Outcome {
    PartyA,
    PartyB,
    Split,
    Refund,
}
