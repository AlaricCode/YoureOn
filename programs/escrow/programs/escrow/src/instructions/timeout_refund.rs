use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::EscrowError,
    events::BetRefunded,
    payout::{compute_payout, payout, PayoutAccounts, PayoutKind},
    state::{Bet, BetStatus, Outcome},
};

/// Permissionless exit at the deadline of the current status (ESCROW §5.2, I12, TM-L1/L2):
///
/// | status     | allowed when                      | payout                      |
/// |------------|-----------------------------------|-----------------------------|
/// | `Open`     | `now ≥ accept_deadline`           | `(V, 0)`                    |
/// | `Locked`   | `now ≥ resolve_deadline`          | `(stake_a, V − stake_a)`    |
/// | `Appealed` | `now ≥ appeal_resolve_deadline`   | `(stake_a, V − stake_a)`    |
/// | `Resolved` | never (`InvalidStatus`): use `finalize`, which is always reachable |
///
/// An undecided appeal ends in a refund, not the original ruling (TM-L9, accepted residual).
#[event_cpi]
#[derive(Accounts)]
pub struct TimeoutRefund<'info> {
    /// Anyone (the server's deadline sweeper, or `scripts/crank.ts`).
    #[account(mut)]
    pub payer: Signer<'info>,
    // ---- payout set (P), §5.2. NOT closed here: close_bet does it (P8). ----
    #[account(mut, seeds = [BET_SEED, bet.bet_id.as_ref()], bump = bet.bump,
              has_one = mint @ EscrowError::WrongMint)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [VAULT_SEED, bet.bet_id.as_ref()], bump = bet.vault_bump,
              token::mint = mint, token::authority = bet, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Required iff `to_a > 0`. SPL owner field == `bet.party_a` (I1, TM-F1/F4).
    #[account(mut, token::mint = mint, token::token_program = token_program,
              constraint = party_a_token.owner == bet.party_a @ EscrowError::WrongPayoutAccount)]
    pub party_a_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// Required iff `to_b > 0` (may be omitted from `Open`).
    #[account(mut, token::mint = mint, token::token_program = token_program,
              constraint = party_b_token.owner == bet.party_b @ EscrowError::WrongPayoutAccount)]
    pub party_b_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_timeout_refund(ctx: Context<TimeoutRefund>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut *ctx.accounts;
    let caller = a.payer.key();

    let from_status = a.bet.status;
    let (deadline, kind) = match from_status {
        BetStatus::Open => (a.bet.accept_deadline, PayoutKind::OpenRefund),
        BetStatus::Locked => (a.bet.resolve_deadline, PayoutKind::LockedRefund),
        BetStatus::Appealed => (a.bet.appeal_resolve_deadline, PayoutKind::LockedRefund),
        // Resolved (→ finalize) and every terminal status.
        _ => return err!(EscrowError::InvalidStatus),
    };
    // I10: the action is valid `< deadline`, the timeout `≥ deadline`, never both.
    require!(now >= deadline, EscrowError::DeadlineNotReached);

    let v = a.vault.amount;
    let (to_a, to_b) = compute_payout(kind, a.bet.stake_a, v);
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
    bet.status = BetStatus::Refunded;

    // Built first so the borrow of `a` ends before emit_cpi! reads ctx.accounts.
    let event = BetRefunded {
        bet_id: bet.bet_id,
        final_status: BetStatus::Refunded,
        outcome: Outcome::Refund,
        mint: bet.mint,
        party_a: bet.party_a,
        party_b: bet.party_b,
        party_a_token: paid.party_a_token,
        party_b_token: paid.party_b_token,
        to_a: paid.to_a,
        to_b: paid.to_b,
        ts: now,
        from_status,
        caller,
    };
    emit_cpi!(event);
    Ok(())
}
