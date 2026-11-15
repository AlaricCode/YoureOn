//! ESCROW §9.2 appeal rows: P1–P6 (appeal) and RA1–RA8 (resolve_appeal). Uses only `common`
//! helpers. Every terminal-path `resolve_appeal` test applies the §9.1 global post-conditions
//! (`assert_terminal_postconditions_bundled` / `_standalone`); every rejected instruction is
//! also checked to have changed nothing (Bet bytes, vault and party balances).

use escrow::{
    payout::PayoutKind, AppealResolved, Bet, BetAppealed, BetStatus, EscrowError, Outcome,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::common::*;

const ALL_OUTCOMES: [Outcome; 4] = [
    Outcome::PartyA,
    Outcome::PartyB,
    Outcome::Split,
    Outcome::Refund,
];

/// Bet, vault amount and the three tracked token balances, for "nothing changed" checks.
#[derive(Debug, PartialEq, Eq)]
struct Frozen {
    bet: Bet,
    vault: u64,
    a: u64,
    b: u64,
    mallory: u64,
}

fn freeze(env: &Env, id: &[u8; 16]) -> Frozen {
    Frozen {
        bet: env.bet(id),
        vault: env.token_balance(&vault_pda(id).0),
        a: env.token_balance(&env.a_token),
        b: env.token_balance(&env.b_token),
        mallory: env.token_balance(&env.mallory_token),
    }
}

#[track_caller]
fn assert_unchanged(env: &Env, id: &[u8; 16], before: &Frozen) {
    assert_eq!(&freeze(env, id), before, "a rejected ix changed state");
}

/// A successful `appeal` by `appellant` on a `Resolved(outcome)` bet: Appealed, timestamps set,
/// exactly one `BetAppealed` with the right fields, no tokens moved, nothing else in the Bet
/// changed (TM-O: appeal moves no money).
#[track_caller]
fn assert_appeal_ok(
    env: &Env,
    id: &[u8; 16],
    before: &Frozen,
    res: &SendResult,
    appellant: &Keypair,
    outcome: Outcome,
) {
    let sent = assert_ok(res);
    let now = env.now();
    let bet = env.bet(id);
    assert_eq!(bet.status, BetStatus::Appealed);
    assert_eq!(
        bet.outcome,
        Some(outcome),
        "appeal keeps the stored outcome"
    );
    assert_eq!(bet.appealed_at, now);
    assert_eq!(bet.appeal_resolve_deadline, now + APPEAL_RESOLVE_SECS);
    // Only status / appealed_at / appeal_resolve_deadline differ from before.
    let expected = Bet {
        status: BetStatus::Appealed,
        appealed_at: now,
        appeal_resolve_deadline: now + APPEAL_RESOLVE_SECS,
        ..before.bet.clone()
    };
    assert_eq!(bet, expected);
    assert_rederives(&bet, &bet_pda(id).0, &vault_pda(id).0);
    // No tokens moved.
    assert_eq!(env.token_balance(&vault_pda(id).0), before.vault);
    assert_eq!(env.token_balance(&env.a_token), before.a);
    assert_eq!(env.token_balance(&env.b_token), before.b);
    assert_eq!(env.token_balance(&env.mallory_token), before.mallory);

    let evs = events::<BetAppealed>(sent);
    assert_eq!(
        (evs.len(), event_count(sent)),
        (1, 1),
        "exactly one BetAppealed"
    );
    let e = &evs[0];
    assert_eq!(e.bet_id, *id);
    assert_eq!(e.appellant, appellant.pubkey());
    assert_eq!(e.original_outcome, outcome);
    assert_eq!(e.appeal_resolve_deadline, now + APPEAL_RESOLVE_SECS);
    assert_eq!(e.ts, now);
    assert_no_log_truncation(sent);
}

/// The AppealResolved-specific fields (§7.2) of the single event in `sent`.
#[track_caller]
fn assert_appeal_resolved_extras(sent: &Sent, original: Outcome, final_outcome: Outcome) {
    let evs = events::<AppealResolved>(sent);
    assert_eq!(evs.len(), 1);
    let e = &evs[0];
    assert_eq!(e.original_outcome, original);
    assert_eq!(e.outcome, final_outcome);
    assert_eq!(e.appeal_ruling_hash, APPEAL_RULING);
    assert_eq!(e.overturned, original != final_outcome);
}

// ---------------------------------------------------------------------------------------------
// appeal: P1–P6
// ---------------------------------------------------------------------------------------------

/// P1: the loser appeals within the window → ok; Appealed;
/// `appeal_resolve_deadline = now + 300`; `BetAppealed`. Checked for both decisive outcomes,
/// at the last second of the half-open window `[resolved_at, appeal_deadline)` (I10).
#[test]
fn p1_loser_appeals_within_window() {
    let mut env = Env::with_config();
    for (n, outcome) in [(1u8, Outcome::PartyA), (2, Outcome::PartyB)] {
        let id = bet_id(n);
        env.set_now(NOW);
        env.resolved_bet(id, outcome);
        // Last valid instant: appeal_deadline − 1.
        let t = env.bet(&id).appeal_deadline - 1;
        env.set_now(t);
        let loser = env.loser(outcome);
        let before = freeze(&env, &id);
        let res = env.appeal(&id, &loser);
        assert_appeal_ok(&env, &id, &before, &res, &loser, outcome);
        assert_eq!(env.bet(&id).appeal_resolve_deadline, t + 300);
    }
    // Early in the window too (4 s after resolve).
    let id = bet_id(3);
    env.set_now(NOW + 1_000);
    env.resolved_bet(id, Outcome::PartyA);
    env.advance(4);
    let b = env.b.insecure_clone();
    let before = freeze(&env, &id);
    let res = env.appeal(&id, &b);
    assert_appeal_ok(&env, &id, &before, &res, &b, Outcome::PartyA);
    assert_eq!(env.bet(&id).appeal_resolve_deadline, NOW + 1_004 + 300);
}

/// P2: the winner appeals → `[NotLoser]` (A on PartyA, B on PartyB); nothing changes.
#[test]
fn p2_winner_appeals_fails_not_loser() {
    let mut env = Env::with_config();
    for (n, outcome) in [(1u8, Outcome::PartyA), (2, Outcome::PartyB)] {
        let id = bet_id(n);
        env.resolved_bet(id, outcome);
        let winner = env.winner(outcome);
        let before = freeze(&env, &id);
        let res = env.appeal(&id, &winner);
        assert_escrow_err(&res, EscrowError::NotLoser);
        assert_unchanged(&env, &id, &before);
        // The real loser can still appeal afterwards.
        let loser = env.loser(outcome);
        let res = env.appeal(&id, &loser);
        assert_appeal_ok(&env, &id, &before, &res, &loser, outcome);
    }
}

/// P3: appeal after the window (`now = appeal_deadline`, and later) → `[AppealWindowClosed]`;
/// nothing changes, and `finalize` is the exit (I10: no overlap at the boundary).
#[test]
fn p3_appeal_after_window_fails() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let b = env.b.insecure_clone();
    env.warp_to_appeal_deadline(&id);
    assert_eq!(env.now(), NOW + APPEAL_WINDOW_SECS);
    let before = freeze(&env, &id);
    assert_escrow_err(&env.appeal(&id, &b), EscrowError::AppealWindowClosed);
    assert_unchanged(&env, &id, &before);
    env.advance(1_000);
    assert_escrow_err(&env.appeal(&id, &b), EscrowError::AppealWindowClosed);
    assert_unchanged(&env, &id, &before);
    // Split outcome: either party is a loser, still closed at the boundary.
    let id2 = bet_id(2);
    env.set_now(NOW);
    env.resolved_bet(id2, Outcome::Split);
    env.warp_to_appeal_deadline(&id2);
    let a = env.a.insecure_clone();
    let before2 = freeze(&env, &id2);
    assert_escrow_err(&env.appeal(&id2, &a), EscrowError::AppealWindowClosed);
    assert_escrow_err(&env.appeal(&id2, &b), EscrowError::AppealWindowClosed);
    assert_unchanged(&env, &id2, &before2);
}

