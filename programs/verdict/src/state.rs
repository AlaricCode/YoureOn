//! Accounts (CONTRACTS.md §9.3). Field order is normative; sizes are asserted in tests.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VerdictError;

/// Profile (Borsh, space 8 + 179). PDA `["profile", wallet]`.
#[account]
pub struct Profile {
    pub wallet: Pubkey,
    /// Poseidon commitment, 32-byte big-endian (§8.4). Zero = none / deleted.
    pub face_commit: [u8; 32],
    pub voice_commit: [u8; 32],
    /// UTF-8, zero padded.
    pub display_name: [u8; 32],
    pub name_len: u8,
    /// bit0 face, bit1 voice.
    pub flags: u8,
    pub bump: u8,
    pub created_at: i64,
    pub updated_at: i64,
    pub reserved: [u8; 32],
}

impl Profile {
    pub const SPACE: usize = 8 + PROFILE_SIZE;

    pub fn commitment(&self, modality: u8) -> Option<&[u8; 32]> {
        match modality {
            MODALITY_FACE => Some(&self.face_commit),
            MODALITY_VOICE => Some(&self.voice_commit),
            _ => None,
        }
    }
}

/// Identity checkpoint verified onchain (§9.3): 6 bytes Borsh.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq, InitSpace)]
pub struct BioCheck {
    pub participant: u8,
    pub modality: u8,
    pub frame: u32,
}

/// Bet (Borsh, space 8 + 1580). PDA `["bet", creator, nonce LE]`.
#[account]
pub struct Bet {
    pub version: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub state: u8,
    pub flags: u8,
    pub creator: Pubkey,
    pub nonce: u64,
    pub mint: Pubkey,
    pub oracle: Pubkey,
    pub judges: [Pubkey; 3],
    pub n_participants: u8,
    pub participants: [Pubkey; 8],
    pub stakes: [u64; 8],
    pub side_b_mask: u8,
    pub funded_mask: u8,
    pub stake_each: u64,
    pub time_limit_s: u32,
    pub program_hash: [u8; 32],
    pub calibration_hash: [u8; 32],
    pub acceptance_audio_hash: [u8; 32],
    pub created_at: i64,
    pub fund_deadline: i64,
    pub funded_at: i64,
    pub started_at: i64,
    pub beacon_slot: u64,
    pub beacon_hash: [u8; 32],
    pub n_witnesses: u8,
    pub witnesses: [Pubkey; 8],
    pub witness_kinds: [u8; 8],
    pub witness_heads: [u32; 8],
    pub witness_head_hashes: [[u8; 32]; 8],
    pub gap_mask: u8,
    pub evidence_seq: u32,
    pub evidence_root: [u8; 32],
    pub last_commit_at: i64,
    pub ended_at: i64,
    pub perception_root: [u8; 32],
    pub tracks_hash: [u8; 32],
    pub tracks_finalized: u8,
    pub preruling: u8,
    pub prerule_reason: u8,
    pub winner_mask: u8,
    pub leg_results: [u8; 8],
    pub preruled_at: i64,
    pub consent_deadline: i64,
    pub consent_mask: u8,
    pub disputer: Pubkey,
    pub dispute_bond: u64,
    pub dispute_reason: u8,
    pub disputed_at: i64,
    pub n_bio: u8,
    pub bio: [BioCheck; 8],
    pub settled_at: i64,
    pub settle_path: u8,
    pub final_winner_mask: u8,
    pub refund_reason: u8,
    pub reserved: [u8; 64],
}

/// Program kind derived from Bet `flags` (§9.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BetKind {
    Rules,
    AiJudged,
    Market,
}

impl Bet {
    pub const SPACE: usize = 8 + BET_SIZE;

    pub fn n(&self) -> usize {
        self.n_participants as usize
    }

    pub fn kind(&self) -> BetKind {
        if self.flags & FLAG_MARKET != 0 {
            BetKind::Market
        } else if self.flags & FLAG_AI_JUDGED != 0 {
            BetKind::AiJudged
        } else {
            BetKind::Rules
        }
    }

    /// Mask of all participant bits.
    pub fn all_mask(&self) -> u8 {
        ((1u16 << self.n_participants) - 1) as u8
    }

    pub fn participant_index(&self, key: &Pubkey) -> Option<usize> {
        self.participants[..self.n()].iter().position(|p| p == key)
    }

    pub fn require_participant(&self, key: &Pubkey) -> Result<usize> {
        self.participant_index(key).ok_or_else(|| error!(VerdictError::NotParticipant))
    }

    pub fn stakes(&self) -> &[u64] {
        &self.stakes[..self.n()]
    }

    /// Winner mask for a panel side (`0` or `1`).
    pub fn side_mask(&self, side: u8) -> u8 {
        if side == 0 {
            self.all_mask() & !self.side_b_mask
        } else {
            self.side_b_mask
        }
    }

    pub fn has_disputer(&self) -> bool {
        self.disputer != Pubkey::default()
    }

    /// Participant index of the disputer, if any.
    pub fn disputer_index(&self) -> Option<usize> {
        if self.has_disputer() {
            self.participant_index(&self.disputer)
        } else {
            None
        }
    }

    pub fn witness_count(&self) -> usize {
        self.n_witnesses as usize
    }
}

/// TrackBuffer header (zero-copy, 48 bytes, Pod). Account space `8 + 48 + payload_len`;
/// the payload is `data[56 .. 56 + payload_len]` (§9.3, §5.6). The account is created manually
/// by the first `post_tracks` (PDA `["tracks", bet]`).
#[account(zero_copy)]
#[repr(C)]
pub struct TrackBuffer {
    pub bet: Pubkey,
    pub payload_len: u32,
    pub program_len: u16,
    pub calibration_len: u16,
    pub written: u32,
    pub finalized: u8,
    pub bump: u8,
    pub reserved: [u8; 2],
}

const _: () = assert!(core::mem::size_of::<TrackBuffer>() == TRACK_HEADER_SIZE);
