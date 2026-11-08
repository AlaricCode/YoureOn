//! #9 `run_rules` (§9.4, §3): the onchain interpreter over the finalized TrackBuffer.
use anchor_lang::prelude::*;
use verdict_rules::{Checkpoint, ONCHAIN_W};

use crate::constants::*;
use crate::errors::VerdictError;
use crate::events::{Disputed, PreRuled};
use crate::state::{Bet, TrackBuffer};

#[derive(Accounts)]
pub struct RunRules<'info> {
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle @ VerdictError::Unauthorized)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(seeds = [TRACKS_SEED, bet.key().as_ref()], bump)]
    pub track_buffer: AccountLoader<'info, TrackBuffer>,
}

/// A pre-ruling from `run_rules` or `verify_sp1_run`.
pub struct Ruling {
    pub preruling: u8,
    pub reason: u8,
    pub winner_mask: u8,
    pub leg_results: [u8; 8],
}

/// Applies a pre-ruling: WINNER → PreRuled with a consent window; NEEDS_PANEL → Disputed
/// (bond 0, default disputer, `dispute_reason = reason`). Emits `PreRuled` (+ `Disputed`).
pub fn apply_ruling(bet: &mut Bet, bet_key: Pubkey, r: &Ruling, now: i64) -> Result<()> {
    bet.preruling = r.preruling;
    bet.prerule_reason = r.reason;
    bet.leg_results = r.leg_results;
    bet.preruled_at = now;
    match r.preruling {
        PRERULING_WINNER => {
            require!(r.winner_mask != 0 && r.winner_mask & !bet.all_mask() == 0, VerdictError::BadOutcome);
            bet.winner_mask = r.winner_mask;
            bet.consent_deadline = now.checked_add(CONSENT_WINDOW_S).ok_or(VerdictError::MathOverflow)?;
            bet.state = STATE_PRERULED;
        }
        PRERULING_NEEDS_PANEL => {
            bet.winner_mask = 0;
            bet.consent_deadline = 0;
            bet.state = STATE_DISPUTED;
            bet.dispute_reason = r.reason;
            bet.dispute_bond = 0;
            bet.disputer = Pubkey::default();
            bet.disputed_at = now;
        }
        _ => return err!(VerdictError::BadOutcome),
    }
    emit!(PreRuled {
        bet: bet_key,
        preruling: r.preruling,
        reason: r.reason,
        winner_mask: bet.winner_mask,
        leg_results: r.leg_results,
        consent_deadline: bet.consent_deadline,
    });
    if bet.state == STATE_DISPUTED {
        emit!(Disputed { bet: bet_key, disputer: Pubkey::default(), reason: r.reason, bond: 0 });
    }
    Ok(())
}

/// Verified identity checkpoints from `bet.bio`.
pub fn verified_checkpoints(bet: &Bet) -> ([Checkpoint; MAX_CHECKPOINTS], usize) {
    let mut v = [Checkpoint { participant: 0, frame: 0 }; MAX_CHECKPOINTS];
    let n = (bet.n_bio as usize).min(MAX_CHECKPOINTS);
    for (slot, b) in v.iter_mut().zip(bet.bio.iter()).take(n) {
        *slot = Checkpoint { participant: b.participant, frame: b.frame };
    }
    (v, n)
}

pub fn handle_run_rules(ctx: Context<RunRules>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    {
        let bet = &ctx.accounts.bet;
        require!(bet.state == STATE_PERCEIVING, VerdictError::InvalidState);
        require!(bet.tracks_finalized == TRACKS_FINALIZED, VerdictError::TracksNotFinalized);
    }
    let (program_len, calibration_len, payload_len) = {
        let h = ctx.accounts.track_buffer.load()?;
        require!(h.bet == bet_key && h.finalized == 1, VerdictError::TracksNotFinalized);
        (h.program_len as usize, h.calibration_len as usize, h.payload_len as usize)
    };
    let (verified, n_verified) = verified_checkpoints(&ctx.accounts.bet);
    let out = {
        let info = ctx.accounts.track_buffer.to_account_info();
        let data = info.try_borrow_data()?;
        let payload = data
            .get(TRACK_PAYLOAD_OFFSET..TRACK_PAYLOAD_OFFSET + payload_len)
            .ok_or(VerdictError::BufferLayout)?;
        verdict_rules::evaluate_payload::<ONCHAIN_W>(payload, program_len, calibration_len, &verified[..n_verified], Some(MAX_EVAL_COST))
            .map_err(VerdictError::from)?
    };
    let ruling = Ruling {
        preruling: out.preruling,
        reason: out.reason,
        winner_mask: out.winner_mask,
        leg_results: out.leg_results,
    };
    apply_ruling(&mut ctx.accounts.bet, bet_key, &ruling, now)
}
