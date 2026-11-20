//! ESCROW §9.2 event rows that are testable in Rust (§7.1, §7.2, TM-E1..E4):
//!
//! - E1: every instruction emits exactly one event of the §7.2 type, decoded from an `emit_cpi!`
//!   inner instruction, with fields equal to the chain state and the token balance deltas; the
//!   atomic lock and the bundled `[terminal ix, close_bet]` carry two, one per outer ix, in order.
//!   No "Log truncated" and no `Program data:` log line (no `emit!` path) anywhere; and the
//!   inner-instruction events survive when the log collector does truncate (§7.1).
//! - E2 (Rust half): a forged top-level event ix fails, and so do fake event-authority / `program`
//!   accounts on a real ix (TM-E2, TM-C6). The Streams filter half is in the TS filter suite.
//! - E4 (Rust half): `[finalize, <failing ix>]` fails atomically; the inner event the runtime
//!   recorded before the failure is what filter rule 1 (`meta.err != null` → drop) exists for.
//!
//! E3 (mimic program + production filter), E5, E6 (webhook) are TS suites. Uses only `common`.

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::Instruction, AnchorDeserialize, Discriminator,
    Event,
};
use escrow::{
    payout::PayoutKind, AppealResolved, BetAccepted, BetAppealed, BetCancelled, BetClosed,
    BetConceded, BetCreated, BetFinalized, BetRefunded, BetResolved, BetStatus, ConfigInitialized,
    ConfigUpdated, EscrowError, Outcome, UpdateConfigArgs,
};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::{InstructionError, TransactionError};

use crate::common::*;

/// Anchor 1.2.2 `ErrorCode::ConstraintSigner`.
const ANCHOR_CONSTRAINT_SIGNER: u32 = 2002;
/// The cap LiteSVM's (and Agave's) log collector applies by default (~10 KB, §7.1).
const LOG_BYTES_LIMIT: usize = 10_000;

// ---------------------------------------------------------------------------------------------
// local helpers
// ---------------------------------------------------------------------------------------------

/// Events of type `T` emitted under outer instruction `outer` (same rule as `common::events`:
/// escrow program, `EVENT_IX_TAG_LE`, first account = event authority).
fn events_at<T: AnchorDeserialize + Discriminator>(sent: &Sent, outer: usize) -> Vec<T> {
    let ea = event_authority();
    let Some(group) = sent.meta.inner_instructions.get(outer) else {
        return vec![];
    };
    group
        .iter()
        .filter(|inner| {
            let ci = &inner.instruction;
            sent.keys[ci.program_id_index as usize] == escrow::ID
                && ci.data.len() >= 16
                && ci.data[..8] == *anchor_lang::event::EVENT_IX_TAG_LE
                && ci.data[8..16] == *T::DISCRIMINATOR
                && ci.accounts.first().map(|i| sent.keys[*i as usize]) == Some(ea)
        })
        .map(|inner| T::try_from_slice(&inner.instruction.data[16..]).expect("event decodes"))
        .collect()
}

/// Every escrow event inner ix: (outer ix, stack height). Proves "decoded from the inner
/// instruction" and that events sit one level below the escrow ix that emitted them.
fn event_positions(sent: &Sent) -> Vec<(usize, u8)> {
    let mut out = vec![];
    for (outer, group) in sent.meta.inner_instructions.iter().enumerate() {
        for inner in group {
            let ci = &inner.instruction;
            if sent.keys[ci.program_id_index as usize] == escrow::ID
                && ci.data.starts_with(anchor_lang::event::EVENT_IX_TAG_LE)
            {
                assert_eq!(
                    ci.accounts.first().map(|i| sent.keys[*i as usize]),
                    Some(event_authority()),
                    "event inner ix names the event authority first"
                );
                out.push((outer, inner.stack_height));
            }
        }
    }
    out
}

