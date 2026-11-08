//! Timeouts, refunds and cancel (§9.4 #4, #15, §9.9).
mod common;

use common::flow::*;
use common::*;

fn assert_refunded(f: &Flow, reason: u8, expected: &[u64]) {
    let b = f.bet();
    assert_eq!(b.state, STATE_REFUNDED);
    assert_eq!(b.refund_reason, reason);
    assert_eq!(b.settle_path, PATH_REFUND);
    for (i, e) in expected.iter().enumerate() {
        assert_eq!(f.balance(i), *e, "participant {i}");
    }
    assert!(!f.env.exists(&f.vault()));
}

#[test]
fn fund_timeout_refunds_partial_funding() {
    let mut f = Flow::rules(2, true);
    f.create();
    ok(f.try_fund(1));
    assert_err(f.try_refund(), VerdictError::NotRefundable);
    f.env.advance(FUND_WINDOW_S);
    assert_err(f.try_refund(), VerdictError::NotRefundable);
    f.env.advance(1);
    assert_err(f.try_fund(0), VerdictError::DeadlinePassed);
    ok(f.try_refund());
    assert_refunded(&f, REFUND_FUND_TIMEOUT, &[INITIAL_BALANCE, INITIAL_BALANCE]);
    // Terminal: nothing more.
    assert_fails(f.try_refund()); // vault closed
}

#[test]
fn fund_at_exact_deadline_is_allowed() {
    let mut f = Flow::rules(2, true);
    f.create();
    f.env.advance(FUND_WINDOW_S);
    f.fund_all();
    assert_eq!(f.bet().state, STATE_FUNDED);
}

#[test]
fn start_timeout() {
    let mut f = Flow::rules(2, true);
    f.create();
    f.fund_all();
    f.env.advance(START_WINDOW_S);
    assert_err(f.try_refund(), VerdictError::NotRefundable);
    f.env.advance(1);
    assert_err(f.try_start(), VerdictError::DeadlinePassed);
    ok(f.try_refund());
    assert_refunded(&f, REFUND_START_TIMEOUT, &[INITIAL_BALANCE, INITIAL_BALANCE]);
}

#[test]
fn live_timeout() {
    let mut f = Flow::rules(2, true);
    f.create();
    f.fund_all();
    ok(f.try_start());
    f.env.advance(60 + LIVE_GRACE_S);
    assert_err(f.try_refund(), VerdictError::NotRefundable);
    f.env.advance(1);
    ok(f.try_refund());
    assert_refunded(&f, REFUND_LIVE_TIMEOUT, &[INITIAL_BALANCE, INITIAL_BALANCE]);
}

#[test]
fn perception_timeout_closes_track_buffer() {
    let mut f = Flow::rules(2, true);
    f.to_tracks_posted();
    assert!(f.env.exists(&f.tracks()));
    f.env.advance(PERCEPTION_TIMEOUT_S - 30);
    assert_err(f.try_refund(), VerdictError::NotRefundable);
    f.env.advance(31);
    // After the timeout run_rules is no longer usable in practice; refund wins.
    ok(f.try_refund());
    assert_refunded(&f, REFUND_PERCEPTION_TIMEOUT, &[INITIAL_BALANCE, INITIAL_BALANCE]);
    assert!(!f.env.exists(&f.tracks()));
}

#[test]
fn panel_timeout_returns_bond() {
    let mut f = Flow::rules(2, true);
    f.to_preruled();
    ok(f.try_dispute(0, 2));
    f.env.advance(PANEL_TIMEOUT_S);
    assert_err(f.try_refund(), VerdictError::NotRefundable);
    f.env.advance(1);
    ok(f.try_refund());
    assert_refunded(&f, REFUND_PANEL_TIMEOUT, &[INITIAL_BALANCE, INITIAL_BALANCE]);
}

#[test]
fn preruled_stuck_escape() {
    let mut f = Flow::rules(2, true);
    f.to_preruled();
    f.env.advance(CONSENT_WINDOW_S + PANEL_TIMEOUT_S);
    assert_err(f.try_refund(), VerdictError::NotRefundable);
    f.env.advance(1);
    ok(f.try_refund());
    assert_refunded(&f, REFUND_CONSENT_TIMEOUT, &[INITIAL_BALANCE, INITIAL_BALANCE]);
}

#[test]
fn settled_bet_is_not_refundable() {
    let mut f = Flow::rules(2, true);
    f.to_preruled();
    f.env.advance(CONSENT_WINDOW_S + 1);
    let o = f.env.oracle.insecure_clone();
    ok(f.try_consent(&o));
    f.env.advance(100_000);
    assert_fails(f.try_refund()); // vault closed / NotRefundable
}

#[test]
fn cancel_refunds_funded_stakes() {
    let mut f = Flow::rules(2, true);
    f.create();
    ok(f.try_fund(0));
    let stranger = kp(99);
    let ixn = f.cancel_ix(&stranger.pubkey());
    assert_err(f.env.send(&[ixn], &[&stranger]), VerdictError::Unauthorized);
    let c = f.users[0].insecure_clone();
    let ixn = f.cancel_ix(&c.pubkey());
    let meta = ok(f.env.send(&[ixn], &[&c]));
    assert_eq!(meta.logs.iter().filter(|l| l.starts_with("Program data: ")).count(), 2);
    assert_refunded(&f, REFUND_CANCELLED, &[INITIAL_BALANCE, INITIAL_BALANCE]);
}

#[test]
fn cancel_only_while_proposed() {
    let mut f = Flow::rules(2, true);
    f.create();
    f.fund_all();
    let c = f.users[0].insecure_clone();
    let ixn = f.cancel_ix(&c.pubkey());
    assert_err(f.env.send(&[ixn], &[&c]), VerdictError::InvalidState);
}

#[test]
fn refund_rejects_wrong_payout_owner() {
    let mut f = Flow::rules(2, true);
    f.create();
    ok(f.try_fund(0));
    f.env.advance(FUND_WINDOW_S + 1);
    // Payout account 1 replaced by an account of the wrong owner.
    let wrong_owner = kp(98).pubkey();
    let mint = f.env.mint;
    let wrong = f.env.create_token_account(&wrong_owner, &mint);
    let mut ixn = f.refund_ix();
    let n = ixn.accounts.len();
    ixn.accounts[n - 1].pubkey = wrong;
    assert_err(f.env.send(&[ixn], &[]), VerdictError::BadTokenAccount);
    // Wrong oracle account.
    let mut ixn = f.refund_ix();
    ixn.accounts[2].pubkey = wrong_owner;
    assert_err(f.env.send(&[ixn], &[]), VerdictError::Unauthorized);
    ok(f.try_refund());
}
