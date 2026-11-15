//! The ONLY code that pays stakes out of a vault (ESCROW-PROGRAM §5.2 `payout()`, §6 math, I1, I5).
//!
//! Every terminal instruction (`cancel_open_bet`, `concede`, `resolve_appeal`, `finalize`,
//! `timeout_refund`) does the same five steps (§5.2):
//! 1. check its preconditions, including a non-terminal status (the double-pay guard);
//! 2. `v = vault.amount`, `(to_a, to_b) = compute_payout(kind, stake_a, v)`;
//! 3. `payout()`, which ends with `require!(vault.amount == 0)`;
//! 4. write the terminal status (it persists until `close_bet`);
//! 5. emit its terminal event with `to_a`, `to_b` and the destinations used.
//!
//! `close_bet`'s residual sweep (tokens that arrived after settlement, to A only) is the one other
//! vault debit; it lives in `close_bet.rs` and also asserts `vault.amount == 0`.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::BET_SEED,
    error::EscrowError,
    state::{Bet, Outcome},
};

/// Which §6 formula applies. Terminal handlers pick one; `compute_payout` never errors on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutKind {
    /// `cancel_open_bet`, or `timeout_refund` from `Open`: everything back to A.
    OpenRefund,
    /// `concede`, `finalize`, `resolve_appeal`: the (final) ruling's outcome.
    Ruled(Outcome),
    /// `timeout_refund` from `Locked` or `Appealed`: each side's own stake back.
    LockedRefund,
}

/// ESCROW §6. Pure and TOTAL (no `Result`): an exit path must never be bricked by its own math.
///
/// - `to_a + to_b == v` for every input (no dust can strand in the vault, TM-A2).
/// - Split: `to_a = floor(v / 2)`, so an odd micro-unit goes to B.
/// - Refund / LockedRefund: A gets `min(stake_a, v)` (saturating; `v ≥ stake_a` by I13, but a
///   bug or hostile mint must not brick the exit, TM-L6), B gets the rest, i.e. their own stake
///   plus any excess ("anything not attributable to a stake goes to the party who didn't set the
///   terms").
/// - No subtraction can underflow: every `v - a` has `a ≤ v`.
pub fn compute_payout(kind: PayoutKind, stake_a: u64, v: u64) -> (u64, u64) {
    match kind {
        PayoutKind::OpenRefund => (v, 0),
        PayoutKind::Ruled(Outcome::PartyA) => (v, 0),
        PayoutKind::Ruled(Outcome::PartyB) => (0, v),
        PayoutKind::Ruled(Outcome::Split) => {
            let a = v / 2;
            (a, v - a)
        }
        PayoutKind::Ruled(Outcome::Refund) | PayoutKind::LockedRefund => {
            let a = stake_a.min(v);
            (a, v - a)
        }
    }
}

/// Borrowed view of the payout account set (P) of one terminal instruction (§5.2). The
/// destination constraints (`token::mint`, `token::token_program`, SPL `owner == bet.party_x`)
/// were already enforced by the Accounts struct whenever the account is present.
pub struct PayoutAccounts<'a, 'info> {
    pub bet: &'a Account<'info, Bet>,
    pub vault: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub party_a_token: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub party_b_token: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub token_program: &'a Interface<'info, TokenInterface>,
}

/// What a payout did, for the terminal event (§7.2 common fields).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Paid {
    pub to_a: u64,
    pub to_b: u64,
    /// The account that received `to_a`; `Pubkey::default()` when `to_a == 0` (nothing sent).
    pub party_a_token: Pubkey,
    /// The account that received `to_b`; `Pubkey::default()` when `to_b == 0` (nothing sent).
    pub party_b_token: Pubkey,
}

/// `transfer_checked(vault → dst, amount)` signed by the Bet PDA (stored `bet_id` + bump, I16).
pub(crate) fn transfer_from_vault<'info>(
    bet: &Account<'info, Bet>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    dst: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let bump = [bet.bump];
    let seeds: &[&[&[u8]]] = &[&[BET_SEED, bet.bet_id.as_ref(), &bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: dst.to_account_info(),
                authority: bet.to_account_info(),
            },
            seeds,
        ),
        amount,
        mint.decimals,
    )
}