/// §7.1: events go out only via `emit_cpi!` (the `emit!` log path is never used, so a
/// `Program data:` decoder has nothing to find) and the logs are not truncated.
#[track_caller]
fn assert_cpi_only_untruncated(sent: &Sent) {
    assert_no_log_truncation(sent);
    assert!(
        !sent
            .meta
            .logs
            .iter()
            .any(|l| l.starts_with("Program data:")),
        "an emit! log line was found:\n{}",
        sent.meta.logs.join("\n")
    );
    let bytes: usize = sent.meta.logs.iter().map(|l| l.len()).sum();
    assert!(bytes < LOG_BYTES_LIMIT, "logs are {bytes} bytes");
}

/// Exactly one escrow event in the tx, under outer ix 0 at stack height 2.
#[track_caller]
fn assert_single_event(sent: &Sent) {
    assert_eq!(event_count(sent), 1, "exactly one event");
    assert_eq!(event_positions(sent), vec![(0, 2)]);
    assert_cpi_only_untruncated(sent);
}

/// The account keys `Env::send` puts in the message for `ixs` (fee payer first), so a FAILED
/// result can be decoded with the same helpers as a successful one.
fn keys_for(ixs: &[Instruction], fee_payer: &Pubkey) -> Vec<Pubkey> {
    Message::new(ixs, Some(fee_payer)).account_keys
}

/// A model of the production filter's rules 1–3 (§7.1): drop failed txs; count only inner ixs
/// of the escrow with the event tag whose first account is the event authority.
fn filter_model(res: &SendResult) -> usize {
    match res {
        Ok(sent) => event_count(sent),
        Err(_) => 0,
    }
}

macro_rules! assert_config_event {
    ($ev:expr, $cfg:expr, $now:expr) => {{
        let (e, c) = (&$ev, &$cfg);
        assert_eq!(e.admin, c.admin);
        assert_eq!(e.judge_authority, c.judge_authority);
        assert_eq!(e.appeal_authority, c.appeal_authority);
        assert_eq!(e.max_stake, c.max_stake);
        assert_eq!(e.appeal_window_secs, c.appeal_window_secs);
        assert_eq!(e.accept_deadline_secs, c.accept_deadline_secs);
        assert_eq!(e.resolve_deadline_secs, c.resolve_deadline_secs);
        assert_eq!(e.appeal_resolve_secs, c.appeal_resolve_secs);
        assert_eq!(e.allowed_mints, c.allowed_mints);
        assert_eq!(e.paused, c.paused);
        assert_eq!(e.ts, $now);
    }};
}

// ---------------------------------------------------------------------------------------------
// E1
// ---------------------------------------------------------------------------------------------

#[test]
fn e1_config_instructions_one_event_each() {
    // E1: initialize_config → ConfigInitialized; update_config → ConfigUpdated (full post-update
    // snapshot, §7.2), one each.
    let mut env = Env::new();
    let args = demo_args(env.judge.pubkey(), env.appeal.pubkey(), vec![env.usdc]);
    let res = env.initialize_config(&args);
    let sent = assert_ok(&res);
    assert_single_event(sent);
    let evs = events::<ConfigInitialized>(sent);
    assert_eq!(evs.len(), 1);
    let cfg = env.config();
    assert_eq!(evs[0].admin, env.admin.pubkey());
    assert_config_event!(evs[0], cfg, env.now());

    env.advance(7);
    let other = env.create_mint(6, CLASSIC_TOKEN);
    let res = env.update_config(&UpdateConfigArgs {
        max_stake: Some(1_000_000),
        allowed_mints: Some(vec![env.usdc, other]),
        paused: Some(true),
        ..Default::default()
    });
    let sent = assert_ok(&res);
    assert_single_event(sent);
    assert!(events::<ConfigInitialized>(sent).is_empty());
    let evs = events::<ConfigUpdated>(sent);
    assert_eq!(evs.len(), 1);
    let cfg = env.config();
    assert_eq!((cfg.max_stake, cfg.paused), (1_000_000, true));
    assert_config_event!(evs[0], cfg, env.now());
}

