//! You're On escrow (ESCROW-PROGRAM.md). The program decides where money can go and when;
//! the server's judge keys decide only which outcome applies.
//!
//! D0: `initialize_config`, `update_config`, `create_bet`, `accept_bet`.
//! D1: `cancel_open_bet`, `resolve`, `concede`, `appeal`, `resolve_appeal`, `finalize`,
//! `timeout_refund`, `close_bet`. The five terminal instructions pay out only through
//! `payout::payout()` (§5.2, §6) and leave the vault empty; `close_bet` returns the rent (P8).
//! State machine: §8.2. Every state change emits exactly one event via `emit_cpi!` (§7.2).
//!
//! Token-2022 mints are accepted only with the §3.3 extension allowlist (`MetadataPointer`,
//! `TokenMetadata`); `MintCloseAuthority` is rejected so a mint can't close between a terminal
//! ix and `close_bet` (TM-K8). Tests: `tests/matrix` (Rust LiteSVM, every §9.2 program row),
//! `packages/shared/test/escrow` (TS client on LiteSVM: N, A14/A15, E3, CU1) and
//! `packages/shared/test/validator` (Agave). Anyone can settle expired bets with `scripts/crank.ts`.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod payout;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("FyJQHCE1TBuaCtaueeoSzLDzV5Gns6iUSA7Yd2m8UNvm");

#[program]
pub mod escrow {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, args: InitConfigArgs) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(ctx, args)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::update_config::handle_update_config(ctx, args)
    }

    pub fn create_bet(
        ctx: Context<CreateBet>,
        bet_id: [u8; 16],
        party_b: Pubkey,
        stake_a: u64,
        stake_b: u64,
        terms_hash: [u8; 32],
        accept_deadline: i64,
    ) -> Result<()> {
        instructions::create_bet::handle_create_bet(
            ctx,
            bet_id,
            party_b,
            stake_a,
            stake_b,
            terms_hash,
            accept_deadline,
        )
    }

    pub fn accept_bet(
        ctx: Context<AcceptBet>,
        expected_terms_hash: [u8; 32],
        expected_stake_a: u64,
        expected_stake_b: u64,
        expected_party_a: Pubkey,
    ) -> Result<()> {
        instructions::accept_bet::handle_accept_bet(
            ctx,
            expected_terms_hash,
            expected_stake_a,
            expected_stake_b,
            expected_party_a,
        )
    }

    /// Open → Cancelled; refund A (signer: A, B or the bet's judge key).
    pub fn cancel_open_bet(ctx: Context<CancelOpenBet>) -> Result<()> {
        instructions::cancel_open_bet::handle_cancel_open_bet(ctx)
    }

    /// Locked → Resolved (bet's judge key, before `resolve_deadline`).
    pub fn resolve(
        ctx: Context<Resolve>,
        outcome: Outcome,
        evidence_hash: [u8; 32],
        ruling_hash: [u8; 32],
    ) -> Result<()> {
        instructions::resolve::handle_resolve(ctx, outcome, evidence_hash, ruling_hash)
    }

    /// Resolved → Settled; the loser of a PartyA / PartyB ruling pays out at once.
    pub fn concede(ctx: Context<Concede>) -> Result<()> {
        instructions::concede::handle_concede(ctx)
    }

    /// Resolved → Appealed (a loser, before `appeal_deadline`).
    pub fn appeal(ctx: Context<Appeal>) -> Result<()> {
        instructions::appeal::handle_appeal(ctx)
    }

    /// Appealed → Settled (bet's appeal key, before `appeal_resolve_deadline`).
    pub fn resolve_appeal(
        ctx: Context<ResolveAppeal>,
        final_outcome: Outcome,
        appeal_ruling_hash: [u8; 32],
    ) -> Result<()> {
        instructions::resolve_appeal::handle_resolve_appeal(ctx, final_outcome, appeal_ruling_hash)
    }

    /// Resolved → Settled (anyone, at or after `appeal_deadline`).
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        instructions::finalize::handle_finalize(ctx)
    }

    /// Open / Locked / Appealed → Refunded (anyone, at or after that status's deadline).
    pub fn timeout_refund(ctx: Context<TimeoutRefund>) -> Result<()> {
        instructions::timeout_refund::handle_timeout_refund(ctx)
    }

    /// Settled / Refunded / Cancelled → closed; rent to `bet.rent_payer` (anyone).
    pub fn close_bet(ctx: Context<CloseBet>) -> Result<()> {
        instructions::close_bet::handle_close_bet(ctx)
    }
}
