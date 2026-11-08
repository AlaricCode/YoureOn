//! #2 `create_bet` (§9.4): creator + oracle sign; creates the Bet and its vault.
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::crypto::is_zero;
use crate::errors::VerdictError;
use crate::events::BetCreated;
use crate::state::{Bet, BetKind};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateBet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub creator: Signer<'info>,
    pub oracle: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Bet::SPACE,
        seeds = [BET_SEED, creator.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub bet: Box<Account<'info, Bet>>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, bet.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = bet,
        token::token_program = token_program,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Validated `create_bet` terms (pure; unit-tested).
pub struct BetTerms<'a> {
    pub creator: &'a Pubkey,
    pub oracle: &'a Pubkey,
    pub participants: &'a [Pubkey],
    pub stakes: &'a [u64],
    pub side_b_mask: u8,
    pub stake_each: u64,
    pub time_limit_s: u32,
    pub flags: u8,
    pub program_hash: &'a [u8; 32],
    pub judges: &'a [Pubkey; 3],
}

pub fn kind_of(flags: u8) -> BetKind {
    if flags & FLAG_MARKET != 0 {
        BetKind::Market
    } else if flags & FLAG_AI_JUDGED != 0 {
        BetKind::AiJudged
    } else {
        BetKind::Rules
    }
}

pub fn validate_terms(t: &BetTerms) -> Result<()> {
    let p = t.participants.len();
    require!((MIN_PARTICIPANTS..=MAX_PARTICIPANTS).contains(&p), VerdictError::BadParticipants);
    require!(t.participants[0] == *t.creator, VerdictError::BadParticipants);
    for i in 0..p {
        require!(t.participants[i] != Pubkey::default(), VerdictError::BadParticipants);
        for j in 0..i {
            require!(t.participants[i] != t.participants[j], VerdictError::BadParticipants);
        }
    }
    require!(!t.participants.contains(t.oracle), VerdictError::BadParticipants);

    // Flags (§9.2): known bits only; ai_judged ⊕ market; those require bit0 = 0.
    require!(t.flags & !FLAGS_KNOWN == 0, VerdictError::BadFlags);
    require!(!(t.flags & FLAG_AI_JUDGED != 0 && t.flags & FLAG_MARKET != 0), VerdictError::BadFlags);
    let kind = kind_of(t.flags);
    if kind != BetKind::Rules {
        require!(t.flags & FLAG_ACTOR_BOUND == 0, VerdictError::BadFlags);
    }

    // Sides: bit0 = 0 (creator is side 0), nonzero, only bits < P.
    require!(t.side_b_mask & 1 == 0, VerdictError::BadSides);
    require!(t.side_b_mask != 0, VerdictError::BadSides);
    require!((t.side_b_mask as u16) >> p == 0, VerdictError::BadSides);

    // Stakes.
    require!(t.stakes.len() == p, VerdictError::BadStake);
    let in_range = |s: u64| (MIN_STAKE_UNITS..=MAX_STAKE_UNITS).contains(&s);
    match kind {
        BetKind::Rules | BetKind::AiJudged => {
            require!(in_range(t.stake_each), VerdictError::BadStake);
            require!(t.stakes.iter().all(|&s| s == t.stake_each), VerdictError::BadStake);
        }
        BetKind::Market => {
            require!(t.stake_each == 0, VerdictError::BadStake);
            require!(t.stakes.iter().all(|&s| in_range(s)), VerdictError::BadStake);
        }
    }

    // Time limit per kind.
    let max = if kind == BetKind::Market { MARKET_TIME_LIMIT_MAX_S } else { TIME_LIMIT_MAX_S };
    require!(t.time_limit_s >= 1 && t.time_limit_s <= max, VerdictError::BadTimeLimit);

    // Judges: distinct, nonzero, not participants, not the oracle.
    for (i, j) in t.judges.iter().enumerate() {
        require!(*j != Pubkey::default(), VerdictError::BadJudges);
        require!(j != t.oracle, VerdictError::BadJudges);
        require!(!t.participants.contains(j), VerdictError::BadJudges);
        require!(!t.judges[..i].contains(j), VerdictError::BadJudges);
    }

    require!(!is_zero(t.program_hash), VerdictError::ProgramHashMismatch);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn handle_create_bet(
    ctx: Context<CreateBet>,
    nonce: u64,
    participants: Vec<Pubkey>,
    stakes: Vec<u64>,
    side_b_mask: u8,
    stake_each: u64,
    time_limit_s: u32,
    flags: u8,
    program_hash: [u8; 32],
    acceptance_audio_hash: [u8; 32],
    judges: [Pubkey; 3],
) -> Result<()> {
    let creator = ctx.accounts.creator.key();
    let oracle = ctx.accounts.oracle.key();
    validate_terms(&BetTerms {
        creator: &creator,
        oracle: &oracle,
        participants: &participants,
        stakes: &stakes,
        side_b_mask,
        stake_each,
        time_limit_s,
        flags,
        program_hash: &program_hash,
        judges: &judges,
    })?;

    let now = Clock::get()?.unix_timestamp;
    let bet_key = ctx.accounts.bet.key();
    let b = &mut ctx.accounts.bet;
    b.version = BET_VERSION;
    b.bump = ctx.bumps.bet;
    b.vault_bump = ctx.bumps.vault;
    b.state = STATE_PROPOSED;
    b.flags = flags;
    b.creator = creator;
    b.nonce = nonce;
    b.mint = ctx.accounts.mint.key();
    b.oracle = oracle;
    b.judges = judges;
    b.n_participants = participants.len() as u8;
    for (i, (p, s)) in participants.iter().zip(stakes.iter()).enumerate() {
        b.participants[i] = *p;
        b.stakes[i] = *s;
    }
    b.side_b_mask = side_b_mask;
    b.stake_each = stake_each;
    b.time_limit_s = time_limit_s;
    b.program_hash = program_hash;
    b.acceptance_audio_hash = acceptance_audio_hash;
    b.created_at = now;
    b.fund_deadline = now + FUND_WINDOW_S;
    b.witness_kinds = [WITNESS_KIND_UNUSED; 8];
    b.witness_heads = [HEAD_NONE; 8];
    b.leg_results = [LEG_RESULT_UNUSED; 8];

    emit!(BetCreated {
        bet: bet_key,
        creator,
        nonce,
        participants,
        stakes,
        side_b_mask,
        flags,
        program_hash,
        time_limit_s,
        fund_deadline: b.fund_deadline,
    });
    Ok(())
}