#[test]
fn e1_create_and_accept_one_event_each_matching_deltas() {
    // E1: sequential create_bet → BetCreated; accept_bet → BetAccepted. Fields equal the Bet and
    // the token deltas (A −stake_a, B −stake_b, vault = pot).
    let mut env = Env::with_config();
    let id = bet_id(1);
    let (mut c, ca) = env.default_create(id);
    c.stake_a = 6_200_000;
    c.stake_b = 3_800_000;
    let (a0, b0) = (
        env.token_balance(&env.a_token),
        env.token_balance(&env.b_token),
    );

    let res = env.create_bet(&c, &ca);
    let sent = assert_ok(&res);
    assert_single_event(sent);
    let evs = events::<BetCreated>(sent);
    assert_eq!(evs.len(), 1);
    let (e, bet) = (&evs[0], env.bet(&id));
    assert_eq!(e.bet_id, id);
    assert_eq!((e.bet, e.vault), (ca.bet, ca.vault));
    assert_eq!((e.party_a, e.party_b), (bet.party_a, bet.party_b));
    assert_eq!((e.party_a, e.party_b), (env.a.pubkey(), env.b.pubkey()));
    assert_eq!(e.mint, env.usdc);
    assert_eq!((e.stake_a, e.stake_b), (6_200_000, 3_800_000));
    assert_eq!(e.terms_hash, TERMS);
    assert_eq!(e.judge_authority, env.judge.pubkey());
    assert_eq!(e.appeal_authority, env.appeal.pubkey());
    assert_eq!(e.accept_deadline, c.accept_deadline);
    assert_eq!(e.rent_payer, env.s.pubkey());
    assert_eq!(e.ts, env.now());
    assert_eq!(bet.status, BetStatus::Open);
    assert_eq!(env.token_balance(&env.a_token), a0 - e.stake_a);
    assert_eq!(env.token_balance(&ca.vault), e.stake_a);

    env.advance(4);
    let (aa, acc) = env.default_accept(&c, &ca);
    let res = env.accept_bet(&aa, &acc);
    let sent = assert_ok(&res);
    assert_single_event(sent);
    let evs = events::<BetAccepted>(sent);
    assert_eq!(evs.len(), 1);
    let (e, bet) = (&evs[0], env.bet(&id));
    assert_eq!(e.bet_id, id);
    assert_eq!((e.party_a, e.party_b), (env.a.pubkey(), env.b.pubkey()));
    assert_eq!(e.terms_hash, TERMS);
    assert_eq!((e.stake_a, e.stake_b), (6_200_000, 3_800_000));
    assert_eq!(e.vault_amount, env.token_balance(&ca.vault));
    assert_eq!(e.vault_amount, 10_000_000);
    assert_eq!(e.resolve_deadline, bet.resolve_deadline);
    assert_eq!(e.resolve_deadline, env.now() + RESOLVE_WINDOW_SECS);
    assert_eq!(e.ts, env.now());
    assert_eq!(bet.status, BetStatus::Locked);
    assert_eq!(env.token_balance(&env.b_token), b0 - e.stake_b);
}

