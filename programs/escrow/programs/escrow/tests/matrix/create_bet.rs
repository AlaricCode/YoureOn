//! ESCROW §9.2 rows B1–B12, B15–B20, B22 (D0-L2 DoD) plus Token-2022 rows B13, B14 and part
//! of B21 (P1 extension allowlist).

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_instruction},
};
use anchor_spl::token_interface::{
    spl_token_2022::{
        self,
        extension::{
            confidential_transfer, default_account_state, interest_bearing_mint, metadata_pointer,
            pausable, scaled_ui_amount, transfer_fee, transfer_hook, BaseStateWithExtensions,
            ExtensionType, StateWithExtensions,
        },
        state::AccountState,
    },
    spl_token_metadata_interface,
};
use escrow::{BetCreated, BetStatus, EscrowError, UpdateConfigArgs};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::{InstructionError, TransactionError};

use crate::common::*;

#[test]
fn b1_create_ok_snapshots_and_event() {
    let mut env = Env::with_config();
    let (c, ca) = env.default_create(bet_id(1));
    let a_sol = env.sol(&env.a.pubkey());
    let s_sol = env.sol(&env.s.pubkey());
    let a_bal = env.token_balance(&env.a_token);
    let res = env.create_bet(&c, &ca);
    let sent = assert_ok(&res);

    let bet = env.bet(&c.bet_id);
    assert_eq!(bet.status, BetStatus::Open);
    assert_eq!(bet.bet_id, c.bet_id);
    assert_eq!(bet.party_a, env.a.pubkey());
    assert_eq!(bet.party_b, env.b.pubkey());
    assert_eq!(bet.mint, env.usdc);
    assert_eq!(bet.rent_payer, env.s.pubkey());
    assert_eq!(bet.judge_authority, env.judge.pubkey());
    assert_eq!(bet.appeal_authority, env.appeal.pubkey());
    assert_eq!(bet.stake_a, USDC_5);
    assert_eq!(bet.stake_b, USDC_5);
    assert_eq!(bet.terms_hash, TERMS);
    assert_eq!(bet.evidence_hash, [0u8; 32]);
    assert_eq!(bet.ruling_hash, [0u8; 32]);
    assert_eq!(bet.outcome, None);
    assert_eq!(bet.appeal_window_secs, 10);
    assert_eq!(bet.resolve_window_secs, 3600);
    assert_eq!(bet.appeal_resolve_secs, 300);
    assert_eq!(bet.created_at, NOW);
    assert_eq!(bet.accept_deadline, NOW + 300);
    assert_eq!(
        (
            bet.locked_at,
            bet.resolve_deadline,
            bet.resolved_at,
            bet.appeal_deadline,
            bet.appealed_at,
            bet.appeal_resolve_deadline
        ),
        (0, 0, 0, 0, 0, 0)
    );
    assert_eq!(env.token_balance(&ca.vault), USDC_5);
    assert_eq!(env.token_balance(&env.a_token), a_bal - USDC_5);
    // A holds no SOL and pays nothing; S pays fees + rent
    assert_eq!(env.sol(&env.a.pubkey()), a_sol);
    assert_eq!(a_sol, 0);
    assert!(env.sol(&env.s.pubkey()) < s_sol);
    // §3.2: 8 + 401 = 409 bytes
    assert_eq!(env.svm.get_account(&ca.bet).unwrap().data.len(), 409);
    // vault is a classic token account owned by the token program, authority = Bet PDA
    let vault = env.svm.get_account(&ca.vault).unwrap();
    assert_eq!(vault.owner, CLASSIC_TOKEN);
    assert_eq!(vault.data.len(), 165);

    let evs = events::<BetCreated>(sent);
    assert_eq!(evs.len(), 1);
    assert_eq!(event_count(sent), 1);
    let e = &evs[0];
    assert_eq!(e.bet_id, c.bet_id);
    assert_eq!(e.bet, ca.bet);
    assert_eq!(e.vault, ca.vault);
    assert_eq!(e.party_a, env.a.pubkey());
    assert_eq!(e.party_b, env.b.pubkey());
    assert_eq!(e.mint, env.usdc);
    assert_eq!((e.stake_a, e.stake_b), (USDC_5, USDC_5));
    assert_eq!(e.terms_hash, TERMS);
    assert_eq!(e.judge_authority, env.judge.pubkey());
    assert_eq!(e.appeal_authority, env.appeal.pubkey());
    assert_eq!(e.accept_deadline, NOW + 300);
    assert_eq!(e.rent_payer, env.s.pubkey());
    assert_eq!(e.ts, NOW);
    assert_no_log_truncation(sent);
}

