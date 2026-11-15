//! #8 `post_tracks` (§9.4, §9.3, §5.6): chunked TrackBuffer upload and finalization.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Allocate, Assign, CreateAccount, Transfer};
use anchor_lang::Discriminator;

use crate::constants::*;
use crate::crypto::{is_zero, sha256, ZERO32};
use crate::errors::VerdictError;
use crate::events::TracksPosted;
use crate::state::{Bet, BetKind, TrackBuffer};

#[derive(Accounts)]
pub struct PostTracks<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle @ VerdictError::Unauthorized)]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: TrackBuffer PDA, created manually by the first call (§9.3); validated below.
    #[account(mut, seeds = [TRACKS_SEED, bet.key().as_ref()], bump)]
    pub track_buffer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Arguments of `post_tracks`, grouped.
pub struct PostArgs<'a> {
    pub payload_len: u32,
    pub program_len: u16,
    pub calibration_len: u16,
    pub offset: u32,
    pub data: &'a [u8],
    pub finalize: bool,
    pub perception_root: [u8; 32],
}

fn header(data: &[u8]) -> Result<TrackBuffer> {
    require!(data.len() >= TRACK_PAYLOAD_OFFSET, VerdictError::BufferLayout);
    require!(data[..8] == *TrackBuffer::DISCRIMINATOR, VerdictError::BufferLayout);
    Ok(bytemuck::pod_read_unaligned::<TrackBuffer>(&data[8..TRACK_PAYLOAD_OFFSET]))
}

fn write_header(data: &mut [u8], h: &TrackBuffer) {
    data[..8].copy_from_slice(TrackBuffer::DISCRIMINATOR);
    data[8..TRACK_PAYLOAD_OFFSET].copy_from_slice(bytemuck::bytes_of(h));
}

/// Creates the TrackBuffer PDA (robust to pre-funded lamports).
fn create_buffer<'info>(ctx: &Context<'_, '_, '_, 'info, PostTracks<'info>>, space: usize, bump: u8) -> Result<()> {
    let bet_key = ctx.accounts.bet.key();
    let seeds: &[&[u8]] = &[TRACKS_SEED, bet_key.as_ref(), &[bump]];
    let signer = &[seeds];
    let tb = ctx.accounts.track_buffer.to_account_info();
    let payer = ctx.accounts.payer.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    let rent = Rent::get()?.minimum_balance(space);
    if tb.lamports() == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(sys, CreateAccount { from: payer, to: tb }, signer),
            rent,
            space as u64,
            &crate::ID,
        )?;
    } else {
        let missing = rent.saturating_sub(tb.lamports());
        if missing > 0 {
            system_program::transfer(CpiContext::new(sys.clone(), Transfer { from: payer, to: tb.clone() }), missing)?;
        }
        system_program::allocate(CpiContext::new_with_signer(sys.clone(), Allocate { account_to_allocate: tb.clone() }, signer), space as u64)?;
        system_program::assign(CpiContext::new_with_signer(sys, Assign { account_to_assign: tb }, signer), &crate::ID)?;
    }
    Ok(())
}

