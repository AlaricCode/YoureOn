//! Global constants (CONTRACTS.md §0.5), re-exported from `verdict-rules`, plus program-only
//! values (§9.1–§9.3).

pub use verdict_rules::constants::*;

pub const BET_VERSION: u8 = 1;

/// PDA seeds (§9.1).
pub const PROFILE_SEED: &[u8] = b"profile";
pub const BET_SEED: &[u8] = b"bet";
pub const VAULT_SEED: &[u8] = b"vault";
pub const TRACKS_SEED: &[u8] = b"tracks";

/// Account sizes after the 8-byte discriminator (§9.3).
pub const PROFILE_SIZE: usize = 179;
pub const BET_SIZE: usize = 1580;
pub const TRACK_HEADER_SIZE: usize = 48;
/// Offset of the TrackBuffer payload in account data.
pub const TRACK_PAYLOAD_OFFSET: usize = 8 + TRACK_HEADER_SIZE;

/// State enum (§9.2).
pub const STATE_PROPOSED: u8 = 0;
pub const STATE_FUNDED: u8 = 1;
pub const STATE_LIVE: u8 = 2;
pub const STATE_PERCEIVING: u8 = 3;
pub const STATE_PRERULED: u8 = 4;
pub const STATE_DISPUTED: u8 = 5;
pub const STATE_SETTLED: u8 = 6;
pub const STATE_REFUNDED: u8 = 7;

/// `preruling` (§9.2).
pub const PRERULING_NONE: u8 = 0;
pub const PRERULING_WINNER: u8 = 1;
pub const PRERULING_NO_CONTEST: u8 = 2;
pub const PRERULING_NEEDS_PANEL: u8 = 3;

/// `settle_path` (§9.2).
pub const PATH_NONE: u8 = 0;
pub const PATH_CONSENT: u8 = 1;
pub const PATH_RULE: u8 = 2;
pub const PATH_PANEL: u8 = 3;
pub const PATH_REFUND: u8 = 4;

/// `refund_reason` (§9.2).
pub const REFUND_FUND_TIMEOUT: u8 = 1;
pub const REFUND_NO_CONTEST: u8 = 2;
pub const REFUND_START_TIMEOUT: u8 = 3;
pub const REFUND_LIVE_TIMEOUT: u8 = 4;
pub const REFUND_PERCEPTION_TIMEOUT: u8 = 5;
pub const REFUND_PANEL_TIMEOUT: u8 = 6;
pub const REFUND_CANCELLED: u8 = 7;
pub const REFUND_CONSENT_TIMEOUT: u8 = 8;

/// Participant `dispute` reasons (§9.2): 1 wrong_outcome … 4 other.
pub const DISPUTE_REASON_MIN: u8 = 1;
pub const DISPUTE_REASON_MAX: u8 = 4;

/// Bet `flags` (§9.2).
pub const FLAG_ACTOR_BOUND: u8 = 1 << 0;
pub const FLAG_AI_JUDGED: u8 = 1 << 1;
pub const FLAG_MARKET: u8 = 1 << 2;
pub const FLAGS_KNOWN: u8 = FLAG_ACTOR_BOUND | FLAG_AI_JUDGED | FLAG_MARKET;

/// `tracks_finalized` (§9.2).
pub const TRACKS_NOT_FINALIZED: u8 = 0;
pub const TRACKS_FINALIZED: u8 = 1;
pub const TRACKS_SP1_ONLY: u8 = 2;

/// Witness kinds (§7.1).
pub const WITNESS_KIND_MAX: u8 = 2;
pub const WITNESS_KIND_UNUSED: u8 = 0xFF;
pub const HEAD_NONE: u32 = 0xFFFF_FFFF;
pub const LEG_RESULT_UNUSED: u8 = 0xFF;

/// Biometric modalities (§8.6).
pub const MODALITY_FACE: u8 = 0;
pub const MODALITY_VOICE: u8 = 1;

/// Profile flags (§9.3).
pub const PROFILE_FLAG_FACE: u8 = 1 << 0;
pub const PROFILE_FLAG_VOICE: u8 = 1 << 1;
pub const DISPLAY_NAME_MAX: usize = 32;

/// Panel outcomes (§9.4 #12).
pub const OUTCOME_NO_CONTEST: u8 = 0;
pub const OUTCOME_SIDE_0: u8 = 1;
pub const OUTCOME_SIDE_1: u8 = 2;

/// Domain tags (§4.2, §7.2, §9.7).
pub const TAG_TERMS: &[u8] = b"VERDICT/TERMS/v1";
pub const TAG_CHAIN: &[u8] = b"VERDICT/CHAIN/v1";
pub const TAG_PANEL: &[u8] = b"VERDICT/PANEL/v1";

/// Panel message length (§9.7).
pub const PANEL_MSG_LEN: usize = 145;

/// BN254 scalar field modulus r, big-endian (§8.4).
pub const BN254_R_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];