/// P4: a second appeal → `[InvalidStatus]` (the bet is already Appealed), by the same loser and,
/// on a Split outcome, by the other party; nothing changes.
#[test]
fn p4_second_appeal_fails_invalid_status() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.appealed_bet(id, Outcome::PartyA);
    let b = env.b.insecure_clone();
    let before = freeze(&env, &id);
    env.advance(1);
    assert_escrow_err(&env.appeal(&id, &b), EscrowError::InvalidStatus);
    assert_unchanged(&env, &id, &before);

    let id2 = bet_id(2);
    env.appealed_bet(id2, Outcome::Split); // A appealed
    let before2 = freeze(&env, &id2);
    let a = env.a.insecure_clone();
    assert_escrow_err(&env.appeal(&id2, &b), EscrowError::InvalidStatus);
    assert_escrow_err(&env.appeal(&id2, &a), EscrowError::InvalidStatus);
    assert_unchanged(&env, &id2, &before2);
}

/// P5: Split outcome: A appeals → ok; Refund outcome: B appeals → ok (P5: both parties count as
/// losers for Split / Refund). The mirrored pairs (Split/B, Refund/A) are also ok.
#[test]
fn p5_split_and_refund_either_party_may_appeal() {
    let mut env = Env::with_config();
    let a = env.a.insecure_clone();
    let b = env.b.insecure_clone();
    let cases: [(u8, Outcome, &Keypair); 4] = [
        (1, Outcome::Split, &a),
        (2, Outcome::Refund, &b),
        (3, Outcome::Split, &b),
        (4, Outcome::Refund, &a),
    ];
    for (n, outcome, who) in cases {
        let id = bet_id(n);
        env.resolved_bet(id, outcome);
        env.advance(2);
        let before = freeze(&env, &id);
        let res = env.appeal(&id, who);
        assert_appeal_ok(&env, &id, &before, &res, who, outcome);
    }
}

