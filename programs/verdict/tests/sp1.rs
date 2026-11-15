//! #14 `verify_sp1_run` under features `sp1` + `mock-zk` (§9.4, D-9, D-24; errata chainmodel).
//!
//! Needs a program built with both features:
//!   cargo build-sbf --manifest-path programs/verdict/Cargo.toml --features sp1,mock-zk --sbf-out-dir target/deploy-sp1
//!   cargo test -p verdict --features sp1,mock-zk --test sp1
//! The SP1 path is dropped for this build (errata [sp1-dropped]); these tests pin the
//! fail-closed stub's checks so it stays aligned with the TS chain model.
#![cfg(all(feature = "sp1", feature = "mock-zk"))]
#![allow(clippy::result_large_err)]
mod common;

use common::flow::*;
use common::*;

/// create → fund → start → end → post an SP1-only buffer (empty tracks part).
fn sp1_flow() -> Flow {
    let mut f = Flow::rules(2, true);
    f.spec.tracks_bin = vec![];
    f.to_tracks_posted();
    assert_eq!(f.bet().tracks_finalized, TRACKS_SP1_ONLY);
    f
}

/// Public values bound to the bet with the given ruling.
fn public_values(f: &Flow, preruling: u8, reason: u8, mask: u8, legs: [u8; 8]) -> Vec<u8> {
    let b = f.bet();
    let mut pv = Vec::with_capacity(171);
    pv.extend_from_slice(&b.program_hash);
    pv.extend_from_slice(&b.calibration_hash);
    pv.extend_from_slice(&b.perception_root);
    pv.extend_from_slice(&b.evidence_root);
    pv.extend_from_slice(&verdict::crypto::bio_hash(&b.bio[..b.n_bio as usize]));
    pv.extend_from_slice(&[preruling, reason, mask]);
    pv.extend_from_slice(&legs);
    assert_eq!(pv.len(), verdict::instructions::verify_sp1_run::SP1_PUBLIC_VALUES_LEN);
    pv
}

fn try_sp1(f: &mut Flow, pv: Vec<u8>) -> TxResult {
    let ixn = ix(
        verdict::instruction::VerifySp1Run { public_values: pv, proof: vec![1; 64] },
        verdict::accounts::VerifySp1Run { oracle: f.env.oracle.pubkey(), bet: f.bet },
        &[],
    );
    let o = f.env.oracle.insecure_clone();
    f.env.send(&[ixn], &[&o])
}

const LEGS: [u8; 8] = [1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

#[test]
fn winner_is_applied() {
    let mut f = sp1_flow();
    let pv = public_values(&f, PRERULING_WINNER, 0, 0b01, LEGS);
    ok(try_sp1(&mut f, pv));
    let b = f.bet();
    assert_eq!(b.state, STATE_PRERULED);
    assert_eq!(b.winner_mask, 0b01);
}

#[test]
fn needs_panel_is_applied() {
    let mut f = sp1_flow();
    let pv = public_values(&f, PRERULING_NEEDS_PANEL, 13, 0, [0xff; 8]);
    ok(try_sp1(&mut f, pv));
    let b = f.bet();
    assert_eq!(b.state, STATE_DISPUTED);
    assert_eq!(b.dispute_reason, 13);
}

#[test]
fn inconsistent_rulings_are_bad_proof() {
    let mut f = sp1_flow();
    let cases: &[(u8, u8, u8, [u8; 8])] = &[
        (PRERULING_WINNER, 1, 0b01, LEGS),         // WINNER with a nonzero reason
        (PRERULING_WINNER, 0, 0, LEGS),            // WINNER with an empty mask
        (PRERULING_WINNER, 0, 0b100, LEGS),        // mask beyond the participants
        (PRERULING_NEEDS_PANEL, 1, 0, LEGS),       // NEEDS_PANEL with a non-panel reason
        (PRERULING_NEEDS_PANEL, 14, 0, LEGS),      // reason out of range
        (PRERULING_NEEDS_PANEL, 10, 0b01, LEGS),   // NEEDS_PANEL with a mask
        (0, 0, 0, LEGS),                           // unknown preruling
        (2, 10, 0, LEGS),                          // unknown preruling
        (PRERULING_WINNER, 0, 0b01, [3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // leg_result 3
    ];
    for &(pre, reason, mask, legs) in cases {
        let pv = public_values(&f, pre, reason, mask, legs);
        assert_err(try_sp1(&mut f, pv), VerdictError::BadProof);
        assert_eq!(f.bet().state, STATE_PERCEIVING);
    }
}

#[test]
fn after_perception_timeout_is_rejected() {
    let mut f = sp1_flow();
    let deadline = f.bet().ended_at + PERCEPTION_TIMEOUT_S;
    let now = f.env.now();
    f.env.advance(deadline + 1 - now);
    let pv = public_values(&f, PRERULING_WINNER, 0, 0b01, LEGS);
    assert_err(try_sp1(&mut f, pv), VerdictError::DeadlinePassed);
    ok(f.try_refund());
    assert_eq!(f.bet().refund_reason, REFUND_PERCEPTION_TIMEOUT);
}

#[test]
fn at_exact_perception_deadline_is_allowed() {
    let mut f = sp1_flow();
    let deadline = f.bet().ended_at + PERCEPTION_TIMEOUT_S;
    let now = f.env.now();
    f.env.advance(deadline - now);
    assert_err(f.try_refund(), VerdictError::NotRefundable);
    let pv = public_values(&f, PRERULING_WINNER, 0, 0b01, LEGS);
    ok(try_sp1(&mut f, pv));
    assert_eq!(f.bet().state, STATE_PRERULED);
}
