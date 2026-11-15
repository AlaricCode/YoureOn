//! Disputes and the judge panel (§9.4 #11–#12, §9.7).
mod common;

use common::flow::*;
use common::*;
use solana_sdk::instruction::Instruction;

const BOND: u64 = STAKE / 5; // max(min stake / 5, 0.10 USDC)

fn disputed_by_creator() -> Flow {
    let mut f = Flow::rules(2, true); // pre-ruling: B wins
    f.to_preruled();
    ok(f.try_dispute(0, 1));
    f
}

#[test]
fn dispute_moves_bond_and_state() {
    let f = disputed_by_creator();
    let b = f.bet();
    assert_eq!(b.state, STATE_DISPUTED);
    assert_eq!(b.disputer, f.users[0].pubkey());
    assert_eq!(b.dispute_bond, BOND);
    assert_eq!(b.dispute_reason, 1);
    assert_eq!(f.env.token_balance(&f.vault()), 2 * STAKE + BOND);
    assert_eq!(f.balance(0), INITIAL_BALANCE - STAKE - BOND);
}

#[test]
fn dispute_failures() {
    let mut f = Flow::rules(2, true);
    f.to_preruled();
    assert_err(f.try_dispute(0, 0), VerdictError::BadReason);
    assert_err(f.try_dispute(0, 5), VerdictError::BadReason);
    let ixn = f.dispute_ix(0, 1, [9; 32]);
    let u = f.users[0].insecure_clone();
    assert_err(f.env.send(&[ixn], &[&u]), VerdictError::ConsentMismatch);
    let u1 = f.users[1].insecure_clone();
    ok(f.try_consent(&u1));
    assert_err(f.try_dispute(1, 1), VerdictError::AlreadyConsented);
    f.env.advance(CONSENT_WINDOW_S + 1);
    assert_err(f.try_dispute(0, 1), VerdictError::DeadlinePassed);
}

#[test]
fn panel_overturns_and_returns_bond() {
    let mut f = disputed_by_creator();
    // Outcome 1 = side 0 wins (the disputer was right).
    let meta = ok(f.try_settle_panel(1, 0, 2));
    println!("settle_panel CU = {}", meta.compute_units_consumed);
    let b = f.bet();
    assert_eq!(b.state, STATE_SETTLED);
    assert_eq!(b.settle_path, PATH_PANEL);
    assert_eq!(b.final_winner_mask, 0b01);
    assert_eq!(f.balance(0), INITIAL_BALANCE + STAKE);
    assert_eq!(f.balance(1), INITIAL_BALANCE - STAKE);
    assert!(!f.env.exists(&f.vault()));
    assert!(!f.env.exists(&f.tracks()));
}

#[test]
fn panel_upholds_and_bond_joins_pot() {
    let mut f = disputed_by_creator();
    ok(f.try_settle_panel(2, 2, 1));
    let b = f.bet();
    assert_eq!(b.final_winner_mask, 0b10);
    assert_eq!(f.balance(0), INITIAL_BALANCE - STAKE - BOND);
    assert_eq!(f.balance(1), INITIAL_BALANCE + STAKE + BOND);
}

#[test]
fn panel_no_contest_refunds_everyone_and_bond() {
    let mut f = disputed_by_creator();
    ok(f.try_settle_panel(0, 1, 2));
    let b = f.bet();
    assert_eq!(b.state, STATE_REFUNDED);
    assert_eq!(b.refund_reason, REFUND_NO_CONTEST);
    assert_eq!(f.balance(0), INITIAL_BALANCE);
    assert_eq!(f.balance(1), INITIAL_BALANCE);
}

