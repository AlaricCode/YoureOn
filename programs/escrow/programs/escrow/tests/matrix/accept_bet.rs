//! ESCROW §9.2 rows A1–A12.

use anchor_lang::prelude::Pubkey;
use escrow::{BetAccepted, BetStatus, EscrowError, UpdateConfigArgs};
use solana_signer::Signer;

use crate::common::*;

#[test]
fn a1_accept_ok_locked_event() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    env.set_now(NOW + 42);
    let b_bal = env.token_balance(&env.b_token);
    let b_sol = env.sol(&env.b.pubkey());
    let (aa, acc) = env.default_accept(&c, &ca);
    let res = env.accept_bet(&aa, &acc);
    let sent = assert_ok(&res);
    let bet = env.bet(&c.bet_id);
    assert_eq!(bet.status, BetStatus::Locked);
    assert_eq!(bet.locked_at, NOW + 42);
    assert_eq!(bet.resolve_deadline, NOW + 42 + 3600);
    assert_eq!(env.token_balance(&ca.vault), 2 * USDC_5);
    assert_eq!(env.token_balance(&env.b_token), b_bal - USDC_5);
    assert_eq!(env.sol(&env.b.pubkey()), b_sol);
    // nothing else changed
    assert_eq!(bet.terms_hash, TERMS);
    assert_eq!((bet.stake_a, bet.stake_b), (USDC_5, USDC_5));
    assert_eq!(bet.created_at, NOW);

    let evs = events::<BetAccepted>(sent);
    assert_eq!(evs.len(), 1);
    assert_eq!(event_count(sent), 1);
    let e = &evs[0];
    assert_eq!(e.bet_id, c.bet_id);
    assert_eq!(e.party_a, env.a.pubkey());
    assert_eq!(e.party_b, env.b.pubkey());
    assert_eq!(e.terms_hash, TERMS);
    assert_eq!((e.stake_a, e.stake_b), (USDC_5, USDC_5));
    assert_eq!(e.vault_amount, 2 * USDC_5);
    assert_eq!(e.resolve_deadline, NOW + 42 + 3600);
    assert_eq!(e.ts, NOW + 42);
    assert_no_log_truncation(sent);
}

#[test]
fn a2_wrong_terms_hash() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let b_bal = env.token_balance(&env.b_token);
    let (mut aa, acc) = env.default_accept(&c, &ca);
    aa.expected_terms_hash = [8u8; 32];
    assert_escrow_err(&env.accept_bet(&aa, &acc), EscrowError::TermsHashMismatch);
    assert_eq!(env.token_balance(&env.b_token), b_bal);
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Open);
}

#[test]
fn a3_wrong_expected_stakes() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    let mut x = aa.clone();
    x.expected_stake_a = USDC_5 - 1;
    assert_escrow_err(&env.accept_bet(&x, &acc), EscrowError::StakeMismatch);
    let mut x = aa.clone();
    x.expected_stake_b = USDC_5 + 1;
    assert_escrow_err(&env.accept_bet(&x, &acc), EscrowError::StakeMismatch);
}

#[test]
fn a4_mallory_signs_as_b() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let (aa, mut acc) = env.default_accept(&c, &ca);
    acc.party_b = env.mallory.pubkey();
    acc.party_b_token = env.mallory_token;
    let mallory = env.mallory.insecure_clone();
    assert_escrow_err(
        &env.accept_bet_as(&aa, &acc, &mallory),
        EscrowError::NotPartyB,
    );
    assert_eq!(env.token_balance(&env.mallory_token), FUNDED);
}

#[test]
fn a5_accept_deadline_half_open() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let (c2, ca2) = env.open_bet(bet_id(2));
    let deadline = env.bet(&c.bet_id).accept_deadline;
    env.set_now(deadline - 1);
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_ok(&env.accept_bet(&aa, &acc));
    env.set_now(deadline);
    let (aa2, acc2) = env.default_accept(&c2, &ca2);
    assert_escrow_err(
        &env.accept_bet(&aa2, &acc2),
        EscrowError::AcceptDeadlinePassed,
    );
}

#[test]
fn a6_second_accept() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_ok(&env.accept_bet(&aa, &acc));
    let b_bal = env.token_balance(&env.b_token);
    assert_escrow_err(&env.accept_bet(&aa, &acc), EscrowError::InvalidStatus);
    assert_eq!(env.token_balance(&env.b_token), b_bal);
}

