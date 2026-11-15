use anchor_lang::prelude::*;

use crate::{
    constants::*, error::EscrowError, events::ConfigInitialized, program::Escrow, state::Config,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct InitConfigArgs {
    pub judge_authority: Pubkey,
    pub appeal_authority: Pubkey,
    pub max_stake: u64,
    pub appeal_window_secs: u32,
    pub accept_deadline_secs: u32,
    pub resolve_deadline_secs: u32,
    pub appeal_resolve_secs: u32,
    pub allowed_mints: Vec<Pubkey>,
}

/// Only the program's upgrade authority can initialize, so nobody can front-run init after
/// deploy. The upgrade authority becomes `config.admin`.
#[event_cpi]
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    // Named escrow_program because #[event_cpi] already injects a field called `program`.
    #[account(constraint = escrow_program.programdata_address()? == Some(program_data.key()))]
    pub escrow_program: Program<'info, Escrow>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key())
              @ EscrowError::NotUpgradeAuthority)]
    pub program_data: Box<Account<'info, ProgramData>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    args: InitConfigArgs,
) -> Result<()> {
    let candidate = Config {
        admin: ctx.accounts.admin.key(),
        judge_authority: args.judge_authority,
        appeal_authority: args.appeal_authority,
        max_stake: args.max_stake,
        appeal_window_secs: args.appeal_window_secs,
        accept_deadline_secs: args.accept_deadline_secs,
        resolve_deadline_secs: args.resolve_deadline_secs,
        appeal_resolve_secs: args.appeal_resolve_secs,
        allowed_mints: args.allowed_mints,
        paused: false,
        bump: ctx.bumps.config,
    };
    candidate.validate()?;
    let ts = Clock::get()?.unix_timestamp;
    let event = ConfigInitialized {
        admin: candidate.admin,
        judge_authority: candidate.judge_authority,
        appeal_authority: candidate.appeal_authority,
        max_stake: candidate.max_stake,
        appeal_window_secs: candidate.appeal_window_secs,
        accept_deadline_secs: candidate.accept_deadline_secs,
        resolve_deadline_secs: candidate.resolve_deadline_secs,
        appeal_resolve_secs: candidate.appeal_resolve_secs,
        allowed_mints: candidate.allowed_mints.clone(),
        paused: candidate.paused,
        ts,
    };
    let config: &mut Config = &mut ctx.accounts.config;
    *config = candidate;
    emit_cpi!(event);
    Ok(())
}
