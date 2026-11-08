//! Escrow payouts and account closing (CONTRACTS.md §9.4 dust rule, §9.8).
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::VerdictError;
use crate::state::Bet;

/// Everything a terminal transition needs to move funds and close accounts.
pub struct Escrow<'a, 'info> {
    pub bet: AccountInfo<'info>,
    pub vault: &'a Account<'info, TokenAccount>,
    pub oracle: AccountInfo<'info>,
    pub track_buffer: AccountInfo<'info>,
    pub token_program: &'a Program<'info, Token>,
    pub payout_accounts: &'a [AccountInfo<'info>],
}

/// Signer seeds material for the Bet PDA.
pub struct BetSeeds {
    creator: Pubkey,
    nonce: [u8; 8],
    bump: [u8; 1],
}

impl BetSeeds {
    pub fn of(bet: &Bet) -> Self {
        BetSeeds { creator: bet.creator, nonce: bet.nonce.to_le_bytes(), bump: [bet.bump] }
    }
    pub fn seeds(&self) -> [&[u8]; 4] {
        [BET_SEED, self.creator.as_ref(), &self.nonce, &self.bump]
    }
}

/// Validates the payout accounts: `n` SPL token accounts, one per participant, in order, each
/// with `mint == bet.mint` and `owner == participants[i]`, writable.
pub fn check_payout_accounts(bet: &Bet, accounts: &[AccountInfo]) -> Result<()> {
    require!(accounts.len() >= bet.n(), VerdictError::BadTokenAccount);
    for (i, info) in accounts.iter().take(bet.n()).enumerate() {
        require!(info.is_writable, VerdictError::BadTokenAccount);
        require!(*info.owner == token::ID, VerdictError::BadTokenAccount);
        let data = info.try_borrow_data()?;
        let ta = TokenAccount::try_deserialize(&mut &data[..]).map_err(|_| error!(VerdictError::BadTokenAccount))?;
        require!(ta.mint == bet.mint, VerdictError::BadTokenAccount);
        require!(ta.owner == bet.participants[i], VerdictError::BadTokenAccount);
    }
    Ok(())
}

/// Pays `payouts` (after applying the dust rule toward `dust_recipient`), closes the vault and
/// the TrackBuffer (rent → oracle). Returns the final per-participant amounts.
pub fn pay_and_close(bet: &Bet, esc: &Escrow, mut payouts: [u64; MAX_PARTICIPANTS], dust_recipient: usize) -> Result<[u64; MAX_PARTICIPANTS]> {
    check_payout_accounts(bet, esc.payout_accounts)?;
    require!(esc.oracle.key() == bet.oracle, VerdictError::Unauthorized);
    verdict_rules::settle::apply_dust(&mut payouts, esc.vault.amount, dust_recipient).map_err(VerdictError::from)?;

    let seeds = BetSeeds::of(bet);
    let s = seeds.seeds();
    let signer: &[&[&[u8]]] = &[&s];
    for (i, &amount) in payouts.iter().enumerate().take(bet.n()) {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                esc.token_program.to_account_info(),
                Transfer {
                    from: esc.vault.to_account_info(),
                    to: esc.payout_accounts[i].clone(),
                    authority: esc.bet.clone(),
                },
                signer,
            ),
            amount,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        esc.token_program.to_account_info(),
        CloseAccount {
            account: esc.vault.to_account_info(),
            destination: esc.oracle.clone(),
            authority: esc.bet.clone(),
        },
        signer,
    ))?;
    close_track_buffer(&esc.track_buffer, &esc.oracle)?;
    Ok(payouts)
}

/// Closes the TrackBuffer if it is owned by this program and non-empty (§9.3).
pub fn close_track_buffer<'info>(track_buffer: &AccountInfo<'info>, dest: &AccountInfo<'info>) -> Result<()> {
    if *track_buffer.owner != crate::ID || track_buffer.data_is_empty() {
        return Ok(());
    }
    let lamports = track_buffer.lamports();
    **dest.try_borrow_mut_lamports()? = dest.lamports().checked_add(lamports).ok_or(VerdictError::MathOverflow)?;
    **track_buffer.try_borrow_mut_lamports()? = 0;
    track_buffer.assign(&system_program::ID);
    track_buffer.resize(0)?;
    Ok(())
}

/// Total stake held: `Σ_{i funded} stakes[i]`.
pub fn funded_total(bet: &Bet) -> Result<u64> {
    let mut t: u64 = 0;
    for i in 0..bet.n() {
        if bet.funded_mask & (1 << i) != 0 {
            t = t.checked_add(bet.stakes[i]).ok_or(VerdictError::MathOverflow)?;
        }
    }
    Ok(t)
}

/// Refunds every funded stake and any bond (to the disputer), then closes accounts.
/// Dust goes to participant 0. Returns the amounts transferred.
pub fn refund_all(bet: &Bet, esc: &Escrow) -> Result<[u64; MAX_PARTICIPANTS]> {
    let disputer = bet.disputer_index();
    let bond = if disputer.is_some() { bet.dispute_bond } else { 0 };
    let payouts = verdict_rules::settle::refund_payouts(bet.stakes(), bet.funded_mask, bond, disputer).map_err(VerdictError::from)?;
    pay_and_close(bet, esc, payouts, 0)
}

/// Winner settlement (§9.8). Returns `(pot, amounts)`.
pub fn settle_winners(bet: &Bet, esc: &Escrow, winner_mask: u8, bond_upheld: bool) -> Result<(u64, [u64; MAX_PARTICIPANTS])> {
    let disputer = bet.disputer_index();
    let bond = if disputer.is_some() { bet.dispute_bond } else { 0 };
    let payouts = verdict_rules::settle::settle_payouts(bet.stakes(), bet.funded_mask, winner_mask, bond, bond_upheld && bond > 0, disputer)
        .map_err(VerdictError::from)?;
    let mut pot = funded_total(bet)?;
    if bond_upheld {
        pot = pot.checked_add(bond).ok_or(VerdictError::MathOverflow)?;
    }
    let recipient = verdict_rules::settle::lowest_winner(winner_mask).ok_or(VerdictError::BadOutcome)?;
    let amounts = pay_and_close(bet, esc, payouts, recipient)?;
    Ok((pot, amounts))
}