#[test]
fn e1_resolve_and_appeal_one_event_each() {
    // E1: resolve → BetResolved; appeal → BetAppealed; no tokens move on either.
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let (a0, b0, v0) = (
        env.token_balance(&env.a_token),
        env.token_balance(&env.b_token),
        env.token_balance(&vault_pda(&id).0),
    );
    env.advance(9);
    let j = env.judge.insecure_clone();
    let (ev_h, ru_h) = ([0x5a; 32], [0xa5; 32]);
    let res = env.resolve_as(&id, &j, Outcome::PartyB, ev_h, ru_h);
    let sent = assert_ok(&res);
    assert_single_event(sent);
    let evs = events::<BetResolved>(sent);
    assert_eq!(evs.len(), 1);
    let (e, bet) = (&evs[0], env.bet(&id));
    assert_eq!(e.bet_id, id);
    assert_eq!(e.judge, env.judge.pubkey());
    assert_eq!(e.outcome, Outcome::PartyB);
    assert_eq!((e.evidence_hash, e.ruling_hash), (ev_h, ru_h));
    assert_eq!(e.appeal_deadline, bet.appeal_deadline);
    assert_eq!(e.appeal_deadline, env.now() + APPEAL_WINDOW_SECS);
    assert_eq!(e.ts, env.now());

    env.advance(2);
    let a = env.a.insecure_clone(); // A loses PartyB
    let res = env.appeal(&id, &a);
    let sent = assert_ok(&res);
    assert_single_event(sent);
    let evs = events::<BetAppealed>(sent);
    assert_eq!(evs.len(), 1);
    let (e, bet) = (&evs[0], env.bet(&id));
    assert_eq!(e.bet_id, id);
    assert_eq!(e.appellant, env.a.pubkey());
    assert_eq!(e.original_outcome, Outcome::PartyB);
    assert_eq!(e.appeal_resolve_deadline, bet.appeal_resolve_deadline);
    assert_eq!(e.appeal_resolve_deadline, env.now() + APPEAL_RESOLVE_SECS);
    assert_eq!(e.ts, env.now());
    assert_eq!(
        (
            env.token_balance(&env.a_token),
            env.token_balance(&env.b_token),
            env.token_balance(&vault_pda(&id).0)
        ),
        (a0, b0, v0),
        "resolve / appeal move no tokens"
    );
}

