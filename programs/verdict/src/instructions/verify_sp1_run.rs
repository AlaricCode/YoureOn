//! #14 `verify_sp1_run` (§9.4, D-9, D-24): SP1 pre-ruling for SP1-only buffers.
//!
//! Compiled out by default (`Sp1Disabled`). With feature `sp1`, the public values are fully
//! checked against the Bet and the ruling is applied exactly like `run_rules`. Proof verification
//! is fail-closed: no SP1 Groth16 verifying key is wired yet, so only the `mock-zk` test proof
//! (64 × 0x01 prefix) is accepted.
use anchor_lang::prelude::*;

use crate::errors::VerdictError;
use crate::state::Bet;

#[derive(Accounts)]
pub struct VerifySp1Run<'info> {
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle @ VerdictError::Unauthorized)]
    pub bet: Box<Account<'info, Bet>>,
}

/// `program_hash ‖ calibration_hash ‖ perception_root ‖ evidence_root ‖ bio_hash ‖ preruling ‖
/// reason ‖ winner_mask ‖ leg_results[8]`.
pub const SP1_PUBLIC_VALUES_LEN: usize = 32 * 5 + 3 + 8;

#[cfg(feature = "sp1")]
pub fn handle_verify_sp1_run(ctx: Context<VerifySp1Run>, public_values: Vec<u8>, proof: Vec<u8>) -> Result<()> {
    use super::run_rules::{apply_ruling, Ruling};
    use crate::constants::*;
    use crate::crypto::bio_hash;

    let now = Clock::get()?.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    let bet = &mut ctx.accounts.bet;
    require!(bet.state == STATE_PERCEIVING, VerdictError::InvalidState);
    require!(bet.tracks_finalized == TRACKS_SP1_ONLY, VerdictError::TracksNotFinalized);
    require!(now <= bet.ended_at.saturating_add(PERCEPTION_TIMEOUT_S), VerdictError::DeadlinePassed);
    let pv = &public_values;
    require!(pv.len() == SP1_PUBLIC_VALUES_LEN, VerdictError::BadProof);
    let h = |i: usize| -> &[u8] { &pv[32 * i..32 * i + 32] };
    require!(h(0) == bet.program_hash, VerdictError::ProgramHashMismatch);
    require!(h(1) == bet.calibration_hash, VerdictError::CalibrationHashMismatch);
    require!(h(2) == bet.perception_root, VerdictError::BadProof);
    require!(h(3) == bet.evidence_root, VerdictError::BadProof);
    let n_bio = bet.n_bio as usize;
    require!(h(4) == bio_hash(&bet.bio[..n_bio]), VerdictError::BadProof);

    verify_sp1_proof(&public_values, &proof)?;

    // The ruling must be self-consistent (errata chainmodel; mirrors the TS chain model): a
    // WINNER has reason 0 and a nonzero mask within the participants; NEEDS_PANEL has a §3.2
    // panel reason (10..=13) and mask 0; leg results are 0/1/2 or 0xFF.
    let (pre, reason, mask) = (pv[160], pv[161], pv[162]);
    if pre == PRERULING_WINNER {
        require!(reason == 0 && mask != 0 && mask & !bet.all_mask() == 0, VerdictError::BadProof);
    } else {
        require!(pre == PRERULING_NEEDS_PANEL && (10..=13).contains(&reason) && mask == 0, VerdictError::BadProof);
    }
    require!(pv[163..171].iter().all(|&v| v <= 2 || v == 0xff), VerdictError::BadProof);

    let mut leg_results = [0u8; 8];
    leg_results.copy_from_slice(&pv[163..171]);
    let ruling = Ruling { preruling: pre, reason, winner_mask: mask, leg_results };
    apply_ruling(bet, bet_key, &ruling, now)
}

#[cfg(feature = "sp1")]
fn verify_sp1_proof(_public_values: &[u8], proof: &[u8]) -> Result<()> {
    if cfg!(feature = "mock-zk") && proof.len() >= 64 && proof[..64].iter().all(|&b| b == 1) {
        return Ok(());
    }
    err!(VerdictError::BadProof)
}

#[cfg(not(feature = "sp1"))]
pub fn handle_verify_sp1_run(_ctx: Context<VerifySp1Run>, _public_values: Vec<u8>, _proof: Vec<u8>) -> Result<()> {
    err!(VerdictError::Sp1Disabled)
}
