//! #6 `commit_evidence` and #7 `end` (§9.4, §7.4).
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VerdictError;
use crate::events::{BetEnded, EvidenceCommitted};
use crate::evidence::{apply_commit, current_root, HeadArg};
use crate::state::{Bet, BetKind};

#[derive(Accounts)]
pub struct CommitEvidence<'info> {
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle @ VerdictError::Unauthorized)]
    pub bet: Box<Account<'info, Bet>>,
}

pub fn handle_commit_evidence(ctx: Context<CommitEvidence>, seq: u32, heads: Vec<HeadArg>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    let bet = &mut ctx.accounts.bet;
    require!(bet.state == STATE_LIVE, VerdictError::InvalidState);
    apply_commit(bet, seq, &heads, now)?;
    emit!(EvidenceCommitted {
        bet: bet_key,
        seq,
        root: bet.evidence_root,
        gap_mask: bet.gap_mask,
        is_final: false,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct End<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub bet: Box<Account<'info, Bet>>,
}

pub fn handle_end(ctx: Context<End>, seq: u32, heads: Vec<HeadArg>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    let auth = ctx.accounts.authority.key();
    let bet = &mut ctx.accounts.bet;
    require!(bet.state == STATE_LIVE, VerdictError::InvalidState);

    let is_oracle = auth == bet.oracle;
    if bet.kind() == BetKind::Market {
        require!(is_oracle, VerdictError::Unauthorized);
        require!(heads.is_empty(), VerdictError::EvidenceHeads);
    } else if is_oracle {
        // The oracle may end at any time, with final heads or [].
    } else if bet.participant_index(&auth).is_some() {
        require!(heads.is_empty(), VerdictError::EvidenceHeads);
    } else {
        let limit = bet.started_at.saturating_add(bet.time_limit_s as i64);
        require!(now >= limit, VerdictError::DeadlineNotReached);
        require!(heads.is_empty(), VerdictError::EvidenceHeads);
    }

    if heads.is_empty() {
        // Final root = root of the last stored heads.
        bet.evidence_root = current_root(bet);
    } else {
        apply_commit(bet, seq, &heads, now)?;
    }
    bet.state = STATE_PERCEIVING;
    bet.ended_at = now;

    emit!(EvidenceCommitted {
        bet: bet_key,
        seq: bet.evidence_seq,
        root: bet.evidence_root,
        gap_mask: bet.gap_mask,
        is_final: true,
    });
    emit!(BetEnded { bet: bet_key, evidence_root: bet.evidence_root, ended_at: now });
    Ok(())
}