/// Runs one STANDALONE terminal tx, checks it with the §9.1 standalone post-conditions (one
/// event, fields == balance deltas, only party accounts moved), then closes the bet standalone
/// and checks `BetClosed` the same way. Returns the terminal tx for per-type extras.
fn terminal_then_close(
    env: &mut Env,
    id: &[u8; 16],
    ix: Instruction,
    signers: &[&Keypair],
    exp: &ExpectTerminal,
) -> Sent {
    let before = Snapshot::take(env, id);
    let res = env.send_s(&[ix], signers);
    let sent = match res {
        Ok(s) => s,
        Err(f) => panic!("tx failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    };
    assert_single_event(&sent);
    assert_terminal_postconditions_standalone(env, &before, &sent, exp);

    let before = Snapshot::take(env, id);
    let res = env.close_bet(id);
    let closed = assert_ok(&res);
    assert_single_event(closed);
    assert_close_postconditions(env, &before, closed, 0);
    sent
}

#[test]
fn e1_every_terminal_instruction_one_event_matching_deltas() {
    // E1 for the five token-moving instructions (all paths, incl. each timeout_refund source
    // status) and close_bet: exactly one event of the §7.2 type, common fields == balance deltas
    // and the accounts that changed (via the §9.1 post-conditions), plus each type's extras.
    let mut env = Env::with_config();
    let (a, b, ap) = (
        env.a.insecure_clone(),
        env.b.insecure_clone(),
        env.appeal.insecure_clone(),
    );

    // cancel_open_bet (B declines) → BetCancelled
    let id = bet_id(1);
    env.open_bet(id);
    let ix = env.ix_cancel_open_bet(b.pubkey(), &env.default_payout(&id));
    let exp = ExpectTerminal::new(TerminalKind::Cancelled, Outcome::Refund, USDC_5, 0);
    let sent = terminal_then_close(&mut env, &id, ix, &[&b], &exp);
    let e = &events::<BetCancelled>(&sent)[0];
    assert_eq!(e.cancelled_by, env.b.pubkey());
    assert_eq!(e.final_status, BetStatus::Cancelled);

    // concede (B loses PartyA) → BetConceded
    let id = bet_id(2);
    env.resolved_bet(id, Outcome::PartyA);
    let ix = env.ix_concede(b.pubkey(), &env.default_payout(&id));
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyA, 2 * USDC_5, 0);
    let sent = terminal_then_close(&mut env, &id, ix, &[&b], &exp);
    assert_eq!(events::<BetConceded>(&sent)[0].conceded_by, env.b.pubkey());

    // finalize (Split, odd pot) → BetFinalized; caller = the fee payer / payer signer
    let id = bet_id(3);
    env.resolved_bet_with(id, 3_000_001, 2_000_000, Outcome::Split);
    env.warp_to_appeal_deadline(&id);
    let ix = env.ix_finalize(&env.default_payout(&id));
    let exp = ExpectTerminal::new(
        TerminalKind::Finalized,
        Outcome::Split,
        2_500_000,
        2_500_001,
    );
    let sent = terminal_then_close(&mut env, &id, ix, &[], &exp);
    assert_eq!(events::<BetFinalized>(&sent)[0].caller, env.s.pubkey());

    // resolve_appeal (A appealed PartyB, upheld) → AppealResolved
    let id = bet_id(4);
    env.appealed_bet_with(id, USDC_5, USDC_5, Outcome::PartyB, &a);
    let ix = env.ix_resolve_appeal(
        ap.pubkey(),
        &env.default_payout(&id),
        Outcome::PartyB,
        APPEAL_RULING,
    );
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::PartyB, 0, 2 * USDC_5);
    let sent = terminal_then_close(&mut env, &id, ix, &[&ap], &exp);
    let e = &events::<AppealResolved>(&sent)[0];
    assert_eq!(e.original_outcome, Outcome::PartyB);
    assert_eq!(e.appeal_ruling_hash, APPEAL_RULING);
    assert!(!e.overturned);

    // resolve_appeal overturned (PartyA → Refund, 6.2 / 3.8)
    let id = bet_id(5);
    env.appealed_bet_with(id, 6_200_000, 3_800_000, Outcome::PartyA, &b);
    let ix = env.ix_resolve_appeal(
        ap.pubkey(),
        &env.default_payout(&id),
        Outcome::Refund,
        APPEAL_RULING,
    );
    let exp = ExpectTerminal::new(
        TerminalKind::AppealResolved,
        Outcome::Refund,
        6_200_000,
        3_800_000,
    );
    let sent = terminal_then_close(&mut env, &id, ix, &[&ap], &exp);
    let e = &events::<AppealResolved>(&sent)[0];
    assert_eq!(e.original_outcome, Outcome::PartyA);
    assert!(e.overturned);

    // timeout_refund from Open, Locked and Appealed → BetRefunded with from_status
    for (n, from) in [
        (6u8, BetStatus::Open),
        (7, BetStatus::Locked),
        (8, BetStatus::Appealed),
    ] {
        let id = bet_id(n);
        let kind = match from {
            BetStatus::Open => {
                env.open_bet(id);
                env.warp_to_accept_deadline(&id);
                PayoutKind::OpenRefund
            }
            BetStatus::Locked => {
                env.locked_bet_with(id, 6_200_000, 3_800_000);
                env.warp_to_resolve_deadline(&id);
                PayoutKind::LockedRefund
            }
            _ => {
                env.appealed_bet_with(id, 6_200_000, 3_800_000, Outcome::PartyA, &b);
                env.warp_to_appeal_resolve_deadline(&id);
                PayoutKind::LockedRefund
            }
        };
        let ix = env.ix_timeout_refund(&env.default_payout(&id));
        let before = Snapshot::take(&env, &id);
        let exp = ExpectTerminal::from_math(TerminalKind::Refunded, Outcome::Refund, kind, &before);
        let sent = terminal_then_close(&mut env, &id, ix, &[], &exp);
        let e = &events::<BetRefunded>(&sent)[0];
        assert_eq!(e.from_status, from);
        assert_eq!(e.caller, env.s.pubkey());
    }
}