/// P6: Mallory appeals → `[NotParty]`, for every outcome (even Split / Refund, where both
/// parties are losers); nothing changes.
#[test]
fn p6_mallory_appeals_fails_not_party() {
    let mut env = Env::with_config();
    let m = env.mallory.insecure_clone();
    for (n, outcome) in (1u8..).zip(ALL_OUTCOMES) {
        let id = bet_id(n);
        env.resolved_bet(id, outcome);
        let before = freeze(&env, &id);
        assert_escrow_err(&env.appeal(&id, &m), EscrowError::NotParty);
        // Mallory as both fee payer and appellant: same result.
        let ix = env.ix_appeal(&AppealAccts {
            payer: m.pubkey(),
            appellant: m.pubkey(),
            bet: bet_pda(&id).0,
        });
        assert_escrow_err(&env.send(&[ix], &m, &[]), EscrowError::NotParty);
        assert_unchanged(&env, &id, &before);
    }
}

// ---------------------------------------------------------------------------------------------
// resolve_appeal: RA1–RA8
// ---------------------------------------------------------------------------------------------

/// RA1: upheld → ok; `overturned = false`; payout per the original outcome. Every outcome,
/// bundled with `close_bet` (§9.1 bundled post-conditions).
#[test]
fn ra1_upheld_pays_original_outcome() {
    let mut env = Env::with_config();
    for (n, outcome) in (1u8..).zip(ALL_OUTCOMES) {
        let id = bet_id(n);
        env.appealed_bet(id, outcome);
        env.advance(30);
        let before = Snapshot::take(&env, &id);
        let res = env.resolve_appeal_bundled(&id, outcome);
        let sent = assert_ok(&res);
        let exp = ExpectTerminal::from_math(
            TerminalKind::AppealResolved,
            outcome,
            PayoutKind::Ruled(outcome),
            &before,
        );
        let want = match outcome {
            Outcome::PartyA => (2 * USDC_5, 0),
            Outcome::PartyB => (0, 2 * USDC_5),
            Outcome::Split | Outcome::Refund => (USDC_5, USDC_5),
        };
        assert_eq!((exp.to_a, exp.to_b), want, "{outcome:?}");
        assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
        assert_appeal_resolved_extras(sent, outcome, outcome);
    }
}

/// RA1 (standalone shape): upheld PartyA without `close_bet`: the Bet persists `Settled` with
/// `outcome = PartyA` and an empty vault; every other terminal ix now fails `[InvalidStatus]`.
#[test]
fn ra1_upheld_standalone_settles() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.appealed_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let res = env.resolve_appeal(&id, Outcome::PartyA);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);
    assert_appeal_resolved_extras(sent, Outcome::PartyA, Outcome::PartyA);
    assert_eq!(env.bet(&id).outcome, Some(Outcome::PartyA));
}

