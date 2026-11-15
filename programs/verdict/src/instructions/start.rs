//! #5 `start` (§9.4, §7.5): verifies the SlotHashes beacon and registers witnesses.
use anchor_lang::prelude::*;
use solana_sdk_ids::sysvar::slot_hashes;

use crate::beacon::verify_beacon;
use crate::constants::*;
use crate::crypto::{chain_genesis, ZERO32};
use crate::errors::VerdictError;
use crate::events::BetStarted;
use crate::evidence::{current_root, WitnessArg};
use crate::state::{Bet, BetKind};

#[derive(Accounts)]
pub struct Start<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: SlotHashes sysvar, read raw (§9.1).
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

pub fn validate_witnesses(witnesses: &[WitnessArg]) -> Result<()> {
    require!(witnesses.len() <= MAX_WITNESSES, VerdictError::TooManyWitnesses);
    for (i, w) in witnesses.iter().enumerate() {
        require!(w.kind <= WITNESS_KIND_MAX, VerdictError::TooManyWitnesses);
        require!(w.key != Pubkey::default(), VerdictError::TooManyWitnesses);
        require!(!witnesses[..i].iter().any(|x| x.key == w.key), VerdictError::TooManyWitnesses);
    }
    Ok(())
}

pub fn handle_start(ctx: Context<Start>, beacon_slot: u64, witnesses: Vec<WitnessArg>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    let bet = &mut ctx.accounts.bet;
    let auth = ctx.accounts.authority.key();
    require!(auth == bet.creator || auth == bet.oracle, VerdictError::Unauthorized);
    require!(bet.state == STATE_FUNDED, VerdictError::InvalidState);
    require!(now <= bet.funded_at.saturating_add(START_WINDOW_S), VerdictError::DeadlinePassed);

    let beacon_hash = if bet.kind() == BetKind::Market {
        // Market bets have no recording: no beacon, no witnesses.
        require!(beacon_slot == 0, VerdictError::BeaconSlotNotFound);
        require!(witnesses.is_empty(), VerdictError::TooManyWitnesses);
        ZERO32
    } else {
        validate_witnesses(&witnesses)?;
        verify_beacon(&ctx.accounts.slot_hashes.to_account_info(), clock.slot, beacon_slot)?
    };

    bet.beacon_slot = beacon_slot;
    bet.beacon_hash = beacon_hash;
    bet.n_witnesses = witnesses.len() as u8;
    for (i, w) in witnesses.iter().enumerate() {
        bet.witnesses[i] = w.key;
        bet.witness_kinds[i] = w.kind;
        bet.witness_heads[i] = HEAD_NONE;
        bet.witness_head_hashes[i] = chain_genesis(&bet_key, &w.key, w.kind, beacon_slot, &beacon_hash);
    }
    bet.gap_mask = 0;
    bet.evidence_seq = 0;
    bet.last_commit_at = now;
    bet.evidence_root = current_root(bet);
    bet.state = STATE_LIVE;
    bet.started_at = now;

    emit!(BetStarted {
        bet: bet_key,
        beacon_slot,
        beacon_hash,
        started_at: now,
        n_witnesses: bet.n_witnesses,
    });
    Ok(())
}
