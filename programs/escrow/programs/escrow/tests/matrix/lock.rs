//! Atomic-lock composition (ESCROW §5.0.1): `create_bet` + `accept_bet` in ONE transaction on a
//! durable nonce, `[AdvanceNonceAccount, SetComputeUnitLimit, SetComputeUnitPrice, create_bet,
//! accept_bet]`, signed by S (fee payer + nonce authority), A and B. Rust-side subset of
//! N1, N3, N4, N5 and N6; the TS + local-validator N rows are other suites.

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_instruction},
};
use escrow::{BetAccepted, BetCreated, BetStatus, EscrowError};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, Hash, Signature, TransactionError};

use crate::common::*;

fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET,
        accounts: vec![],
        data,
    }
}

fn cu_price(micro_lamports: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET,
        accounts: vec![],
        data,
    }
}

/// Create a System nonce account with authority = S; returns (address, stored nonce hash).
fn make_nonce(env: &mut Env) -> Pubkey {
    let nonce = Keypair::new();
    let s = env.s.insecure_clone();
    let lamports = env.svm.minimum_balance_for_rent_exemption(80);
    let ixs = system_instruction::create_nonce_account(
        &s.pubkey(),
        &nonce.pubkey(),
        &s.pubkey(),
        lamports,
    );
    assert_ok(&env.send(&ixs, &s, &[&nonce]));
    nonce.pubkey()
}

fn nonce_value(env: &Env, nonce: &Pubkey) -> Hash {
    // nonce::state::Versions::Current(State::Initialized(Data { authority, durable_nonce, .. }))
    let data = env.svm.get_account(nonce).unwrap().data;
    assert_eq!(&data[0..8], &[1, 0, 0, 0, 1, 0, 0, 0]);
    Hash::new_from_array(data[40..72].try_into().unwrap())
}

fn lock_tx(env: &Env, nonce: &Pubkey, body: &[Instruction]) -> VersionedTransaction {
    let s = &env.s;
    let mut ixs = vec![
        system_instruction::advance_nonce_account(nonce, &s.pubkey()),
        cu_limit(200_000),
        cu_price(1),
    ];
    ixs.extend_from_slice(body);
    let msg = Message::new_with_blockhash(&ixs, Some(&s.pubkey()), &nonce_value(env, nonce));
    VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[s, &env.a, &env.b]).unwrap()
}

fn keys_of(tx: &VersionedTransaction) -> Vec<Pubkey> {
    tx.message.static_account_keys().to_vec()
}

