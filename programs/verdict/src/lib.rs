//! VERDICT onchain program (CONTRACTS.md §9): escrowed bets settled by an onchain rule
//! interpreter (`verdict-rules`), with consent, disputes, a 2-of-3 judge panel and timeouts.
#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod beacon;
pub mod constants;
pub mod crypto;
pub mod errors;
pub mod events;
pub mod evidence;
pub mod instructions;
pub mod panel;
pub mod payout;
pub mod state;
pub mod zk;

pub use errors::VerdictError;
pub use evidence::{HeadArg, WitnessArg};
pub use instructions::*;
pub use state::*;

declare_id!("dbqDmF6YtjPygXTvJD31CNADoLqiUG8pZgj1zpHaMye");

#[program]
pub mod verdict {
    use super::*;

    /// #1 Creates or overwrites the caller's Profile (biometric commitments, display name).
    pub fn init_profile(ctx: Context<InitProfile>, face_commit: [u8; 32], voice_commit: [u8; 32], display_name: String) -> Result<()> {
        instructions::init_profile::handle_init_profile(ctx, face_commit, voice_commit, display_name)
    }

    /// #2 Creates a Bet and its USDC vault. Creator and oracle sign.
    pub fn create_bet(
        ctx: Context<CreateBet>,
        nonce: u64,
        participants: Vec<Pubkey>,
        stakes: Vec<u64>,
        side_b_mask: u8,
        stake_each: u64,
        time_limit_s: u32,
        flags: u8,
        program_hash: [u8; 32],
        acceptance_audio_hash: [u8; 32],
        judges: [Pubkey; 3],
    ) -> Result<()> {
        instructions::create_bet::handle_create_bet(
            ctx,
            nonce,
            participants,
            stakes,
            side_b_mask,
            stake_each,
            time_limit_s,
            flags,
            program_hash,
            acceptance_audio_hash,
            judges,
        )
    }

    /// #3 Escrows a participant's stake, binding calibration, program and terms.
    pub fn fund(ctx: Context<Fund>, calibration_hash: [u8; 32], program_hash: [u8; 32], terms_hash: [u8; 32]) -> Result<()> {
        instructions::fund::handle_fund(ctx, calibration_hash, program_hash, terms_hash)
    }

    /// #4 Cancels a Proposed bet (creator); refunds funded stakes.
    pub fn cancel<'info>(ctx: Context<'_, '_, 'info, 'info, Cancel<'info>>) -> Result<()> {
        instructions::cancel::handle_cancel(ctx)
    }

    /// #5 Starts the bet: SlotHashes beacon + witness registration.
    pub fn start(ctx: Context<Start>, beacon_slot: u64, witnesses: Vec<WitnessArg>) -> Result<()> {
        instructions::start::handle_start(ctx, beacon_slot, witnesses)
    }

    /// #6 Oracle evidence commit (rolling root).
    pub fn commit_evidence(ctx: Context<CommitEvidence>, seq: u32, heads: Vec<HeadArg>) -> Result<()> {
        instructions::commit_end::handle_commit_evidence(ctx, seq, heads)
    }

    /// #7 Ends recording; sets the final evidence root.
    pub fn end(ctx: Context<End>, seq: u32, heads: Vec<HeadArg>) -> Result<()> {
        instructions::commit_end::handle_end(ctx, seq, heads)
    }

    /// #8 Writes a TrackBuffer chunk; validates everything on `finalize`.
    pub fn post_tracks<'info>(
        ctx: Context<'_, '_, '_, 'info, PostTracks<'info>>,
        payload_len: u32,
        program_len: u16,
        calibration_len: u16,
        offset: u32,
        data: Vec<u8>,
        finalize: bool,
        perception_root: [u8; 32],
    ) -> Result<()> {
        instructions::post_tracks::handle_post_tracks(
            ctx,
            PostArgs { payload_len, program_len, calibration_len, offset, data: &data, finalize, perception_root },
        )
    }

    /// #9 Runs the onchain interpreter (oracle).
    pub fn run_rules(ctx: Context<RunRules>) -> Result<()> {
        instructions::run_rules::handle_run_rules(ctx)
    }

    /// #10 Consents to the pre-ruling; settles on unanimity or after the window.
    pub fn consent<'info>(ctx: Context<'_, '_, 'info, 'info, Consent<'info>>, winner_mask: u8, evidence_root: [u8; 32]) -> Result<()> {
        instructions::consent::handle_consent(ctx, winner_mask, evidence_root)
    }

    /// #11 Disputes the pre-ruling with a bond.
    pub fn dispute(ctx: Context<Dispute>, reason: u8, evidence_root: [u8; 32]) -> Result<()> {
        instructions::dispute::handle_dispute(ctx, reason, evidence_root)
    }

    /// #12 Settles a Disputed bet with a 2-of-3 judge quorum (Ed25519 precompile).
    pub fn settle_panel<'info>(ctx: Context<'_, '_, 'info, 'info, SettlePanel<'info>>, outcome: u8) -> Result<()> {
        instructions::settle_panel::handle_settle_panel(ctx, outcome)
    }

    /// #13 Verifies a Groth16 biometric proof and records an identity checkpoint.
    pub fn verify_biometric_proof(
        ctx: Context<VerifyBiometricProof>,
        participant: u8,
        modality: u8,
        frame: u32,
        tau_bps: u16,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
    ) -> Result<()> {
        instructions::verify_biometric_proof::handle_verify_biometric_proof(
            ctx,
            &ProofArgs { participant, modality, frame, tau_bps, proof_a, proof_b, proof_c },
        )
    }

    /// #14 SP1 pre-ruling (feature `sp1`; otherwise `Sp1Disabled`).
    pub fn verify_sp1_run(ctx: Context<VerifySp1Run>, public_values: Vec<u8>, proof: Vec<u8>) -> Result<()> {
        instructions::verify_sp1_run::handle_verify_sp1_run(ctx, public_values, proof)
    }

    /// #15 Permissionless timeout refund.
    pub fn refund<'info>(ctx: Context<'_, '_, 'info, 'info, Refund<'info>>) -> Result<()> {
        instructions::refund::handle_refund(ctx)
    }
}
