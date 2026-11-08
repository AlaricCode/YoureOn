//! Hashes and Merkle roots (CONTRACTS.md §4.2, §7.2–§7.4, §9.7).
use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hashv;

use crate::constants::*;

pub const ZERO32: [u8; 32] = [0u8; 32];

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    hashv(parts).to_bytes()
}

pub fn is_zero(h: &[u8; 32]) -> bool {
    h.iter().all(|&b| b == 0)
}

/// `terms_hash = sha256("VERDICT/TERMS/v1" ‖ oracle ‖ judges[0..3] ‖ acceptance_audio_hash)` (§4.2).
pub fn terms_hash(oracle: &Pubkey, judges: &[Pubkey; 3], acceptance_audio_hash: &[u8; 32]) -> [u8; 32] {
    sha256(&[
        TAG_TERMS,
        oracle.as_ref(),
        judges[0].as_ref(),
        judges[1].as_ref(),
        judges[2].as_ref(),
        acceptance_audio_hash,
    ])
}

/// Witness chain genesis `G_w` (§7.2).
pub fn chain_genesis(bet: &Pubkey, witness: &Pubkey, kind: u8, beacon_slot: u64, beacon_hash: &[u8; 32]) -> [u8; 32] {
    sha256(&[TAG_CHAIN, bet.as_ref(), witness.as_ref(), &[kind], &beacon_slot.to_le_bytes(), beacon_hash])
}

/// `leaf_w = sha256(0x00 ‖ witness_key ‖ u32 index ‖ hash)` (§7.4).
pub fn evidence_leaf(witness: &Pubkey, index: u32, hash: &[u8; 32]) -> [u8; 32] {
    sha256(&[&[0u8], witness.as_ref(), &index.to_le_bytes(), hash])
}

/// Merkle root over at most `MAX_WITNESSES` leaves (§7.3): pairs → `sha256(0x01 ‖ l ‖ r)`,
/// an odd last node is carried up unchanged; `merkle([]) = 0`. In place, no heap.
pub fn merkle_root(leaves: &mut [[u8; 32]]) -> [u8; 32] {
    let mut n = leaves.len();
    if n == 0 {
        return ZERO32;
    }
    while n > 1 {
        let mut w = 0;
        let mut i = 0;
        while i < n {
            leaves[w] = if i + 1 < n { sha256(&[&[1u8], &leaves[i], &leaves[i + 1]]) } else { leaves[i] };
            w += 1;
            i += 2;
        }
        n = w;
    }
    leaves[0]
}

/// Evidence root over the stored witness heads (§7.4).
pub fn evidence_root(witnesses: &[Pubkey], heads: &[u32], head_hashes: &[[u8; 32]]) -> [u8; 32] {
    let n = witnesses.len().min(MAX_WITNESSES);
    let mut leaves = [ZERO32; MAX_WITNESSES];
    for i in 0..n {
        leaves[i] = evidence_leaf(&witnesses[i], heads[i], &head_hashes[i]);
    }
    merkle_root(&mut leaves[..n])
}

/// Panel message `M` (§9.7), 145 bytes.
pub fn panel_message(
    program_id: &Pubkey,
    bet: &Pubkey,
    outcome: u8,
    evidence_root: &[u8; 32],
    program_hash: &[u8; 32],
) -> [u8; PANEL_MSG_LEN] {
    let mut m = [0u8; PANEL_MSG_LEN];
    m[..16].copy_from_slice(TAG_PANEL);
    m[16..48].copy_from_slice(program_id.as_ref());
    m[48..80].copy_from_slice(bet.as_ref());
    m[80] = outcome;
    m[81..113].copy_from_slice(evidence_root);
    m[113..145].copy_from_slice(program_hash);
    m
}

/// Big-endian `a < BN254 r` (§8.4).
pub fn lt_bn254_r(a: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] != BN254_R_BE[i] {
            return a[i] < BN254_R_BE[i];
        }
    }
    false
}

/// `bio_hash = sha256(u8 n_bio ‖ bio[0..n_bio])`, each BioCheck 6 bytes Borsh (§4.2).
pub fn bio_hash(bio: &[crate::state::BioCheck]) -> [u8; 32] {
    let mut buf = [0u8; 1 + 6 * MAX_CHECKPOINTS];
    let n = bio.len().min(MAX_CHECKPOINTS);
    buf[0] = n as u8;
    for (i, b) in bio.iter().take(n).enumerate() {
        let o = 1 + 6 * i;
        buf[o] = b.participant;
        buf[o + 1] = b.modality;
        buf[o + 2..o + 6].copy_from_slice(&b.frame.to_le_bytes());
    }
    sha256(&[&buf[..1 + 6 * n]])
}
