use anchor_lang::prelude::*;

use crate::{constants::*, error::EscrowError, events::ConfigUpdated, state::Config};

/// Every field is optional; `allowed_mints` replaces the whole list. Live bets are unaffected
/// (their guarantees are snapshotted at `create_bet`, I11).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateConfigArgs {
    pub new_admin: Option<Pubkey>,
    pub judge_authority: Option<Pubkey>,
    pub appeal_authority: Option<Pubkey>,
    pub max_stake: Option<u64>,
    pub appeal_window_secs: Option<u32>,
    pub accept_deadline_secs: Option<u32>,
    pub resolve_deadline_secs: Option<u32>,
    pub appeal_resolve_secs: Option<u32>,
    pub allowed_mints: Option<Vec<Pubkey>>,
    pub paused: Option<bool>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ EscrowError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let mut c: Config = (**ctx.accounts.config).clone();
    if let Some(v) = args.new_admin {
        c.admin = v;
    }
    if let Some(v) = args.judge_authority {
        c.judge_authority = v;
    }
    if let Some(v) = args.appeal_authority {
        c.appeal_authority = v;
    }
    if let Some(v) = args.max_stake {
        c.max_stake = v;
    }
    if let Some(v) = args.appeal_window_secs {
        c.appeal_window_secs = v;
    }
    if let Some(v) = args.accept_deadline_secs {
        c.accept_deadline_secs = v;
    }
    if let Some(v) = args.resolve_deadline_secs {
        c.resolve_deadline_secs = v;
    }
    if let Some(v) = args.appeal_resolve_secs {
        c.appeal_resolve_secs = v;
    }
    if let Some(v) = args.allowed_mints {
        c.allowed_mints = v;
    }
    if let Some(v) = args.paused {
        c.paused = v;
    }
    c.validate()?;
    let ts = Clock::get()?.unix_timestamp;
    let event = ConfigUpdated {
        admin: c.admin,
        judge_authority: c.judge_authority,
        appeal_authority: c.appeal_authority,
        max_stake: c.max_stake,
        appeal_window_secs: c.appeal_window_secs,
        accept_deadline_secs: c.accept_deadline_secs,
        resolve_deadline_secs: c.resolve_deadline_secs,
        appeal_resolve_secs: c.appeal_resolve_secs,
        allowed_mints: c.allowed_mints.clone(),
        paused: c.paused,
        ts,
    };
    let config: &mut Config = &mut ctx.accounts.config;
    *config = c;
    emit_cpi!(event);
    Ok(())
}
