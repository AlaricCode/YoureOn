//! #10 `consent` (§9.4): agree with the pre-ruling; settles on unanimity or silence.
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::*;
use crate::errors::VerdictError;
use crate::events::{Consented, Settled};
use crate::payout::{settle_winners, Escrow};
use crate::state::Bet;

#[derive(Accounts)]
pub struct Consent<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [VAULT_SEED, bet.key().as_ref()], bump = bet.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: rent destination; must be `bet.oracle`.
    #[account(mut, address = bet.oracle @ VerdictError::Unauthorized)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: TrackBuffer PDA; closed only if program-owned and non-empty (§9.3).
    #[account(mut, seeds = [TRACKS_SEED, bet.key().as_ref()], bump)]
    pub track_buffer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Marks the bet Settled and emits `Settled`.
pub fn finish_settle(bet: &mut Bet, bet_key: Pubkey, path: u8, winner_mask: u8, pot: u64, payouts: [u64; 8]) -> Result<()> {
    bet.state = STATE_SETTLED;
    bet.settle_path = path;
    bet.final_winner_mask = winner_mask;
    bet.settled_at = Clock::get()?.unix_timestamp;
    emit!(Settled { bet: bet_key, path, winner_mask, pot, payouts });
    Ok(())
}

pub fn handle_consent<'info>(ctx: Context<'_, '_, 'info, 'info, Consent<'info>>, winner_mask: u8, evidence_root: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    let auth = ctx.accounts.authority.key();
    {
        let bet = &mut ctx.accounts.bet;
        require!(bet.state == STATE_PRERULED, VerdictError::InvalidState);
        require!(winner_mask == bet.winner_mask && evidence_root == bet.evidence_root, VerdictError::ConsentMismatch);
        let before_deadline = now <= bet.consent_deadline;
        let idx = bet.participant_index(&auth);
        if before_deadline {
            let i = idx.ok_or(VerdictError::NotParticipant)?;
            require!(bet.consent_mask & (1 << i) == 0, VerdictError::AlreadyConsented);
            bet.consent_mask |= 1 << i;
            emit!(Consented { bet: bet_key, participant: auth, consent_mask: bet.consent_mask });
            if bet.consent_mask != bet.all_mask() {
                return Ok(());
            }
        }
        // Unanimous consent, or any signer after the deadline (silence = consent).
    }

    let bet = &ctx.accounts.bet;
    let path = if bet.tracks_finalized == TRACKS_SP1_ONLY { PATH_RULE } else { PATH_CONSENT };
    let wm = bet.winner_mask;
    let (pot, payouts) = {
        let esc = Escrow {
            bet: ctx.accounts.bet.to_account_info(),
            vault: &ctx.accounts.vault,
            oracle: ctx.accounts.oracle.to_account_info(),
            track_buffer: ctx.accounts.track_buffer.to_account_info(),
            token_program: &ctx.accounts.token_program,
            payout_accounts: ctx.remaining_accounts,
        };
        settle_winners(bet, &esc, wm, false)?
    };
    finish_settle(&mut ctx.accounts.bet, bet_key, path, wm, pot, payouts)
}
