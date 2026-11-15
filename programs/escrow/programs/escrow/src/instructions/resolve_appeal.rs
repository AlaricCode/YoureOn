use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::EscrowError,
    events::AppealResolved,
    payout::{compute_payout, payout, PayoutAccounts, PayoutKind},
    state::{Bet, BetStatus, Outcome},
};

/// The appeal authority's final ruling and payout (ESCROW §5.2, I8). `final_outcome` may uphold
/// or overturn the original. Like the judge, the appeal key chooses an outcome, never an account.
#[event_cpi]
#[derive(Accounts)]
pub struct ResolveAppeal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Must be the bet's snapshotted `appeal_authority` (I8, I11).
    pub appeal_authority: Signer<'info>,
    // ---- payout set (P), §5.2. NOT closed here: close_bet does it (P8). ----
    #[account(mut, seeds = [BET_SEED, bet.bet_id.as_ref()], bump = bet.bump,
              has_one = mint @ EscrowError::WrongMint,
              has_one = appeal_authority @ EscrowError::NotAppealAuthority)]
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
    /// Required iff `to_b > 0`. SPL owner field == `bet.party_b`.
    #[account(mut, token::mint = mint, token::token_program = token_program,
              constraint = party_b_token.owner == bet.party_b @ EscrowError::WrongPayoutAccount)]
    pub party_b_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_resolve_appeal(
    ctx: Context<ResolveAppeal>,
    final_outcome: Outcome,
    appeal_ruling_hash: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut *ctx.accounts;

    require!(
        a.bet.status == BetStatus::Appealed,
        EscrowError::InvalidStatus
    );
    let original_outcome = a.bet.outcome.ok_or(EscrowError::InvalidStatus)?;
    // I10: resolve_appeal `< appeal_resolve_deadline`; timeout_refund `≥` it (RA6).
    require!(
        now < a.bet.appeal_resolve_deadline,
        EscrowError::AppealResolveDeadlinePassed
    );
    require!(appeal_ruling_hash != [0u8; 32], EscrowError::EmptyHash);

    let v = a.vault.amount;
    let (to_a, to_b) = compute_payout(PayoutKind::Ruled(final_outcome), a.bet.stake_a, v);
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
    bet.outcome = Some(final_outcome);
    bet.status = BetStatus::Settled;

    // Built first so the borrow of `a` ends before emit_cpi! reads ctx.accounts.
    let event = AppealResolved {
        bet_id: bet.bet_id,
        final_status: BetStatus::Settled,
        outcome: final_outcome,
        mint: bet.mint,
        party_a: bet.party_a,
        party_b: bet.party_b,
        party_a_token: paid.party_a_token,
        party_b_token: paid.party_b_token,
        to_a: paid.to_a,
        to_b: paid.to_b,
        ts: now,
        original_outcome,
        appeal_ruling_hash,
        overturned: final_outcome != original_outcome,
    };
    emit_cpi!(event);
    Ok(())
}
