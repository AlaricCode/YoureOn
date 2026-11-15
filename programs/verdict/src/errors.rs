//! Error codes (CONTRACTS.md §9.6): numbered from 6000, in this exact order.
use anchor_lang::prelude::*;

#[error_code]
pub enum VerdictError {
    #[msg("Bet is not in the required state")]
    InvalidState, // 6000
    #[msg("Signer is not a participant")]
    NotParticipant,
    #[msg("Participant already funded")]
    AlreadyFunded,
    #[msg("Invalid participant list")]
    BadParticipants,
    #[msg("Invalid stake")]
    BadStake,
    #[msg("Invalid side mask")]
    BadSides,
    #[msg("Invalid time limit")]
    BadTimeLimit,
    #[msg("Invalid judges")]
    BadJudges,
    #[msg("Calibration hash mismatch")]
    CalibrationMismatch,
    #[msg("Deadline passed")]
    DeadlinePassed,
    #[msg("Deadline not reached")]
    DeadlineNotReached, // 6010
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Beacon slot not found in SlotHashes")]
    BeaconSlotNotFound,
    #[msg("Beacon too old")]
    BeaconTooOld,
    #[msg("Too many or invalid witnesses")]
    TooManyWitnesses,
    #[msg("Evidence sequence mismatch")]
    EvidenceSeq,
    #[msg("Evidence heads do not match the witness list")]
    EvidenceHeads,
    #[msg("Evidence head regressed")]
    EvidenceRegress,
    #[msg("Track buffer too large")]
    BufferTooLarge,
    #[msg("Track buffer layout mismatch")]
    BufferLayout,
    #[msg("Track buffer incomplete")]
    BufferIncomplete, // 6020
    #[msg("Program hash mismatch")]
    ProgramHashMismatch,
    #[msg("Calibration hash mismatch in track buffer")]
    CalibrationHashMismatch,
    #[msg("Malformed program")]
    MalformedProgram,
    #[msg("Malformed calibration")]
    MalformedCalibration,
    #[msg("Malformed tracks")]
    MalformedTracks,
    #[msg("Program does not match the bet")]
    ProgramBetMismatch,
    #[msg("Tracks not finalized")]
    TracksNotFinalized,
    #[msg("Already consented")]
    AlreadyConsented,
    #[msg("Consent arguments do not match the bet")]
    ConsentMismatch,
    #[msg("Insufficient judge quorum")]
    InsufficientQuorum, // 6030
    #[msg("Invalid outcome")]
    BadOutcome,
    #[msg("Invalid proof")]
    BadProof,
    #[msg("Threshold too low")]
    TauTooLow,
    #[msg("Missing biometric commitment")]
    MissingCommitment,
    #[msg("Too many identity checkpoints")]
    TooManyCheckpoints,
    #[msg("SP1 verification is disabled")]
    Sp1Disabled,
    #[msg("Invalid token account")]
    BadTokenAccount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Bet is not refundable")]
    NotRefundable,
    #[msg("Invalid reason")]
    BadReason, // 6040
    #[msg("Invalid commitment")]
    BadCommitment,
    #[msg("Profile updated after the bet was created")]
    ProfileTooNew,
    #[msg("Invalid Ed25519 instruction")]
    BadEd25519Instruction,
    #[msg("Invalid flags")]
    BadFlags, // 6044
}

impl From<verdict_rules::DecodeError> for VerdictError {
    fn from(e: verdict_rules::DecodeError) -> Self {
        match e {
            verdict_rules::DecodeError::MalformedProgram => VerdictError::MalformedProgram,
            verdict_rules::DecodeError::MalformedCalibration => VerdictError::MalformedCalibration,
            verdict_rules::DecodeError::MalformedTracks => VerdictError::MalformedTracks,
        }
    }
}

impl From<verdict_rules::SettleError> for VerdictError {
    fn from(e: verdict_rules::SettleError) -> Self {
        match e {
            verdict_rules::SettleError::MathOverflow => VerdictError::MathOverflow,
            verdict_rules::SettleError::BadOutcome => VerdictError::BadOutcome,
        }
    }
}