#[test]
fn quorum_failures() {
    let mut f = disputed_by_creator();
    // The same judge twice.
    assert_err(f.try_settle_panel(1, 0, 0), VerdictError::InsufficientQuorum);
    // A non-judge signer.
    let msg = f.panel_message(1);
    let outsider = kp(77);
    let ed = f.ed25519_ix(&f.env.judges[0], &outsider, &msg);
    let s = f.settle_panel_ix(1);
    assert_err(f.env.send(&[ed, s], &[]), VerdictError::InsufficientQuorum);
    // Signatures over a different outcome.
    let msg2 = f.panel_message(2);
    let ed = f.ed25519_ix(&f.env.judges[0], &f.env.judges[1], &msg2);
    let s = f.settle_panel_ix(1);
    assert_err(f.env.send(&[ed, s], &[]), VerdictError::BadEd25519Instruction);
    // No Ed25519 instruction at all.
    let s = f.settle_panel_ix(1);
    assert_err(f.env.send(&[s], &[]), VerdictError::BadEd25519Instruction);
    // Ed25519 instruction not immediately before.
    let ed = f.ed25519_ix(&f.env.judges[0], &f.env.judges[1], &msg);
    let s = f.settle_panel_ix(1);
    let filler = solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_price(1);
    assert_err(f.env.send(&[ed, filler, s], &[]), VerdictError::BadEd25519Instruction);
    // Two Ed25519 instructions.
    let ed1 = f.ed25519_ix(&f.env.judges[0], &f.env.judges[1], &msg);
    let ed2 = f.ed25519_ix(&f.env.judges[1], &f.env.judges[2], &msg);
    let s = f.settle_panel_ix(1);
    assert_err(f.env.send(&[ed1, ed2, s], &[]), VerdictError::BadEd25519Instruction);
    // Tampered layout (offset field).
    let mut ed = f.ed25519_ix(&f.env.judges[0], &f.env.judges[1], &msg);
    ed.data[1] = 0; // still valid padding
    ed.data[2] = 63;
    let s = f.settle_panel_ix(1);
    assert_fails(f.env.send(&[ed, s], &[]));
    // Forged signature: the precompile rejects the transaction.
    let mut ed = f.ed25519_ix(&f.env.judges[0], &f.env.judges[1], &msg);
    ed.data[70] ^= 0xFF;
    let s = f.settle_panel_ix(1);
    let err = assert_fails(f.env.send(&[ed, s], &[]));
    assert!(!matches!(err, solana_sdk::transaction::TransactionError::InstructionError(1, _)), "{err:?}");
    // Outcome out of range.
    let msg3 = f.panel_message(3);
    let ed = f.ed25519_ix(&f.env.judges[0], &f.env.judges[1], &msg3);
    let s = f.settle_panel_ix(3);
    assert_err(f.env.send(&[ed, s], &[]), VerdictError::BadOutcome);
    // Still disputed; a valid quorum works.
    assert_eq!(f.bet().state, STATE_DISPUTED);
    ok(f.try_settle_panel(1, 1, 2));
}

#[test]
fn settle_panel_requires_disputed_and_correct_payout_accounts() {
    let mut f = Flow::rules(2, true);
    f.to_preruled();
    assert_err(f.try_settle_panel(1, 0, 1), VerdictError::InvalidState);
    ok(f.try_dispute(1, 4));
    // Swapped payout accounts.
    let msg = f.panel_message(1);
    let ed = f.ed25519_ix(&f.env.judges[0], &f.env.judges[1], &msg);
    let mut s: Instruction = f.settle_panel_ix(1);
    let n = s.accounts.len();
    s.accounts.swap(n - 1, n - 2);
    assert_err(f.env.send(&[ed, s], &[]), VerdictError::BadTokenAccount);
    // Missing payout account.
    let ed = f.ed25519_ix(&f.env.judges[0], &f.env.judges[1], &msg);
    let mut s = f.settle_panel_ix(1);
    s.accounts.pop();
    assert_err(f.env.send(&[ed, s], &[]), VerdictError::BadTokenAccount);
    ok(f.try_settle_panel(1, 0, 1));
    // Disputer was participant 1 and lost: bond returned? Pre-ruling was B (mask 0b10); panel says A ⇒ not upheld.
    assert_eq!(f.balance(0), INITIAL_BALANCE + STAKE);
    assert_eq!(f.balance(1), INITIAL_BALANCE - STAKE);
}
