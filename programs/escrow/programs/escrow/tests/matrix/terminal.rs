//! ESCROW §9.2 terminal-path rows: X1–X6 (cancel_open_bet), R1–R5 (resolve), K1–K15 (concede),
//! F1–F8 (finalize), T1–T9 (timeout_refund), L1–L7 (close_bet). Uses only `common` helpers plus
//! a few local fixtures (frozen / Token-2022 MemoTransfer destinations, an executable rent payer).
//!
//! Every successful terminal tx is checked with the §9.1 global post-conditions
//! (`assert_terminal_postconditions_bundled` / `_standalone`, `assert_close_postconditions`);
//! every rejected one with `assert_nothing_moved` (Bet, vault, tracked balances and supply
//! unchanged).

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::Instruction, program_option::COption, program_pack::Pack, system_instruction,
    },
};
use anchor_spl::token_interface::spl_token_2022::{
    self,
    extension::{memo_transfer, ExtensionType},
};
use escrow::{
    payout::PayoutKind, BetCancelled, BetClosed, BetConceded, BetFinalized, BetRefunded,
    BetResolved, BetStatus, EscrowError, Outcome, UpdateConfigArgs,
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

// SPL Token / Token-2022 `TokenError` codes surfaced as `InstructionError::Custom`.
const TOKEN_ERR_ACCOUNT_FROZEN: u32 = 17;
const TOKEN_ERR_NO_MEMO: u32 = 36;

// ---------------------------------------------------------------------------------------------
// local helpers
// ---------------------------------------------------------------------------------------------

/// A rejected tx moved nothing: the Bet is byte-for-byte as before, the vault still holds `V`,
/// every tracked token account and the mint supply are unchanged.
#[track_caller]
fn assert_nothing_moved(env: &Env, before: &Snapshot) {
    assert_eq!(
        env.try_bet(&before.bet_id).as_ref(),
        Some(&before.bet),
        "Bet unchanged"
    );
    assert_eq!(
        env.try_token_balance(&before.vault_addr),
        Some(before.v),
        "vault unchanged"
    );
    for (k, bal) in &before.balances {
        assert_eq!(env.try_token_balance(k), *bal, "balance of {k} unchanged");
    }
    assert_eq!(env.mint_supply(&before.bet.mint), before.supply, "supply");
}

/// `[WrongPayoutAccount]` or Anchor's duplicate-mutable-account rejection (K10, K11).
#[track_caller]
fn assert_wrong_payout_or_duplicate(res: &SendResult) {
    let code = custom_code(res);
    assert!(
        code == Some(err_code(EscrowError::WrongPayoutAccount))
            || code == Some(ANCHOR_CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT),
        "expected WrongPayoutAccount or duplicate-mutable, got {:?}\n{}",
        res.as_ref().err().map(|f| &f.err),
        res.as_ref()
            .err()
            .map(|f| f.meta.logs.join("\n"))
            .unwrap_or_default()
    );
}

#[track_caller]
fn assert_failed(res: &SendResult, what: &str) {
    assert!(res.is_err(), "{what}: expected failure, tx succeeded");
}

fn kp(k: &Keypair) -> Keypair {
    k.insecure_clone()
}

/// Rewrites an SPL token account's state (Frozen / Initialized) in place.
fn set_token_state(env: &mut Env, addr: Pubkey, state: spl_token_2022::state::AccountState) {
    let mut acc = env.svm.get_account(&addr).unwrap();
    let mut ta = spl_token_2022::state::Account::unpack_from_slice(&acc.data[..165]).unwrap();
    ta.state = state;
    ta.pack_into_slice(&mut acc.data[..165]);
    env.svm.set_account(addr, acc).unwrap();
}

/// Gives a mint a freeze authority (K14: "test mint with a freeze authority").
fn set_freeze_authority(env: &mut Env, mint: Pubkey, auth: Pubkey) {
    let mut acc = env.svm.get_account(&mint).unwrap();
    let mut m = spl_token_2022::state::Mint::unpack_from_slice(&acc.data[..82]).unwrap();
    m.freeze_authority = COption::Some(auth);
    m.pack_into_slice(&mut acc.data[..82]);
    env.svm.set_account(mint, acc).unwrap();
}

/// A Token-2022 6-dp mint (no extensions), allowlisted next to USDC, with funded Token-2022
/// accounts for A and B. Returns `(mint, a_tok, b_tok)`.
fn t22_setup(env: &mut Env) -> (Pubkey, Pubkey, Pubkey) {
    let mint = env.create_mint(6, TOKEN_2022);
    let a_tok = env.create_token_account(mint, env.a.pubkey(), FUNDED, TOKEN_2022);
    let b_tok = env.create_token_account(mint, env.b.pubkey(), FUNDED, TOKEN_2022);
    assert_ok(&env.update_config(&UpdateConfigArgs {
        allowed_mints: Some(vec![env.usdc, mint]),
        ..Default::default()
    }));
    (mint, a_tok, b_tok)
}

/// 5/5 Token-2022 bet → Locked (atomic shape) → Resolved(`outcome`).
fn t22_resolved_bet(
    env: &mut Env,
    id: [u8; 16],
    mint: Pubkey,
    a_tok: Pubkey,
    b_tok: Pubkey,
    outcome: Outcome,
) {
    let (c, mut ca) = env.default_create(id);
    ca.mint = mint;
    ca.party_a_token = a_tok;
    ca.token_program = TOKEN_2022;
    let (aa, mut acc) = env.default_accept(&c, &ca);
    acc.party_b_token = b_tok;
    let ixs = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let (a, b) = (kp(&env.a), kp(&env.b));
    assert_ok(&env.send_s(&ixs, &[&a, &b]));
    assert_ok(&env.resolve(&id, outcome));
}

/// A real Token-2022 account for `mint` owned by `owner` with `MemoTransfer` required on
/// incoming transfers (created and configured through the Token-2022 program).
fn t22_memo_required_account(env: &mut Env, mint: Pubkey, owner: &Keypair) -> Pubkey {
    let acct = Keypair::new();
    let space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[
        ExtensionType::MemoTransfer,
    ])
    .unwrap();
    let lamports = env.svm.minimum_balance_for_rent_exemption(space);
    let s = kp(&env.s);
    let ixs = [
        system_instruction::create_account(
            &s.pubkey(),
            &acct.pubkey(),
            lamports,
            space as u64,
            &TOKEN_2022,
        ),
        spl_token_2022::instruction::initialize_account3(
            &TOKEN_2022,
            &acct.pubkey(),
            &mint,
            &owner.pubkey(),
        )
        .unwrap(),
        memo_transfer::instruction::enable_required_transfer_memos(
            &TOKEN_2022,
            &acct.pubkey(),
            &owner.pubkey(),
            &[],
        )
        .unwrap(),
    ];
    assert_ok(&env.send(&ixs, &s, &[&acct, owner]));
    acct.pubkey()
}

/// The 5/5 bet `id` driven to `Locked` with a dedicated rent payer `r` (create payer = r).
fn locked_bet_paid_by(env: &mut Env, id: [u8; 16], r: &Keypair) {
    let (c, mut ca) = env.default_create(id);
    ca.payer = r.pubkey();
    let (aa, acc) = env.default_accept(&c, &ca);
    let ixs = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let (a, b) = (kp(&env.a), kp(&env.b));
    assert_ok(&env.send_s(&ixs, &[&a, &b, r]));
    assert_eq!(env.bet(&id).rent_payer, r.pubkey());
}

