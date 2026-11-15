use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    spl_token_2022::{
        self,
        extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    },
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::EscrowError,
    events::BetCreated,
    state::{Bet, BetStatus, Config},
};

/// A's deposit. In the default atomic lock (ESCROW §5.0.1) this is followed, in the same
/// transaction, by `accept_bet`; nothing here assumes a separate transaction.
#[event_cpi]
#[derive(Accounts)]
#[instruction(bet_id: [u8; 16])]
pub struct CreateBet<'info> {
    /// Server fee payer → stored as `rent_payer`.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// A's device key.
    pub party_a: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, space = 8 + Bet::INIT_SPACE,
              seeds = [BET_SEED, bet_id.as_ref()], bump)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(init, payer = payer, seeds = [VAULT_SEED, bet_id.as_ref()], bump,
              token::mint = mint, token::authority = bet, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Any A-owned account for the mint (normally A's ATA).
    #[account(mut, token::mint = mint, token::authority = party_a,
              token::token_program = token_program)]
    pub party_a_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Classic SPL Token or Token-2022 only.
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Token-2022 extension ALLOWLIST (ESCROW §3.3): anything not listed is rejected, so
/// extensions added to Token-2022 later are rejected by default. Classic mints have none.
fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    for ext in state.get_extension_types()? {
        match ext {
            ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::MintCloseAuthority => {}
            _ => return err!(EscrowError::MintExtensionNotAllowed),
        }
    }
    Ok(())
}

pub fn handle_create_bet(
    ctx: Context<CreateBet>,
    bet_id: [u8; 16],
    party_b: Pubkey,
    stake_a: u64,
    stake_b: u64,
    terms_hash: [u8; 32],
    accept_deadline: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    let mint_key = ctx.accounts.mint.key();
    let party_a = ctx.accounts.party_a.key();
    let bet_key = ctx.accounts.bet.key();
    let vault_key = ctx.accounts.vault.key();
    let decimals = ctx.accounts.mint.decimals;

    require!(!config.paused, EscrowError::Paused);
    require!(
        config.allowed_mints.contains(&mint_key),
        EscrowError::MintNotAllowed
    );
    require!(decimals == REQUIRED_DECIMALS, EscrowError::WrongDecimals);
    check_mint_extensions(&ctx.accounts.mint.to_account_info())?;

    // I2
    require!(stake_a > 0 && stake_b > 0, EscrowError::StakeZero);
    require!(
        stake_a <= config.max_stake && stake_b <= config.max_stake,
        EscrowError::StakeExceedsMax
    );

    // I17
    require_keys_neq!(party_a, party_b, EscrowError::SameParty);
    let forbidden = [
        Pubkey::default(),
        bet_key,
        vault_key,
        config.judge_authority,
        config.appeal_authority,
    ];
    require!(
        !forbidden.contains(&party_a) && !forbidden.contains(&party_b),
        EscrowError::InvalidParty
    );

    // I3: written once, here
    require!(terms_hash != [0u8; 32], EscrowError::EmptyHash);

    // P10: now < accept_deadline ≤ now + config.accept_deadline_secs
    let max_deadline = now
        .checked_add(i64::from(config.accept_deadline_secs))
        .ok_or(EscrowError::MathOverflow)?;
    require!(
        now < accept_deadline && accept_deadline <= max_deadline,
        EscrowError::InvalidDeadline
    );

    let judge_authority = config.judge_authority;
    let appeal_authority = config.appeal_authority;
    let appeal_window_secs = config.appeal_window_secs;
    let resolve_window_secs = config.resolve_deadline_secs;
    let appeal_resolve_secs = config.appeal_resolve_secs;
    let rent_payer = ctx.accounts.payer.key();

    let bet = &mut ctx.accounts.bet;
    bet.set_inner(Bet {
        bet_id, // from the argument: it seeds every later derivation (I16)
        party_a,
        party_b,
        mint: mint_key,
        rent_payer,
        judge_authority,
        appeal_authority,
        stake_a,
        stake_b,
        terms_hash,
        evidence_hash: [0u8; 32],
        ruling_hash: [0u8; 32],
        status: BetStatus::Open,
        outcome: None,
        appeal_window_secs,
        resolve_window_secs,
        appeal_resolve_secs,
        created_at: now,
        accept_deadline,
        locked_at: 0,
        resolve_deadline: 0,
        resolved_at: 0,
        appeal_deadline: 0,
        appealed_at: 0,
        appeal_resolve_deadline: 0,
        bump: ctx.bumps.bet,
        vault_bump: ctx.bumps.vault,
    });

    // A's deposit; authority = party_a (a user signature, not a PDA)
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.party_a_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.party_a.to_account_info(),
            },
        ),
        stake_a,
        decimals,
    )?;
    // Brand-new vault: equality is exact, so a fee-on-transfer mint fails here (I13).
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts.vault.amount == stake_a,
        EscrowError::VaultUnderfunded
    );

    emit_cpi!(BetCreated {
        bet_id,
        bet: bet_key,
        vault: vault_key,
        party_a,
        party_b,
        mint: mint_key,
        stake_a,
        stake_b,
        terms_hash,
        judge_authority,
        appeal_authority,
        accept_deadline,
        rent_payer,
        ts: now,
    });
    Ok(())
}
