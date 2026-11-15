//! Events (CONTRACTS.md §9.5), emitted with `emit!`.
use anchor_lang::prelude::*;

#[event]
pub struct ProfileUpdated {
    pub wallet: Pubkey,
    pub flags: u8,
}

#[event]
pub struct BetCreated {
    pub bet: Pubkey,
    pub creator: Pubkey,
    pub nonce: u64,
    pub participants: Vec<Pubkey>,
    pub stakes: Vec<u64>,
    pub side_b_mask: u8,
    pub flags: u8,
    pub program_hash: [u8; 32],
    pub time_limit_s: u32,
    pub fund_deadline: i64,
}

#[event]
pub struct Funded {
    pub bet: Pubkey,
    pub participant: Pubkey,
    pub participant_idx: u8,
    pub amount: u64,
    pub funded_mask: u8,
    pub all_funded: bool,
    pub calibration_hash: [u8; 32],
}

#[event]
pub struct BetCancelled {
    pub bet: Pubkey,
}

#[event]
pub struct BetStarted {
    pub bet: Pubkey,
    pub beacon_slot: u64,
    pub beacon_hash: [u8; 32],
    pub started_at: i64,
    pub n_witnesses: u8,
}

#[event]
pub struct EvidenceCommitted {
    pub bet: Pubkey,
    pub seq: u32,
    pub root: [u8; 32],
    pub gap_mask: u8,
    pub is_final: bool,
}

#[event]
pub struct BetEnded {
    pub bet: Pubkey,
    pub evidence_root: [u8; 32],
    pub ended_at: i64,
}

#[event]
pub struct TracksPosted {
    pub bet: Pubkey,
    pub perception_root: [u8; 32],
    pub tracks_hash: [u8; 32],
    pub payload_len: u32,
}

#[event]
pub struct BiometricVerified {
    pub bet: Pubkey,
    pub participant_idx: u8,
    pub modality: u8,
    pub frame: u32,
}

#[event]
pub struct PreRuled {
    pub bet: Pubkey,
    pub preruling: u8,
    pub reason: u8,
    pub winner_mask: u8,
    pub leg_results: [u8; 8],
    pub consent_deadline: i64,
}

#[event]
pub struct Consented {
    pub bet: Pubkey,
    pub participant: Pubkey,
    pub consent_mask: u8,
}

#[event]
pub struct Disputed {
    pub bet: Pubkey,
    pub disputer: Pubkey,
    pub reason: u8,
    pub bond: u64,
}

#[event]
pub struct Settled {
    pub bet: Pubkey,
    pub path: u8,
    pub winner_mask: u8,
    pub pot: u64,
    pub payouts: [u64; 8],
}

#[event]
pub struct Refunded {
    pub bet: Pubkey,
    pub reason: u8,
    pub amounts: [u64; 8],
}