#[test]
fn b2_stake_above_max_and_boundary() {
    let mut env = Env::with_config();
    let (mut c, ca) = env.default_create(bet_id(1));
    c.stake_a = MAX_STAKE + 1;
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::StakeExceedsMax);
    c.stake_a = USDC_5;
    c.stake_b = MAX_STAKE + 1;
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::StakeExceedsMax);
    c.stake_a = MAX_STAKE;
    c.stake_b = MAX_STAKE;
    assert_ok(&env.create_bet(&c, &ca));
    assert_eq!(env.token_balance(&ca.vault), MAX_STAKE);
}

#[test]
fn b3_stake_zero_either_side() {
    let mut env = Env::with_config();
    let (mut c, ca) = env.default_create(bet_id(1));
    c.stake_a = 0;
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::StakeZero);
    c.stake_a = USDC_5;
    c.stake_b = 0;
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::StakeZero);
    assert!(!env.exists(&ca.bet));
}

#[test]
fn b4_mint_not_allowlisted() {
    let mut env = Env::with_config();
    let other = env.create_mint(6, CLASSIC_TOKEN);
    let a_other = env.create_token_account(other, env.a.pubkey(), FUNDED, CLASSIC_TOKEN);
    let (c, mut ca) = env.default_create(bet_id(1));
    ca.mint = other;
    ca.party_a_token = a_other;
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::MintNotAllowed);
    assert!(!env.exists(&ca.bet));
    assert_eq!(env.token_balance(&a_other), FUNDED);
}

#[test]
fn b5_party_a_token_of_another_mint() {
    let mut env = Env::with_config();
    let other = env.create_mint(6, CLASSIC_TOKEN);
    let a_other = env.create_token_account(other, env.a.pubkey(), FUNDED, CLASSIC_TOKEN);
    let (c, mut ca) = env.default_create(bet_id(1));
    ca.party_a_token = a_other;
    assert_err(&env.create_bet(&c, &ca), ANCHOR_CONSTRAINT_TOKEN_MINT);
}

#[test]
fn b6_party_a_token_owned_by_mallory() {
    let mut env = Env::with_config();
    let (c, mut ca) = env.default_create(bet_id(1));
    ca.party_a_token = env.mallory_token;
    assert_err(&env.create_bet(&c, &ca), ANCHOR_CONSTRAINT_TOKEN_OWNER);
    assert_eq!(env.token_balance(&env.mallory_token), FUNDED);
}

#[test]
fn b7_same_party_and_default_party() {
    let mut env = Env::with_config();
    let (mut c, ca) = env.default_create(bet_id(1));
    c.party_b = env.a.pubkey();
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::SameParty);
    c.party_b = Pubkey::default();
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::InvalidParty);
    assert!(!env.exists(&ca.bet));
}

#[test]
fn b8_empty_terms_hash() {
    let mut env = Env::with_config();
    let (mut c, ca) = env.default_create(bet_id(1));
    c.terms_hash = [0u8; 32];
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::EmptyHash);
}

#[test]
fn b9_duplicate_live_bet_id() {
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let a_bal = env.token_balance(&env.a_token);
    let mut c2 = c.clone();
    c2.terms_hash = [9u8; 32];
    assert_already_in_use(&env.create_bet(&c2, &ca));
    assert_eq!(env.token_balance(&env.a_token), a_bal);
    assert_eq!(env.bet(&c.bet_id).terms_hash, TERMS);
}

