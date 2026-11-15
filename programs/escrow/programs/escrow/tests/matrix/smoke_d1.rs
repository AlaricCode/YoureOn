//! D1 smoke: one happy path per new instruction (ESCROW §5.2), each checked with the §9.1
//! global post-conditions from `common`. The full §9.2 rows live in terminal.rs, appeal.rs,
//! math.rs, security.rs and events.rs.

use escrow::{
    payout::PayoutKind, AppealResolved, BetAppealed, BetCancelled, BetConceded, BetFinalized,
    BetRefunded, BetResolved, BetStatus, Outcome,
};
use solana_signer::Signer;

use crate::common::*;

#[test]
fn smoke_cancel_open_bet_bundled() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.open_bet(id);
    let before = Snapshot::take(&env, &id);
    let a = env.a.insecure_clone();
    let res = env.cancel_open_bet_bundled(&id, &a);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Cancelled, Outcome::Refund, USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(events::<BetCancelled>(sent)[0].cancelled_by, env.a.pubkey());
}

#[test]
fn smoke_resolve() {
    let mut env = Env::with_config();
    let id = bet_id(2);
    env.locked_bet(id);
    env.advance(5);
    let res = env.resolve(&id, Outcome::PartyA);
    let sent = assert_ok(&res);
    let bet = env.bet(&id);
    assert_eq!(bet.status, BetStatus::Resolved);
    assert_eq!(bet.outcome, Some(Outcome::PartyA));
    assert_eq!((bet.evidence_hash, bet.ruling_hash), (EVIDENCE, RULING));
    assert_eq!(bet.resolved_at, NOW + 5);
    assert_eq!(bet.appeal_deadline, NOW + 5 + APPEAL_WINDOW_SECS);
    assert_eq!(env.token_balance(&vault_pda(&id).0), 2 * USDC_5);
    let evs = events::<BetResolved>(sent);
    assert_eq!((evs.len(), event_count(sent)), (1, 1));
    assert_eq!(evs[0].judge, env.judge.pubkey());
    assert_eq!(evs[0].outcome, Outcome::PartyA);
    assert_eq!(evs[0].appeal_deadline, bet.appeal_deadline);
}

#[test]
fn smoke_concede_bundled() {
    let mut env = Env::with_config();
    let id = bet_id(3);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let b = env.b.insecure_clone();
    let res = env.concede_bundled(&id, &b);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(events::<BetConceded>(sent)[0].conceded_by, env.b.pubkey());
}

#[test]
fn smoke_appeal() {
    let mut env = Env::with_config();
    let id = bet_id(4);
    env.resolved_bet(id, Outcome::PartyA);
    env.advance(3);
    let b = env.b.insecure_clone();
    let res = env.appeal(&id, &b);
    let sent = assert_ok(&res);
    let bet = env.bet(&id);
    assert_eq!(bet.status, BetStatus::Appealed);
    assert_eq!(bet.appealed_at, NOW + 3);
    assert_eq!(bet.appeal_resolve_deadline, NOW + 3 + APPEAL_RESOLVE_SECS);
    let evs = events::<BetAppealed>(sent);
    assert_eq!((evs.len(), event_count(sent)), (1, 1));
    assert_eq!(evs[0].appellant, env.b.pubkey());
    assert_eq!(evs[0].original_outcome, Outcome::PartyA);
}

#[test]
fn smoke_resolve_appeal_bundled_overturned() {
    let mut env = Env::with_config();
    let id = bet_id(5);
    env.appealed_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let res = env.resolve_appeal_bundled(&id, Outcome::PartyB);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::PartyB, 0, 2 * USDC_5);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    let e = &events::<AppealResolved>(sent)[0];
    assert_eq!(e.original_outcome, Outcome::PartyA);
    assert_eq!(e.appeal_ruling_hash, APPEAL_RULING);
    assert!(e.overturned);
}

#[test]
fn smoke_finalize_standalone_split() {
    let mut env = Env::with_config();
    let id = bet_id(6);
    env.resolved_bet_with(id, 3_000_001, 2_000_000, Outcome::Split);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.finalize(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(
        TerminalKind::Finalized,
        Outcome::Split,
        2_500_000,
        2_500_001,
    );
    assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);
    assert_eq!(events::<BetFinalized>(sent)[0].caller, env.s.pubkey());
}

#[test]
fn smoke_timeout_refund_bundled_from_locked() {
    let mut env = Env::with_config();
    let id = bet_id(7);
    env.locked_bet_with(id, 6_200_000, 3_800_000);
    env.warp_to_resolve_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.timeout_refund_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::from_math(
        TerminalKind::Refunded,
        Outcome::Refund,
        PayoutKind::LockedRefund,
        &before,
    );
    assert_eq!((exp.to_a, exp.to_b), (6_200_000, 3_800_000));
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    let e = &events::<BetRefunded>(sent)[0];
    assert_eq!(e.from_status, BetStatus::Locked);
    assert_eq!(e.caller, env.s.pubkey());
}

#[test]
fn smoke_close_bet_with_residual() {
    let mut env = Env::with_config();
    let id = bet_id(8);
    env.settled_bet(id, Outcome::PartyB);
    // 5 units arrive after settlement: close_bet sweeps them to A (L5).
    assert_ok(&env.donate_to_vault(&id, 5));
    let before = Snapshot::take(&env, &id);
    let mut c = env.default_close(&id);
    c.party_a_token = Some(env.a_token);
    let ix = env.ix_close_bet(&c);
    let res = env.send_s(&[ix], &[]);
    let sent = assert_ok(&res);
    assert_close_postconditions(&env, &before, sent, 5);
}
