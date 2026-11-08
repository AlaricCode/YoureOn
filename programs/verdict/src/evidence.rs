//! Rolling evidence roots (CONTRACTS.md §7.4): head checks, gap bits and the root.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::crypto;
use crate::errors::VerdictError;
use crate::state::Bet;

/// One witness head as passed to `commit_evidence` / `end` (§9.4): chunk index + chain hash.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeadArg {
    pub index: u32,
    pub hash: [u8; 32],
}

/// Witness registration for `start` (§9.4 #5).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct WitnessArg {
    pub key: Pubkey,
    pub kind: u8,
}

/// Head index as a signed position: `0xFFFFFFFF` (none) = −1.
fn pos(index: u32) -> i64 {
    if index == HEAD_NONE {
        -1
    } else {
        index as i64
    }
}

/// Applies an oracle commit: `seq == evidence_seq + 1`, exactly `n_witnesses` heads in witness
/// order, monotonic heads, equal index ⇒ equal hash; updates gap bits, heads and the root.
pub fn apply_commit(bet: &mut Bet, seq: u32, heads: &[HeadArg], now: i64) -> Result<()> {
    let expected = bet.evidence_seq.checked_add(1).ok_or(VerdictError::EvidenceSeq)?;
    require!(seq == expected, VerdictError::EvidenceSeq);
    let n = bet.witness_count();
    require!(heads.len() == n, VerdictError::EvidenceHeads);

    let mut gap = bet.gap_mask;
    for (w, h) in heads.iter().enumerate() {
        let old = pos(bet.witness_heads[w]);
        let new = pos(h.index);
        require!(new >= old, VerdictError::EvidenceRegress);
        if new == old {
            require!(h.hash == bet.witness_head_hashes[w], VerdictError::EvidenceRegress);
        }
        if new - old > MAX_CHUNKS_PER_COMMIT as i64 {
            gap |= 1 << w;
        }
    }
    if now.saturating_sub(bet.last_commit_at) > EVIDENCE_MAX_GAP_S {
        gap |= ((1u16 << n) - 1) as u8;
    }
    for (w, h) in heads.iter().enumerate() {
        bet.witness_heads[w] = h.index;
        bet.witness_head_hashes[w] = h.hash;
    }
    bet.gap_mask = gap;
    bet.evidence_seq = seq;
    bet.last_commit_at = now;
    bet.evidence_root = current_root(bet);
    Ok(())
}

/// Root of the stored heads.
pub fn current_root(bet: &Bet) -> [u8; 32] {
    let n = bet.witness_count();
    crypto::evidence_root(&bet.witnesses[..n], &bet.witness_heads[..n], &bet.witness_head_hashes[..n])
}