#[test]
fn b10_insufficient_usdc() {
    let mut env = Env::with_config();
    let poor = env.create_token_account(env.usdc, env.a.pubkey(), USDC_5 - 1, CLASSIC_TOKEN);
    let (c, mut ca) = env.default_create(bet_id(1));
    ca.party_a_token = poor;
    let res = env.create_bet(&c, &ca);
    // SPL Token TokenError::InsufficientFunds = 1
    assert_err(&res, 1);
    assert!(res
        .as_ref()
        .err()
        .unwrap()
        .meta
        .logs
        .iter()
        .any(|l| l.contains("insufficient funds")));
    assert!(!env.exists(&ca.bet));
    assert!(!env.exists(&ca.vault));
    assert_eq!(env.token_balance(&poor), USDC_5 - 1);
}

#[test]
fn b11_wrong_or_fake_token_program() {
    let mut env = Env::with_config();
    let (c, mut ca) = env.default_create(bet_id(1));
    ca.token_program = TOKEN_2022;
    // Matrix row says ConstraintMintTokenProgram. Anchor 1.2.2 runs `init` fields before the
    // non-init constraint checks, so the vault's InitializeAccount3 CPI to Token-2022 rejects
    // the classic mint first. Pinned to the observed error (§8.1); the tx fails either way.
    let res = env.create_bet(&c, &ca);
    assert_eq!(
        res.as_ref().err().map(|f| f.err.clone()),
        Some(TransactionError::InstructionError(
            0,
            InstructionError::IncorrectProgramId
        ))
    );
    assert!(res
        .as_ref()
        .err()
        .unwrap()
        .meta
        .logs
        .iter()
        .any(|l| l.contains("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed")));
    assert!(!env.exists(&ca.bet));
    // The reverse (Token-2022 mint, classic program) fails the same way in the classic program.
    let (mut env, mint, a_tok) = t22_env_with(&[]);
    let (c, mut ca) = env.default_create(bet_id(1));
    ca.mint = mint;
    ca.party_a_token = a_tok;
    ca.token_program = CLASSIC_TOKEN;
    let res = env.create_bet(&c, &ca);
    assert_eq!(
        res.as_ref().err().map(|f| f.err.clone()),
        Some(TransactionError::InstructionError(
            0,
            InstructionError::IncorrectProgramId
        ))
    );
    // a "token program" that isn't SPL Token / Token-2022
    ca.token_program = escrow::ID;
    assert_err(&env.create_bet(&c, &ca), ANCHOR_INVALID_PROGRAM_ID);
    assert!(!env.exists(&ca.bet));
}

#[test]
fn b12_party_a_signature_missing() {
    let mut env = Env::with_config();
    let (c, ca) = env.default_create(bet_id(1));
    // (a) A's key passed but not marked as signer
    let mut ix = env.ix_create_bet(&c, &ca);
    unsign(&mut ix, &env.a.pubkey());
    let s = env.s.insecure_clone();
    assert_err(&env.send(&[ix], &s, &[]), ANCHOR_ACCOUNT_NOT_SIGNER);
    // (b) A marked as signer but the signature is garbage: rejected before execution
    let ix = env.ix_create_bet(&c, &ca);
    let blockhash = env.svm.latest_blockhash();
    let msg = solana_message::Message::new_with_blockhash(&[ix], Some(&s.pubkey()), &blockhash);
    let mut tx = solana_transaction::versioned::VersionedTransaction::try_new(
        solana_message::VersionedMessage::Legacy(msg),
        &[&s, &env.a],
    )
    .unwrap();
    tx.signatures[1] = solana_transaction::Signature::default();
    let res = env.svm.send_transaction(tx);
    assert_eq!(
        res.unwrap_err().err,
        solana_transaction::TransactionError::SignatureFailure
    );
    assert!(!env.exists(&ca.bet));
}

