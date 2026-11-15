//! #12 `settle_panel` (§9.4, §9.7): 2-of-3 judge quorum via the Ed25519 precompile.
use anchor_lang::prelude::*;
use solana_sdk_ids::sysvar::instructions as ix_sysvar;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::*;
use crate::crypto::panel_message;
use crate::errors::VerdictError;
use crate::panel::verify_panel_quorum;
use crate::payout::{refund_all, settle_winners, Escrow};
use crate::state::Bet;

use super::consent::finish_settle;
use super::refund::finish_refund;

#[derive(Accounts)]
pub struct SettlePanel<'info> {
    #[account(mut)]
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
    /// CHECK: Instructions sysvar (§9.7).
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_settle_panel<'info>(ctx: Context<'_, '_, 'info, 'info, SettlePanel<'info>>, outcome: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    {
        let bet = &ctx.accounts.bet;
        require!(bet.state == STATE_DISPUTED, VerdictError::InvalidState);
        require!(outcome <= OUTCOME_SIDE_1, VerdictError::BadOutcome);
        // After the panel timeout only `refund` (reason 6) applies (§9.9; errata chainmodel).
        // Exactly complementary to refund's `now > disputed_at + PANEL_TIMEOUT_S`.
        require!(now <= bet.disputed_at.saturating_add(PANEL_TIMEOUT_S), VerdictError::DeadlinePassed);
        let msg = panel_message(&crate::ID, &bet_key, outcome, &bet.evidence_root, &bet.program_hash);
        verify_panel_quorum(&ctx.accounts.instructions.to_account_info(), &msg, &bet.judges)?;
    }

    let bet = &ctx.accounts.bet;
    let esc = Escrow {
        bet: ctx.accounts.bet.to_account_info(),
        vault: &ctx.accounts.vault,
        oracle: ctx.accounts.oracle.to_account_info(),
        track_buffer: ctx.accounts.track_buffer.to_account_info(),
        token_program: &ctx.accounts.token_program,
        payout_accounts: ctx.remaining_accounts,
    };
    if outcome == OUTCOME_NO_CONTEST {
        let amounts = refund_all(bet, &esc)?;
        drop(esc);
        return finish_refund(&mut ctx.accounts.bet, bet_key, REFUND_NO_CONTEST, amounts);
    }
    let winner_mask = bet.side_mask(outcome - 1);
    let upheld = bet.preruling == PRERULING_WINNER && winner_mask == bet.winner_mask;
    let (pot, payouts) = settle_winners(bet, &esc, winner_mask, upheld)?;
    drop(esc);
    finish_settle(&mut ctx.accounts.bet, bet_key, PATH_PANEL, winner_mask, pot, payouts)
}