/// RA2: overturned PartyA → PartyB → ok; B gets V; `overturned = true`. Bundled, then the same
/// ruling standalone (stored `outcome` is the final one).
#[test]
fn ra2_overturned_party_a_to_party_b() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.appealed_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let res = env.resolve_appeal_bundled(&id, Outcome::PartyB);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::PartyB, 0, 2 * USDC_5);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(before.delta(&env, &env.b_token), i128::from(before.v));
    assert_eq!(ev.party_b_token, env.b_token);
    assert_eq!(ev.party_a_token, anchor_lang::prelude::Pubkey::default());
    assert_appeal_resolved_extras(sent, Outcome::PartyA, Outcome::PartyB);

    let id2 = bet_id(2);
    env.appealed_bet(id2, Outcome::PartyA);
    let before2 = Snapshot::take(&env, &id2);
    let res2 = env.resolve_appeal(&id2, Outcome::PartyB);
    let sent2 = assert_ok(&res2);
    assert_terminal_postconditions_standalone(&mut env, &before2, sent2, &exp);
    assert_appeal_resolved_extras(sent2, Outcome::PartyA, Outcome::PartyB);
    let bet = env.bet(&id2);
    assert_eq!(bet.outcome, Some(Outcome::PartyB), "final outcome stored");
    // The judge's hashes are kept (the appeal ruling hash lives in the event).
    assert_eq!((bet.evidence_hash, bet.ruling_hash), (EVIDENCE, RULING));
}

/// RA3: final Split on an odd pot (3_000_001 / 2_000_000) → A 2_500_000, B 2_500_001 (odd unit
/// to B, §6). Original PartyA, so this is also an overturn.
#[test]
fn ra3_final_split_odd_pot() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    let b = env.b.insecure_clone();
    env.appealed_bet_with(id, 3_000_001, 2_000_000, Outcome::PartyA, &b);
    let before = Snapshot::take(&env, &id);
    assert_eq!(before.v, 5_000_001);
    let res = env.resolve_appeal_bundled(&id, Outcome::Split);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(
        TerminalKind::AppealResolved,
        Outcome::Split,
        2_500_000,
        2_500_001,
    );
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_appeal_resolved_extras(sent, Outcome::PartyA, Outcome::Split);
}

/// RA4: J signs instead of AP → `[NotAppealAuthority]` (also admin, A and Mallory); nothing
/// moves; AP then settles normally.
#[test]
fn ra4_judge_signs_fails_not_appeal_authority() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.appealed_bet(id, Outcome::PartyA);
    let before = freeze(&env, &id);
    let impostors = [
        env.judge.insecure_clone(),
        env.admin.insecure_clone(),
        env.a.insecure_clone(),
        env.mallory.insecure_clone(),
    ];
    for k in &impostors {
        let res = env.resolve_appeal_as(&id, k, Outcome::PartyB, APPEAL_RULING);
        assert_escrow_err(&res, EscrowError::NotAppealAuthority);
        assert_unchanged(&env, &id, &before);
    }
    let snap = Snapshot::take(&env, &id);
    let res = env.resolve_appeal_bundled(&id, Outcome::PartyA);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &snap, sent, &exp);
}

/// RA5: status Resolved (no appeal filed) → `[InvalidStatus]`, for every outcome; nothing moves.
#[test]
fn ra5_status_resolved_fails_invalid_status() {
    let mut env = Env::with_config();
    for (n, outcome) in (1u8..).zip(ALL_OUTCOMES) {
        let id = bet_id(n);
        env.resolved_bet(id, outcome);
        let before = freeze(&env, &id);
        for final_outcome in ALL_OUTCOMES {
            let res = env.resolve_appeal(&id, final_outcome);
            assert_escrow_err(&res, EscrowError::InvalidStatus);
        }
        assert_unchanged(&env, &id, &before);
    }
}

