//! You're On escrow (ESCROW-PROGRAM.md). The program decides where money can go and when;
//! the server's judge keys decide only which outcome applies.
//!
//! D0 (this commit): `initialize_config`, `update_config`, `create_bet`, `accept_bet`.
//! D1 (pending): `cancel_open_bet`, `resolve`, `concede`, `appeal`, `resolve_appeal`,
//! `finalize`, `timeout_refund`, `close_bet`.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
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
}