pub fn handle_post_tracks<'info>(ctx: Context<'_, '_, '_, 'info, PostTracks<'info>>, a: PostArgs) -> Result<()> {
    {
        let bet = &ctx.accounts.bet;
        require!(bet.state == STATE_PERCEIVING, VerdictError::InvalidState);
        require!(bet.tracks_finalized == TRACKS_NOT_FINALIZED, VerdictError::InvalidState);
    }
    require!(a.payload_len as usize <= MAX_BUFFER_PAYLOAD, VerdictError::BufferTooLarge);
    require!(a.data.len() <= POST_TRACKS_CHUNK, VerdictError::BufferTooLarge);
    let parts = a.program_len as u32 + a.calibration_len as u32;
    require!(parts <= a.payload_len, VerdictError::BufferLayout);

    let bet_key = ctx.accounts.bet.key();
    let bump = ctx.bumps.track_buffer;
    if ctx.accounts.track_buffer.data_is_empty() {
        let space = TRACK_PAYLOAD_OFFSET + a.payload_len as usize;
        create_buffer(&ctx, space, bump)?;
        let mut data = ctx.accounts.track_buffer.try_borrow_mut_data()?;
        let h = TrackBuffer {
            bet: bet_key,
            payload_len: a.payload_len,
            program_len: a.program_len,
            calibration_len: a.calibration_len,
            written: 0,
            finalized: 0,
            bump,
            reserved: [0; 2],
        };
        write_header(&mut data, &h);
    }
    require!(*ctx.accounts.track_buffer.owner == crate::ID, VerdictError::BufferLayout);

    let mut data = ctx.accounts.track_buffer.try_borrow_mut_data()?;
    let mut h = header(&data)?;
    require!(h.bet == bet_key, VerdictError::BufferLayout);
    require!(
        h.payload_len == a.payload_len && h.program_len == a.program_len && h.calibration_len == a.calibration_len,
        VerdictError::BufferLayout
    );
    require!(data.len() == TRACK_PAYLOAD_OFFSET + h.payload_len as usize, VerdictError::BufferLayout);
    require!(h.finalized == 0, VerdictError::InvalidState);
    require!(a.offset == h.written, VerdictError::BufferLayout);
    let end = (h.written as usize).checked_add(a.data.len()).ok_or(VerdictError::BufferTooLarge)?;
    require!(end <= h.payload_len as usize, VerdictError::BufferTooLarge);
    data[TRACK_PAYLOAD_OFFSET + h.written as usize..TRACK_PAYLOAD_OFFSET + end].copy_from_slice(a.data);
    h.written = end as u32;

    if a.finalize {
        require!(h.written == h.payload_len, VerdictError::BufferIncomplete);
        let payload = &data[TRACK_PAYLOAD_OFFSET..];
        let (tracks_hash, finalized) = validate_payload(&ctx.accounts.bet, payload, h.program_len as usize, h.calibration_len as usize)?;
        h.finalized = 1;
        let bet = &mut ctx.accounts.bet;
        bet.tracks_hash = tracks_hash;
        bet.perception_root = a.perception_root;
        bet.tracks_finalized = finalized;
        emit!(TracksPosted {
            bet: bet_key,
            perception_root: a.perception_root,
            tracks_hash,
            payload_len: h.payload_len,
        });
    }
    write_header(&mut data, &h);
    Ok(())
}

/// Finalization checks (§9.4 #8). Returns `(tracks_hash, tracks_finalized)`.
pub fn validate_payload(bet: &Bet, payload: &[u8], program_len: usize, calibration_len: usize) -> Result<([u8; 32], u8)> {
    let (program_bin, rest) = payload.split_at(program_len);
    let (calibration_bin, tracks_bin) = rest.split_at(calibration_len);

    require!(sha256(&[program_bin]) == bet.program_hash, VerdictError::ProgramHashMismatch);
    let cal_hash = if calibration_bin.is_empty() { ZERO32 } else { sha256(&[calibration_bin]) };
    require!(cal_hash == bet.calibration_hash, VerdictError::CalibrationHashMismatch);
    require!(calibration_bin.is_empty() == is_zero(&bet.calibration_hash), VerdictError::CalibrationHashMismatch);

    let program = verdict_rules::decode_program(program_bin).map_err(VerdictError::from)?;
    verdict_rules::decode_calibration(calibration_bin, &program).map_err(VerdictError::from)?;
    check_program_matches_bet(bet, &program)?;

    if tracks_bin.is_empty() {
        // SP1-only buffer (feature `sp1`).
        require!(cfg!(feature = "sp1"), VerdictError::BufferLayout);
        return Ok((ZERO32, TRACKS_SP1_ONLY));
    }
    if program.kind == verdict_rules::ProgramKind::Market {
        verdict_rules::decode_market(tracks_bin).map_err(VerdictError::from)?;
    } else {
        verdict_rules::decode_tracks(tracks_bin, &program).map_err(VerdictError::from)?;
    }
    Ok((sha256(&[tracks_bin]), TRACKS_FINALIZED))
}

/// Program participants, stakes, sides, time limit, kind and actor-bound flag must equal the Bet's.
pub fn check_program_matches_bet(bet: &Bet, p: &verdict_rules::Program) -> Result<()> {
    let n = bet.n();
    require!(p.n_participants as usize == n, VerdictError::ProgramBetMismatch);
    for i in 0..n {
        require!(p.participant(i) == bet.participants[i].as_ref(), VerdictError::ProgramBetMismatch);
        require!(p.stakes[i] == bet.stakes[i], VerdictError::ProgramBetMismatch);
    }
    require!(p.side_b_mask == bet.side_b_mask, VerdictError::ProgramBetMismatch);
    require!(p.time_limit_s == bet.time_limit_s, VerdictError::ProgramBetMismatch);
    let kind = match bet.kind() {
        BetKind::Rules => verdict_rules::ProgramKind::Rules,
        BetKind::AiJudged => verdict_rules::ProgramKind::AiJudged,
        BetKind::Market => verdict_rules::ProgramKind::Market,
    };
    require!(p.kind == kind, VerdictError::ProgramBetMismatch);
    require!(p.any_actor_bound() == (bet.flags & FLAG_ACTOR_BOUND != 0), VerdictError::ProgramBetMismatch);
    Ok(())
}
