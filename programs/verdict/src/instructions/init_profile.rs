//! #1 `init_profile` (§9.4): creates or overwrites a Profile.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::crypto::{is_zero, lt_bn254_r};
use crate::errors::VerdictError;
use crate::events::ProfileUpdated;
use crate::state::Profile;

#[derive(Accounts)]
pub struct InitProfile<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub wallet: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = Profile::SPACE,
        seeds = [PROFILE_SEED, wallet.key().as_ref()],
        bump,
    )]
    pub profile: Account<'info, Profile>,
    pub system_program: Program<'info, System>,
}

fn check_commitment(c: &[u8; 32]) -> Result<bool> {
    if is_zero(c) {
        return Ok(false);
    }
    require!(lt_bn254_r(c), VerdictError::BadCommitment);
    Ok(true)
}

pub fn handle_init_profile(ctx: Context<InitProfile>, face_commit: [u8; 32], voice_commit: [u8; 32], display_name: String) -> Result<()> {
    let name = display_name.as_bytes();
    require!(name.len() <= DISPLAY_NAME_MAX, VerdictError::BadCommitment);
    let face = check_commitment(&face_commit)?;
    let voice = check_commitment(&voice_commit)?;

    let now = Clock::get()?.unix_timestamp;
    let wallet = ctx.accounts.wallet.key();
    let p = &mut ctx.accounts.profile;
    if p.created_at == 0 && p.wallet == Pubkey::default() {
        p.created_at = now;
    }
    p.wallet = wallet;
    p.face_commit = face_commit;
    p.voice_commit = voice_commit;
    p.display_name = [0u8; 32];
    p.display_name[..name.len()].copy_from_slice(name);
    p.name_len = name.len() as u8;
    p.flags = (face as u8 * PROFILE_FLAG_FACE) | (voice as u8 * PROFILE_FLAG_VOICE);
    p.bump = ctx.bumps.profile;
    p.updated_at = now;
    p.reserved = [0u8; 32];

    emit!(ProfileUpdated { wallet, flags: p.flags });
    Ok(())
}
