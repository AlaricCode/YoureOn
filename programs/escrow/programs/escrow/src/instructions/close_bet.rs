use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    close_account, CloseAccount, Mint, TokenAccount, TokenInterface,
};

use crate::{
    constants::*, error::EscrowError, events::BetClosed, payout::transfer_from_vault, state::Bet,
};

/// Returns all rent to the stored `rent_payer` (ESCROW §5.2, P8, I6). Permissionless, terminal
/// status only. Split from the payout so no token movement ever depends on a lamport destination
/// the program can't vouch for (TM-L4). The server bundles `[terminal ix, close_bet]`.
///
/// Duplicate accounts (TM-U3): `payer == rent_payer` is the normal case. Anchor 1.2.2's
/// duplicate-mutable check covers only serializing types (`Account`, `InterfaceAccount`), not
/// `Signer` / `UncheckedAccount`, so no dup-allow constraint is needed.
#[event_cpi]
#[derive(Accounts)]
pub struct CloseBet<'info> {
    /// Anyone. Gets nothing: rent goes to `rent_payer` (TM-F9, TM-R3).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BET_SEED, bet.bet_id.as_ref()], bump = bet.bump,
              has_one = mint @ EscrowError::WrongMint, close = rent_payer)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [VAULT_SEED, bet.bet_id.as_ref()], bump = bet.vault_bump,
              token::mint = mint, token::authority = bet, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Required iff the vault is non-empty (tokens donated after settlement go to A only, I1).
    #[account(mut, token::mint = mint, token::token_program = token_program,
              constraint = party_a_token.owner == bet.party_a @ EscrowError::WrongPayoutAccount)]
    pub party_a_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// CHECK: lamport destination only; pinned to the stored rent payer.
    #[account(mut, address = bet.rent_payer @ EscrowError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_close_bet(ctx: Context<CloseBet>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut *ctx.accounts;

    // The only instruction that accepts a terminal status (§4).
    require!(a.bet.status.is_terminal(), EscrowError::InvalidStatus);

    // Residual sweep: payout() already asserted vault == 0, so anything here arrived after
    // settlement (TM-D5). It goes to A, the one party guaranteed to have had an account.
    let residual_to_a = a.vault.amount;
    if residual_to_a > 0 {
        let dst = a
            .party_a_token
            .as_deref()
            .ok_or(EscrowError::MissingPayoutAccount)?;
        transfer_from_vault(
            &a.bet,
            &a.vault,
            &a.mint,
            dst,
            &a.token_program,
            residual_to_a,
        )?;
        a.vault.reload()?;
    }
    require!(a.vault.amount == 0, EscrowError::VaultNotEmpty);

    // Read before closing: Bet + vault lamports, including any SOL donated to either (G6).
    let rent_returned = a
        .bet
        .to_account_info()
        .lamports()
        .checked_add(a.vault.to_account_info().lamports())
        .ok_or(EscrowError::MathOverflow)?;

    let bump = [a.bet.bump];
    let seeds: &[&[&[u8]]] = &[&[BET_SEED, a.bet.bet_id.as_ref(), &bump]];
    close_account(CpiContext::new_with_signer(
        a.token_program.key(),
        CloseAccount {
            account: a.vault.to_account_info(),
            destination: a.rent_payer.to_account_info(),
            authority: a.bet.to_account_info(),
        },
        seeds,
    ))?;

    // Anchor's `close = rent_payer` moves the Bet's lamports and zeroes it on exit.
    let event = BetClosed {
        bet_id: a.bet.bet_id,
        final_status: a.bet.status,
        rent_payer: a.rent_payer.key(),
        rent_returned,
        residual_to_a,
        ts: now,
    };
    emit_cpi!(event);
    Ok(())
}