// =============================================================================================
// X: cancel_open_bet
// =============================================================================================

/// X1: A cancels an Open bet (bundled with close_bet) → ok; A gets V; Cancelled; closed;
/// rent → S; `BetCancelled` + `BetClosed`.
#[test]
fn x1_party_a_cancels_open_bet_bundled() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.open_bet(id);
    let before = Snapshot::take(&env, &id);
    assert_eq!(before.bet.rent_payer, env.s.pubkey());
    assert_eq!(before.v, USDC_5);
    let a = kp(&env.a);
    let res = env.cancel_open_bet_bundled(&id, &a);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Cancelled, Outcome::Refund, USDC_5, 0);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.final_status, BetStatus::Cancelled);
    assert_eq!(ev.party_a_token, env.a_token);
    assert_eq!(events::<BetCancelled>(sent)[0].cancelled_by, env.a.pubkey());
    assert_eq!(events::<BetClosed>(sent)[0].rent_payer, env.s.pubkey());
    assert_eq!(env.token_balance(&env.a_token), FUNDED);
}

/// X2: B cancels; J cancels → ok; the refund still goes to A only.
#[test]
fn x2_party_b_or_judge_cancels_refund_to_a_only() {
    let mut env = Env::with_config();
    let (b, j) = (kp(&env.b), kp(&env.judge));
    for (n, canceller) in [(1u8, &b), (2u8, &j)] {
        let id = bet_id(n);
        env.open_bet(id);
        let before = Snapshot::take(&env, &id);
        let res = env.cancel_open_bet_bundled(&id, canceller);
        let sent = assert_ok(&res);
        let exp = ExpectTerminal::new(TerminalKind::Cancelled, Outcome::Refund, USDC_5, 0);
        let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
        assert_eq!((ev.to_a, ev.to_b), (USDC_5, 0));
        assert_eq!(ev.party_b_token, Pubkey::default());
        assert_eq!(before.delta(&env, &env.b_token), 0, "B gets nothing");
        assert_eq!(
            events::<BetCancelled>(sent)[0].cancelled_by,
            canceller.pubkey()
        );
    }
}

/// X3: Mallory; AP → `[NotAuthorizedToCancel]`.
#[test]
fn x3_mallory_or_appeal_authority_cannot_cancel() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.open_bet(id);
    let before = Snapshot::take(&env, &id);
    let (m, ap) = (kp(&env.mallory), kp(&env.appeal));
    for who in [&m, &ap] {
        let res = env.cancel_open_bet_bundled(&id, who);
        assert_err_at(&res, 0, err_code(EscrowError::NotAuthorizedToCancel));
        let res = env.cancel_open_bet(&id, who);
        assert_escrow_err(&res, EscrowError::NotAuthorizedToCancel);
        assert_nothing_moved(&env, &before);
    }
}

/// X4: A cancels after Locked → `[InvalidStatus]`.
#[test]
fn x4_party_a_cancels_locked_bet() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let before = Snapshot::take(&env, &id);
    let a = kp(&env.a);
    assert_escrow_err(&env.cancel_open_bet(&id, &a), EscrowError::InvalidStatus);
    assert_err_at(
        &env.cancel_open_bet_bundled(&id, &a),
        0,
        err_code(EscrowError::InvalidStatus),
    );
    assert_nothing_moved(&env, &before);
}

/// X5: J cancels a Locked bet; B cancels a Locked bet → `[InvalidStatus]` each (TM-O3).
#[test]
fn x5_judge_or_party_b_cancels_locked_bet() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let before = Snapshot::take(&env, &id);
    let (j, b) = (kp(&env.judge), kp(&env.b));
    for who in [&j, &b] {
        assert_escrow_err(&env.cancel_open_bet(&id, who), EscrowError::InvalidStatus);
        assert_nothing_moved(&env, &before);
    }
    assert_eq!(env.bet(&id).status, BetStatus::Locked);
}

/// X6: B has no token account for the mint; `party_b_token` omitted → ok; A gets V.
#[test]
fn x6_party_b_without_token_account_cancel_ok() {
    let mut env = Env::with_config();
    let a = kp(&env.a);

    // (a) party_b never had a token account for this mint.
    let id = bet_id(1);
    let fresh_b = Keypair::new();
    let (mut c, ca) = env.default_create(id);
    c.party_b = fresh_b.pubkey();
    assert_ok(&env.create_bet(&c, &ca));
    let before = Snapshot::take(&env, &id);
    let mut p = env.default_payout(&id);
    p.party_b_token = None;
    let ix = env.ix_cancel_open_bet(a.pubkey(), &p);
    let res = env.send_bundled(&id, ix, &[&a]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Cancelled, Outcome::Refund, USDC_5, 0);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.party_b, fresh_b.pubkey());
    assert_eq!(ev.party_b_token, Pubkey::default());

    // (b) the default B (who has an account) with party_b_token omitted.
    let id = bet_id(2);
    env.open_bet(id);
    let before = Snapshot::take(&env, &id);
    let mut p = env.default_payout(&id);
    p.party_b_token = None;
    let ix = env.ix_cancel_open_bet(a.pubkey(), &p);
    let res = env.send_bundled(&id, ix, &[&a]);
    let sent = assert_ok(&res);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
}

// =============================================================================================
// R: resolve
// =============================================================================================

/// R1: J, each of the 4 outcomes → ok; Resolved; hashes stored; `appeal_deadline = now + 10`;
/// `BetResolved`.
#[test]
fn r1_judge_resolves_each_outcome() {
    let mut env = Env::with_config();
    for (i, outcome) in ALL_OUTCOMES.into_iter().enumerate() {
        let id = bet_id(i as u8 + 1);
        env.locked_bet(id);
        env.advance(7);
        let before = Snapshot::take(&env, &id);
        let now = env.now();
        let res = env.resolve(&id, outcome);
        let sent = assert_ok(&res);
        let bet = env.bet(&id);
        assert_eq!(bet.status, BetStatus::Resolved);
        assert_eq!(bet.outcome, Some(outcome));
        assert_eq!(bet.evidence_hash, EVIDENCE);
        assert_eq!(bet.ruling_hash, RULING);
        assert_eq!(bet.resolved_at, now);
        assert_eq!(bet.appeal_deadline, now + APPEAL_WINDOW_SECS);
        // Untouched by resolve.
        assert_eq!(bet.terms_hash, before.bet.terms_hash);
        assert_eq!(bet.resolve_deadline, before.bet.resolve_deadline);
        assert_rederives(&bet, &before.bet_addr, &before.vault_addr);
        // No token moves.
        assert_eq!(env.token_balance(&before.vault_addr), before.v);
        for (k, bal) in &before.balances {
            assert_eq!(env.try_token_balance(k), *bal);
        }
        let evs = events::<BetResolved>(sent);
        assert_eq!((evs.len(), event_count(sent)), (1, 1));
        let e = &evs[0];
        assert_eq!(e.bet_id, id);
        assert_eq!(e.judge, env.judge.pubkey());
        assert_eq!(e.outcome, outcome);
        assert_eq!((e.evidence_hash, e.ruling_hash), (EVIDENCE, RULING));
        assert_eq!(e.appeal_deadline, now + APPEAL_WINDOW_SECS);
        assert_eq!(e.ts, now);
        assert_no_log_truncation(sent);
    }
}