#[test]
fn b15_party_b_is_own_bet_or_vault_pda() {
    let mut env = Env::with_config();
    let (mut c, ca) = env.default_create(bet_id(1));
    c.party_b = ca.bet;
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::InvalidParty);
    c.party_b = ca.vault;
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::InvalidParty);
}

#[test]
fn b16_party_is_config_authority() {
    let mut env = Env::with_config();
    // party_b = judge / appeal
    for k in [env.judge.pubkey(), env.appeal.pubkey()] {
        let (mut c, ca) = env.default_create(bet_id(1));
        c.party_b = k;
        assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::InvalidParty);
    }
    // party_a = judge / appeal (signing with their own funded token account)
    for kp in [env.judge.insecure_clone(), env.appeal.insecure_clone()] {
        let tok = env.create_token_account(env.usdc, kp.pubkey(), FUNDED, CLASSIC_TOKEN);
        let (c, mut ca) = env.default_create(bet_id(2));
        ca.party_a = kp.pubkey();
        ca.party_a_token = tok;
        let ix = env.ix_create_bet(&c, &ca);
        let s = env.s.insecure_clone();
        assert_escrow_err(&env.send(&[ix], &s, &[&kp]), EscrowError::InvalidParty);
    }
}

#[test]
fn b17_wrong_decimals() {
    let mut env = Env::with_config();
    let nine = env.create_mint(9, CLASSIC_TOKEN);
    let a9 = env.create_token_account(nine, env.a.pubkey(), FUNDED, CLASSIC_TOKEN);
    assert_ok(&env.update_config(&UpdateConfigArgs {
        allowed_mints: Some(vec![env.usdc, nine]),
        ..Default::default()
    }));
    let (c, mut ca) = env.default_create(bet_id(1));
    ca.mint = nine;
    ca.party_a_token = a9;
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::WrongDecimals);
}

#[test]
fn b18_lamports_presented_to_pdas() {
    let mut env = Env::with_config();
    let (c, ca) = env.default_create(bet_id(1));
    let mallory = env.mallory.insecure_clone();
    let extra = 1_234_567;
    let ixs = [
        system_instruction::transfer(&mallory.pubkey(), &ca.bet, extra),
        system_instruction::transfer(&mallory.pubkey(), &ca.vault, extra),
    ];
    assert_ok(&env.send(&ixs, &mallory, &[]));
    let s_before = env.sol(&env.s.pubkey());
    let sent = env.create_bet(&c, &ca);
    let fee = assert_ok(&sent).meta.fee;
    let bet_acc = env.svm.get_account(&ca.bet).unwrap();
    let vault_acc = env.svm.get_account(&ca.vault).unwrap();
    let (bet_rent, vault_rent) = (
        env.svm.minimum_balance_for_rent_exemption(409),
        env.svm.minimum_balance_for_rent_exemption(165),
    );
    assert!(
        extra < bet_rent && extra < vault_rent,
        "fixture: partial pre-fund"
    );
    assert_eq!(bet_acc.owner, escrow::ID);
    assert_eq!(vault_acc.owner, CLASSIC_TOKEN);
    // Anchor's funded-init path tops up to exactly rent-exempt (no overfunding, no failure)...
    assert_eq!(bet_acc.lamports, bet_rent);
    assert_eq!(vault_acc.lamports, vault_rent);
    // ...so S paid only the difference: Mallory's lamports count toward the rent S gets back.
    assert_eq!(
        s_before - env.sol(&env.s.pubkey()),
        fee + (bet_rent - extra) + (vault_rent - extra)
    );
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Open);
    assert_eq!(env.token_balance(&ca.vault), USDC_5);
}

