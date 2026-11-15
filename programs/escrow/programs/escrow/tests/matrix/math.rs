//! ESCROW §9.2 payout-math rows M1–M6 (§6 `compute_payout`, onchain and pure). Uses only `common`
//! helpers and `escrow::payout`. Onchain cases send the bundled `[terminal ix, close_bet]` and
//! apply the §9.1 global post-conditions; pure cases call `compute_payout` directly.

use crate::common::*;
use escrow::{
    payout::{compute_payout, PayoutKind},
    Outcome, MAX_STAKE_CEILING,
};

const ALL_OUTCOMES: [Outcome; 4] = [
    Outcome::PartyA,
    Outcome::PartyB,
    Outcome::Split,
    Outcome::Refund,
];

/// Every §6 formula (`PayoutKind`), i.e. every `Outcome` plus the two refund kinds.
const ALL_KINDS: [PayoutKind; 6] = [
    PayoutKind::OpenRefund,
    PayoutKind::LockedRefund,
    PayoutKind::Ruled(Outcome::PartyA),
    PayoutKind::Ruled(Outcome::PartyB),
    PayoutKind::Ruled(Outcome::Split),
    PayoutKind::Ruled(Outcome::Refund),
];

/// Deterministic SplitMix64 (no `rand` dev-dependency; a fixed seed keeps failures replayable).
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform-ish in `[lo, hi]` (modulo bias is irrelevant here).
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
}

/// The §6 contract for one input, checked against the formula's definition per kind:
/// `to_a + to_b == v` always; PartyA `(v, 0)`; PartyB `(0, v)`; OpenRefund `(v, 0)`;
/// Split `b − a ∈ {0, 1}` (odd unit to B); Refund / LockedRefund `(min(stake_a, v), rest)`.
#[track_caller]
fn check_contract(kind: PayoutKind, stake_a: u64, v: u64) -> (u64, u64) {
    let (a, b) = compute_payout(kind, stake_a, v);
    assert_eq!(
        a.checked_add(b),
        Some(v),
        "{kind:?} stake_a={stake_a} v={v}: to_a + to_b == V"
    );
    match kind {
        PayoutKind::OpenRefund | PayoutKind::Ruled(Outcome::PartyA) => assert_eq!((a, b), (v, 0)),
        PayoutKind::Ruled(Outcome::PartyB) => assert_eq!((a, b), (0, v)),
        PayoutKind::Ruled(Outcome::Split) => {
            assert!(b >= a && b - a <= 1, "Split {a}/{b}: diff ≤ 1, favors B");
            assert_eq!(a, v / 2);
        }
        PayoutKind::Ruled(Outcome::Refund) | PayoutKind::LockedRefund => {
            assert_eq!(a, stake_a.min(v), "Refund: A gets own stake (saturating)");
        }
    }
    (a, b)
}

/// Resets A's and B's USDC balances to `FUNDED` so long property loops never run dry.
fn top_up(env: &mut Env) {
    let (a, b) = (env.a_token, env.b_token);
    env.set_token_amount(a, FUNDED);
    env.set_token_amount(b, FUNDED);
}

/// Onchain: `stake_a / stake_b` bet resolved with `outcome`, `excess` units donated by Mallory,
/// clock at `appeal_deadline`, then bundled `[finalize, close_bet]`. Asserts the §9.1 bundled
/// post-conditions with amounts from the program's own §6 function and returns `(to_a, to_b)`.
#[track_caller]
fn finalize_case(
    env: &mut Env,
    id: [u8; 16],
    stake_a: u64,
    stake_b: u64,
    outcome: Outcome,
    excess: u64,
) -> (u64, u64) {
    top_up(env);
    env.resolved_bet_with(id, stake_a, stake_b, outcome);
    if excess > 0 {
        assert_ok(&env.donate_to_vault(&id, excess));
    }
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(env, &id);
    assert_eq!(before.v, stake_a + stake_b + excess);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::from_math(
        TerminalKind::Finalized,
        outcome,
        PayoutKind::Ruled(outcome),
        &before,
    );
    check_contract(PayoutKind::Ruled(outcome), stake_a, before.v);
    let ev = assert_terminal_postconditions_bundled(env, &before, sent, &exp);
    (ev.to_a, ev.to_b)
}

