//! Settlement math (§9.8).
use verdict_rules::settle::*;
use verdict_rules::SettleError;

#[test]
fn even_split_two_players() {
    let s = [5_000_000u64, 5_000_000];
    let p = settle_payouts(&s, 0b11, 0b10, 0, false, None).unwrap();
    assert_eq!(&p[..2], &[0, 10_000_000]);
}

#[test]
fn proportional_with_remainder_to_lowest_winner() {
    // pot = 10 + 10 + 10 = 30 (+ bond 7 upheld = 37); winners 0 and 2 with stakes 10 and 10 → SW 20.
    let s = [10u64, 10, 10];
    let p = settle_payouts(&s, 0b111, 0b101, 7, true, Some(1)).unwrap();
    // 37·10/20 = 18 each, rem 1 → participant 0.
    assert_eq!(&p[..3], &[19, 0, 18]);
    // Uneven stakes: 7 and 3 winners, pot 7+3+5 = 15: 15·7/10 = 10, 15·3/10 = 4, rem 1.
    let s = [7u64, 5, 3];
    let p = settle_payouts(&s, 0b111, 0b101, 0, false, None).unwrap();
    assert_eq!(&p[..3], &[11, 0, 4]);
    assert_eq!(p.iter().sum::<u64>(), 15);
}

#[test]
fn bond_not_upheld_returns_to_disputer() {
    let s = [1_000_000u64, 1_000_000];
    let bond = dispute_bond(&s);
    assert_eq!(bond, 200_000);
    let p = settle_payouts(&s, 0b11, 0b01, bond, false, Some(1)).unwrap();
    assert_eq!(&p[..2], &[2_000_000, 200_000]);
    let p = settle_payouts(&s, 0b11, 0b01, bond, true, Some(1)).unwrap();
    assert_eq!(&p[..2], &[2_200_000, 0]);
    assert_eq!(dispute_bond(&[10_000, 1_000_000]), 100_000); // DISPUTE_BOND_MIN
}

#[test]
fn max_stakes_need_u128() {
    let m = 1_000_000_000_000u64;
    let s = [m; 8];
    let p = settle_payouts(&s, 0xFF, 0b0000_0111, 0, false, None).unwrap();
    // pot 8e12, SW 3e12 → each floor(8e12·1e12/3e12) = 2_666_666_666_666, rem 2.
    assert_eq!(p[0], 2_666_666_666_668);
    assert_eq!(p[1], 2_666_666_666_666);
    assert_eq!(p.iter().sum::<u64>(), 8 * m);
}

#[test]
fn refunds_and_dust() {
    let s = [5u64, 6, 7];
    let mut p = refund_payouts(&s, 0b011, 4, Some(2)).unwrap();
    assert_eq!(&p[..3], &[5, 6, 4]);
    assert_eq!(apply_dust(&mut p, 18, 0).unwrap(), 3);
    assert_eq!(&p[..3], &[8, 6, 4]);
    assert_eq!(apply_dust(&mut p, 1, 0), Err(SettleError::MathOverflow));
    assert_eq!(lowest_winner(0b0110), Some(1));
    assert_eq!(lowest_winner(0), None);
}

#[test]
fn bad_outcomes() {
    let s = [5u64, 6];
    assert_eq!(settle_payouts(&s, 0b11, 0, 0, false, None), Err(SettleError::BadOutcome));
    assert_eq!(settle_payouts(&s, 0b11, 0b100, 0, false, None), Err(SettleError::BadOutcome));
    assert_eq!(settle_payouts(&s, 0b11, 0b01, 5, false, None), Err(SettleError::BadOutcome));
    assert_eq!(settle_payouts(&[], 0, 1, 0, false, None), Err(SettleError::BadOutcome));
}