/// R2: non-judge: AP, admin, A, Mallory → `[NotJudge]` each.
#[test]
fn r2_resolve_by_non_judge_fails() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let before = Snapshot::take(&env, &id);
    let signers = [
        kp(&env.appeal),
        kp(&env.admin),
        kp(&env.a),
        kp(&env.mallory),
    ];
    for who in &signers {
        let res = env.resolve_as(&id, who, Outcome::PartyA, EVIDENCE, RULING);
        assert_escrow_err(&res, EscrowError::NotJudge);
        assert_nothing_moved(&env, &before);
    }
}

/// R3: status Open; already Resolved → `[InvalidStatus]`.
#[test]
fn r3_resolve_open_or_already_resolved() {
    let mut env = Env::with_config();
    let open = bet_id(1);
    env.open_bet(open);
    let before = Snapshot::take(&env, &open);
    assert_escrow_err(
        &env.resolve(&open, Outcome::PartyA),
        EscrowError::InvalidStatus,
    );
    assert_nothing_moved(&env, &before);

    let id = bet_id(2);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    for outcome in ALL_OUTCOMES {
        assert_escrow_err(&env.resolve(&id, outcome), EscrowError::InvalidStatus);
    }
    assert_nothing_moved(&env, &before);
    assert_eq!(env.bet(&id).outcome, Some(Outcome::PartyA));
}

/// R4: `now = resolve_deadline` → `[ResolveDeadlinePassed]` (and T7); one second earlier is ok.
#[test]
fn r4_resolve_at_deadline_fails() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    env.warp_to_resolve_deadline(&id);
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(
        &env.resolve(&id, Outcome::PartyA),
        EscrowError::ResolveDeadlinePassed,
    );
    env.advance(1000);
    assert_escrow_err(
        &env.resolve(&id, Outcome::PartyB),
        EscrowError::ResolveDeadlinePassed,
    );
    assert_nothing_moved(&env, &before);

    // Boundary: resolve_deadline − 1 is still inside [locked_at, resolve_deadline).
    let id2 = bet_id(2);
    env.locked_bet(id2);
    let rd = env.bet(&id2).resolve_deadline;
    env.set_now(rd - 1);
    assert_ok(&env.resolve(&id2, Outcome::PartyA));
    assert_eq!(env.bet(&id2).status, BetStatus::Resolved);
}

/// R5: zero `evidence_hash` / `ruling_hash` → `[EmptyHash]`.
#[test]
fn r5_resolve_with_empty_hash() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let before = Snapshot::take(&env, &id);
    let j = kp(&env.judge);
    for (ev, rh) in [
        ([0u8; 32], RULING),
        (EVIDENCE, [0u8; 32]),
        ([0u8; 32], [0u8; 32]),
    ] {
        let res = env.resolve_as(&id, &j, Outcome::PartyA, ev, rh);
        assert_escrow_err(&res, EscrowError::EmptyHash);
        assert_nothing_moved(&env, &before);
    }
}

// =============================================================================================
// K: concede
// =============================================================================================

/// K1: PartyA outcome, B concedes → ok; A +10_000_000; Settled; closed; `BetConceded`.
#[test]
fn k1_loser_concedes_party_a_bundled() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.advance(2); // inside the appeal window
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    let res = env.concede_bundled(&id, &b);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyA, 10_000_000, 0);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.final_status, BetStatus::Settled);
    assert_eq!(before.delta(&env, &env.a_token), 10_000_000);
    assert_eq!(before.delta(&env, &env.b_token), 0);
    assert_eq!(events::<BetConceded>(sent)[0].conceded_by, env.b.pubkey());
}

/// K2: winner tries to concede (A on PartyA) → `[NotLoser]` (also B on PartyB).
#[test]
fn k2_winner_cannot_concede() {
    let mut env = Env::with_config();
    let (a, b) = (kp(&env.a), kp(&env.b));
    for (n, outcome, winner) in [(1u8, Outcome::PartyA, &a), (2u8, Outcome::PartyB, &b)] {
        let id = bet_id(n);
        env.resolved_bet(id, outcome);
        let before = Snapshot::take(&env, &id);
        assert_escrow_err(&env.concede(&id, winner), EscrowError::NotLoser);
        assert_err_at(
            &env.concede_bundled(&id, winner),
            0,
            err_code(EscrowError::NotLoser),
        );
        assert_nothing_moved(&env, &before);
    }
}

/// K3: Mallory → `[NotParty]`.
#[test]
fn k3_non_party_cannot_concede() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let m = kp(&env.mallory);
    assert_escrow_err(&env.concede(&id, &m), EscrowError::NotParty);
    assert_nothing_moved(&env, &before);
}

/// K4: Split / Refund outcome → `[ConcedeNotAllowed]` (whichever party signs).
#[test]
fn k4_concede_not_allowed_for_split_or_refund() {
    let mut env = Env::with_config();
    let (a, b) = (kp(&env.a), kp(&env.b));
    for (n, outcome) in [(1u8, Outcome::Split), (2u8, Outcome::Refund)] {
        let id = bet_id(n);
        env.resolved_bet(id, outcome);
        let before = Snapshot::take(&env, &id);
        for who in [&a, &b] {
            assert_escrow_err(&env.concede(&id, who), EscrowError::ConcedeNotAllowed);
        }
        assert_nothing_moved(&env, &before);
    }
}

/// K5: status Locked / Appealed → `[InvalidStatus]`.
#[test]
fn k5_concede_on_locked_or_appealed() {
    let mut env = Env::with_config();
    let b = kp(&env.b);
    let locked = bet_id(1);
    env.locked_bet(locked);
    let before = Snapshot::take(&env, &locked);
    assert_escrow_err(&env.concede(&locked, &b), EscrowError::InvalidStatus);
    assert_nothing_moved(&env, &before);

    let appealed = bet_id(2);
    env.appealed_bet(appealed, Outcome::PartyA); // appealed by B, the loser
    let before = Snapshot::take(&env, &appealed);
    assert_escrow_err(&env.concede(&appealed, &b), EscrowError::InvalidStatus);
    assert_nothing_moved(&env, &before);
}

/// K6: concede after the appeal window → ok.
#[test]
fn k6_concede_after_appeal_window() {
    let mut env = Env::with_config();
    let a = kp(&env.a);
    for (n, late) in [(1u8, 0i64), (2u8, 86_400)] {
        let id = bet_id(n);
        env.resolved_bet(id, Outcome::PartyB);
        env.warp_to_appeal_deadline(&id);
        env.advance(late);
        let before = Snapshot::take(&env, &id);
        let res = env.concede_bundled(&id, &a);
        let sent = assert_ok(&res);
        let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyB, 0, 2 * USDC_5);
        assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
        assert_eq!(events::<BetConceded>(sent)[0].conceded_by, env.a.pubkey());
    }
}

