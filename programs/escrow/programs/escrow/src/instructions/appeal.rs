use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EscrowError,
    events::BetAppealed,
    state::{Bet, BetStatus, Outcome},
};

/// The loser disputes the ruling (ESCROW §5.2, §4 loser table, P5). For `Split` / `Refund` both
/// parties count as losers. Opens `[now, now + appeal_resolve_secs)` for the appeal authority;
/// after that `timeout_refund` returns each stake (TM-L2).
#[event_cpi]
#[derive(Accounts)]
pub struct Appeal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// A party's device key; must be a loser of the stored outcome.
    pub appellant: Signer<'info>,
    #[account(mut, seeds = [BET_SEED, bet.bet_id.as_ref()], bump = bet.bump)]
    pub bet: Box<Account<'info, Bet>>,
}

pub fn handle_appeal(ctx: Context<Appeal>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let appellant = ctx.accounts.appellant.key();
    let bet = &ctx.accounts.bet;

    require!(
        bet.status == BetStatus::Resolved,
        EscrowError::InvalidStatus
    );
    let outcome = bet.outcome.ok_or(EscrowError::InvalidStatus)?;
    // I10: appeal `< appeal_deadline`; finalize `≥` it.
    require!(now < bet.appeal_deadline, EscrowError::AppealWindowClosed);
    require!(
        appellant == bet.party_a || appellant == bet.party_b,
        EscrowError::NotParty
    );
    let is_loser = match outcome {
        Outcome::PartyA => appellant == bet.party_b,
        Outcome::PartyB => appellant == bet.party_a,
        Outcome::Split | Outcome::Refund => true,
    };
    require!(is_loser, EscrowError::NotLoser);
    let appeal_resolve_deadline = now
        .checked_add(i64::from(bet.appeal_resolve_secs))
        .ok_or(EscrowError::MathOverflow)?;

    let bet = &mut ctx.accounts.bet;
    bet.status = BetStatus::Appealed;
    bet.appealed_at = now;
    bet.appeal_resolve_deadline = appeal_resolve_deadline;

    emit_cpi!(BetAppealed {
        bet_id: bet.bet_id,
        appellant,
        original_outcome: outcome,
        appeal_resolve_deadline,
        ts: now,
    });
    Ok(())
}
