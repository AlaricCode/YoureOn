//! Event structs (ESCROW-PROGRAM §7.2): exactly one per state-changing instruction, always
//! emitted with `emit_cpi!`. The wire/Zod mirror is SCHEMAS §10.2 `ChainEvents`: same field
//! names and order. Change both in the same commit.
//!
//! All events are defined now (D0) so the IDL and codes stay stable; the terminal and
//! resolve/appeal events are emitted by the D1 instructions.

use anchor_lang::prelude::*;

use crate::state::{BetStatus, Outcome};

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub judge_authority: Pubkey,
    pub appeal_authority: Pubkey,
    pub max_stake: u64,
    pub appeal_window_secs: u32,
    pub accept_deadline_secs: u32,
    pub resolve_deadline_secs: u32,
    pub appeal_resolve_secs: u32,
    pub allowed_mints: Vec<Pubkey>,
    pub paused: bool,
    pub ts: i64,
}

/// Full post-update snapshot; identical fields to `ConfigInitialized`.
#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub judge_authority: Pubkey,
    pub appeal_authority: Pubkey,
    pub max_stake: u64,
    pub appeal_window_secs: u32,
    pub accept_deadline_secs: u32,
    pub resolve_deadline_secs: u32,
    pub appeal_resolve_secs: u32,
    pub allowed_mints: Vec<Pubkey>,
    pub paused: bool,
    pub ts: i64,
}

/// status = Open
#[event]
pub struct BetCreated {
    pub bet_id: [u8; 16],
    pub bet: Pubkey,
    pub vault: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub mint: Pubkey,
    pub stake_a: u64,
    pub stake_b: u64,
    pub terms_hash: [u8; 32],
    pub judge_authority: Pubkey,
    pub appeal_authority: Pubkey,
    pub accept_deadline: i64,
    pub rent_payer: Pubkey,
    pub ts: i64,
}

/// status = Locked
#[event]
pub struct BetAccepted {
    pub bet_id: [u8; 16],
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub terms_hash: [u8; 32],
    pub stake_a: u64,
    pub stake_b: u64,
    pub vault_amount: u64,
    pub resolve_deadline: i64,
    pub ts: i64,
}

/// status = Resolved (D1: `resolve`)
#[event]
pub struct BetResolved {
    pub bet_id: [u8; 16],
    pub judge: Pubkey,
    pub outcome: Outcome,
    pub evidence_hash: [u8; 32],
    pub ruling_hash: [u8; 32],
    pub appeal_deadline: i64,
    pub ts: i64,
}

/// status = Appealed (D1: `appeal`)
#[event]
pub struct BetAppealed {
    pub bet_id: [u8; 16],
    pub appellant: Pubkey,
    pub original_outcome: Outcome,
    pub appeal_resolve_deadline: i64,
    pub ts: i64,
}

// Terminal events: self-contained (the Bet is gone after close_bet). Common fields first:
//   bet_id, final_status, outcome, mint, party_a, party_b,
//   party_a_token, party_b_token (Pubkey::default() if that side was omitted), to_a, to_b, ts

/// D1: `concede`
#[event]
pub struct BetConceded {
    pub bet_id: [u8; 16],
    pub final_status: BetStatus,
    pub outcome: Outcome,
    pub mint: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub party_a_token: Pubkey,
    pub party_b_token: Pubkey,
    pub to_a: u64,
    pub to_b: u64,
    pub ts: i64,
    pub conceded_by: Pubkey,
}

/// D1: `finalize`
#[event]
pub struct BetFinalized {
    pub bet_id: [u8; 16],
    pub final_status: BetStatus,
    pub outcome: Outcome,
    pub mint: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub party_a_token: Pubkey,
    pub party_b_token: Pubkey,
    pub to_a: u64,
    pub to_b: u64,
    pub ts: i64,
    pub caller: Pubkey,
}

/// D1: `resolve_appeal`
#[event]
pub struct AppealResolved {
    pub bet_id: [u8; 16],
    pub final_status: BetStatus,
    pub outcome: Outcome,
    pub mint: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub party_a_token: Pubkey,
    pub party_b_token: Pubkey,
    pub to_a: u64,
    pub to_b: u64,
    pub ts: i64,
    pub original_outcome: Outcome,
    pub appeal_ruling_hash: [u8; 32],
    pub overturned: bool,
}

/// D1: `timeout_refund`
#[event]
pub struct BetRefunded {
    pub bet_id: [u8; 16],
    pub final_status: BetStatus,
    pub outcome: Outcome,
    pub mint: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub party_a_token: Pubkey,
    pub party_b_token: Pubkey,
    pub to_a: u64,
    pub to_b: u64,
    pub ts: i64,
    pub from_status: BetStatus,
    pub caller: Pubkey,
}

/// D1: `cancel_open_bet`
#[event]
pub struct BetCancelled {
    pub bet_id: [u8; 16],
    pub final_status: BetStatus,
    pub outcome: Outcome,
    pub mint: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub party_a_token: Pubkey,
    pub party_b_token: Pubkey,
    pub to_a: u64,
    pub to_b: u64,
    pub ts: i64,
    pub cancelled_by: Pubkey,
}

/// D1: `close_bet`. Housekeeping (P8): rent back; not a "money moved" event for the UI.
#[event]
pub struct BetClosed {
    pub bet_id: [u8; 16],
    pub final_status: BetStatus,
    pub rent_payer: Pubkey,
    /// Bet + vault lamports, read before closing.
    pub rent_returned: u64,
    pub residual_to_a: u64,
    pub ts: i64,
}