#[test]
fn e1_two_event_transactions_one_event_per_outer_ix_in_order() {
    // §7.2: the atomic lock carries BetCreated (outer ix 0) then BetAccepted (outer ix 1); a
    // bundled terminal tx carries the terminal event (outer ix 0) then BetClosed (outer ix 1).
    let mut env = Env::with_config();
    let id = bet_id(1);
    let (c, ca) = env.default_create(id);
    let (aa, acc) = env.default_accept(&c, &ca);
    let ixs = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let (a, b) = (env.a.insecure_clone(), env.b.insecure_clone());
    let res = env.send_s(&ixs, &[&a, &b]);
    let sent = assert_ok(&res);
    assert_cpi_only_untruncated(sent);
    assert_eq!(event_count(sent), 2);
    assert_eq!(event_positions(sent), vec![(0, 2), (1, 2)]);
    assert_eq!(events_at::<BetCreated>(sent, 0).len(), 1);
    assert_eq!(events_at::<BetAccepted>(sent, 1).len(), 1);
    assert!(events_at::<BetAccepted>(sent, 0).is_empty());
    assert!(events_at::<BetCreated>(sent, 1).is_empty());
    let created = &events_at::<BetCreated>(sent, 0)[0];
    let accepted = &events_at::<BetAccepted>(sent, 1)[0];
    assert_eq!(created.bet_id, accepted.bet_id);
    assert_eq!(created.ts, accepted.ts, "locked_at == created_at");
    assert_eq!(accepted.vault_amount, 2 * USDC_5);

    // bundled [concede, close_bet]
    assert_ok(&env.resolve(&id, Outcome::PartyB));
    let before = Snapshot::take(&env, &id);
    let res = env.concede_bundled(&id, &a);
    let sent = assert_ok(&res);
    assert_cpi_only_untruncated(sent);
    assert_eq!(event_positions(sent), vec![(0, 2), (1, 2)]);
    assert_eq!(events_at::<BetConceded>(sent, 0).len(), 1);
    assert_eq!(events_at::<BetClosed>(sent, 1).len(), 1);
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyB, 0, 2 * USDC_5);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
}

#[test]
fn e1_failed_instructions_emit_nothing_and_change_nothing() {
    // "Exactly one event per state change": a rejected ix changes no state and leaves the filter
    // nothing to apply (failed tx → dropped; LiteSVM commits nothing).
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = env.bet(&id);
    let a = env.a.insecure_clone();
    let attempts: Vec<(SendResult, EscrowError)> = vec![
        (env.concede(&id, &a), EscrowError::NotLoser),
        (env.finalize(&id), EscrowError::AppealWindowOpen),
        (env.timeout_refund(&id), EscrowError::InvalidStatus),
        (
            env.resolve(&id, Outcome::PartyB),
            EscrowError::InvalidStatus,
        ),
    ];
    for (res, e) in &attempts {
        assert_escrow_err(res, *e);
        assert_eq!(filter_model(res), 0);
    }
    assert_eq!(env.bet(&id), before);
}

#[test]
fn e1_events_survive_log_truncation() {
    // §7.1: with the log collector capped so the logs truncate, `emit_cpi!` events are
    // still complete in the inner instructions (the reason the filter never reads logs).
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::Split);
    env.warp_to_appeal_deadline(&id);
    let svm = std::mem::take(&mut env.svm);
    env.svm = svm.with_log_bytes_limit(Some(200));
    let (a0, b0) = (
        env.token_balance(&env.a_token),
        env.token_balance(&env.b_token),
    );
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    assert!(
        sent.meta.logs.iter().any(|l| l.contains("Log truncated")),
        "fixture: logs must truncate"
    );
    assert_eq!(event_positions(sent), vec![(0, 2), (1, 2)]);
    let fin = &events::<BetFinalized>(sent)[0];
    assert_eq!((fin.bet_id, fin.outcome), (id, Outcome::Split));
    assert_eq!((fin.to_a, fin.to_b), (USDC_5, USDC_5));
    assert_eq!(
        (fin.party_a_token, fin.party_b_token),
        (env.a_token, env.b_token)
    );
    assert_eq!(env.token_balance(&env.a_token) - a0, fin.to_a);
    assert_eq!(env.token_balance(&env.b_token) - b0, fin.to_b);
    let closed = &events::<BetClosed>(sent)[0];
    assert_eq!(closed.final_status, BetStatus::Settled);
    assert!(!env.exists(&bet_pda(&id).0));
}