/// K7: payout to a third party: Mallory's USDC account as `party_a_token` →
/// `[WrongPayoutAccount]`; no balances move.
#[test]
fn k7_third_party_payout_account() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    let mut p = env.default_payout(&id);
    p.party_a_token = Some(env.mallory_token);
    let ix = env.ix_concede(b.pubkey(), &p);
    assert_escrow_err(
        &env.send_s(std::slice::from_ref(&ix), &[&b]),
        EscrowError::WrongPayoutAccount,
    );
    assert_err_at(
        &env.send_bundled(&id, ix, &[&b]),
        0,
        err_code(EscrowError::WrongPayoutAccount),
    );
    // Mallory's account on the zero side is rejected too (constraints apply when present).
    let mut p = env.default_payout(&id);
    p.party_b_token = Some(env.mallory_token);
    let ix = env.ix_concede(b.pubkey(), &p);
    assert_escrow_err(&env.send_s(&[ix], &[&b]), EscrowError::WrongPayoutAccount);
    assert_nothing_moved(&env, &before);
}

/// K8: `party_a_token` = A's account for another mint → `ConstraintTokenMint`.
#[test]
fn k8_party_a_token_of_another_mint() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let other_mint = env.create_mint(6, CLASSIC_TOKEN);
    let a_other = env.create_token_account(other_mint, env.a.pubkey(), FUNDED, CLASSIC_TOKEN);
    let before = Snapshot::take_with(&env, &id, &[a_other]);
    let b = kp(&env.b);
    let mut p = env.default_payout(&id);
    p.party_a_token = Some(a_other);
    let ix = env.ix_concede(b.pubkey(), &p);
    assert_err(&env.send_s(&[ix], &[&b]), ANCHOR_CONSTRAINT_TOKEN_MINT);
    assert_nothing_moved(&env, &before);
}

/// K9: concede bundled with a `close_bet` whose `rent_payer` = Mallory → whole tx fails
/// `[WrongRentPayer]`; a standalone concede then works.
#[test]
fn k9_bundled_close_with_wrong_rent_payer() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    let concede = env.ix_concede(b.pubkey(), &env.default_payout(&id));
    let mut c = env.default_close(&id);
    c.rent_payer = env.mallory.pubkey();
    let close = env.ix_close_bet(&c);
    let m_sol = env.sol(&env.mallory.pubkey());
    let res = env.send_s(&[concede, close], &[&b]);
    assert_err_at(&res, 1, err_code(EscrowError::WrongRentPayer));
    assert_nothing_moved(&env, &before);
    assert_eq!(env.sol(&env.mallory.pubkey()), m_sol);

    // Fresh snapshot: LiteSVM charges S the fee of the failed tx.
    let before = Snapshot::take(&env, &id);
    let res = env.concede(&id, &b);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);
}

/// K10: `party_a_token` = the vault itself → `[WrongPayoutAccount]` or Anchor's
/// duplicate-mutable rejection; no balances move.
#[test]
fn k10_vault_as_destination() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    for side_a in [true, false] {
        let mut p = env.default_payout(&id);
        if side_a {
            p.party_a_token = Some(p.vault);
        } else {
            p.party_b_token = Some(p.vault);
        }
        let ix = env.ix_concede(b.pubkey(), &p);
        assert_wrong_payout_or_duplicate(&env.send_s(&[ix], &[&b]));
        assert_nothing_moved(&env, &before);
    }
}

/// K11: the same account (A's) as both `party_a_token` and `party_b_token` →
/// `[WrongPayoutAccount]` (or Anchor's duplicate-mutable rejection).
#[test]
fn k11_same_account_for_both_sides() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    for acct in [env.a_token, env.b_token] {
        let mut p = env.default_payout(&id);
        p.party_a_token = Some(acct);
        p.party_b_token = Some(acct);
        let ix = env.ix_concede(b.pubkey(), &p);
        assert_wrong_payout_or_duplicate(&env.send_s(&[ix], &[&b]));
        assert_nothing_moved(&env, &before);
    }
}

/// K12: PartyA outcome, winner's `party_a_token` omitted → `[MissingPayoutAccount]`; no
/// balances move.
#[test]
fn k12_winner_destination_omitted() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    let mut p = env.default_payout(&id);
    p.party_a_token = None;
    let ix = env.ix_concede(b.pubkey(), &p);
    assert_escrow_err(
        &env.send_s(std::slice::from_ref(&ix), &[&b]),
        EscrowError::MissingPayoutAccount,
    );
    assert_err_at(
        &env.send_bundled(&id, ix, &[&b]),
        0,
        err_code(EscrowError::MissingPayoutAccount),
    );
    assert_nothing_moved(&env, &before);
}

/// K13: PartyA outcome, loser's `party_b_token` omitted → ok.
#[test]
fn k13_loser_destination_omitted() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    let mut p = env.default_payout(&id);
    p.party_b_token = None;
    let ix = env.ix_concede(b.pubkey(), &p);
    let res = env.send_bundled(&id, ix, &[&b]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyA, 2 * USDC_5, 0);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.party_b_token, Pubkey::default());
}

/// K14: winner's ATA frozen (mint with a freeze authority); separately, winner's Token-2022
/// account has `MemoTransfer` required → that destination fails; the same ix with a fresh
/// winner-owned account is ok (TM-L3).
#[test]
fn k14_unreceivable_winner_account_then_fresh_account() {
    // (a) classic: frozen winner account.
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let usdc = env.usdc;
    set_freeze_authority(&mut env, usdc, Pubkey::new_unique());
    let a_tok = env.a_token;
    set_token_state(&mut env, a_tok, spl_token_2022::state::AccountState::Frozen);
    let fresh = env.create_token_account(usdc, env.a.pubkey(), 0, CLASSIC_TOKEN);
    let before = Snapshot::take_with(&env, &id, &[fresh]);
    let b = kp(&env.b);
    let res = env.concede_bundled(&id, &b);
    assert_err_at(&res, 0, TOKEN_ERR_ACCOUNT_FROZEN);
    assert_nothing_moved(&env, &before);
    let before = Snapshot::take_with(&env, &id, &[fresh]);
    let mut p = env.default_payout(&id);
    p.party_a_token = Some(fresh);
    let ix = env.ix_concede(b.pubkey(), &p);
    let res = env.send_bundled(&id, ix, &[&b]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyA, 2 * USDC_5, 0);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.party_a_token, fresh);
    assert_eq!(env.token_balance(&fresh), 2 * USDC_5);

    // (b) Token-2022: winner's account requires a memo on incoming transfers.
    let mut env = Env::with_config();
    let (mint, a_tok, b_tok) = t22_setup(&mut env);
    let id = bet_id(2);
    t22_resolved_bet(&mut env, id, mint, a_tok, b_tok, Outcome::PartyA);
    let a = kp(&env.a);
    let memo = t22_memo_required_account(&mut env, mint, &a);
    let fresh = env.create_token_account(mint, env.a.pubkey(), 0, TOKEN_2022);
    let before = Snapshot::take_with(&env, &id, &[a_tok, b_tok, memo, fresh]);
    let b = kp(&env.b);
    let mut p = env.default_payout(&id);
    assert_eq!(p.token_program, TOKEN_2022);
    p.party_b_token = Some(b_tok);
    p.party_a_token = Some(memo);
    let ix = env.ix_concede(b.pubkey(), &p);
    let res = env.send_bundled(&id, ix, &[&b]);
    assert_err_at(&res, 0, TOKEN_ERR_NO_MEMO);
    assert_nothing_moved(&env, &before);
    let before = Snapshot::take_with(&env, &id, &[a_tok, b_tok, memo, fresh]);
    p.party_a_token = Some(fresh);
    let ix = env.ix_concede(b.pubkey(), &p);
    let res = env.send_bundled(&id, ix, &[&b]);
    let sent = assert_ok(&res);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.party_a_token, fresh);
    assert_eq!(ev.mint, mint);
}

