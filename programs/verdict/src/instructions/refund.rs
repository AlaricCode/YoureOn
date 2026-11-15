//! #15 `refund` (§9.4): permissionless timeout refunds.
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::*;
use crate::errors::VerdictError;
use crate::events::Refunded;
use crate::payout::{refund_all, Escrow};
use crate::state::Bet;

#[derive(Accounts)]
pub struct Refund<'info> {
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
}

/// The refund reason that applies now, if any (§9.4 #15).
pub fn refund_reason(bet: &Bet, now: i64) -> Option<u8> {
    let add = |a: i64, b: i64| a.saturating_add(b);
    match bet.state {
        STATE_PROPOSED if now > bet.fund_deadline => Some(REFUND_FUND_TIMEOUT),
        STATE_FUNDED if now > add(bet.funded_at, START_WINDOW_S) => Some(REFUND_START_TIMEOUT),
        STATE_LIVE if now > add(add(bet.started_at, bet.time_limit_s as i64), LIVE_GRACE_S) => Some(REFUND_LIVE_TIMEOUT),
        STATE_PERCEIVING if now > add(bet.ended_at, PERCEPTION_TIMEOUT_S) => Some(REFUND_PERCEPTION_TIMEOUT),
        STATE_DISPUTED if now > add(bet.disputed_at, PANEL_TIMEOUT_S) => Some(REFUND_PANEL_TIMEOUT),
        STATE_PRERULED if now > add(bet.consent_deadline, PANEL_TIMEOUT_S) => Some(REFUND_CONSENT_TIMEOUT),
        _ => None,
    }
}

/// Marks the bet Refunded and emits `Refunded`.
pub fn finish_refund(bet: &mut Bet, bet_key: Pubkey, reason: u8, amounts: [u64; 8]) -> Result<()> {
    bet.state = STATE_REFUNDED;
    bet.refund_reason = reason;
    bet.settle_path = PATH_REFUND;
    bet.settled_at = Clock::get()?.unix_timestamp;
    emit!(Refunded { bet: bet_key, reason, amounts });
    Ok(())
}

pub fn handle_refund<'info>(ctx: Context<'_, '_, 'info, 'info, Refund<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let reason = refund_reason(&ctx.accounts.bet, now).ok_or(VerdictError::NotRefundable)?;
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
    finish_refund(&mut ctx.accounts.bet, bet_key, reason, amounts)
}
