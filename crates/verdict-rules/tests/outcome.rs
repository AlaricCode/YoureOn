//! Outcome condition (Kleene logic), winner_mask and pre-ruling (§3.10), via market legs.
mod common;
use common::*;

const H: [[u8; 32]; 3] = [[1; 32], [2; 32], [3; 32]];

/// Leg values: 0 False, 1 True, 2 Unknown (void).
fn eval(values: [u8; 3], cond: Vec<u8>, p: u8, side_b_mask: u8, if_true: u8) -> (u8, u8, u8) {
    let mut m = ProgramB::rules(vec![], (0..3).map(|i| LegB::market(i as u8 + 1, H[i], true)).collect(), 86_400);
    m.kind = 2;
    m.p = p;
    m.stakes = vec![1_000_000; p as usize];
    m.side_b_mask = side_b_mask;
    m.if_true = if_true;
    m.else_side = 1 - if_true;
    m.cond = cond;
    let entries: Vec<([u8; 32], u8)> = (0..3).map(|i| (H[i], values[i])).collect();
    let d = run(&m.encode(), &[], &market_bin(&entries), &[]).unwrap();
    assert_eq!(legs_of(&d), values.to_vec());
    (d.out.preruling, d.out.reason, d.out.winner_mask)
}

#[test]
fn kleene_truth_tables() {
    let a = || and(cond_leg(1), cond_leg(2));
    let o = || or(cond_leg(1), cond_leg(2));
    let n = || not(cond_leg(1));
    let truth = |c: Vec<u8>, x: u8, y: u8| -> u8 {
        let (pr, _, mask) = eval([x, y, 1], c, 2, 0b10, 1);
        match (pr, mask) {
            (1, 0b10) => 1,
            (1, 0b01) => 0,
            (3, 0) => 2,
            other => panic!("{other:?}"),
        }
    };
    // and
    for (x, y, r) in [(0, 0, 0), (0, 1, 0), (0, 2, 0), (2, 0, 0), (1, 1, 1), (1, 2, 2), (2, 2, 2)] {
        assert_eq!(truth(a(), x, y), r, "and({x},{y})");
    }
    // or
    for (x, y, r) in [(1, 0, 1), (1, 2, 1), (2, 1, 1), (0, 0, 0), (0, 2, 2), (2, 2, 2)] {
        assert_eq!(truth(o(), x, y), r, "or({x},{y})");
    }
    // not
    for (x, r) in [(0, 1), (1, 0), (2, 2)] {
        assert_eq!(truth(n(), x, 1), r, "not({x})");
    }
}

#[test]
fn unknown_outcome_is_low_confidence_panel() {
    assert_eq!(eval([2, 1, 1], cond_leg(1), 2, 0b10, 0), (3, 10, 0));
}

#[test]
fn winner_mask_multi_participant() {
    // 4 participants, sides [0,1,0,1] → side_b_mask 0b1010.
    assert_eq!(eval([1, 1, 1], cond_leg(1), 4, 0b1010, 1), (1, 0, 0b1010));
    assert_eq!(eval([0, 1, 1], cond_leg(1), 4, 0b1010, 1), (1, 0, 0b0101));
    assert_eq!(eval([1, 1, 1], or(cond_leg(3), not(cond_leg(2))), 4, 0b1000, 0), (1, 0, 0b0111));
}