/// K15: `concede` + `appeal` in one tx, both orders → whole tx fails; state unchanged.
#[test]
fn k15_concede_and_appeal_in_one_tx() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    let concede = env.ix_concede(b.pubkey(), &env.default_payout(&id));
    let appeal = env.ix_appeal(&env.default_appeal(&id, b.pubkey()));
    // concede first: the bet is Settled when appeal runs.
    let res = env.send_s(&[concede.clone(), appeal.clone()], &[&b]);
    assert_err_at(&res, 1, err_code(EscrowError::InvalidStatus));
    assert_nothing_moved(&env, &before);
    // appeal first: the bet is Appealed when concede runs.
    let res = env.send_s(&[appeal, concede], &[&b]);
    assert_err_at(&res, 1, err_code(EscrowError::InvalidStatus));
    assert_nothing_moved(&env, &before);
    assert_eq!(env.bet(&id).status, BetStatus::Resolved);
}

// =============================================================================================
// F: finalize
// =============================================================================================

/// F1: after the window, each outcome → ok; payout per §6; `BetFinalized`.
#[test]
fn f1_finalize_each_outcome() {
    let mut env = Env::with_config();
    let (sa, sb) = (6_200_000u64, 3_800_000u64);
    let want = [
        (Outcome::PartyA, 10_000_000, 0),
        (Outcome::PartyB, 0, 10_000_000),
        (Outcome::Split, 5_000_000, 5_000_000),
        (Outcome::Refund, 6_200_000, 3_800_000),
    ];
    for (i, (outcome, to_a, to_b)) in want.into_iter().enumerate() {
        let id = bet_id(i as u8 + 1);
        env.resolved_bet_with(id, sa, sb, outcome);
        env.warp_to_appeal_deadline(&id);
        let before = Snapshot::take(&env, &id);
        let exp = ExpectTerminal::from_math(
            TerminalKind::Finalized,
            outcome,
            PayoutKind::Ruled(outcome),
            &before,
        );
        assert_eq!((exp.to_a, exp.to_b), (to_a, to_b), "{outcome:?}");
        let res = env.finalize_bundled(&id);
        let sent = assert_ok(&res);
        assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
        assert_eq!(events::<BetFinalized>(sent)[0].caller, env.s.pubkey());
    }
}

/// F2: before the window (`appeal_deadline − 1`) → `[AppealWindowOpen]`; at `appeal_deadline`
/// → ok.
#[test]
fn f2_finalize_window_boundary() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyB);
    // Same second as resolve.
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(&env.finalize(&id), EscrowError::AppealWindowOpen);
    let ad = env.bet(&id).appeal_deadline;
    env.set_now(ad - 1);
    assert_escrow_err(&env.finalize(&id), EscrowError::AppealWindowOpen);
    assert_err_at(
        &env.finalize_bundled(&id),
        0,
        err_code(EscrowError::AppealWindowOpen),
    );
    assert_nothing_moved(&env, &before);
    env.set_now(ad);
    let before = Snapshot::take(&env, &id);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyB, 0, 2 * USDC_5);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
}

/// F3: double finalize: two bundled txs → 2nd `AccountNotInitialized`; two standalone txs → 2nd
/// `[InvalidStatus]`; the same ix twice in one tx → whole tx fails.
#[test]
fn f3_double_finalize() {
    let mut env = Env::with_config();
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);

    // Two bundled txs.
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.finalize_bundled(&id);
    assert_terminal_postconditions_bundled(&env, &before, assert_ok(&res), &exp);
    let a_bal = env.token_balance(&env.a_token);
    let res = env.finalize_bundled(&id);
    assert_err_at(&res, 0, ANCHOR_ACCOUNT_NOT_INITIALIZED);
    assert_eq!(env.token_balance(&env.a_token), a_bal, "no second payout");

    // Two standalone txs (the standalone post-conditions already probe every terminal ix).
    let id = bet_id(2);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.finalize(&id);
    assert_terminal_postconditions_standalone(&mut env, &before, assert_ok(&res), &exp);
    let a_bal = env.token_balance(&env.a_token);
    assert_escrow_err(&env.finalize(&id), EscrowError::InvalidStatus);
    assert_eq!(env.token_balance(&env.a_token), a_bal, "no second payout");
    assert_eq!(env.bet(&id).status, BetStatus::Settled);

    // The same ix twice in one tx.
    let id = bet_id(3);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let fin = env.ix_finalize(&env.default_payout(&id));
    let res = env.send_s(&[fin.clone(), fin], &[]);
    assert_err_at(&res, 1, err_code(EscrowError::InvalidStatus));
    assert_nothing_moved(&env, &before);
}

/// F4: status Appealed → `[InvalidStatus]` (even after the appeal window).
#[test]
fn f4_finalize_appealed_bet() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.appealed_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(&env.finalize(&id), EscrowError::InvalidStatus);
    env.warp_to_appeal_deadline(&id);
    assert_escrow_err(&env.finalize(&id), EscrowError::InvalidStatus);
    env.advance(100);
    assert_escrow_err(&env.finalize(&id), EscrowError::InvalidStatus);
    assert_nothing_moved(&env, &before);
}

/// F5: Mallory as payer → ok; funds only to A/B; rent → S, not Mallory.
#[test]
fn f5_mallory_pays_finalize_and_close() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyB);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let m = kp(&env.mallory);
    let mut p = env.default_payout(&id);
    p.payer = m.pubkey();
    let mut c = env.default_close(&id);
    c.payer = m.pubkey();
    assert_eq!(c.rent_payer, env.s.pubkey());
    let ixs = [env.ix_finalize(&p), env.ix_close_bet(&c)];
    let m_sol = env.sol(&m.pubkey());
    let res = env.send(&ixs, &m, &[]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyB, 0, 2 * USDC_5);
    // rent_payer (S) is not the fee payer here, so S gains exactly rent_returned.
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(before.delta(&env, &env.mallory_token), 0);
    assert_eq!(
        env.sol(&m.pubkey()),
        m_sol - sent.meta.fee,
        "Mallory only paid the fee"
    );
    assert_eq!(events::<BetFinalized>(sent)[0].caller, m.pubkey());
    assert_eq!(events::<BetClosed>(sent)[0].rent_payer, env.s.pubkey());
}

/// F6: third-party payout account → `[WrongPayoutAccount]`.
#[test]
fn f6_finalize_third_party_payout_account() {
    let mut env = Env::with_config();
    for (n, outcome) in [(1u8, Outcome::PartyA), (2u8, Outcome::PartyB)] {
        let id = bet_id(n);
        env.resolved_bet(id, outcome);
        env.warp_to_appeal_deadline(&id);
        let before = Snapshot::take(&env, &id);
        let mut p = env.default_payout(&id);
        if outcome == Outcome::PartyA {
            p.party_a_token = Some(env.mallory_token);
        } else {
            p.party_b_token = Some(env.mallory_token);
        }
        let ix = env.ix_finalize(&p);
        assert_escrow_err(
            &env.send_s(std::slice::from_ref(&ix), &[]),
            EscrowError::WrongPayoutAccount,
        );
        assert_err_at(
            &env.send_bundled(&id, ix, &[]),
            0,
            err_code(EscrowError::WrongPayoutAccount),
        );
        assert_nothing_moved(&env, &before);
    }
}

