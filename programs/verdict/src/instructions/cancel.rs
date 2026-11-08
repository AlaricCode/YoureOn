//! #4 `cancel` (§9.4): creator cancels a Proposed bet; funded stakes are refunded.
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::*;
use crate::errors::VerdictError;
use crate::events::BetCancelled;
use crate::payout::{refund_all, Escrow};
use crate::state::Bet;

use super::refund::finish_refund;

#[derive(Accounts)]
pub struct Cancel<'info> {
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ VerdictError::Unauthorized)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [VAULT_SEED, bet.key().as_ref()], bump = bet.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: rent destination; must be `bet.oracle`.
    #[account(mut, address = bet.oracle @ VerdictError::Unauthorized)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: TrackBuffer PDA; closed only if program-owned and non-empty (§9.3).
    #[account(mut, seeds = [TRACKS_SEED, bet.key().as_ref()], bump)]
    pub track_buffer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_cancel<'info>(ctx: Context<'_, '_, 'info, 'info, Cancel<'info>>) -> Result<()> {
    require!(ctx.accounts.bet.state == STATE_PROPOSED, VerdictError::InvalidState);
    let amounts = {
        let esc = Escrow {
            bet: ctx.accounts.bet.to_account_info(),
            vault: &ctx.accounts.vault,
            oracle: ctx.accounts.oracle.to_account_info(),
            track_buffer: ctx.accounts.track_buffer.to_account_info(),
            token_program: &ctx.accounts.token_program,
            payout_accounts: ctx.remaining_accounts,
        };
        refund_all(&ctx.accounts.bet, &esc)?
    };
    let bet_key = ctx.accounts.bet.key();
    emit!(BetCancelled { bet: bet_key });
    finish_refund(&mut ctx.accounts.bet, bet_key, REFUND_CANCELLED, amounts)
}