#[test]
fn b19_squat_front_run() {
    let mut env = Env::with_config();
    let (c, ca) = env.default_create(bet_id(1));
    // Mallory front-runs with A's bet_id, herself as party_a, the same terms and stakes.
    let mallory = env.mallory.insecure_clone();
    let mut m_accts = ca.clone();
    m_accts.payer = mallory.pubkey();
    m_accts.party_a = mallory.pubkey();
    m_accts.party_a_token = env.mallory_token;
    let ix = env.ix_create_bet(&c, &m_accts);
    assert_ok(&env.send(&[ix], &mallory, &[]));
    // A's create → already in use
    assert_already_in_use(&env.create_bet(&c, &ca));
    // B's accept with expected_party_a = A → PartyMismatch; B's balance unchanged
    let b_bal = env.token_balance(&env.b_token);
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_eq!(aa.expected_party_a, env.a.pubkey());
    assert_escrow_err(&env.accept_bet(&aa, &acc), EscrowError::PartyMismatch);
    assert_eq!(env.token_balance(&env.b_token), b_bal);
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Open);
}

#[test]
fn b20_pda_integrity_canonical_bumps() {
    let mut env = Env::with_config();
    for n in 0..20u8 {
        let mut id = bet_id(n);
        id[1] = n.wrapping_mul(37);
        let (c, ca) = env.default_create(id);
        assert_ok(&env.create_bet(&c, &ca));
        let bet = env.bet(&id);
        assert_eq!(bet.bet_id, id);
        let (bet_addr, bet_bump) = bet_pda(&id);
        let (vault_addr, vault_bump) = vault_pda(&id);
        assert_eq!(bet.bump, bet_bump, "canonical bet bump");
        assert_eq!(bet.vault_bump, vault_bump, "canonical vault bump");
        assert_eq!(
            Pubkey::create_program_address(
                &[escrow::BET_SEED, &bet.bet_id, &[bet.bump]],
                &escrow::ID
            )
            .unwrap(),
            bet_addr
        );
        assert_eq!(
            Pubkey::create_program_address(
                &[escrow::VAULT_SEED, &bet.bet_id, &[bet.vault_bump]],
                &escrow::ID
            )
            .unwrap(),
            vault_addr
        );
        // After accept too (nothing rewrites the id or bumps)
        let (aa, acc) = env.default_accept(&c, &ca);
        assert_ok(&env.accept_bet(&aa, &acc));
        let after = env.bet(&id);
        assert_eq!(
            (after.bet_id, after.bump, after.vault_bump),
            (id, bet_bump, vault_bump)
        );
    }
}

#[test]
fn b22_accept_deadline_bounds() {
    let mut env = Env::with_config();
    let now = env.now();
    let cases = [
        (now, Some(EscrowError::InvalidDeadline)),
        (now - 1, Some(EscrowError::InvalidDeadline)),
        (now + 601, Some(EscrowError::InvalidDeadline)),
        (now + 600, None),
        (now + 60, None),
    ];
    for (i, (deadline, expect)) in cases.iter().enumerate() {
        let (mut c, ca) = env.default_create(bet_id(i as u8));
        c.accept_deadline = *deadline;
        let res = env.create_bet(&c, &ca);
        match expect {
            Some(e) => assert_escrow_err(&res, *e),
            None => {
                assert_ok(&res);
                assert_eq!(env.bet(&c.bet_id).accept_deadline, *deadline);
            }
        }
    }
    // the `now + 60` bet: accept at now + 60 → AcceptDeadlinePassed (TM-T6)
    let (c, ca) = env.default_create(bet_id(4));
    env.set_now(now + 60);
    let (mut aa, acc) = env.default_accept(&c, &ca);
    aa.expected_party_a = env.a.pubkey();
    assert_escrow_err(
        &env.accept_bet(&aa, &acc),
        EscrowError::AcceptDeadlinePassed,
    );
}

// ---------------- Token-2022 (P1 extension allowlist) ----------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum Ext {
    PermanentDelegate,
    TransferFee,
    NonTransferable,
    MintCloseAuthority,
    MetadataPointer,
    /// MetadataPointer (to the mint itself) + the TokenMetadata TLV, initialized after the mint.
    TokenMetadata,
    TransferHook,
    DefaultAccountStateFrozen,
    Pausable,
    ScaledUiAmount,
    InterestBearing,
    ConfidentialTransferMint,
}