/// F7: `finalize` + `concede` in one tx; `finalize` + `timeout_refund` in one tx → 2nd ix
/// `[InvalidStatus]`; whole tx fails.
#[test]
fn f7_finalize_with_second_terminal_ix_in_one_tx() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let b = kp(&env.b);
    let p = env.default_payout(&id);
    let fin = env.ix_finalize(&p);
    let concede = env.ix_concede(b.pubkey(), &p);
    let timeout = env.ix_timeout_refund(&p);
    let res = env.send_s(&[fin.clone(), concede], &[&b]);
    assert_err_at(&res, 1, err_code(EscrowError::InvalidStatus));
    assert_nothing_moved(&env, &before);
    let res = env.send_s(&[fin, timeout], &[]);
    assert_err_at(&res, 1, err_code(EscrowError::InvalidStatus));
    assert_nothing_moved(&env, &before);
}

/// F8: standalone (no close_bet), PartyA outcome, loser's account omitted → ok; Bet persists
/// `Settled`, vault = 0; any 2nd terminal ix `[InvalidStatus]`.
#[test]
fn f8_standalone_finalize_loser_omitted() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let mut p = env.default_payout(&id);
    p.party_b_token = None;
    let ix = env.ix_finalize(&p);
    let res = env.send_s(&[ix], &[]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    let ev = assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);
    assert_eq!(ev.party_b_token, Pubkey::default());
    assert!(
        env.exists(&before.vault_addr),
        "vault persists until close_bet"
    );
    assert_eq!(env.bet(&id).status, BetStatus::Settled);
}

// =============================================================================================
// T: timeout_refund
// =============================================================================================

/// T1: Open at `accept_deadline` → ok; A gets V; Refunded; `from_status = Open`.
#[test]
fn t1_timeout_open_at_accept_deadline() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.open_bet(id);
    env.warp_to_accept_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.timeout_refund_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Refunded, Outcome::Refund, USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    let e = &events::<BetRefunded>(sent)[0];
    assert_eq!(e.from_status, BetStatus::Open);
    assert_eq!(e.final_status, BetStatus::Refunded);
    assert_eq!(e.caller, env.s.pubkey());
}

/// T2: before the deadline (Open at `accept_deadline − 1`) → `[DeadlineNotReached]`.
#[test]
fn t2_timeout_open_before_deadline() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.open_bet(id);
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(&env.timeout_refund(&id), EscrowError::DeadlineNotReached);
    let ad = env.bet(&id).accept_deadline;
    env.set_now(ad - 1);
    assert_escrow_err(&env.timeout_refund(&id), EscrowError::DeadlineNotReached);
    assert_nothing_moved(&env, &before);
}

/// T3: Locked at `resolve_deadline`, stakes 6_200_000 / 3_800_000 → A 6_200_000, B 3_800_000.
#[test]
fn t3_timeout_locked_at_resolve_deadline() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet_with(id, 6_200_000, 3_800_000);
    env.warp_to_resolve_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.timeout_refund_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(
        TerminalKind::Refunded,
        Outcome::Refund,
        6_200_000,
        3_800_000,
    );
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(before.delta(&env, &env.a_token), 6_200_000);
    assert_eq!(before.delta(&env, &env.b_token), 3_800_000);
    assert_eq!(
        events::<BetRefunded>(sent)[0].from_status,
        BetStatus::Locked
    );
}

/// T4: Locked before the deadline → `[DeadlineNotReached]`.
#[test]
fn t4_timeout_locked_before_deadline() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(&env.timeout_refund(&id), EscrowError::DeadlineNotReached);
    let rd = env.bet(&id).resolve_deadline;
    env.set_now(rd - 1);
    assert_escrow_err(&env.timeout_refund(&id), EscrowError::DeadlineNotReached);
    assert_nothing_moved(&env, &before);
}

/// T5: Appealed at `appeal_resolve_deadline` → own stakes back.
#[test]
fn t5_timeout_appealed_at_appeal_resolve_deadline() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    let b = kp(&env.b);
    env.appealed_bet_with(id, 6_200_000, 3_800_000, Outcome::PartyA, &b);
    let ard = env.bet(&id).appeal_resolve_deadline;
    env.set_now(ard - 1);
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(&env.timeout_refund(&id), EscrowError::DeadlineNotReached);
    assert_nothing_moved(&env, &before);
    env.set_now(ard);
    let before = Snapshot::take(&env, &id);
    let res = env.timeout_refund_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(
        TerminalKind::Refunded,
        Outcome::Refund,
        6_200_000,
        3_800_000,
    );
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(
        events::<BetRefunded>(sent)[0].from_status,
        BetStatus::Appealed
    );
}

/// T6: Resolved → `[InvalidStatus]` (at any time: finalize is the exit).
#[test]
fn t6_timeout_resolved_bet() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(&env.timeout_refund(&id), EscrowError::InvalidStatus);
    env.warp_to_resolve_deadline(&id);
    env.advance(10_000);
    assert_escrow_err(&env.timeout_refund(&id), EscrowError::InvalidStatus);
    assert_nothing_moved(&env, &before);
}

/// T7: resolve vs timeout at exactly `resolve_deadline` → resolve fails, timeout ok.
#[test]
fn t7_resolve_vs_timeout_at_resolve_deadline() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    env.warp_to_resolve_deadline(&id);
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(
        &env.resolve(&id, Outcome::PartyA),
        EscrowError::ResolveDeadlinePassed,
    );
    assert_nothing_moved(&env, &before);
    let before = Snapshot::take(&env, &id);
    let res = env.timeout_refund_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Refunded, Outcome::Refund, USDC_5, USDC_5);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
}

/// T8: forced impossible state via `set_account`: Locked, vault = `stake_a − 1` → ok; A gets V,
/// B gets 0 (saturating, not bricked).
#[test]
fn t8_timeout_saturates_when_vault_short() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let vault = vault_pda(&id).0;
    env.set_token_amount(vault, USDC_5 - 1);
    env.warp_to_resolve_deadline(&id);
    let before = Snapshot::take(&env, &id);
    assert_eq!(before.v, USDC_5 - 1);
    let exp = ExpectTerminal::from_math(
        TerminalKind::Refunded,
        Outcome::Refund,
        PayoutKind::LockedRefund,
        &before,
    );
    assert_eq!((exp.to_a, exp.to_b), (USDC_5 - 1, 0));
    let res = env.timeout_refund_bundled(&id);
    let sent = assert_ok(&res);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.party_b_token, Pubkey::default());
}