/// Onchain: Locked `stake_a / stake_b` bet (+ `excess`), clock at `resolve_deadline`, bundled
/// `[timeout_refund, close_bet]` (§6 `LockedRefund`).
#[track_caller]
fn locked_timeout_case(env: &mut Env, id: [u8; 16], stake_a: u64, stake_b: u64, excess: u64) {
    top_up(env);
    env.locked_bet_with(id, stake_a, stake_b);
    if excess > 0 {
        assert_ok(&env.donate_to_vault(&id, excess));
    }
    env.warp_to_resolve_deadline(&id);
    let before = Snapshot::take(env, &id);
    let res = env.timeout_refund_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::from_math(
        TerminalKind::Refunded,
        Outcome::Refund,
        PayoutKind::LockedRefund,
        &before,
    );
    assert_eq!((exp.to_a, exp.to_b), (stake_a, stake_b + excess));
    assert_terminal_postconditions_bundled(env, &before, sent, &exp);
}

/// Onchain: Open `stake_a / stake_b` bet (+ `excess`), bundled `[cancel_open_bet (A),
/// close_bet]` (§6 `OpenRefund`: everything to A).
#[track_caller]
fn open_cancel_case(env: &mut Env, id: [u8; 16], stake_a: u64, stake_b: u64, excess: u64) {
    top_up(env);
    let (mut c, ca) = env.default_create(id);
    c.stake_a = stake_a;
    c.stake_b = stake_b;
    assert_ok(&env.create_bet(&c, &ca));
    if excess > 0 {
        assert_ok(&env.donate_to_vault(&id, excess));
    }
    let before = Snapshot::take(env, &id);
    let a = env.a.insecure_clone();
    let res = env.cancel_open_bet_bundled(&id, &a);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(
        TerminalKind::Cancelled,
        Outcome::Refund,
        stake_a + excess,
        0,
    );
    assert_terminal_postconditions_bundled(env, &before, sent, &exp);
}

// ---------------------------------------------------------------------------------------------
// M1–M4: the §6 table through the program
// ---------------------------------------------------------------------------------------------

/// M1: Split 3_000_001 / 2_000_000 → 2_500_000 / 2_500_001 (odd unit to B), onchain and pure.
#[test]
fn m1_split_odd_pot() {
    assert_eq!(
        compute_payout(PayoutKind::Ruled(Outcome::Split), 3_000_001, 5_000_001),
        (2_500_000, 2_500_001)
    );
    let mut env = Env::with_config();
    let got = finalize_case(&mut env, bet_id(1), 3_000_001, 2_000_000, Outcome::Split, 0);
    assert_eq!(got, (2_500_000, 2_500_001));
}

/// M2: Split vs Refund on 6_200_000 / 3_800_000 → 5M / 5M vs 6.2M / 3.8M, onchain and pure.
#[test]
fn m2_split_vs_refund_uneven_stakes() {
    assert_eq!(
        compute_payout(PayoutKind::Ruled(Outcome::Split), 6_200_000, 10_000_000),
        (5_000_000, 5_000_000)
    );
    assert_eq!(
        compute_payout(PayoutKind::Ruled(Outcome::Refund), 6_200_000, 10_000_000),
        (6_200_000, 3_800_000)
    );
    let mut env = Env::with_config();
    let split = finalize_case(&mut env, bet_id(1), 6_200_000, 3_800_000, Outcome::Split, 0);
    let refund = finalize_case(
        &mut env,
        bet_id(2),
        6_200_000,
        3_800_000,
        Outcome::Refund,
        0,
    );
    assert_eq!(split, (5_000_000, 5_000_000));
    assert_eq!(refund, (6_200_000, 3_800_000));
}

/// M3: Mallory donates 7 units to the vault before finalize (Split, 5M / 5M) → ok;
/// 5_000_003 / 5_000_004; vault closed (bundled, TM-L5: excess is paid out, never stranded).
/// The §6 table's Refund variant of the same donation (5_000_000 / 5_000_007) is checked too.
#[test]
fn m3_donation_before_finalize_split() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    let m_before = env.token_balance(&env.mallory_token);
    let got = finalize_case(&mut env, id, USDC_5, USDC_5, Outcome::Split, 7);
    assert_eq!(got, (5_000_003, 5_000_004));
    assert!(!env.exists(&vault_pda(&id).0), "vault closed");
    assert!(!env.exists(&bet_pda(&id).0), "bet closed");
    assert_eq!(env.token_balance(&env.mallory_token), m_before - 7);

    let refund = finalize_case(&mut env, bet_id(2), USDC_5, USDC_5, Outcome::Refund, 7);
    assert_eq!(refund, (5_000_000, 5_000_007));
}