/// Pays `to_a` to `party_a_token` and `to_b` to `party_b_token`, then asserts the vault is empty
/// (I5). A destination is required (`MissingPayoutAccount`) iff its amount is > 0, so the side
/// that receives 0 may be omitted (I12, TM-L3). Does NOT close anything: `close_bet` does (P8).
pub fn payout(p: PayoutAccounts, to_a: u64, to_b: u64) -> Result<Paid> {
    let mut paid = Paid {
        to_a,
        to_b,
        party_a_token: Pubkey::default(),
        party_b_token: Pubkey::default(),
    };
    // Both destinations are resolved before any CPI so a missing one moves nothing (TM-L13).
    let dst_a = if to_a > 0 {
        Some(p.party_a_token.ok_or(EscrowError::MissingPayoutAccount)?)
    } else {
        None
    };
    let dst_b = if to_b > 0 {
        Some(p.party_b_token.ok_or(EscrowError::MissingPayoutAccount)?)
    } else {
        None
    };
    if let Some(dst) = dst_a {
        transfer_from_vault(p.bet, p.vault, p.mint, dst, p.token_program, to_a)?;
        paid.party_a_token = dst.key();
    }
    if let Some(dst) = dst_b {
        transfer_from_vault(p.bet, p.vault, p.mint, dst, p.token_program, to_b)?;
        paid.party_b_token = dst.key();
    }
    p.vault.reload()?;
    require!(p.vault.amount == 0, EscrowError::VaultNotEmpty);
    Ok(paid)
}

/// The losing side for a `PartyA` / `PartyB` outcome; `None` for Split / Refund (§4 loser table).
pub fn loser_of(bet: &Bet, outcome: Outcome) -> Option<Pubkey> {
    match outcome {
        Outcome::PartyA => Some(bet.party_b),
        Outcome::PartyB => Some(bet.party_a),
        Outcome::Split | Outcome::Refund => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [PayoutKind; 6] = [
        PayoutKind::OpenRefund,
        PayoutKind::LockedRefund,
        PayoutKind::Ruled(Outcome::PartyA),
        PayoutKind::Ruled(Outcome::PartyB),
        PayoutKind::Ruled(Outcome::Split),
        PayoutKind::Ruled(Outcome::Refund),
    ];

    #[test]
    fn spec_table_rows() {
        use Outcome::*;
        use PayoutKind::*;
        let rows: &[(PayoutKind, u64, u64, u64, u64)] = &[
            (Ruled(PartyA), 5_000_000, 10_000_000, 10_000_000, 0),
            (Ruled(PartyB), 20_000_000, 40_000_000, 0, 40_000_000),
            (Ruled(Split), 6_200_000, 10_000_000, 5_000_000, 5_000_000),
            (Ruled(Refund), 6_200_000, 10_000_000, 6_200_000, 3_800_000),
            (Ruled(Split), 3_000_001, 5_000_001, 2_500_000, 2_500_001),
            (Ruled(Refund), 3_000_001, 5_000_001, 3_000_001, 2_000_000),
            (Ruled(Split), 5_000_000, 10_000_007, 5_000_003, 5_000_004),
            (Ruled(Refund), 5_000_000, 10_000_007, 5_000_000, 5_000_007),
            (OpenRefund, 5_000_000, 5_000_000, 5_000_000, 0),
            (Ruled(Refund), 5_000_000, 4_999_999, 4_999_999, 0),
            (LockedRefund, 5_000_000, 4_999_999, 4_999_999, 0),
        ];
        for &(k, s, v, a, b) in rows {
            assert_eq!(compute_payout(k, s, v), (a, b), "{k:?} stake_a={s} v={v}");
        }
    }

    #[test]
    fn total_and_conserving_on_small_ranges() {
        for k in ALL {
            for s in 0..=50u64 {
                for v in 0..=103u64 {
                    let (a, b) = compute_payout(k, s, v);
                    assert_eq!(a + b, v);
                }
            }
        }
        for k in ALL {
            for v in [0, 1, u64::MAX - 1, u64::MAX] {
                for s in [0, 1, u64::MAX / 4, u64::MAX] {
                    let (a, b) = compute_payout(k, s, v);
                    assert_eq!(a.checked_add(b), Some(v));
                }
            }
        }
    }
}