#[test]
fn n1_atomic_lock_one_tx() {
    let mut env = Env::with_config();
    let nonce = make_nonce(&mut env);
    let before_nonce = nonce_value(&env, &nonce);
    let (c, ca) = env.default_create(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    let body = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let a_sol = env.sol(&env.a.pubkey());
    let b_sol = env.sol(&env.b.pubkey());
    let s_sol = env.sol(&env.s.pubkey());
    let (a_bal, b_bal) = (
        env.token_balance(&env.a_token),
        env.token_balance(&env.b_token),
    );
    // Signed first, submitted after 300 blockhash expiries: the durable nonce keeps it valid (N5).
    let tx = lock_tx(&env, &nonce, &body);
    for _ in 0..300 {
        env.svm.expire_blockhash();
    }
    assert_eq!(tx.signatures.len(), 3);
    let wire = bincode_len(&tx);
    let keys = keys_of(&tx);
    let replay = tx.clone();
    let meta = env
        .svm
        .send_transaction(tx)
        .unwrap_or_else(|f| panic!("{:?}\n{}", f.err, f.meta.logs.join("\n")));
    let sent = Sent { meta, keys };

    let bet = env.bet(&c.bet_id);
    assert_eq!(bet.status, BetStatus::Locked);
    assert_eq!(bet.locked_at, bet.created_at);
    assert_eq!(bet.rent_payer, env.s.pubkey());
    assert_eq!(env.token_balance(&ca.vault), 2 * USDC_5);
    assert_eq!(env.token_balance(&env.a_token), a_bal - USDC_5);
    assert_eq!(env.token_balance(&env.b_token), b_bal - USDC_5);
    assert_eq!(events::<BetCreated>(&sent).len(), 1);
    assert_eq!(events::<BetAccepted>(&sent).len(), 1);
    assert_eq!(event_count(&sent), 2);
    // BetCreated is emitted under outer ix 3, BetAccepted under outer ix 4
    let outer_with_events: Vec<usize> = sent
        .meta
        .inner_instructions
        .iter()
        .enumerate()
        .filter(|(_, g)| {
            g.iter()
                .any(|i| sent.keys[i.instruction.program_id_index as usize] == escrow::ID)
        })
        .map(|(i, _)| i)
        .collect();
    assert_eq!(outer_with_events, vec![3, 4]);
    assert_eq!(env.sol(&env.a.pubkey()), a_sol);
    assert_eq!(env.sol(&env.b.pubkey()), b_sol);
    // S: 3 signatures (15,000) + priority fee ceil(200_000 CU x 1 micro-lamport) = 1, plus the
    // Bet + vault rent it fronts (returned at close_bet).
    assert_eq!(sent.meta.fee, 15_001);
    let rent = env.svm.minimum_balance_for_rent_exemption(409)
        + env.svm.minimum_balance_for_rent_exemption(165);
    assert_eq!(s_sol - env.sol(&env.s.pubkey()), 15_001 + rent);
    assert_ne!(nonce_value(&env, &nonce), before_nonce, "nonce advanced");
    println!(
        "N1/N11/N12 (LiteSVM): lock CU = {}, wire = {} B, fee = {}",
        sent.meta.compute_units_consumed, wire, sent.meta.fee
    );
    assert!(wire <= 1232);

    // N9 (part): replaying the landed lock (same bytes) is rejected; nothing moves again.
    let err = env.svm.send_transaction(replay).unwrap_err().err;
    assert!(
        matches!(
            err,
            TransactionError::AlreadyProcessed | TransactionError::BlockhashNotFound
        ),
        "{err:?}"
    );
    // ...and so is a freshly signed copy on the old nonce value.
    let tx = lock_tx_replay(&env, &nonce, &body, before_nonce);
    let err = env.svm.send_transaction(tx).unwrap_err().err;
    assert!(
        matches!(
            err,
            TransactionError::AlreadyProcessed | TransactionError::BlockhashNotFound
        ),
        "{err:?}"
    );
    assert_eq!(env.token_balance(&ca.vault), 2 * USDC_5);
}

fn lock_tx_replay(
    env: &Env,
    nonce: &Pubkey,
    body: &[Instruction],
    old: Hash,
) -> VersionedTransaction {
    let s = &env.s;
    let mut ixs = vec![
        system_instruction::advance_nonce_account(nonce, &s.pubkey()),
        cu_limit(200_000),
        cu_price(1),
    ];
    ixs.extend_from_slice(body);
    let msg = Message::new_with_blockhash(&ixs, Some(&s.pubkey()), &old);
    VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[s, &env.a, &env.b]).unwrap()
}

fn bincode_len(tx: &VersionedTransaction) -> usize {
    // signatures: shortvec(1 byte for < 128) + 64 each; message serialized by solana-message
    1 + 64 * tx.signatures.len() + tx.message.serialize().len()
}

#[test]
fn n3_accept_fails_whole_lock_fails() {
    for case in 0..3 {
        let mut env = Env::with_config();
        let nonce = make_nonce(&mut env);
        let (c, ca) = env.default_create(bet_id(1));
        let (mut aa, acc) = env.default_accept(&c, &ca);
        let expect = match case {
            0 => {
                aa.expected_terms_hash = [1u8; 32];
                EscrowError::TermsHashMismatch
            }
            1 => {
                aa.expected_stake_b += 1;
                EscrowError::StakeMismatch
            }
            _ => {
                aa.expected_party_a = Pubkey::new_unique();
                EscrowError::PartyMismatch
            }
        };
        let a_bal = env.token_balance(&env.a_token);
        let body = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
        let tx = lock_tx(&env, &nonce, &body);
        let res = env
            .svm
            .send_transaction(tx)
            .map(|meta| Sent { meta, keys: vec![] });
        // accept_bet (outer ix 4) fails after create_bet ran: the whole tx rolls back.
        assert_err_at(&res, 4, err_code(expect));
        assert!(!env.exists(&ca.bet));
        assert!(!env.exists(&ca.vault));
        assert_eq!(env.token_balance(&env.a_token), a_bal);
    }
}