#[test]
fn a7_after_cancel_and_after_close() {
    // `cancel_open_bet` / `close_bet` are D1: the states they leave are written directly.
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    for st in [
        BetStatus::Cancelled,
        BetStatus::Refunded,
        BetStatus::Settled,
        BetStatus::Resolved,
        BetStatus::Appealed,
    ] {
        env.force_status(&c.bet_id, st);
        assert_escrow_err(&env.accept_bet(&aa, &acc), EscrowError::InvalidStatus);
    }
    // closed: Bet account gone
    let mut acc_data = env.svm.get_account(&ca.bet).unwrap();
    acc_data.lamports = 0;
    env.svm.set_account(ca.bet, acc_data).unwrap();
    assert!(!env.exists(&ca.bet));
    assert_err(&env.accept_bet(&aa, &acc), ANCHOR_ACCOUNT_NOT_INITIALIZED);
}

#[test]
fn a8_vault_of_another_bet() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let (_c2, ca2) = env.open_bet(bet_id(2));
    let (aa, mut acc) = env.default_accept(&c, &ca);
    acc.vault = ca2.vault;
    assert_err(&env.accept_bet(&aa, &acc), ANCHOR_CONSTRAINT_SEEDS);
}

#[test]
fn a9_party_b_token_wrong_mint_or_owner() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let other = env.create_mint(6, CLASSIC_TOKEN);
    let b_other = env.create_token_account(other, env.b.pubkey(), FUNDED, CLASSIC_TOKEN);
    let (aa, mut acc) = env.default_accept(&c, &ca);
    acc.party_b_token = b_other;
    assert_err(&env.accept_bet(&aa, &acc), ANCHOR_CONSTRAINT_TOKEN_MINT);
    acc.party_b_token = env.mallory_token;
    assert_err(&env.accept_bet(&aa, &acc), ANCHOR_CONSTRAINT_TOKEN_OWNER);
    assert_eq!(env.token_balance(&env.mallory_token), FUNDED);
}

#[test]
fn a10_different_allowlisted_mint() {
    let mut env = Env::with_config();
    let usdc2 = env.create_mint(6, CLASSIC_TOKEN);
    let b2 = env.create_token_account(usdc2, env.b.pubkey(), FUNDED, CLASSIC_TOKEN);
    assert_ok(&env.update_config(&UpdateConfigArgs {
        allowed_mints: Some(vec![env.usdc, usdc2]),
        ..Default::default()
    }));
    let (c, ca) = env.open_bet(bet_id(1));
    let (aa, mut acc) = env.default_accept(&c, &ca);
    acc.mint = usdc2;
    acc.party_b_token = b2;
    assert_escrow_err(&env.accept_bet(&aa, &acc), EscrowError::WrongMint);
}

#[test]
fn a11_expected_party_a_mismatch() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let (mut aa, acc) = env.default_accept(&c, &ca);
    aa.expected_party_a = Pubkey::new_unique();
    assert_escrow_err(&env.accept_bet(&aa, &acc), EscrowError::PartyMismatch);
}

#[test]
fn a12_donation_while_open_does_not_mask_deposit() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    // A real SPL transfer from Mallory's account into the vault (not a state write).
    let mallory = env.mallory.insecure_clone();
    let (m_tok, usdc) = (env.mallory_token, env.usdc);
    assert_ok(&env.transfer_tokens(m_tok, &mallory, ca.vault, usdc, 7, CLASSIC_TOKEN));
    assert_eq!(env.token_balance(&ca.vault), USDC_5 + 7);
    assert_eq!(env.token_balance(&env.mallory_token), FUNDED - 7);
    let b_bal = env.token_balance(&env.b_token);
    let (aa, acc) = env.default_accept(&c, &ca);
    let res = env.accept_bet(&aa, &acc);
    let sent = assert_ok(&res);
    // B's delta is exactly stake_b; the donation stays in the vault on top of the pot.
    assert_eq!(env.token_balance(&env.b_token), b_bal - USDC_5);
    assert_eq!(env.token_balance(&ca.vault), 2 * USDC_5 + 7);
    assert_eq!(events::<BetAccepted>(sent)[0].vault_amount, 2 * USDC_5 + 7);
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Locked);
}
