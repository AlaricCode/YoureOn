//! #11 `dispute` (§9.4): a non-consenting participant posts a bond → Disputed.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::VerdictError;
use crate::events::Disputed;
use crate::state::Bet;

#[derive(Accounts)]
pub struct Dispute<'info> {
    pub disputer: Signer<'info>,
    #[account(mut)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [VAULT_SEED, bet.key().as_ref()], bump = bet.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = disputer_token.mint == bet.mint @ VerdictError::BadTokenAccount,
        constraint = disputer_token.owner == disputer.key() @ VerdictError::BadTokenAccount,
    )]
    pub disputer_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_dispute(ctx: Context<Dispute>, reason: u8, evidence_root: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    let disputer = ctx.accounts.disputer.key();
    let bond = {
        let bet = &ctx.accounts.bet;
        require!(bet.state == STATE_PRERULED, VerdictError::InvalidState);
        require!(now <= bet.consent_deadline, VerdictError::DeadlinePassed);
        require!((DISPUTE_REASON_MIN..=DISPUTE_REASON_MAX).contains(&reason), VerdictError::BadReason);
        require!(evidence_root == bet.evidence_root, VerdictError::ConsentMismatch);
        let i = bet.require_participant(&disputer)?;
        require!(bet.consent_mask & (1 << i) == 0, VerdictError::AlreadyConsented);
        verdict_rules::settle::dispute_bond(bet.stakes())
    };

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.disputer_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.disputer.to_account_info(),
            },
        ),
        bond,
    )?;

    let bet = &mut ctx.accounts.bet;
    bet.state = STATE_DISPUTED;
    bet.disputer = disputer;
    bet.dispute_bond = bond;
    bet.dispute_reason = reason;
    bet.disputed_at = now;
    emit!(Disputed { bet: bet_key, disputer, reason, bond });
    Ok(())
}