fn ext_type(e: Ext) -> ExtensionType {
    match e {
        Ext::PermanentDelegate => ExtensionType::PermanentDelegate,
        Ext::TransferFee => ExtensionType::TransferFeeConfig,
        Ext::NonTransferable => ExtensionType::NonTransferable,
        Ext::MintCloseAuthority => ExtensionType::MintCloseAuthority,
        Ext::MetadataPointer => ExtensionType::MetadataPointer,
        Ext::TokenMetadata => ExtensionType::TokenMetadata,
        Ext::TransferHook => ExtensionType::TransferHook,
        Ext::DefaultAccountStateFrozen => ExtensionType::DefaultAccountState,
        Ext::Pausable => ExtensionType::Pausable,
        Ext::ScaledUiAmount => ExtensionType::ScaledUiAmount,
        Ext::InterestBearing => ExtensionType::InterestBearingConfig,
        Ext::ConfidentialTransferMint => ExtensionType::ConfidentialTransferMint,
    }
}

/// A real Token-2022 mint (6 dp) built by the Token-2022 program itself with `exts`.
fn create_t22_mint(env: &mut Env, exts: &[Ext]) -> Pubkey {
    let mint = Keypair::new();
    let auth = Keypair::new();
    let with_metadata = exts.contains(&Ext::TokenMetadata);
    // The fixed-size TLVs present at InitializeMint (TokenMetadata is variable-length, added after).
    let mut fixed: Vec<ExtensionType> = exts
        .iter()
        .filter(|e| **e != Ext::TokenMetadata)
        .map(|e| ext_type(*e))
        .collect();
    if with_metadata && !fixed.contains(&ExtensionType::MetadataPointer) {
        fixed.push(ExtensionType::MetadataPointer);
    }
    let space =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&fixed).unwrap();
    // Token-2022 reallocs for TokenMetadata but does not fund it: pre-fund generously.
    let lamports = env.svm.minimum_balance_for_rent_exemption(space + 1024);
    let s = env.s.insecure_clone();
    let (m, a) = (mint.pubkey(), auth.pubkey());
    let mut ixs: Vec<Instruction> = vec![system_instruction::create_account(
        &s.pubkey(),
        &m,
        lamports,
        space as u64,
        &TOKEN_2022,
    )];
    for t in &fixed {
        ixs.push(match t {
            ExtensionType::PermanentDelegate => {
                spl_token_2022::instruction::initialize_permanent_delegate(&TOKEN_2022, &m, &a)
                    .unwrap()
            }
            ExtensionType::TransferFeeConfig => {
                transfer_fee::instruction::initialize_transfer_fee_config(
                    &TOKEN_2022,
                    &m,
                    Some(&a),
                    Some(&a),
                    100,
                    1_000_000,
                )
                .unwrap()
            }
            ExtensionType::NonTransferable => {
                spl_token_2022::instruction::initialize_non_transferable_mint(&TOKEN_2022, &m)
                    .unwrap()
            }
            ExtensionType::MintCloseAuthority => {
                spl_token_2022::instruction::initialize_mint_close_authority(
                    &TOKEN_2022,
                    &m,
                    Some(&a),
                )
                .unwrap()
            }
            ExtensionType::MetadataPointer => {
                metadata_pointer::instruction::initialize(&TOKEN_2022, &m, Some(a), Some(m))
                    .unwrap()
            }
            ExtensionType::TransferHook => transfer_hook::instruction::initialize(
                &TOKEN_2022,
                &m,
                Some(a),
                Some(Pubkey::new_unique()),
            )
            .unwrap(),
            ExtensionType::DefaultAccountState => {
                default_account_state::instruction::initialize_default_account_state(
                    &TOKEN_2022,
                    &m,
                    &AccountState::Frozen,
                )
                .unwrap()
            }
            ExtensionType::Pausable => {
                pausable::instruction::initialize(&TOKEN_2022, &m, &a).unwrap()
            }
            ExtensionType::ScaledUiAmount => {
                scaled_ui_amount::instruction::initialize(&TOKEN_2022, &m, Some(a), 2.0).unwrap()
            }
            ExtensionType::InterestBearingConfig => {
                interest_bearing_mint::instruction::initialize(&TOKEN_2022, &m, Some(a), 500)
                    .unwrap()
            }
            ExtensionType::ConfidentialTransferMint => {
                confidential_transfer::instruction::initialize_mint(
                    &TOKEN_2022,
                    &m,
                    Some(a),
                    false,
                    None,
                )
                .unwrap()
            }
            other => panic!("fixture has no initializer for {other:?}"),
        });
    }
    // A freeze authority is allowed (Circle's USDC has one) and DefaultAccountState needs it.
    ixs.push(
        spl_token_2022::instruction::initialize_mint2(&TOKEN_2022, &m, &a, Some(&a), 6).unwrap(),
    );
    assert_ok(&env.send(&ixs, &s, &[&mint]));
    if with_metadata {
        let ix = spl_token_metadata_interface::instruction::initialize(
            &TOKEN_2022,
            &m,
            &a,
            &m,
            &a,
            "You're On Test USD".to_string(),
            "YOTUSD".to_string(),
            "https://example.invalid/yot.json".to_string(),
        );
        assert_ok(&env.send(&[ix], &s, &[&auth]));
    }
    let acc = env.svm.get_account(&m).unwrap();
    let st = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&acc.data).unwrap();
    let mut want = fixed.clone();
    if with_metadata {
        want.push(ExtensionType::TokenMetadata);
    }
    assert_eq!(st.get_extension_types().unwrap(), want);
    assert_eq!(st.base.decimals, 6);
    m
}

