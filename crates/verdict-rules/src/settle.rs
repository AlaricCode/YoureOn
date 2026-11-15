//! Settlement math (§9.8), u128 intermediates, identical to the engine's bigint `settle.ts`.

use crate::constants::*;
use crate::error::SettleError;

pub type Payouts = [u64; MAX_PARTICIPANTS];

fn check_n(n: usize) -> Result<(), SettleError> {
    if !(1..=MAX_PARTICIPANTS).contains(&n) {
        return Err(SettleError::BadOutcome);
    }
    Ok(())
}

/// Dispute bond: `max(min_i stakes[i] / DISPUTE_BOND_DIV, DISPUTE_BOND_MIN)` (§9.4 #11).
pub fn dispute_bond(stakes: &[u64]) -> u64 {
    let min = stakes.iter().copied().min().unwrap_or(0);
    (min / DISPUTE_BOND_DIV).max(DISPUTE_BOND_MIN)
}

/// Winner payouts (§9.8).
///
/// `pot = Σ_{i funded} stakes[i] + (bond_upheld ? bond : 0)`, `SW = Σ_{i∈W} stakes[i]`,
/// `payout_i = floor(pot·stakes[i] / SW)` for i ∈ W, the remainder goes to the lowest-index
/// winner. A bond that is not upheld (`bond > 0`, `!bond_upheld`) is returned to
/// `disputer` (participant index). Dust is applied separately ([`apply_dust`]).
pub fn settle_payouts(
    stakes: &[u64],
    funded_mask: u8,
    winner_mask: u8,
    bond: u64,
    bond_upheld: bool,
    disputer: Option<usize>,
) -> Result<Payouts, SettleError> {
    let n = stakes.len();
    check_n(n)?;
    if winner_mask == 0 || (winner_mask as u32) >> n != 0 {
        return Err(SettleError::BadOutcome);
    }
    let mut pot: u128 = 0;
    let mut sw: u128 = 0;
    for (i, &s) in stakes.iter().enumerate() {
        if funded_mask & (1 << i) != 0 {
            pot += s as u128;
        }
        if winner_mask & (1 << i) != 0 {
            sw += s as u128;
        }
    }
    if bond_upheld {
        pot += bond as u128;
    }
    if sw == 0 {
        return Err(SettleError::BadOutcome);
    }
    let mut out = [0u64; MAX_PARTICIPANTS];
    let mut paid: u128 = 0;
    let mut lowest = None;
    for (i, &s) in stakes.iter().enumerate() {
        if winner_mask & (1 << i) == 0 {
            continue;
        }
        lowest.get_or_insert(i);
        let p = pot * s as u128 / sw;
        paid += p;
        out[i] = u64::try_from(p).map_err(|_| SettleError::MathOverflow)?;
    }
    let rem = pot.checked_sub(paid).ok_or(SettleError::MathOverflow)?;
    let lw = lowest.ok_or(SettleError::BadOutcome)?;
    out[lw] = add(out[lw], rem)?;
    if !bond_upheld && bond > 0 {
        let d = disputer.filter(|&d| d < n).ok_or(SettleError::BadOutcome)?;
        out[d] = add(out[d], bond as u128)?;
    }
    Ok(out)
}

/// Refund payouts: every funded stake back, plus any bond to the disputer.
pub fn refund_payouts(stakes: &[u64], funded_mask: u8, bond: u64, disputer: Option<usize>) -> Result<Payouts, SettleError> {
    let n = stakes.len();
    check_n(n)?;
    let mut out = [0u64; MAX_PARTICIPANTS];
    for (i, &s) in stakes.iter().enumerate() {
        if funded_mask & (1 << i) != 0 {
            out[i] = s;
        }
    }
    if bond > 0 {
        let d = disputer.filter(|&d| d < n).ok_or(SettleError::BadOutcome)?;
        out[d] = add(out[d], bond as u128)?;
    }
    Ok(out)
}

/// Dust rule (§9.4): `vault_amount − Σ payouts` goes to `recipient` (lowest-index winner;
/// refund paths: participant 0). Returns the dust moved. `vault_amount < Σ payouts` ⇒ overflow.
pub fn apply_dust(payouts: &mut Payouts, vault_amount: u64, recipient: usize) -> Result<u64, SettleError> {
    if recipient >= MAX_PARTICIPANTS {
        return Err(SettleError::BadOutcome);
    }
    let total: u128 = payouts.iter().map(|&p| p as u128).sum();
    let dust = (vault_amount as u128).checked_sub(total).ok_or(SettleError::MathOverflow)?;
    payouts[recipient] = add(payouts[recipient], dust)?;
    Ok(dust as u64)
}

/// Lowest set bit index of a winner mask.
pub fn lowest_winner(winner_mask: u8) -> Option<usize> {
    if winner_mask == 0 {
        None
    } else {
        Some(winner_mask.trailing_zeros() as usize)
    }
}

fn add(a: u64, b: u128) -> Result<u64, SettleError> {
    u64::try_from(a as u128 + b).map_err(|_| SettleError::MathOverflow)
}
