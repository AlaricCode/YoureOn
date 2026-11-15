use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::EscrowError,
    events::BetAccepted,
    state::{Bet, BetStatus, Config},
};

/// B's deposit. B commits to who they bet against (`expected_party_a`, P9), the terms they saw
/// (`expected_terms_hash`, I3) and both amounts (P3). In the atomic lock this runs right after
/// `create_bet` in the same transaction and reads the Bet that instruction initialized.
#[event_cpi]
#[derive(Accounts)]
pub struct AcceptBet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// B's device key.
    pub party_b: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BET_SEED, bet.bet_id.as_ref()], bump = bet.bump,
              has_one = mint @ EscrowError::WrongMint,
              has_one = party_b @ EscrowError::NotPartyB)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [VAULT_SEED, bet.bet_id.as_ref()], bump = bet.vault_bump,
              token::mint = mint, token::authority = bet, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = party_b,
              token::token_program = token_program)]
    pub party_b_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_accept_bet(
    ctx: Context<AcceptBet>,
    expected_terms_hash: [u8; 32],
    expected_stake_a: u64,
    expected_stake_b: u64,
    expected_party_a: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.config.paused, EscrowError::Paused);

    let bet = &ctx.accounts.bet;
    require!(bet.status == BetStatus::Open, EscrowError::InvalidStatus);
    require!(now < bet.accept_deadline, EscrowError::AcceptDeadlinePassed);
    require_keys_eq!(expected_party_a, bet.party_a, EscrowError::PartyMismatch);
    require!(
        expected_terms_hash == bet.terms_hash,
        EscrowError::TermsHashMismatch
    );
    require!(
        expected_stake_a == bet.stake_a && expected_stake_b == bet.stake_b,
        EscrowError::StakeMismatch
    );
    let stake_b = bet.stake_b;
    let resolve_deadline = now
        .checked_add(i64::from(bet.resolve_window_secs))
        .ok_or(EscrowError::MathOverflow)?;

    // B's deposit, checked by exact vault delta (I13): a donation can't mask a short deposit.
    let pre = ctx.accounts.vault.amount;
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.party_b_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.party_b.to_account_info(),
            },
        ),
        stake_b,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.vault.reload()?;
    let vault_amount = ctx.accounts.vault.amount;
    require!(
        vault_amount.checked_sub(pre) == Some(stake_b),
        EscrowError::VaultUnderfunded
    );

    let bet = &mut ctx.accounts.bet;
    bet.status = BetStatus::Locked;
    bet.locked_at = now;
    bet.resolve_deadline = resolve_deadline;

    emit_cpi!(BetAccepted {
        bet_id: bet.bet_id,
        party_a: bet.party_a,
        party_b: bet.party_b,
        terms_hash: bet.terms_hash,
        stake_a: bet.stake_a,
        stake_b: bet.stake_b,
        vault_amount,
        resolve_deadline,
        ts: now,
    });
    Ok(())
}