#[test]
fn n4_reversed_order_fails() {
    let mut env = Env::with_config();
    let nonce = make_nonce(&mut env);
    let (c, ca) = env.default_create(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    let body = [env.ix_accept_bet(&aa, &acc), env.ix_create_bet(&c, &ca)];
    let tx = lock_tx(&env, &nonce, &body);
    let res = env
        .svm
        .send_transaction(tx)
        .map(|meta| Sent { meta, keys: vec![] });
    assert_err_at(&res, 3, ANCHOR_ACCOUNT_NOT_INITIALIZED);
    assert!(!env.exists(&ca.bet));
}

#[test]
fn n6_revoke_by_advancing_nonce() {
    let mut env = Env::with_config();
    let nonce = make_nonce(&mut env);
    let (c, ca) = env.default_create(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    let body = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let signed = lock_tx(&env, &nonce, &body);
    // fee-payer-only revoke
    let s = env.s.insecure_clone();
    env.svm.expire_blockhash();
    assert_ok(&env.send(
        &[system_instruction::advance_nonce_account(
            &nonce,
            &s.pubkey(),
        )],
        &s,
        &[],
    ));
    let a_bal = env.token_balance(&env.a_token);
    let err = env.svm.send_transaction(signed).unwrap_err().err;
    assert_eq!(err, TransactionError::BlockhashNotFound);
    assert!(!env.exists(&ca.bet));
    assert_eq!(env.token_balance(&env.a_token), a_bal);
}

/// Sends a lock, mapping the result into the common `SendResult`.
fn submit(env: &mut Env, tx: VersionedTransaction) -> SendResult {
    let keys = keys_of(&tx);
    env.svm.send_transaction(tx).map(|meta| Sent { meta, keys })
}

#[test]
fn n2_only_a_signed() {
    let mut env = Env::with_config();
    let nonce = make_nonce(&mut env);
    let (c, ca) = env.default_create(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    let body = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let mut tx = lock_tx(&env, &nonce, &body);
    // B's slot left empty
    let b_slot = keys_of(&tx)
        .iter()
        .position(|k| *k == env.b.pubkey())
        .unwrap();
    assert!(b_slot < 3, "B is a required signer");
    tx.signatures[b_slot] = Signature::default();
    let a_bal = env.token_balance(&env.a_token);
    let before = nonce_value(&env, &nonce);
    let err = env.svm.send_transaction(tx).unwrap_err().err;
    assert_eq!(err, TransactionError::SignatureFailure);
    assert!(!env.exists(&ca.bet));
    assert_eq!(env.token_balance(&env.a_token), a_bal);
    assert_eq!(nonce_value(&env, &nonce), before);
}

#[test]
fn n8_submitted_at_accept_deadline() {
    let mut env = Env::with_config();
    let nonce = make_nonce(&mut env);
    let (c, ca) = env.default_create(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    let body = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let tx = lock_tx(&env, &nonce, &body);
    // Held until accept_deadline: create_bet's own bound (now < accept_deadline) fails first.
    env.set_now(c.accept_deadline);
    let res = submit(&mut env, tx);
    assert_err_at(&res, 3, err_code(EscrowError::InvalidDeadline));
    assert!(!env.exists(&ca.bet));
}

#[test]
fn n13_squat_before_lock() {
    let mut env = Env::with_config();
    let nonce = make_nonce(&mut env);
    let (c, ca) = env.default_create(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    let body = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let tx = lock_tx(&env, &nonce, &body);
    // Mallory squats A's bet_id first (party_a = Mallory, same terms and stakes).
    let mallory = env.mallory.insecure_clone();
    let mut m = ca.clone();
    m.payer = mallory.pubkey();
    m.party_a = mallory.pubkey();
    m.party_a_token = env.mallory_token;
    let ix = env.ix_create_bet(&c, &m);
    assert_ok(&env.send(&[ix], &mallory, &[]));
    let (a_bal, b_bal) = (
        env.token_balance(&env.a_token),
        env.token_balance(&env.b_token),
    );
    let res = submit(&mut env, tx);
    assert_already_in_use(&res);
    assert_eq!(env.token_balance(&env.a_token), a_bal);
    assert_eq!(env.token_balance(&env.b_token), b_bal);
    assert_eq!(env.bet(&c.bet_id).party_a, mallory.pubkey());
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Open);
}

#[test]
fn n14_paused() {
    let mut env = Env::with_config();
    let nonce = make_nonce(&mut env);
    let (c, ca) = env.default_create(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    let body = [env.ix_create_bet(&c, &ca), env.ix_accept_bet(&aa, &acc)];
    let tx = lock_tx(&env, &nonce, &body);
    assert_ok(&env.update_config(&escrow::UpdateConfigArgs {
        paused: Some(true),
        ..Default::default()
    }));
    let a_bal = env.token_balance(&env.a_token);
    let res = submit(&mut env, tx);
    assert_err_at(&res, 3, err_code(EscrowError::Paused));
    assert!(!env.exists(&ca.bet));
    assert_eq!(env.token_balance(&env.a_token), a_bal);
}