// ---------------------------------------------------------------------------------------------
// E2 (+ TM-C6)
// ---------------------------------------------------------------------------------------------

#[test]
fn e2_forged_top_level_event_ix_fails() {
    // E2 / TM-E2: a top-level ix to the escrow carrying EVENT_IX_TAG ‖ a forged BetFinalized
    // (paying Mallory). Anchor's event handler requires the event-authority PDA as a signer,
    // which only the escrow can produce: every variant fails, and the filter sees 0 events.
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let forged = BetFinalized {
        bet_id: id,
        final_status: BetStatus::Settled,
        outcome: Outcome::PartyB,
        mint: env.usdc,
        party_a: env.a.pubkey(),
        party_b: env.mallory.pubkey(),
        party_a_token: Pubkey::default(),
        party_b_token: env.mallory_token,
        to_a: 0,
        to_b: 2 * USDC_5,
        ts: env.now(),
        caller: env.mallory.pubkey(),
    };
    let data = [anchor_lang::event::EVENT_IX_TAG_LE, &forged.data()[..]].concat();
    let ix_with = |accounts| Instruction {
        program_id: escrow::ID,
        accounts,
        data: data.clone(),
    };
    let mallory = env.mallory.insecure_clone();
    let bet_before = env.bet(&id);
    let bal = |env: &Env| {
        (
            env.token_balance(&env.mallory_token),
            env.token_balance(&vault_pda(&id).0),
        )
    };
    let bal0 = bal(&env);

    // (a) the real event-authority address, not signing (nobody can sign for it)
    let res = env.send(
        &[ix_with(vec![meta(event_authority(), false, false)])],
        &mallory,
        &[],
    );
    assert_err(&res, ANCHOR_CONSTRAINT_SIGNER);
    assert_eq!(filter_model(&res), 0);
    // (b) Mallory signs in the event-authority slot
    let res = env.send(
        &[ix_with(vec![meta(mallory.pubkey(), true, false)])],
        &mallory,
        &[],
    );
    assert_err(&res, ANCHOR_CONSTRAINT_SEEDS);
    assert_eq!(filter_model(&res), 0);
    // (c) no accounts at all (Anchor's `next_account_info` → NotEnoughAccountKeys)
    let res = env.send(&[ix_with(vec![])], &mallory, &[]);
    #[allow(deprecated)]
    let expected = TransactionError::InstructionError(0, InstructionError::NotEnoughAccountKeys);
    assert_eq!(res.as_ref().err().map(|f| f.err.clone()), Some(expected));
    assert_eq!(filter_model(&res), 0);
    assert_eq!(bal(&env), bal0, "nothing moved");
    assert_eq!(env.bet(&id), bet_before, "the bet is untouched");

    // (d) after a real finalize in the same tx: the forged ix still fails, so the whole tx does
    env.warp_to_appeal_deadline(&id);
    let ixs = [
        env.ix_finalize(&env.default_payout(&id)),
        ix_with(vec![meta(event_authority(), false, false)]),
    ];
    let res = env.send_s(&ixs, &[]);
    assert_err_at(&res, 1, ANCHOR_CONSTRAINT_SIGNER);
    assert_eq!(filter_model(&res), 0);
    assert_eq!(bal(&env), bal0, "nothing moved");
    assert_eq!(env.bet(&id), bet_before, "the bet is untouched");

    // The real finalize still pays A, not Mallory.
    let before = Snapshot::take(&env, &id);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
}

