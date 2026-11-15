use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::EscrowError,
    events::BetCancelled,
    payout::{compute_payout, payout, PayoutAccounts, PayoutKind},
    state::{Bet, BetStatus, Outcome},
};

/// Refund an `Open` bet to A (ESCROW §5.2, P4). Kept for robustness under the atomic lock (D3):
/// `Open` persists only under `LOCK_MODE=sequential` or for a bet someone else created. A, B
/// ("decline") or the bet's judge key ("cleanup") may sign; the money can only go back to A.
#[event_cpi]
#[derive(Accounts)]
pub struct CancelOpenBet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// `bet.party_a`, `bet.party_b` or `bet.judge_authority` (`NotAuthorizedToCancel`).
    pub canceller: Signer<'info>,
    // ---- payout set (P), §5.2. NOT closed here: close_bet does it (P8). ----
    #[account(mut, seeds = [BET_SEED, bet.bet_id.as_ref()], bump = bet.bump,
              has_one = mint @ EscrowError::WrongMint)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [VAULT_SEED, bet.bet_id.as_ref()], bump = bet.vault_bump,
              token::mint = mint, token::authority = bet, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Receives the whole vault. SPL owner field == `bet.party_a` (I1, TM-F1/F4).
    #[account(mut, token::mint = mint, token::token_program = token_program,
              constraint = party_a_token.owner == bet.party_a @ EscrowError::WrongPayoutAccount)]
    pub party_a_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// Always receives 0 here, so it may be omitted (B may never have had an account, X6).
    #[account(mut, token::mint = mint, token::token_program = token_program,
              constraint = party_b_token.owner == bet.party_b @ EscrowError::WrongPayoutAccount)]
    pub party_b_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_cancel_open_bet(ctx: Context<CancelOpenBet>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut *ctx.accounts;

    require!(a.bet.status == BetStatus::Open, EscrowError::InvalidStatus);
    let canceller = a.canceller.key();
    require!(
        canceller == a.bet.party_a
            || canceller == a.bet.party_b
            || canceller == a.bet.judge_authority,
        EscrowError::NotAuthorizedToCancel
    );

    let v = a.vault.amount;
    let (to_a, to_b) = compute_payout(PayoutKind::OpenRefund, a.bet.stake_a, v);
    let paid = payout(
        PayoutAccounts {
            bet: &a.bet,
            vault: &mut a.vault,
            mint: &a.mint,
            party_a_token: a.party_a_token.as_deref(),
            party_b_token: a.party_b_token.as_deref(),
            token_program: &a.token_program,
        },
        to_a,
        to_b,
    )?;

    let bet = &mut a.bet;
    bet.status = BetStatus::Cancelled;

    // Built first so the borrow of `a` ends before emit_cpi! reads ctx.accounts.
    let event = BetCancelled {
        bet_id: bet.bet_id,
        final_status: BetStatus::Cancelled,
        outcome: Outcome::Refund,
        mint: bet.mint,
        party_a: bet.party_a,
        party_b: bet.party_b,
        party_a_token: paid.party_a_token,
        party_b_token: paid.party_b_token,
        to_a: paid.to_a,
        to_b: paid.to_b,
        ts: now,
        cancelled_by: canceller,
    };
    emit_cpi!(event);
    Ok(())
}
