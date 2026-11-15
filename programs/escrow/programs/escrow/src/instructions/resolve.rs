use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EscrowError,
    events::BetResolved,
    state::{Bet, BetStatus, Outcome},
};

/// The judge key rules (ESCROW §5.2). It chooses an outcome, never an account (I4, I7): no token
/// accounts are passed. Opens the appeal window `[now, now + appeal_window_secs)`.
#[event_cpi]
#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Must be the bet's snapshotted `judge_authority` (I7, I11).
    pub judge_authority: Signer<'info>,
    #[account(mut, seeds = [BET_SEED, bet.bet_id.as_ref()], bump = bet.bump,
              has_one = judge_authority @ EscrowError::NotJudge)]
    pub bet: Box<Account<'info, Bet>>,
}

pub fn handle_resolve(
    ctx: Context<Resolve>,
    outcome: Outcome,
    evidence_hash: [u8; 32],
    ruling_hash: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bet = &ctx.accounts.bet;

    require!(bet.status == BetStatus::Locked, EscrowError::InvalidStatus);
    // I10: resolve `< resolve_deadline`; timeout_refund `≥` it (T7).
    require!(
        now < bet.resolve_deadline,
        EscrowError::ResolveDeadlinePassed
    );
    require!(
        evidence_hash != [0u8; 32] && ruling_hash != [0u8; 32],
        EscrowError::EmptyHash
    );
    let appeal_deadline = now
        .checked_add(i64::from(bet.appeal_window_secs))
        .ok_or(EscrowError::MathOverflow)?;

    // Every Outcome variant is allowed. Status and outcome are written together, so a Resolved
    // bet with `outcome == None` is unreachable.
    let bet = &mut ctx.accounts.bet;
    bet.status = BetStatus::Resolved;
    bet.outcome = Some(outcome);
    bet.evidence_hash = evidence_hash;
    bet.ruling_hash = ruling_hash;
    bet.resolved_at = now;
    bet.appeal_deadline = appeal_deadline;

    emit_cpi!(BetResolved {
        bet_id: bet.bet_id,
        judge: bet.judge_authority,
        outcome,
        evidence_hash,
        ruling_hash,
        appeal_deadline,
        ts: now,
    });
    Ok(())
}