/// M4: max stakes 20M / 20M, every outcome → `to_a + to_b == V` (= 40M), onchain for each
/// `Outcome` via finalize, plus the Locked timeout and Open cancel refunds; pure for every kind.
#[test]
fn m4_max_stakes_every_outcome_sums_to_v() {
    let mut env = Env::with_config();
    assert_eq!(env.config().max_stake, MAX_STAKE, "test config max_stake");
    let v = 2 * MAX_STAKE;
    for kind in ALL_KINDS {
        let (a, b) = check_contract(kind, MAX_STAKE, v);
        assert_eq!(a + b, v, "{kind:?}");
    }
    let want = |o: Outcome| match o {
        Outcome::PartyA => (v, 0),
        Outcome::PartyB => (0, v),
        Outcome::Split | Outcome::Refund => (MAX_STAKE, MAX_STAKE),
    };
    for (n, outcome) in (1u8..).zip(ALL_OUTCOMES) {
        let got = finalize_case(&mut env, bet_id(n), MAX_STAKE, MAX_STAKE, outcome, 0);
        assert_eq!(got.0 + got.1, v, "{outcome:?}");
        assert_eq!(got, want(outcome), "{outcome:?}");
    }
    locked_timeout_case(&mut env, bet_id(10), MAX_STAKE, MAX_STAKE, 0);
    open_cancel_case(&mut env, bet_id(11), MAX_STAKE, MAX_STAKE, 0);
}

// ---------------------------------------------------------------------------------------------
// M5: compute_payout properties (pure exhaustive + random) and the same properties onchain
// ---------------------------------------------------------------------------------------------

/// M5 (pure, exhaustive): every kind, `stake_a, stake_b ≤ 50` (0 included: the function is
/// total even for inputs `create_bet` rejects), excess ≤ 3 → `to_a + to_b == V`; Split
/// difference ≤ 1 and favors B; Refund returns each stake with the excess to B.
#[test]
fn m5_compute_payout_exhaustive_small() {
    let mut cases = 0u32;
    for stake_a in 0..=50u64 {
        for stake_b in 0..=50u64 {
            for excess in 0..=3u64 {
                let v = stake_a + stake_b + excess;
                for kind in ALL_KINDS {
                    let (a, b) = check_contract(kind, stake_a, v);
                    if matches!(
                        kind,
                        PayoutKind::Ruled(Outcome::Refund) | PayoutKind::LockedRefund
                    ) {
                        assert_eq!((a, b), (stake_a, stake_b + excess));
                    }
                    cases += 1;
                }
                // OpenRefund sees only A's deposit (+ excess) in the vault.
                check_contract(PayoutKind::OpenRefund, stake_a, stake_a + excess);
            }
        }
    }
    assert_eq!(cases, 51 * 51 * 4 * 6);
}

/// M5 (pure, random): 10k seeded cases with stakes in `[1, max_stake]` and excess in `[0, 3]`,
/// every kind; then 10k more up to `MAX_STAKE_CEILING` (the largest `max_stake` a config can
/// hold) with arbitrary excess that still fits `u64` → same properties, no overflow.
#[test]
fn m5_compute_payout_random_up_to_max_stake() {
    let mut rng = SplitMix64(0x5EED_E5C2_0000_0005);
    for _ in 0..10_000 {
        let stake_a = rng.range(1, MAX_STAKE);
        let stake_b = rng.range(1, MAX_STAKE);
        let excess = rng.range(0, 3);
        let v = stake_a + stake_b + excess;
        for kind in ALL_KINDS {
            let (a, b) = check_contract(kind, stake_a, v);
            if kind == PayoutKind::Ruled(Outcome::Refund) || kind == PayoutKind::LockedRefund {
                assert_eq!((a, b), (stake_a, stake_b + excess));
            }
        }
    }
    for _ in 0..10_000 {
        let stake_a = rng.range(1, MAX_STAKE_CEILING);
        let stake_b = rng.range(1, MAX_STAKE_CEILING);
        let deposited = stake_a + stake_b; // ≤ u64::MAX / 2
        let excess = rng.range(0, u64::MAX - deposited);
        let v = deposited + excess;
        for kind in ALL_KINDS {
            check_contract(kind, stake_a, v);
        }
    }
}

