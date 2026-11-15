//! #3 `fund` (§9.4): a participant escrows its stake and binds program, calibration and terms.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::crypto::{is_zero, terms_hash};
use crate::errors::VerdictError;
use crate::events::Funded as FundedEvent;
use crate::state::{Bet, BetKind};

#[derive(Accounts)]
pub struct Fund<'info> {
    pub participant: Signer<'info>,
    #[account(mut)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [VAULT_SEED, bet.key().as_ref()], bump = bet.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = participant_token.mint == bet.mint @ VerdictError::BadTokenAccount,
        constraint = participant_token.owner == participant.key() @ VerdictError::BadTokenAccount,
    )]
    pub participant_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_fund(ctx: Context<Fund>, calibration_hash: [u8; 32], program_hash: [u8; 32], terms: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bet = &ctx.accounts.bet;
    require!(bet.state == STATE_PROPOSED, VerdictError::InvalidState);
    require!(now <= bet.fund_deadline, VerdictError::DeadlinePassed);
    let i = bet.require_participant(&ctx.accounts.participant.key())?;
    require!(bet.funded_mask & (1 << i) == 0, VerdictError::AlreadyFunded);

    // Consent binding (D-37): the funder commits to the program and the terms.
    require!(program_hash == bet.program_hash, VerdictError::ConsentMismatch);
    require!(
        terms == terms_hash(&bet.oracle, &bet.judges, &bet.acceptance_audio_hash),
        VerdictError::ConsentMismatch
    );

    // Calibration (D-12).
    let set_calibration = match bet.kind() {
        BetKind::Rules => {
            require!(!is_zero(&calibration_hash), VerdictError::CalibrationMismatch);
            if is_zero(&bet.calibration_hash) {
                true
            } else {
                require!(calibration_hash == bet.calibration_hash, VerdictError::CalibrationMismatch);
                false
            }
        }
        BetKind::AiJudged | BetKind::Market => {
            require!(is_zero(&calibration_hash), VerdictError::CalibrationMismatch);
            false
        }
    };

    let amount = bet.stakes[i];
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.participant_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.participant.to_account_info(),
            },
        ),
        amount,
    )?;

    let bet_key = ctx.accounts.bet.key();
    let bet = &mut ctx.accounts.bet;
    if set_calibration {
        bet.calibration_hash = calibration_hash;
    }
    bet.funded_mask |= 1 << i;
    let all_funded = bet.funded_mask == bet.all_mask();
    if all_funded {
        bet.state = STATE_FUNDED;
        bet.funded_at = now;
    }
    emit!(FundedEvent {
        bet: bet_key,
        participant: ctx.accounts.participant.key(),
        participant_idx: i as u8,
        amount,
        funded_mask: bet.funded_mask,
        all_funded,
        calibration_hash: bet.calibration_hash,
    });
    Ok(())
}