/// T9: clock steps back (TM-T2): warp past `resolve_deadline`, then back to
/// `resolve_deadline − 5`: resolve ok; warp forward again → `timeout_refund` `[InvalidStatus]`;
/// finalize ok; exactly one payout.
#[test]
fn t9_clock_steps_back_exactly_one_payout() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let a_start = env.token_balance(&env.a_token);
    let b_start = env.token_balance(&env.b_token);
    let rd = env.bet(&id).resolve_deadline;
    env.set_now(rd + 50);
    env.set_now(rd - 5);
    assert_ok(&env.resolve(&id, Outcome::PartyA));
    env.set_now(rd + 100);
    let before = Snapshot::take(&env, &id);
    assert_escrow_err(&env.timeout_refund(&id), EscrowError::InvalidStatus);
    assert_err_at(
        &env.timeout_refund_bundled(&id),
        0,
        err_code(EscrowError::InvalidStatus),
    );
    assert_nothing_moved(&env, &before);
    let before = Snapshot::take(&env, &id);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    // Any later exit finds the Bet closed: no second payout.
    assert_err_at(&env.timeout_refund(&id), 0, ANCHOR_ACCOUNT_NOT_INITIALIZED);
    assert_eq!(env.token_balance(&env.a_token), a_start + 2 * USDC_5);
    assert_eq!(env.token_balance(&env.b_token), b_start);
}

// =============================================================================================
// L: close_bet
// =============================================================================================

/// L1: bundled `[finalize, close_bet]` with `payer == rent_payer == S` → ok; both accounts
/// gone; S Δ = `rent_returned` − fees; `BetFinalized` + `BetClosed` (TM-U3, TM-R4).
#[test]
fn l1_bundled_finalize_close_payer_is_rent_payer() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let c = env.default_close(&id);
    assert_eq!((c.payer, c.rent_payer), (env.s.pubkey(), env.s.pubkey()));
    let s_sol = env.sol(&env.s.pubkey());
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    assert_eq!(sent.keys[0], env.s.pubkey(), "S is the fee payer");
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    let closed = &events::<BetClosed>(sent)[0];
    assert_eq!(
        closed.rent_returned,
        before.bet_lamports + before.vault_lamports
    );
    assert_eq!(
        i128::from(env.sol(&env.s.pubkey())) - i128::from(s_sol),
        i128::from(closed.rent_returned) - i128::from(sent.meta.fee)
    );
    assert_eq!(events::<BetFinalized>(sent).len(), 1);
    assert!(!env.exists(&before.bet_addr) && !env.exists(&before.vault_addr));
}

/// L2: status Open / Locked / Resolved / Appealed → `[InvalidStatus]` each.
#[test]
fn l2_close_non_terminal_bet() {
    let mut env = Env::with_config();
    let ids = [bet_id(1), bet_id(2), bet_id(3), bet_id(4)];
    env.open_bet(ids[0]);
    env.locked_bet(ids[1]);
    env.resolved_bet(ids[2], Outcome::PartyA);
    env.appealed_bet(ids[3], Outcome::PartyA);
    for id in ids {
        let status = env.bet(&id).status;
        let before = Snapshot::take(&env, &id);
        assert_escrow_err(&env.close_bet(&id), EscrowError::InvalidStatus);
        // Also with A's account present (the residual path must not open a withdrawal).
        let mut c = env.default_close(&id);
        c.party_a_token = Some(env.a_token);
        let ix = env.ix_close_bet(&c);
        assert_escrow_err(&env.send_s(&[ix], &[]), EscrowError::InvalidStatus);
        assert_nothing_moved(&env, &before);
        assert_eq!(env.bet(&id).status, status);
    }
}

/// L3: `rent_payer` = Mallory → `[WrongRentPayer]`.
#[test]
fn l3_close_with_wrong_rent_payer() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.settled_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let m_sol = env.sol(&env.mallory.pubkey());
    let mut c = env.default_close(&id);
    c.rent_payer = env.mallory.pubkey();
    let ix = env.ix_close_bet(&c);
    assert_escrow_err(&env.send_s(&[ix], &[]), EscrowError::WrongRentPayer);
    assert_nothing_moved(&env, &before);
    assert_eq!(env.sol(&env.mallory.pubkey()), m_sol);
    assert_eq!(env.sol(&before.bet_addr), before.bet_lamports);
    assert_eq!(env.sol(&before.vault_addr), before.vault_lamports);
}

/// L4: `rent_payer` replaced by an executable account (a program deployed at the rent payer's
/// address) → bundled tx fails; standalone `finalize` ok (tokens paid); `close_bet` keeps
/// failing; the Bet stays `Settled` (TM-L4).
#[test]
fn l4_executable_rent_payer_does_not_block_payout() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    let r = Keypair::new();
    env.svm.airdrop(&r.pubkey(), 1_000_000_000).unwrap();
    locked_bet_paid_by(&mut env, id, &r);
    assert_ok(&env.resolve(&id, Outcome::PartyA));
    env.warp_to_appeal_deadline(&id);

    // The rent payer's key holder deploys a program at that address (set_account).
    let program = env.svm.get_account(&escrow::ID).unwrap();
    let mut exec = solana_account(
        env.sol(&r.pubkey()).max(program.lamports),
        program.data.clone(),
        program.owner,
    );
    exec.executable = true;
    env.svm.set_account(r.pubkey(), exec).unwrap();
    assert!(env.svm.get_account(&r.pubkey()).unwrap().executable);

    let before = Snapshot::take(&env, &id);
    assert_eq!(before.bet.rent_payer, r.pubkey());
    let res = env.finalize_bundled(&id);
    assert_failed(
        &res,
        "bundled [finalize, close_bet] with an executable rent_payer",
    );
    // The runtime refuses to credit the executable account inside close_bet (ix 1); the exact
    // error depends on feature gates (UnbalancedInstruction under LiteSVM 0.15).
    assert!(
        matches!(
            res.as_ref().err().map(|f| &f.err),
            Some(solana_transaction::TransactionError::InstructionError(1, _))
        ),
        "close_bet (ix 1) is what fails: {:?}",
        res.as_ref().err().map(|f| &f.err)
    );
    assert_nothing_moved(&env, &before);

    let res = env.finalize(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);

    let settled = Snapshot::take(&env, &id);
    for _ in 0..2 {
        assert_failed(
            &env.close_bet(&id),
            "close_bet with an executable rent_payer",
        );
        assert_nothing_moved(&env, &settled);
    }
    assert_eq!(env.bet(&id).status, BetStatus::Settled);
}

/// L5: 5 units donated after a standalone finalize: with `party_a_token` → ok, A +5,
/// `residual_to_a = 5`; without → `[MissingPayoutAccount]`.
#[test]
fn l5_residual_sweep_after_settlement() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.settled_bet(id, Outcome::PartyB);
    assert_ok(&env.donate_to_vault(&id, 5));
    let before = Snapshot::take(&env, &id);
    assert_eq!(before.v, 5);

    assert_escrow_err(&env.close_bet(&id), EscrowError::MissingPayoutAccount);
    assert_nothing_moved(&env, &before);
    // B's account is not a valid residual destination (A only, I1).
    let mut c = env.default_close(&id);
    c.party_a_token = Some(env.b_token);
    let ix = env.ix_close_bet(&c);
    assert_escrow_err(&env.send_s(&[ix], &[]), EscrowError::WrongPayoutAccount);
    assert_nothing_moved(&env, &before);

    let before = Snapshot::take(&env, &id);
    let mut c = env.default_close(&id);
    c.party_a_token = Some(env.a_token);
    let ix = env.ix_close_bet(&c);
    let res = env.send_s(&[ix], &[]);
    let sent = assert_ok(&res);
    let closed = assert_close_postconditions(&env, &before, sent, 5);
    assert_eq!(closed.residual_to_a, 5);
    assert_eq!(closed.final_status, BetStatus::Settled);
    assert_eq!(before.delta(&env, &env.a_token), 5);
}