#[test]
fn e2_tm_c6_fake_event_authority_or_program_account() {
    // TM-C6 (tested under E2): a real terminal ix with a substituted `event_authority` or
    // `program` account fails as a whole; no tokens move and no event is recorded.
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let bet_before = env.bet(&id);
    let v0 = env.token_balance(&vault_pda(&id).0);
    let a0 = env.token_balance(&env.a_token);

    // event_authority → an arbitrary key
    let mut ix = env.ix_finalize(&env.default_payout(&id));
    let ea_pos = ix
        .accounts
        .iter()
        .position(|m| m.pubkey == event_authority())
        .unwrap();
    ix.accounts[ea_pos].pubkey = Pubkey::new_unique();
    let res = env.send_s(&[ix], &[]);
    assert_err(&res, ANCHOR_CONSTRAINT_ADDRESS); // #[event_cpi] pins the PDA address

    // program → the SPL Token program (an executable that is not the escrow); and → a plain key
    for fake in [CLASSIC_TOKEN, Pubkey::new_unique()] {
        let mut ix = env.ix_finalize(&env.default_payout(&id));
        let last = ix.accounts.len() - 1;
        assert_eq!(
            ix.accounts[last].pubkey,
            escrow::ID,
            "`program` is the last meta"
        );
        ix.accounts[last].pubkey = fake;
        let res = env.send_s(&[ix], &[]);
        assert!(res.is_err(), "fake `program` {fake} must fail");
        assert_eq!(filter_model(&res), 0);
    }
    assert_eq!(env.bet(&id), bet_before);
    assert_eq!(env.token_balance(&vault_pda(&id).0), v0);
    assert_eq!(env.token_balance(&env.a_token), a0);
    assert_ok(&env.finalize(&id));
}

// ---------------------------------------------------------------------------------------------
// E4
// ---------------------------------------------------------------------------------------------

#[test]
fn e4_finalize_then_failing_ix_rolls_back() {
    // E4 / TM-E3: `[finalize, <failing ix>]`. The tx fails at ix 1 and nothing is committed, yet
    // the failed meta still carries ix 0's BetFinalized inner ix; filter rule 1 (drop
    // `meta.err != null`) is what yields 0 events.
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let bet_before = env.bet(&id);
    let snap = Snapshot::take(&env, &id);
    let b = env.b.insecure_clone();

    for failing in [
        // a second terminal ix on the same bet (InvalidStatus after finalize)
        env.ix_concede(b.pubkey(), &env.bare_payout(&id)),
        // an unrelated failing ix: an SPL transfer from B larger than B's balance
        anchor_spl::token_interface::spl_token_2022::instruction::transfer_checked(
            &CLASSIC_TOKEN,
            &env.b_token,
            &env.usdc,
            &env.mallory_token,
            &b.pubkey(),
            &[],
            FUNDED * 10,
            6,
        )
        .unwrap(),
    ] {
        let ixs = [env.ix_finalize(&env.default_payout(&id)), failing];
        let keys = keys_for(&ixs, &env.s.pubkey());
        let res = env.send_s(&ixs, &[&b]);
        let f = res.as_ref().err().expect("whole tx fails");
        assert!(
            matches!(f.err, TransactionError::InstructionError(1, _)),
            "fails at ix 1: {:?}",
            f.err
        );
        assert_eq!(filter_model(&res), 0, "rule 1 drops failed txs");
        // What an err-blind decoder would have seen: at most the one BetFinalized of ix 0.
        let raw = Sent {
            meta: f.meta.clone(),
            keys,
        };
        // The runtime DID record ix 0's BetFinalized in the failed tx's meta (TM-E3): an
        // err-blind decoder would report a payout that never happened.
        let recorded = events::<BetFinalized>(&raw);
        assert_eq!(
            recorded.len(),
            1,
            "the would-be event is in the failed meta"
        );
        assert_eq!((recorded[0].bet_id, recorded[0].to_a), (id, 2 * USDC_5));
        assert_eq!(env.bet(&id), bet_before, "Bet unchanged");
        for (k, _) in &snap.balances {
            assert_eq!(snap.delta(&env, k), 0, "balance of {k} unchanged");
        }
        assert_eq!(env.token_balance(&vault_pda(&id).0), snap.v);
    }
    // The bet still settles normally afterwards.
    assert_ok(&env.finalize_bundled(&id));
}
