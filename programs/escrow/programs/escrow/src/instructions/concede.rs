use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::EscrowError,
    events::BetConceded,
    payout::{compute_payout, loser_of, payout, PayoutAccounts, PayoutKind},
    state::{Bet, BetStatus},
};

/// The loser accepts the ruling ("GG"): instant payout per the stored outcome (ESCROW §5.2).
/// `PartyA` / `PartyB` outcomes only (P5: a one-sided concede of Split/Refund would bypass the
/// other party's right to appeal). Allowed any time while `Resolved`; after the window it is
/// equivalent to `finalize`.
#[event_cpi]
#[derive(Accounts)]
pub struct Concede<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The loser's device key (`NotParty`, `NotLoser`).
    pub party: Signer<'info>,
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
    /// Required iff `to_b > 0`. SPL owner field == `bet.party_b`.
    #[account(mut, token::mint = mint, token::token_program = token_program,
              constraint = party_b_token.owner == bet.party_b @ EscrowError::WrongPayoutAccount)]
    pub party_b_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_concede(ctx: Context<Concede>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut *ctx.accounts;
    let party = a.party.key();

    require!(
        a.bet.status == BetStatus::Resolved,
        EscrowError::InvalidStatus
    );
    let outcome = a.bet.outcome.ok_or(EscrowError::InvalidStatus)?;
    let loser = loser_of(&a.bet, outcome).ok_or(EscrowError::ConcedeNotAllowed)?;
    require!(
        party == a.bet.party_a || party == a.bet.party_b,
        EscrowError::NotParty
    );
    require_keys_eq!(party, loser, EscrowError::NotLoser);

    let v = a.vault.amount;
    let (to_a, to_b) = compute_payout(PayoutKind::Ruled(outcome), a.bet.stake_a, v);
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
    bet.status = BetStatus::Settled;

    // Built first so the borrow of `a` ends before emit_cpi! reads ctx.accounts.
    let event = BetConceded {
        bet_id: bet.bet_id,
        final_status: BetStatus::Settled,
        outcome,
        mint: bet.mint,
        party_a: bet.party_a,
        party_b: bet.party_b,
        party_a_token: paid.party_a_token,
        party_b_token: paid.party_b_token,
        to_a: paid.to_a,
        to_b: paid.to_b,
        ts: now,
        conceded_by: party,
    };
    emit_cpi!(event);
    Ok(())
}