fn t22_env_with(exts: &[Ext]) -> (Env, Pubkey, Pubkey) {
    let mut env = Env::with_config();
    let mint = create_t22_mint(&mut env, exts);
    let a_tok = env.create_token_account(mint, env.a.pubkey(), FUNDED, TOKEN_2022);
    assert_ok(&env.update_config(&UpdateConfigArgs {
        allowed_mints: Some(vec![env.usdc, mint]),
        ..Default::default()
    }));
    (env, mint, a_tok)
}

fn t22_create(env: &mut Env, mint: Pubkey, a_tok: Pubkey, n: u8) -> (SendResult, Pubkey) {
    let (c, mut ca) = env.default_create(bet_id(n));
    ca.mint = mint;
    ca.party_a_token = a_tok;
    ca.token_program = TOKEN_2022;
    let vault = ca.vault;
    (env.create_bet(&c, &ca), vault)
}

#[test]
fn b13_token_2022_no_extensions_ok() {
    let (mut env, mint, a_tok) = t22_env_with(&[]);
    let (res, vault) = t22_create(&mut env, mint, a_tok, 1);
    assert_ok(&res);
    assert_eq!(env.token_balance(&vault), USDC_5);
    let v = env.svm.get_account(&vault).unwrap();
    assert_eq!(v.owner, TOKEN_2022);
    // §3.3: the Token-2022 vault size Anchor computed for a mint with no extensions (observed)
    assert_eq!(v.data.len(), 165);
}

#[test]
fn b14_token_2022_permanent_delegate_or_transfer_fee_rejected() {
    for ext in [Ext::PermanentDelegate, Ext::TransferFee] {
        let (mut env, mint, a_tok) = t22_env_with(&[ext]);
        let (res, vault) = t22_create(&mut env, mint, a_tok, 1);
        assert_eq!(
            custom_code(&res),
            Some(err_code(EscrowError::MintExtensionNotAllowed)),
            "{ext:?}: {:?}",
            res.as_ref().err().map(|f| f.meta.logs.join("\n"))
        );
        assert!(!env.exists(&vault));
    }
}