/// RA6: `now = appeal_resolve_deadline` → `[AppealResolveDeadlinePassed]` (and later); nothing
/// moves. One second earlier is still ok (half-open window, I10).
#[test]
fn ra6_at_appeal_resolve_deadline_fails() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.appealed_bet(id, Outcome::PartyA);
    env.warp_to_appeal_resolve_deadline(&id);
    assert_eq!(env.now(), NOW + APPEAL_RESOLVE_SECS);
    let before = freeze(&env, &id);
    assert_escrow_err(
        &env.resolve_appeal(&id, Outcome::PartyB),
        EscrowError::AppealResolveDeadlinePassed,
    );
    env.advance(3_600);
    assert_escrow_err(
        &env.resolve_appeal(&id, Outcome::PartyA),
        EscrowError::AppealResolveDeadlinePassed,
    );
    assert_unchanged(&env, &id, &before);

    // Boundary: appeal_resolve_deadline − 1 is the last valid instant.
    let id2 = bet_id(2);
    env.set_now(NOW);
    env.appealed_bet(id2, Outcome::PartyA);
    let t = env.bet(&id2).appeal_resolve_deadline - 1;
    env.set_now(t);
    let snap = Snapshot::take(&env, &id2);
    let res = env.resolve_appeal_bundled(&id2, Outcome::PartyB);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::PartyB, 0, 2 * USDC_5);
    assert_terminal_postconditions_bundled(&env, &snap, sent, &exp);
}

/// RA7: a third-party payout account (Mallory's USDC account as `party_a_token` or
/// `party_b_token`) → `[WrongPayoutAccount]`; no balances move. The correct accounts then work.
#[test]
fn ra7_third_party_payout_account_fails() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.appealed_bet(id, Outcome::PartyA);
    let ap = env.appeal.insecure_clone();
    let before = freeze(&env, &id);

    for (final_outcome, side_a) in [
        (Outcome::PartyA, true),  // the winner's slot
        (Outcome::PartyB, false), // the winner's slot
        (Outcome::PartyB, true),  // the zero side's slot is still owner-checked
        (Outcome::Split, false),
    ] {
        let mut p = env.default_payout(&id);
        if side_a {
            p.party_a_token = Some(env.mallory_token);
        } else {
            p.party_b_token = Some(env.mallory_token);
        }
        let ix = env.ix_resolve_appeal(ap.pubkey(), &p, final_outcome, APPEAL_RULING);
        let res = env.send_s(&[ix], &[&ap]);
        assert_escrow_err(&res, EscrowError::WrongPayoutAccount);
        assert_unchanged(&env, &id, &before);
    }
    // Bundled with close_bet: the whole tx fails the same way.
    let mut p = env.default_payout(&id);
    p.party_b_token = Some(env.mallory_token);
    let ix = env.ix_resolve_appeal(ap.pubkey(), &p, Outcome::PartyB, APPEAL_RULING);
    let res = env.send_bundled(&id, ix, &[&ap]);
    assert_err_at(&res, 0, err_code(EscrowError::WrongPayoutAccount));
    assert_unchanged(&env, &id, &before);

    let snap = Snapshot::take(&env, &id);
    let res = env.resolve_appeal_bundled(&id, Outcome::PartyB);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::PartyB, 0, 2 * USDC_5);
    assert_terminal_postconditions_bundled(&env, &snap, sent, &exp);
}

/// RA8: status Locked (no resolve, no appeal) → `[InvalidStatus]` (TM-O2: the appeal key cannot
/// skip the judge); nothing moves.
#[test]
fn ra8_status_locked_fails_invalid_status() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let before = freeze(&env, &id);
    for final_outcome in ALL_OUTCOMES {
        assert_escrow_err(
            &env.resolve_appeal(&id, final_outcome),
            EscrowError::InvalidStatus,
        );
    }
    // Also after the resolve deadline (a timeout-eligible Locked bet).
    env.warp_to_resolve_deadline(&id);
    assert_escrow_err(
        &env.resolve_appeal(&id, Outcome::PartyB),
        EscrowError::InvalidStatus,
    );
    assert_unchanged(&env, &id, &before);
    assert_eq!(env.bet(&id).outcome, None);
}

/// Not a §9.2 row: the §5.2 `resolve_appeal` precondition `appeal_ruling_hash` non-zero
/// (`[EmptyHash]`, §8.1 6011); nothing moves.
#[test]
fn ra_extra_empty_appeal_ruling_hash_fails() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.appealed_bet(id, Outcome::PartyA);
    let ap = env.appeal.insecure_clone();
    let before = freeze(&env, &id);
    let res = env.resolve_appeal_as(&id, &ap, Outcome::PartyB, [0u8; 32]);
    assert_escrow_err(&res, EscrowError::EmptyHash);
    assert_unchanged(&env, &id, &before);
}