/// M5 (onchain property loop): for a set of stake pairs (boundaries, the §6 table's pairs and
/// seeded random pairs in `[1, max_stake]`), every `Outcome` with excess 0 and 3 via bundled
/// finalize, plus the Locked timeout refund and the Open cancel refund. Each payout equals the
/// program's own `compute_payout` and passes every §9.1 bundled post-condition (`Δa + Δb == V`,
/// money only to A/B, accounts closed, rent to S).
#[test]
fn m5_onchain_payouts_match_compute_payout_for_stake_pairs() {
    let mut rng = SplitMix64(0x0DD5_B0B5);
    let mut pairs: Vec<(u64, u64)> = vec![
        (1, 1),
        (1, 2),
        (2, 1),
        (3, 3),
        (USDC_5, USDC_5),
        (3_000_001, 2_000_000),
        (6_200_000, 3_800_000),
        (MAX_STAKE, 1),
        (1, MAX_STAKE),
        (MAX_STAKE, MAX_STAKE),
    ];
    for _ in 0..3 {
        pairs.push((rng.range(1, MAX_STAKE), rng.range(1, MAX_STAKE)));
    }
    let mut env = Env::with_config();
    let mut n: u8 = 0;
    let mut next_id = || {
        n = n.checked_add(1).expect("bet_id space");
        bet_id(n)
    };
    for &(stake_a, stake_b) in &pairs {
        for outcome in ALL_OUTCOMES {
            for excess in [0u64, 3] {
                let id = next_id();
                let got = finalize_case(&mut env, id, stake_a, stake_b, outcome, excess);
                let v = stake_a + stake_b + excess;
                assert_eq!(
                    got,
                    compute_payout(PayoutKind::Ruled(outcome), stake_a, v),
                    "{outcome:?} {stake_a}/{stake_b} +{excess}"
                );
            }
        }
        let id = next_id();
        locked_timeout_case(&mut env, id, stake_a, stake_b, 1);
        let id = next_id();
        open_cancel_case(&mut env, id, stake_a, stake_b, 1);
    }
    // Mallory's donations are the only tokens that left her account.
    let donated = pairs.len() as u64 * (ALL_OUTCOMES.len() as u64 * 3 + 2);
    assert_eq!(env.token_balance(&env.mallory_token), FUNDED - donated);
}

// ---------------------------------------------------------------------------------------------
// M6: saturating refund
// ---------------------------------------------------------------------------------------------

/// M6 (pure): `compute_payout(Refund / LockedRefund, stake_a, v)` with `v < stake_a` → `(v, 0)`;
/// never panics (exhaustive for `stake_a ≤ 200`, then boundaries up to `u64::MAX`).
#[test]
fn m6_refund_saturates_when_vault_short() {
    let kinds = [PayoutKind::Ruled(Outcome::Refund), PayoutKind::LockedRefund];
    for stake_a in 1..=200u64 {
        for v in 0..stake_a {
            for kind in kinds {
                assert_eq!(compute_payout(kind, stake_a, v), (v, 0), "{kind:?}");
            }
        }
    }
    for stake_a in [
        2,
        USDC_5,
        MAX_STAKE,
        MAX_STAKE_CEILING,
        u64::MAX - 1,
        u64::MAX,
    ] {
        for v in [0, 1, stake_a / 2, stake_a - 1] {
            for kind in kinds {
                let r = std::panic::catch_unwind(|| compute_payout(kind, stake_a, v));
                assert_eq!(r.ok(), Some((v, 0)), "{kind:?} stake_a={stake_a} v={v}");
            }
        }
    }
}

/// M6 (onchain): a forced impossible state (`set_account`: vault = `stake_a − 1` on a
/// `Resolved(Refund)` bet, and on an `Appealed` bet ruled `Refund`) still drains: A gets V,
/// B gets 0, the vault closes (TM-L6: the exit is not bricked by its own math).
#[test]
fn m6_onchain_short_vault_refund_not_bricked() {
    let mut env = Env::with_config();
    let short = USDC_5 - 1;

    let id = bet_id(1);
    env.resolved_bet(id, Outcome::Refund);
    env.set_token_amount(vault_pda(&id).0, short);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    assert_eq!(before.v, short);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::Refund, short, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);

    let id = bet_id(2);
    env.appealed_bet(id, Outcome::PartyA);
    env.set_token_amount(vault_pda(&id).0, short);
    let before = Snapshot::take(&env, &id);
    let res = env.resolve_appeal_bundled(&id, Outcome::Refund);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::Refund, short, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
}