#[test]
fn b21_extension_allowlist() {
    // Each rejected extension on its own → MintExtensionNotAllowed, and nothing is left behind.
    for ext in [
        Ext::TransferHook,
        Ext::DefaultAccountStateFrozen,
        Ext::Pausable,
        Ext::NonTransferable,
        Ext::ScaledUiAmount,
        Ext::InterestBearing,
        Ext::ConfidentialTransferMint,
        // TM-K8 / ESC-SEC-1: a closeable mint can vanish between the terminal ix and close_bet.
        Ext::MintCloseAuthority,
    ] {
        let (mut env, mint, a_tok) = t22_env_with(&[ext]);
        let a_bal = env.token_balance(&a_tok);
        let (res, vault) = t22_create(&mut env, mint, a_tok, 1);
        assert_eq!(
            custom_code(&res),
            Some(err_code(EscrowError::MintExtensionNotAllowed)),
            "{ext:?}: {:?}",
            res.as_ref().err().map(|f| f.meta.logs.join("\n"))
        );
        assert!(!env.exists(&vault), "{ext:?}");
        assert!(!env.exists(&bet_pda(&bet_id(1)).0), "{ext:?}");
        assert_eq!(env.token_balance(&a_tok), a_bal, "{ext:?}");
    }
    // An allowed extension does not launder a rejected one.
    for exts in [
        &[Ext::MetadataPointer, Ext::PermanentDelegate][..],
        &[
            Ext::MintCloseAuthority,
            Ext::MetadataPointer,
            Ext::TokenMetadata,
        ][..],
    ] {
        let (mut env, mint, a_tok) = t22_env_with(exts);
        let (res, vault) = t22_create(&mut env, mint, a_tok, 1);
        assert_eq!(
            custom_code(&res),
            Some(err_code(EscrowError::MintExtensionNotAllowed)),
            "{exts:?}"
        );
        assert!(!env.exists(&vault), "{exts:?}");
    }

    // Allowed: MetadataPointer, MetadataPointer + TokenMetadata.
    for exts in [
        &[Ext::MetadataPointer][..],
        &[Ext::MetadataPointer, Ext::TokenMetadata][..],
    ] {
        let (mut env, mint, a_tok) = t22_env_with(exts);
        let (res, vault) = t22_create(&mut env, mint, a_tok, 1);
        assert_ok(&res);
        assert_eq!(env.token_balance(&vault), USDC_5, "{exts:?}");
        assert_eq!(env.svm.get_account(&vault).unwrap().owner, TOKEN_2022);
    }
}

#[test]
fn g3_fake_or_substituted_config() {
    // TM-C1 (G3 subset for create/accept): a Config copy owned by another program, a Config copy
    // owned by the escrow at a non-PDA address, and a Bet passed as the Config (type cosplay).
    let mut env = Env::with_config();
    let real = env.svm.get_account(&config_pda()).unwrap();
    let mut fake_sys_owned = real.clone();
    fake_sys_owned.owner = anchor_lang::solana_program::system_program::ID;
    let fake_sys = Pubkey::new_unique();
    env.svm.set_account(fake_sys, fake_sys_owned).unwrap();
    let mut fake_owned = real.clone();
    fake_owned.owner = escrow::ID;
    let fake_pda = Pubkey::new_unique();
    env.svm.set_account(fake_pda, fake_owned).unwrap();

    let (c, mut ca) = env.default_create(bet_id(1));
    ca.config = fake_sys;
    assert_err(&env.create_bet(&c, &ca), 3007); // AccountOwnedByWrongProgram
    ca.config = fake_pda;
    assert_err(&env.create_bet(&c, &ca), ANCHOR_CONSTRAINT_SEEDS);
    assert!(!env.exists(&ca.bet));

    let (c, ca) = env.open_bet(bet_id(2));
    let (aa, mut acc) = env.default_accept(&c, &ca);
    acc.config = ca.bet; // a Bet where the Config goes
    assert_err(&env.accept_bet(&aa, &acc), 3002); // AccountDiscriminatorMismatch
    acc.config = fake_sys;
    assert_err(&env.accept_bet(&aa, &acc), 3007);
    acc.config = fake_pda;
    assert_err(&env.accept_bet(&aa, &acc), ANCHOR_CONSTRAINT_SEEDS);
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Open);
}
