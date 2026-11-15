//! E3 mimic (ESCROW §9.2, TM-E1, TM-E4): the escrow's `BetFinalized` (same name, so the same
//! 8-byte discriminator, and the same borsh layout) emitted by a program that is NOT the escrow.
//! `emit_via_cpi` uses Anchor's `emit_cpi!` (a self-CPI signed by THIS program's event authority),
//! `emit_via_log` uses `emit!` ("Program data:" log line). Both instructions also list the real
//! escrow program and its event authority as plain accounts, so the escrow ID is in the tx's
//! account keys and the filter's cheap pre-filter does not hide the test. The production filter
//! must forward 0 events for either.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("7kSL4sqMG2PDAGaDoeEiV8WS86wYkUYBbRsuZHkSkGgh");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BetStatus {
    Open,
    Locked,
    Resolved,
    Appealed,
    Settled,
    Refunded,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    PartyA,
    PartyB,
    Split,
    Refund,
}

/// Field-for-field copy of `escrow::events::BetFinalized`.
#[event]
pub struct BetFinalized {
    pub bet_id: [u8; 16],
    pub final_status: BetStatus,
    pub outcome: Outcome,
    pub mint: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub party_a_token: Pubkey,
    pub party_b_token: Pubkey,
    pub to_a: u64,
    pub to_b: u64,
    pub ts: i64,
    pub caller: Pubkey,
}

#[program]
pub mod mimic {
    use super::*;

    pub fn emit_via_cpi(ctx: Context<EmitViaCpi>, ev: BetFinalized) -> Result<()> {
        let _ = &ctx.accounts.escrow_program;
        emit_cpi!(ev);
        Ok(())
    }

    pub fn emit_via_log(ctx: Context<EmitViaLog>, ev: BetFinalized) -> Result<()> {
        let _ = &ctx.accounts.escrow_program;
        emit!(ev);
        Ok(())
    }
}

#[event_cpi]
#[derive(Accounts)]
pub struct EmitViaCpi<'info> {
    /// CHECK: listed only so the escrow ID appears in the tx's account keys.
    pub escrow_program: UncheckedAccount<'info>,
    /// CHECK: the REAL escrow event authority, listed (never signed) next to our own.
    pub escrow_event_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct EmitViaLog<'info> {
    /// CHECK: listed only so the escrow ID appears in the tx's account keys.
    pub escrow_program: UncheckedAccount<'info>,
    /// CHECK: the REAL escrow event authority, listed (never signed).
    pub escrow_event_authority: UncheckedAccount<'info>,
}
