//! #13 `verify_biometric_proof` (§9.4, §8.6): Groth16 identity checkpoint.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::crypto::is_zero;
use crate::errors::VerdictError;
use crate::events::BiometricVerified;
use crate::state::{BioCheck, Bet, Profile};
use crate::zk;

#[derive(Accounts)]
pub struct VerifyBiometricProof<'info> {
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle @ VerdictError::Unauthorized)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(seeds = [PROFILE_SEED, profile.wallet.as_ref()], bump = profile.bump)]
    pub profile: Box<Account<'info, Profile>>,
}

/// Biometric proof arguments.
pub struct ProofArgs {
    pub participant: u8,
    pub modality: u8,
    pub frame: u32,
    pub tau_bps: u16,
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
}

pub fn handle_verify_biometric_proof(ctx: Context<VerifyBiometricProof>, a: &ProofArgs) -> Result<()> {
    let bet_key = ctx.accounts.bet.key();
    let profile = &ctx.accounts.profile;
    {
        let bet = &ctx.accounts.bet;
        require!(bet.state == STATE_PERCEIVING, VerdictError::InvalidState);
        require!((a.participant as usize) < bet.n(), VerdictError::NotParticipant);
        require!(profile.wallet == bet.participants[a.participant as usize], VerdictError::NotParticipant);
        require!(profile.updated_at <= bet.created_at, VerdictError::ProfileTooNew);
        let tau_min = match a.modality {
            MODALITY_FACE => TAU_FACE_BPS,
            MODALITY_VOICE => TAU_VOICE_BPS,
            _ => return err!(VerdictError::BadReason),
        };
        let commitment = profile.commitment(a.modality).ok_or(VerdictError::MissingCommitment)?;
        require!(!is_zero(commitment), VerdictError::MissingCommitment);
        require!(a.tau_bps >= tau_min, VerdictError::TauTooLow);

        let inputs = zk::public_inputs(commitment, &bet_key, &bet.evidence_root, a.participant, a.frame, a.modality, a.tau_bps);
        zk::verify(&a.proof_a, &a.proof_b, &a.proof_c, &inputs)?;
    }

    let bet = &mut ctx.accounts.bet;
    let n = bet.n_bio as usize;
    let dup = bet.bio[..n].iter().any(|b| b.participant == a.participant && b.frame == a.frame);
    if !dup {
        require!(n < MAX_CHECKPOINTS, VerdictError::TooManyCheckpoints);
        bet.bio[n] = BioCheck { participant: a.participant, modality: a.modality, frame: a.frame };
        bet.n_bio += 1;
    }
    emit!(BiometricVerified { bet: bet_key, participant_idx: a.participant, modality: a.modality, frame: a.frame });
    Ok(())
}