/// L6: second close; lamports re-sent to the closed Bet address, then any bet ix →
/// `AccountNotInitialized` / owner mismatch (TM-D2).
#[test]
fn l6_closed_bet_cannot_be_revived() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.settled_bet(id, Outcome::PartyA);
    let before = Snapshot::take(&env, &id);
    let res = env.close_bet(&id);
    assert_close_postconditions(&env, &before, assert_ok(&res), 0);

    // Second close.
    assert_err(&env.close_bet(&id), ANCHOR_ACCOUNT_NOT_INITIALIZED);

    // Re-fund the closed Bet address (and the vault address), then try every bet ix.
    let s = kp(&env.s);
    let bet_addr = bet_pda(&id).0;
    let vault_addr = vault_pda(&id).0;
    assert_ok(&env.send_s(
        &[
            system_instruction::transfer(&s.pubkey(), &bet_addr, 5_000_000),
            system_instruction::transfer(&s.pubkey(), &vault_addr, 5_000_000),
        ],
        &[],
    ));
    let acc = env.svm.get_account(&bet_addr).unwrap();
    assert_eq!(acc.owner, anchor_lang::solana_program::system_program::ID);
    assert!(acc.data.is_empty());

    let a_bal = env.token_balance(&env.a_token);
    let b_bal = env.token_balance(&env.b_token);
    let (a, b, j, ap) = (kp(&env.a), kp(&env.b), kp(&env.judge), kp(&env.appeal));
    let p = env.default_payout(&id);
    let probes: Vec<(&str, Instruction, Vec<&Keypair>)> = vec![
        (
            "close_bet",
            env.ix_close_bet(&env.default_close(&id)),
            vec![],
        ),
        ("finalize", env.ix_finalize(&p), vec![]),
        ("timeout_refund", env.ix_timeout_refund(&p), vec![]),
        (
            "cancel_open_bet",
            env.ix_cancel_open_bet(a.pubkey(), &p),
            vec![&a],
        ),
        ("concede", env.ix_concede(b.pubkey(), &p), vec![&b]),
        (
            "resolve",
            env.ix_resolve(&env.default_resolve(&id), Outcome::PartyA, EVIDENCE, RULING),
            vec![&j],
        ),
        (
            "appeal",
            env.ix_appeal(&env.default_appeal(&id, a.pubkey())),
            vec![&a],
        ),
        (
            "resolve_appeal",
            env.ix_resolve_appeal(ap.pubkey(), &p, Outcome::PartyA, APPEAL_RULING),
            vec![&ap],
        ),
    ];
    for (name, ix, signers) in probes {
        let res = env.send_s(&[ix], &signers);
        assert_eq!(
            custom_code(&res),
            Some(ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM),
            "{name} on a re-funded closed Bet: {:?}",
            res.as_ref().err().map(|f| &f.err)
        );
    }
    assert_eq!(env.token_balance(&env.a_token), a_bal);
    assert_eq!(env.token_balance(&env.b_token), b_bal);
    assert_eq!(
        env.sol(&bet_addr),
        5_000_000,
        "nobody can take the re-sent lamports"
    );
}

/// L7: Mallory as payer → ok; rent → S.
#[test]
fn l7_mallory_pays_close_rent_to_s() {
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.settled_bet(id, Outcome::Split);
    let before = Snapshot::take(&env, &id);
    let m = kp(&env.mallory);
    let mut c = env.default_close(&id);
    c.payer = m.pubkey();
    let ix = env.ix_close_bet(&c);
    let m_sol = env.sol(&m.pubkey());
    let s_sol = env.sol(&env.s.pubkey());
    let res = env.send(&[ix], &m, &[]);
    let sent = assert_ok(&res);
    let closed = assert_close_postconditions(&env, &before, sent, 0);
    assert_eq!(closed.rent_payer, env.s.pubkey());
    assert_eq!(env.sol(&env.s.pubkey()), s_sol + closed.rent_returned);
    assert_eq!(
        env.sol(&m.pubkey()),
        m_sol - sent.meta.fee,
        "Mallory only paid the fee"
    );
}

// =============================================================================================
// T22-1: Token-2022 lifecycle
// =============================================================================================

/// T22-1: full lifecycle with a Token-2022 mint: create → accept (atomic shape) → resolve →
/// finalize, bundled with close_bet → ok; vault closes; balances exact. Also the other exit a
/// Locked Token-2022 bet can take without the judge: timeout_refund + close_bet.
#[test]
fn t22_1_token_2022_full_lifecycle_finalize() {
    let mut env = Env::with_config();
    let (mint, a_tok, b_tok) = t22_setup(&mut env);
    let id = bet_id(1);
    t22_resolved_bet(&mut env, id, mint, a_tok, b_tok, Outcome::PartyA);
    assert_eq!(env.token_balance(&vault_pda(&id).0), 2 * USDC_5);
    assert_eq!(
        env.svm.get_account(&vault_pda(&id).0).unwrap().owner,
        TOKEN_2022
    );
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take_with(&env, &id, &[a_tok, b_tok]);
    // default_payout leaves the destinations None for a non-USDC mint: name them here.
    let mut p = env.default_payout(&id);
    assert_eq!(p.token_program, TOKEN_2022);
    p.party_a_token = Some(a_tok);
    p.party_b_token = Some(b_tok);
    let ix = env.ix_finalize(&p);
    let res = env.send_bundled(&id, ix, &[]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.mint, mint);
    assert_eq!(ev.party_a_token, a_tok);
    assert_eq!(env.token_balance(&a_tok), FUNDED + USDC_5);
    assert_eq!(env.token_balance(&b_tok), FUNDED - USDC_5);
    assert!(!env.exists(&before.vault_addr), "vault closed");
    assert!(!env.exists(&before.bet_addr), "Bet closed");

    // timeout_refund on a Locked Token-2022 bet, bundled with close_bet.
    let id = bet_id(2);
    let (c, mut ca) = env.default_create(id);
    ca.mint = mint;
    ca.party_a_token = a_tok;
    ca.token_program = TOKEN_2022;
    let (aa, mut acc) = env.default_accept(&c, &ca);
    acc.party_b_token = b_tok;
    let ixs = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let (a, b) = (kp(&env.a), kp(&env.b));
    assert_ok(&env.send_s(&ixs, &[&a, &b]));
    env.warp_to_resolve_deadline(&id);
    let before = Snapshot::take_with(&env, &id, &[a_tok, b_tok]);
    let mut p = env.default_payout(&id);
    p.party_a_token = Some(a_tok);
    p.party_b_token = Some(b_tok);
    let ix = env.ix_timeout_refund(&p);
    let res = env.send_bundled(&id, ix, &[]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Refunded, Outcome::Refund, USDC_5, USDC_5);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.mint, mint);
    assert_eq!(env.token_balance(&a_tok), FUNDED + USDC_5);
    assert_eq!(env.token_balance(&b_tok), FUNDED - USDC_5);
    assert!(!env.exists(&before.vault_addr));
    assert!(!env.exists(&before.bet_addr));
}
