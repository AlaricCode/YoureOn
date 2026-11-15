//! ESCROW §9.2 security and griefing rows:
//!
//! - G1–G6 (griefing / TM-L3, TM-C1, TM-D3, TM-F11, TM-C8) and CPI1 (TM-F12).
//! - D1 legs of rows that the D0 files could not finish (audit of config.rs, create_bet.rs,
//!   accept_bet.rs): U3 (rotated judge resolves), U6 (live bet settles after its mint is
//!   delisted), U7 (every exit works while paused), A7 (after a REAL cancel / cancel + close),
//!   B18 (pre-sent lamports come back in `rent_returned`) and G3 for every Bet instruction plus
//!   `update_config` (create_bet.rs covers G3 for create / accept's Config).
//!
//! Terminal paths are checked with the §9.1 global post-conditions from `common`.
//!
//! CPI1 needs "a test program". It is a LiteSVM *builtin* registered from this file (no new
//! crate or dependency): a forwarder that CPIs, via the runtime's `native_invoke_signed`, into
//! whatever program and accounts its own instruction names. Like an SBF caller, it can lend only
//! the signer privileges of its own outer instruction (no PDA seeds are passed).

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_instruction, system_program,
    },
};
use anchor_spl::token_interface::spl_token_2022::{self, instruction::AuthorityType};
use escrow::{
    BetClosed, BetCreated, BetFinalized, BetStatus, EscrowError, Outcome, UpdateConfigArgs,
};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::{InstructionError, TransactionError};

use crate::common::*;

pub const ATA_PROGRAM: Pubkey =
    anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// Anchor 1.2.2 `ErrorCode::AccountDiscriminatorMismatch`.
const ANCHOR_ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
/// Bet account size (8 + `Bet::INIT_SPACE`), as measured in B18.
const BET_SPACE: usize = 409;
const TOKEN_ACCOUNT_SPACE: usize = 165;

// =============================================================================================
// local helpers
// =============================================================================================

fn bet_rent(env: &Env) -> u64 {
    env.svm.minimum_balance_for_rent_exemption(BET_SPACE)
}

fn vault_rent(env: &Env) -> u64 {
    env.svm
        .minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_SPACE)
}

fn sol_transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    system_instruction::transfer(from, to, lamports)
}

/// Real SPL `SetAuthority(AccountOwner)` on a classic token account (G1).
fn ix_set_owner(account: &Pubkey, owner: &Pubkey, new_owner: &Pubkey) -> Instruction {
    spl_token_2022::instruction::set_authority(
        &CLASSIC_TOKEN,
        account,
        Some(new_owner),
        AuthorityType::AccountOwner,
        owner,
        &[],
    )
    .unwrap()
}

/// Canonical ATA of `wallet` for `mint` (classic token program).
fn ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), CLASSIC_TOKEN.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

/// ATA program `CreateIdempotent` (instruction 1).
fn ix_create_ata_idempotent(funder: &Pubkey, wallet: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            meta(*funder, true, true),
            meta(ata(wallet, mint), false, true),
            meta(*wallet, false, false),
            meta(*mint, false, false),
            meta(system_program::ID, false, false),
            meta(CLASSIC_TOKEN, false, false),
        ],
        data: vec![1],
    }
}

fn swap_key(ix: &mut Instruction, from: &Pubkey, to: Pubkey) {
    let mut n = 0;
    for m in ix.accounts.iter_mut().filter(|m| m.pubkey == *from) {
        m.pubkey = to;
        n += 1;
    }
    assert_eq!(n, 1, "{from} appears exactly once");
}

/// The tracked balances (A, B, Mallory + extras) did not move since `snap`.
#[track_caller]
fn assert_no_token_moved(env: &Env, snap: &Snapshot) {
    for (k, _) in &snap.balances {
        assert_eq!(snap.delta(env, k), 0, "balance of {k} moved");
    }
    assert_eq!(
        env.try_token_balance(&snap.vault_addr),
        Some(snap.v),
        "vault moved"
    );
}

// ---------- CPI1 test program (LiteSVM builtin) ----------

/// Registers the CPI forwarder and returns its program ID.
///
/// Its instruction: account 0 = the callee program; accounts 1.. = the callee's accounts in
/// order; data = one flag byte per callee account (bit 0 signer, bit 1 writable) followed by
/// the callee's instruction data. It CPIs with NO signer seeds, so a callee signer must already
/// be a signer of the forwarder's own instruction (TM-F12). On a failed CPI it fails too (the
/// outer error is `ProgramFailedToComplete`; the callee's own error is in the logs).
fn install_cpi_caller(env: &mut Env) -> Pubkey {
    let id = Pubkey::new_unique();
    env.svm.add_builtin(id, |program, _name| {
        program.register_function(
            "entrypoint",
            (
                |mut vm_addr, _a, _b, _c, _d, _e| {
                    // SAFETY: the runtime passes the address of the live VM that is calling this
                    // builtin; this is the only reference made from it.
                    unsafe {
                        vm_addr.with_vm(|vm| {
                            let ic = vm.context();
                            let cpi = {
                                let ctx = ic
                                    .transaction_context
                                    .get_current_instruction_context()
                                    .expect("instruction context");
                                let n = ctx.get_number_of_instruction_accounts();
                                let data = ctx.get_instruction_data();
                                let key = |i| *ctx.get_key_of_instruction_account(i).unwrap();
                                let flags = &data[..usize::from(n) - 1];
                                Instruction {
                                    program_id: key(0),
                                    accounts: (1..n)
                                        .map(|i| AccountMeta {
                                            pubkey: key(i),
                                            is_signer: flags[usize::from(i) - 1] & 1 != 0,
                                            is_writable: flags[usize::from(i) - 1] & 2 != 0,
                                        })
                                        .collect(),
                                    data: data[usize::from(n) - 1..].to_vec(),
                                }
                            };
                            if ic.native_invoke_signed(cpi, &[]).is_ok() {
                                vm.program_result = Ok(0).into();
                            } else {
                                // The VM's error type isn't nameable from here; derive one from
                                // the only public constructor path (an ELF symbol collision).
                                let reg = vm.loader.get_function_registry();
                                let x = reg.lookup_by_name(b"sol_log_").unwrap().1;
                                let y = reg.lookup_by_name(b"sol_log_64_").unwrap().1;
                                let mut scratch = default_like(reg);
                                scratch.register_function(1, "x", x).unwrap();
                                let err = scratch.register_function(1, "x", y).unwrap_err();
                                vm.program_result = Err(err.into()).into();
                            }
                        })
                    }
                },
                |_jit| {},
            ),
        )
    });
    id
}

fn default_like<T: Default>(_: &T) -> T {
    T::default()
}

/// Wraps `inner` in a call to the forwarder `caller`.
fn ix_via_cpi(caller: Pubkey, inner: &Instruction) -> Instruction {
    let mut accounts = vec![meta(inner.program_id, false, false)];
    accounts.extend(inner.accounts.iter().cloned());
    let mut data: Vec<u8> = inner
        .accounts
        .iter()
        .map(|m| u8::from(m.is_signer) | (u8::from(m.is_writable) << 1))
        .collect();
    data.extend_from_slice(&inner.data);
    Instruction {
        program_id: caller,
        accounts,
        data,
    }
}

// =============================================================================================
// G1–G6
// =============================================================================================

#[test]
fn g1a_reassigned_loser_account_omitted_ok() {
    // G1(a) / TM-L3: B (the loser of PartyA) reassigns their classic token account's owner.
    // Passing it fails the owner check; omitting it (B receives 0) settles normally.
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let b = env.b.insecure_clone();
    let elsewhere = Pubkey::new_unique();
    assert_ok(&env.send_s(
        &[ix_set_owner(&env.b_token, &b.pubkey(), &elsewhere)],
        &[&b],
    ));
    assert_eq!(env.token_owner(&env.b_token), elsewhere);

    let snap = Snapshot::take(&env, &id);
    let res = env.finalize_bundled(&id);
    assert_escrow_err(&res, EscrowError::WrongPayoutAccount);
    assert_no_token_moved(&env, &snap);

    let mut p = env.default_payout(&id);
    p.party_b_token = None;
    let ix = env.ix_finalize(&p);
    let before = Snapshot::take(&env, &id);
    let res = env.send_bundled(&id, ix, &[]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.party_b_token, Pubkey::default());
}

#[test]
fn g1b_reassigned_winner_account_fresh_account_ok() {
    // G1(b) / TM-L3: B (the winner of PartyB) reassigned their account's owner. That account is
    // rejected; the server passes a fresh B-owned token account and the payout lands there.
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyB);
    env.warp_to_appeal_deadline(&id);
    let b = env.b.insecure_clone();
    let mallory = env.mallory.pubkey();
    assert_ok(&env.send_s(&[ix_set_owner(&env.b_token, &b.pubkey(), &mallory)], &[&b]));

    let snap = Snapshot::take(&env, &id);
    assert_escrow_err(&env.finalize_bundled(&id), EscrowError::WrongPayoutAccount);
    assert_no_token_moved(&env, &snap);

    let fresh = env.create_token_account(env.usdc, b.pubkey(), 0, CLASSIC_TOKEN);
    let mut p = env.default_payout(&id);
    p.party_b_token = Some(fresh);
    let ix = env.ix_finalize(&p);
    let before = Snapshot::take_with(&env, &id, &[fresh]);
    let res = env.send_bundled(&id, ix, &[]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyB, 0, 2 * USDC_5);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.party_b_token, fresh);
    assert_eq!(env.token_balance(&fresh), 2 * USDC_5);
}

#[test]
fn g2_closed_winner_ata_recreated_idempotently() {
    // G2 / TM-L3: the winner's ATA was closed. Without it the payout can't land; with the
    // server's prepended ATA `CreateIdempotent` the bundled tx settles into the new ATA.
    // The ATA rent is fronted by a second server key so the §9.1 rent check on S stays exact.
    let mut env = Env::with_config();
    let (a, usdc) = (env.a.insecure_clone(), env.usdc);
    let a_ata = ata(&a.pubkey(), &usdc);
    let funder = Keypair::new();
    env.svm.airdrop(&funder.pubkey(), 1_000_000_000).unwrap();

    // A's ATA exists, then A closes it (empty, so SPL allows it).
    let create = ix_create_ata_idempotent(&funder.pubkey(), &a.pubkey(), &usdc);
    assert_ok(&env.send_s(std::slice::from_ref(&create), &[&funder]));
    assert_eq!(env.token_owner(&a_ata), a.pubkey());
    let close = spl_token_2022::instruction::close_account(
        &CLASSIC_TOKEN,
        &a_ata,
        &a.pubkey(),
        &a.pubkey(),
        &[],
    )
    .unwrap();
    assert_ok(&env.send_s(&[close], &[&a]));
    assert!(!env.exists(&a_ata));

    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    env.warp_to_appeal_deadline(&id);
    let mut p = env.default_payout(&id);
    p.party_a_token = Some(a_ata);
    p.party_b_token = None;

    // Without the re-create: the closed account is rejected and nothing moves.
    let snap = Snapshot::take_with(&env, &id, &[a_ata]);
    let res = env.send_bundled(&id, env.ix_finalize(&p), &[]);
    assert_err(&res, ANCHOR_ACCOUNT_NOT_INITIALIZED);
    assert_no_token_moved(&env, &snap);

    // [CreateIdempotent, finalize, close_bet] in one tx.
    let before = Snapshot::take_with(&env, &id, &[a_ata]);
    let close_ix = env.ix_close_bet(&env.default_close(&id));
    let res = env.send_s(&[create, env.ix_finalize(&p), close_ix], &[&funder]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    let ev = assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    assert_eq!(ev.party_a_token, a_ata);
    assert_eq!(env.token_balance(&a_ata), 2 * USDC_5);
}

/// The G3 instruction set: one bet per instruction, driven to the status (and clock) where the
/// REAL Bet succeeds. Returns the instruction (built against the real Bet) and its signers.
fn g3_case(env: &mut Env, n: u8) -> (&'static str, [u8; 16], Instruction, Vec<Keypair>) {
    let id = bet_id(n);
    let (a, b, j, ap) = (
        env.a.insecure_clone(),
        env.b.insecure_clone(),
        env.judge.insecure_clone(),
        env.appeal.insecure_clone(),
    );
    match n {
        0 => {
            let (c, ca) = env.open_bet(id);
            let (aa, acc) = env.default_accept(&c, &ca);
            ("accept_bet", id, env.ix_accept_bet(&aa, &acc), vec![b])
        }
        1 => {
            env.open_bet(id);
            let ix = env.ix_cancel_open_bet(a.pubkey(), &env.default_payout(&id));
            ("cancel_open_bet", id, ix, vec![a])
        }
        2 => {
            env.locked_bet(id);
            let ix = env.ix_resolve(&env.default_resolve(&id), Outcome::PartyA, EVIDENCE, RULING);
            ("resolve", id, ix, vec![j])
        }
        3 => {
            env.resolved_bet(id, Outcome::PartyA);
            let ix = env.ix_concede(b.pubkey(), &env.default_payout(&id));
            ("concede", id, ix, vec![b])
        }
        4 => {
            env.resolved_bet(id, Outcome::PartyA);
            let ix = env.ix_appeal(&env.default_appeal(&id, b.pubkey()));
            ("appeal", id, ix, vec![b])
        }
        5 => {
            env.appealed_bet(id, Outcome::PartyA);
            let p = env.default_payout(&id);
            let ix = env.ix_resolve_appeal(ap.pubkey(), &p, Outcome::PartyB, APPEAL_RULING);
            ("resolve_appeal", id, ix, vec![ap])
        }
        6 => {
            env.resolved_bet(id, Outcome::PartyA);
            env.warp_to_appeal_deadline(&id);
            (
                "finalize",
                id,
                env.ix_finalize(&env.default_payout(&id)),
                vec![],
            )
        }
        7 => {
            env.open_bet(id);
            env.warp_to_accept_deadline(&id);
            let ix = env.ix_timeout_refund(&env.default_payout(&id));
            ("timeout_refund", id, ix, vec![])
        }
        _ => {
            env.settled_bet(id, Outcome::PartyA);
            (
                "close_bet",
                id,
                env.ix_close_bet(&env.default_close(&id)),
                vec![],
            )
        }
    }
}

#[test]
fn g3_fake_bet_on_every_bet_instruction() {
    // G3 / TM-C1: in every instruction that takes the Bet, substitute (a) a byte-identical copy
    // owned by another program → AccountOwnedByWrongProgram; (b) the Config (type cosplay) →
    // AccountDiscriminatorMismatch; (c) an escrow-owned copy at a non-PDA address →
    // ConstraintSeeds. Nothing changes; the same ix with the real Bet then succeeds.
    for n in 0..9u8 {
        let mut env = Env::with_config();
        let (name, id, ix, signers) = g3_case(&mut env, n);
        let real = bet_pda(&id).0;
        let real_acc = env.svm.get_account(&real).unwrap();
        let before = env.bet(&id);
        let snap = Snapshot::take(&env, &id);
        let signers: Vec<&Keypair> = signers.iter().collect();

        for owner in [system_program::ID, CLASSIC_TOKEN] {
            let fake = Pubkey::new_unique();
            let mut acc = real_acc.clone();
            acc.owner = owner;
            env.svm.set_account(fake, acc).unwrap();
            let mut bad = ix.clone();
            swap_key(&mut bad, &real, fake);
            let res = env.send_s(&[bad], &signers);
            assert!(
                custom_code(&res) == Some(ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM),
                "{name}: Bet owned by {owner}: {:?}",
                res.as_ref().err().map(|f| &f.err)
            );
        }
        let mut cosplay = ix.clone();
        swap_key(&mut cosplay, &real, config_pda());
        let res = env.send_s(&[cosplay], &signers);
        assert!(
            custom_code(&res) == Some(ANCHOR_ACCOUNT_DISCRIMINATOR_MISMATCH),
            "{name}: Config as Bet: {:?}",
            res.as_ref().err().map(|f| &f.err)
        );
        let copy = Pubkey::new_unique();
        env.svm.set_account(copy, real_acc.clone()).unwrap();
        let mut forged = ix.clone();
        swap_key(&mut forged, &real, copy);
        let res = env.send_s(&[forged], &signers);
        assert!(
            custom_code(&res) == Some(ANCHOR_CONSTRAINT_SEEDS),
            "{name}: escrow-owned non-PDA copy: {:?}",
            res.as_ref().err().map(|f| &f.err)
        );

        assert_eq!(env.bet(&id), before, "{name}: Bet unchanged");
        assert_no_token_moved(&env, &snap);
        let res = env.send_s(&[ix], &signers);
        assert!(
            res.is_ok(),
            "{name} with the real Bet: {:?}",
            res.err().map(|f| f.meta.logs)
        );
    }
}

#[test]
fn g3_fake_config_in_update_config() {
    // G3 / TM-C1 for `update_config` (create / accept are in create_bet.rs): a Config copy owned
    // by another program, a Bet in the Config slot, an escrow-owned copy at a non-PDA address.
    let mut env = Env::with_config();
    env.open_bet(bet_id(1));
    let real = env.svm.get_account(&config_pda()).unwrap();
    let args = UpdateConfigArgs {
        max_stake: Some(1),
        ..Default::default()
    };
    let admin = env.admin.insecure_clone();
    let foreign = Pubkey::new_unique();
    let mut acc = real.clone();
    acc.owner = system_program::ID;
    env.svm.set_account(foreign, acc).unwrap();
    let copy = Pubkey::new_unique();
    env.svm.set_account(copy, real.clone()).unwrap();
    for (fake, code) in [
        (foreign, ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM),
        (bet_pda(&bet_id(1)).0, ANCHOR_ACCOUNT_DISCRIMINATOR_MISMATCH),
        (copy, ANCHOR_CONSTRAINT_SEEDS),
    ] {
        let mut ix = env.ix_update_config(admin.pubkey(), &args);
        swap_key(&mut ix, &config_pda(), fake);
        assert_err(&env.send(&[ix], &admin, &[]), code);
    }
    assert_eq!(env.config().max_stake, MAX_STAKE);
}

#[test]
fn g4_same_bet_id_recreated_after_close_is_independent() {
    // G4 / TM-D3: after a bet settles and closes, its bet_id can be created again, even after
    // Mallory sent lamports to the closed Bet and vault addresses. It is an independent new bet
    // (fresh fields, fresh deposits); offchain must key bets by (bet_id, create signature).
    let mut env = Env::with_config();
    let id = bet_id(1);
    let (c1, ca1) = env.default_create(id);
    let first = assert_ok(&env.create_bet(&c1, &ca1)).meta.signature;
    let (aa, acc) = env.default_accept(&c1, &ca1);
    assert_ok(&env.accept_bet(&aa, &acc));
    assert_ok(&env.resolve(&id, Outcome::PartyA));
    env.warp_to_appeal_deadline(&id);
    assert_ok(&env.finalize_bundled(&id));
    assert!(!env.exists(&ca1.bet) && !env.exists(&ca1.vault));

    // More than the Bet's rent to the Bet address; less than a token account's rent (but enough
    // for the runtime to accept a fresh 0-byte account) to the vault address.
    let mallory = env.mallory.insecure_clone();
    let (big, small) = (10_000_000, 1_000_000);
    assert!(big > bet_rent(&env) && small < vault_rent(&env));
    let gifts = [
        sol_transfer(&mallory.pubkey(), &ca1.bet, big),
        sol_transfer(&mallory.pubkey(), &ca1.vault, small),
    ];
    assert_ok(&env.send(&gifts, &mallory, &[]));

    env.advance(100);
    let (mut c2, ca2) = env.default_create(id);
    c2.stake_a = 3_000_000;
    c2.stake_b = 2_000_000;
    c2.terms_hash = [9u8; 32];
    let res = env.create_bet(&c2, &ca2);
    let sent = assert_ok(&res);
    let second = sent.meta.signature;
    let ev = &events::<BetCreated>(sent)[0];
    assert_eq!(ev.bet_id, id, "same bet_id ...");
    assert_ne!(first, second, "... under a different create signature");
    let bet = env.bet(&id);
    assert_eq!(bet.status, BetStatus::Open);
    assert_eq!((bet.stake_a, bet.stake_b), (3_000_000, 2_000_000));
    assert_eq!(bet.terms_hash, [9u8; 32]);
    assert_eq!(bet.created_at, env.now());
    assert_eq!(bet.outcome, None);
    assert_eq!(bet.rent_payer, env.s.pubkey());
    assert_eq!(
        (bet.bump, bet.vault_bump),
        (bet_pda(&id).1, vault_pda(&id).1)
    );
    assert_eq!(
        env.token_balance(&ca2.vault),
        3_000_000,
        "fresh deposit only"
    );
    // Anchor's funded-init path: no top-up when the Bet address already holds ≥ rent.
    assert_eq!(env.sol(&ca2.bet), big);
    assert_eq!(env.sol(&ca2.vault), vault_rent(&env));

    let (aa, acc) = env.default_accept(&c2, &ca2);
    assert_ok(&env.accept_bet(&aa, &acc));
    assert_ok(&env.resolve(&id, Outcome::PartyB));
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyB, 0, 5_000_000);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    let closed = &events::<BetClosed>(sent)[0];
    assert_eq!(
        closed.rent_returned,
        big + vault_rent(&env),
        "Mallory's gift → S"
    );
}

#[test]
fn g5_foreign_token_accounts_owned_by_bet_pda_are_stranded() {
    // G5 / TM-F11 (residual): Mallory creates token accounts owned by the Bet PDA (one of
    // another mint, one of USDC) and funds them with real transfers. They can't stand in for the
    // vault or a payout account, the lifecycle is unaffected, and the tokens stay there.
    let mut env = Env::with_config();
    let id = bet_id(1);
    env.locked_bet(id);
    let bet = bet_pda(&id).0;
    let mallory = env.mallory.insecure_clone();
    let other = env.create_mint(6, CLASSIC_TOKEN);
    let m_other = env.create_token_account(other, mallory.pubkey(), FUNDED, CLASSIC_TOKEN);
    let stranded_other = env.create_token_account(other, bet, 0, CLASSIC_TOKEN);
    let stranded_usdc = env.create_token_account(env.usdc, bet, 0, CLASSIC_TOKEN);
    assert_ok(&env.transfer_tokens(
        m_other,
        &mallory,
        stranded_other,
        other,
        1_000,
        CLASSIC_TOKEN,
    ));
    let (m_usdc, usdc) = (env.mallory_token, env.usdc);
    assert_ok(&env.transfer_tokens(m_usdc, &mallory, stranded_usdc, usdc, 777, CLASSIC_TOKEN));

    assert_ok(&env.resolve(&id, Outcome::PartyA));
    env.warp_to_appeal_deadline(&id);
    let snap = Snapshot::take_with(&env, &id, &[stranded_usdc]);
    // The Bet-owned USDC account as the vault → seeds; as B's destination → owner check; the
    // other-mint account as A's destination → rejected too (the owner check fires first).
    let mut p = env.default_payout(&id);
    p.vault = stranded_usdc;
    assert_err(
        &env.send_s(&[env.ix_finalize(&p)], &[]),
        ANCHOR_CONSTRAINT_SEEDS,
    );
    let mut p = env.default_payout(&id);
    p.party_b_token = Some(stranded_usdc);
    assert_escrow_err(
        &env.send_s(&[env.ix_finalize(&p)], &[]),
        EscrowError::WrongPayoutAccount,
    );
    let mut p = env.default_payout(&id);
    p.party_a_token = Some(stranded_other);
    assert_escrow_err(
        &env.send_s(&[env.ix_finalize(&p)], &[]),
        EscrowError::WrongPayoutAccount,
    );
    let mut c = env.default_close(&id);
    c.vault = stranded_usdc;
    assert!(env.send_s(&[env.ix_close_bet(&c)], &[]).is_err());
    assert_no_token_moved(&env, &snap);

    let before = Snapshot::take_with(&env, &id, &[stranded_usdc]);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    // Stranded by design: still there, still owned by the (now closed) Bet address.
    assert_eq!(env.token_balance(&stranded_other), 1_000);
    assert_eq!(env.token_balance(&stranded_usdc), 777);
    assert_eq!(env.token_owner(&stranded_usdc), bet);
    assert_eq!(env.token_owner(&stranded_other), bet);
    assert_eq!(env.token_balance(&env.mallory_token), FUNDED - 777);
}

#[test]
fn g6_sol_sent_to_bet_and_vault_goes_to_rent_payer() {
    // G6: Mallory sends SOL to the Bet PDA and the vault. Settlement is unaffected and
    // `rent_returned` includes the extra, all of it to S (bundled and standalone close).
    let mut env = Env::with_config();
    let mallory = env.mallory.insecure_clone();
    let (to_bet, to_vault) = (1_111_111u64, 2_222_222u64);

    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let m0 = env.sol(&mallory.pubkey());
    let gifts = [
        sol_transfer(&mallory.pubkey(), &bet_pda(&id).0, to_bet),
        sol_transfer(&mallory.pubkey(), &vault_pda(&id).0, to_vault),
    ];
    let fee = assert_ok(&env.send(&gifts, &mallory, &[])).meta.fee;
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    let closed = &events::<BetClosed>(sent)[0];
    assert_eq!(
        closed.rent_returned,
        bet_rent(&env) + vault_rent(&env) + to_bet + to_vault
    );
    assert_eq!(closed.rent_payer, env.s.pubkey());
    assert_eq!(
        env.sol(&mallory.pubkey()),
        m0 - to_bet - to_vault - fee,
        "Mallory gets nothing back"
    );

    // Standalone terminal ix (cancel) leaves the lamports alone; close_bet returns them.
    let id = bet_id(2);
    env.open_bet(id);
    assert_ok(&env.send(
        &[sol_transfer(&mallory.pubkey(), &bet_pda(&id).0, to_bet)],
        &mallory,
        &[],
    ));
    let before = Snapshot::take(&env, &id);
    let a = env.a.insecure_clone();
    let res = env.cancel_open_bet(&id, &a);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Cancelled, Outcome::Refund, USDC_5, 0);
    assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);
    assert_eq!(env.sol(&bet_pda(&id).0), bet_rent(&env) + to_bet);
    let before = Snapshot::take(&env, &id);
    let res = env.close_bet(&id);
    let c = assert_close_postconditions(&env, &before, assert_ok(&res), 0);
    assert_eq!(c.rent_returned, bet_rent(&env) + vault_rent(&env) + to_bet);
}

// =============================================================================================
// CPI1
// =============================================================================================

#[test]
fn cpi1_finalize_via_cpi_same_constraints_same_payout() {
    // CPI1 / TM-F12: a test program CPIs into `finalize`. (a) With Mallory's account as
    // `party_a_token` the CPI'd escrow fails [WrongPayoutAccount] and the whole tx fails;
    // (b) with the correct accounts it succeeds with exactly the payout and event of a direct
    // call on an identical bet.
    let mut env = Env::with_config();
    let caller = install_cpi_caller(&mut env);
    let (cpi_id, direct_id) = (bet_id(1), bet_id(2));
    env.resolved_bet(cpi_id, Outcome::Split);
    env.resolved_bet(direct_id, Outcome::Split);
    env.warp_to_appeal_deadline(&cpi_id);

    // (a)
    let mut p = env.default_payout(&cpi_id);
    p.party_a_token = Some(env.mallory_token);
    let bet_before = env.bet(&cpi_id);
    let snap = Snapshot::take(&env, &cpi_id);
    let res = env.send_s(&[ix_via_cpi(caller, &env.ix_finalize(&p))], &[]);
    let f = res
        .as_ref()
        .err()
        .expect("CPI with Mallory's account fails");
    assert_eq!(
        f.err,
        TransactionError::InstructionError(0, InstructionError::ProgramFailedToComplete)
    );
    let logs = f.meta.logs.join("\n");
    assert!(
        logs.contains(&format!("Program {} invoke [2]", escrow::ID)),
        "{logs}"
    );
    assert!(
        logs.contains("Error Code: WrongPayoutAccount")
            && logs.contains(&format!(
                "Program {} failed: custom program error: {:#x}",
                escrow::ID,
                err_code(EscrowError::WrongPayoutAccount)
            )),
        "the CPI'd escrow rejected the destination:\n{logs}"
    );
    assert_eq!(env.bet(&cpi_id), bet_before);
    assert_no_token_moved(&env, &snap);

    // (b) via CPI, standalone, with the §9.1 post-conditions
    let before = Snapshot::take(&env, &cpi_id);
    let ix = ix_via_cpi(caller, &env.ix_finalize(&env.default_payout(&cpi_id)));
    let res = env.send_s(&[ix], &[]);
    let sent = assert_ok(&res);
    assert!(sent
        .meta
        .logs
        .contains(&format!("Program {} invoke [2]", escrow::ID)));
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::Split, USDC_5, USDC_5);
    let via_cpi = assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);
    let caller_field = events::<BetFinalized>(sent)[0].caller;

    // ... and the identical bet finalized directly
    let before = Snapshot::take(&env, &direct_id);
    let res = env.finalize(&direct_id);
    let sent = assert_ok(&res);
    let direct = assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);
    assert_eq!(
        (
            via_cpi.to_a,
            via_cpi.to_b,
            via_cpi.outcome,
            via_cpi.final_status
        ),
        (
            direct.to_a,
            direct.to_b,
            direct.outcome,
            direct.final_status
        )
    );
    assert_eq!(
        (via_cpi.party_a_token, via_cpi.party_b_token),
        (direct.party_a_token, direct.party_b_token)
    );
    assert_eq!(caller_field, events::<BetFinalized>(sent)[0].caller);
}

#[test]
fn cpi1_signer_privileges_only_from_outer_tx() {
    // CPI1 / TM-F12: the caller cannot manufacture a party's signature. A CPI'd `concede` that
    // marks B as signer fails (privilege escalation) unless B signed the outer tx; then it works.
    let mut env = Env::with_config();
    let caller = install_cpi_caller(&mut env);
    let id = bet_id(1);
    env.resolved_bet(id, Outcome::PartyA);
    let b = env.b.insecure_clone();
    let inner = env.ix_concede(b.pubkey(), &env.default_payout(&id));

    let mut outer = ix_via_cpi(caller, &inner);
    unsign(&mut outer, &b.pubkey()); // B is listed, but does not sign the outer tx
    let snap = Snapshot::take(&env, &id);
    let res = env.send_s(&[outer], &[]);
    let f = res.as_ref().err().expect("escalation fails");
    let logs = f.meta.logs.join("\n");
    assert!(logs.contains("signer privilege escalated"), "{logs}");
    assert!(!logs.contains(&format!("Program {} invoke [2]", escrow::ID)));
    assert_eq!(env.bet(&id).status, BetStatus::Resolved);
    assert_no_token_moved(&env, &snap);

    let before = Snapshot::take(&env, &id);
    let res = env.send_s(&[ix_via_cpi(caller, &inner)], &[&b]);
    let sent = assert_ok(&res);
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_standalone(&mut env, &before, sent, &exp);
}

// =============================================================================================
// Audit: D1 legs of C / U / B / A rows left open by the D0 files
// =============================================================================================

#[test]
fn u3_rotated_judge_resolve_legs() {
    // U3 / TM-O5 (D1 legs; config.rs covers the snapshot): rotate J → J2 while a bet is Locked.
    // J2 [NotJudge] on that bet, J resolves it; on a new bet J [NotJudge], J2 resolves. The
    // judge key's cancel right is snapshotted the same way (I11).
    let mut env = Env::with_config();
    let (old, fresh, open_old) = (bet_id(1), bet_id(2), bet_id(3));
    env.locked_bet(old);
    env.open_bet(open_old);
    let j = env.judge.insecure_clone();
    let j2 = Keypair::new();
    assert_ok(&env.update_config(&UpdateConfigArgs {
        judge_authority: Some(j2.pubkey()),
        ..Default::default()
    }));

    assert_escrow_err(
        &env.resolve_as(&old, &j2, Outcome::PartyA, EVIDENCE, RULING),
        EscrowError::NotJudge,
    );
    let res = env.resolve_as(&old, &j, Outcome::PartyA, EVIDENCE, RULING);
    let sent = assert_ok(&res);
    assert_eq!(
        events::<escrow::BetResolved>(sent)[0].judge,
        j.pubkey(),
        "old bet ruled by its snapshotted judge"
    );

    env.locked_bet(fresh);
    assert_escrow_err(
        &env.resolve_as(&fresh, &j, Outcome::PartyB, EVIDENCE, RULING),
        EscrowError::NotJudge,
    );
    assert_ok(&env.resolve_as(&fresh, &j2, Outcome::PartyB, EVIDENCE, RULING));
    assert_eq!(env.bet(&fresh).status, BetStatus::Resolved);

    assert_escrow_err(
        &env.cancel_open_bet(&open_old, &j2),
        EscrowError::NotAuthorizedToCancel,
    );
    assert_ok(&env.cancel_open_bet(&open_old, &j));
}

#[test]
fn u6_delisted_mint_live_bets_settle() {
    // U6 (D1 leg; config.rs covers accept + the new-create rejection): after the bet's mint is
    // removed from the allowlist, a Locked bet resolves and settles and an Open bet cancels.
    let mut env = Env::with_config();
    let (locked, open) = (bet_id(1), bet_id(2));
    env.locked_bet(locked);
    env.open_bet(open);
    assert_ok(&env.update_config(&UpdateConfigArgs {
        allowed_mints: Some(vec![Pubkey::new_unique()]),
        ..Default::default()
    }));
    assert!(!env.config().allowed_mints.contains(&env.usdc));

    assert_ok(&env.resolve(&locked, Outcome::PartyB));
    env.warp_to_appeal_deadline(&locked);
    let before = Snapshot::take(&env, &locked);
    let res = env.finalize_bundled(&locked);
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyB, 0, 2 * USDC_5);
    assert_terminal_postconditions_bundled(&env, &before, assert_ok(&res), &exp);

    let before = Snapshot::take(&env, &open);
    let a = env.a.insecure_clone();
    let res = env.cancel_open_bet_bundled(&open, &a);
    let exp = ExpectTerminal::new(TerminalKind::Cancelled, Outcome::Refund, USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, assert_ok(&res), &exp);
}

/// Bundled terminal tx + the §9.1 bundled post-conditions.
#[track_caller]
fn settle_bundled(
    env: &mut Env,
    id: &[u8; 16],
    ix: Instruction,
    signers: &[&Keypair],
    exp: ExpectTerminal,
) {
    let before = Snapshot::take(env, id);
    let res = env.send_bundled(id, ix, signers);
    assert_terminal_postconditions_bundled(env, &before, assert_ok(&res), &exp);
}

#[test]
fn u7_paused_every_exit_still_works() {
    // U7 / TM-L8 / I14 (D1 legs; config.rs covers create / accept [Paused]): with
    // `paused = true`, cancel, resolve, concede, appeal, resolve_appeal, finalize, timeout_refund
    // (from Open, Locked and Appealed) and close_bet all succeed.
    let mut env = Env::with_config();
    let ids: Vec<[u8; 16]> = (1..=10).map(bet_id).collect();
    let (cancel, t_open, resolve, concede, appeal, finalize, t_locked, close, t_appealed) = (
        ids[0], ids[1], ids[2], ids[3], ids[4], ids[5], ids[6], ids[7], ids[8],
    );
    // t = NOW
    env.open_bet(cancel);
    env.open_bet(t_open); // accept_deadline NOW + 300
    env.locked_bet(resolve);
    env.locked_bet(t_locked); // resolve_deadline NOW + 3600
    env.settled_bet(close, Outcome::PartyA); // leaves the clock at NOW + 10
                                             // t = NOW + 10: appeal_deadline NOW + 20
    env.resolved_bet(concede, Outcome::PartyA);
    env.resolved_bet(appeal, Outcome::PartyA);
    env.resolved_bet(finalize, Outcome::PartyA);
    env.resolved_bet(t_appealed, Outcome::PartyA);

    assert_ok(&env.update_config(&UpdateConfigArgs {
        paused: Some(true),
        ..Default::default()
    }));
    assert!(env.config().paused);
    let (a, b, ap) = (
        env.a.insecure_clone(),
        env.b.insecure_clone(),
        env.appeal.insecure_clone(),
    );

    let ix = env.ix_cancel_open_bet(a.pubkey(), &env.default_payout(&cancel));
    let exp = ExpectTerminal::new(TerminalKind::Cancelled, Outcome::Refund, USDC_5, 0);
    settle_bundled(&mut env, &cancel, ix, &[&a], exp);

    assert_ok(&env.resolve(&resolve, Outcome::PartyB));

    let ix = env.ix_concede(b.pubkey(), &env.default_payout(&concede));
    let exp = ExpectTerminal::new(TerminalKind::Conceded, Outcome::PartyA, 2 * USDC_5, 0);
    settle_bundled(&mut env, &concede, ix, &[&b], exp);

    assert_ok(&env.appeal(&appeal, &b));
    assert_ok(&env.appeal(&t_appealed, &b)); // appeal_resolve_deadline NOW + 310
    let p = env.default_payout(&appeal);
    let ix = env.ix_resolve_appeal(ap.pubkey(), &p, Outcome::PartyA, APPEAL_RULING);
    let exp = ExpectTerminal::new(TerminalKind::AppealResolved, Outcome::PartyA, 2 * USDC_5, 0);
    settle_bundled(&mut env, &appeal, ix, &[&ap], exp);

    let before = Snapshot::take(&env, &close);
    let res = env.close_bet(&close);
    assert_close_postconditions(&env, &before, assert_ok(&res), 0);

    env.set_now(NOW + 20);
    for (id, outcome, to_a, to_b) in [
        (finalize, Outcome::PartyA, 2 * USDC_5, 0),
        (resolve, Outcome::PartyB, 0, 2 * USDC_5),
    ] {
        let ix = env.ix_finalize(&env.default_payout(&id));
        let exp = ExpectTerminal::new(TerminalKind::Finalized, outcome, to_a, to_b);
        settle_bundled(&mut env, &id, ix, &[], exp);
    }

    for (id, at, to_b) in [
        (t_open, NOW + 300, 0),
        (t_appealed, NOW + 310, USDC_5),
        (t_locked, NOW + 3600, USDC_5),
    ] {
        env.set_now(at);
        let ix = env.ix_timeout_refund(&env.default_payout(&id));
        let exp = ExpectTerminal::new(TerminalKind::Refunded, Outcome::Refund, USDC_5, to_b);
        settle_bundled(&mut env, &id, ix, &[], exp);
    }

    // Still paused throughout: create is still rejected.
    let (c, ca) = env.default_create(ids[9]);
    assert_escrow_err(&env.create_bet(&c, &ca), EscrowError::Paused);
}

#[test]
fn a7_after_real_cancel_and_after_cancel_close() {
    // A7 with the real D1 instructions (accept_bet.rs forces the state): accept after a
    // standalone cancel → [InvalidStatus]; after a bundled cancel + close → AccountNotInitialized.
    // B's balance never moves.
    let mut env = Env::with_config();
    let a = env.a.insecure_clone();
    let b0 = env.token_balance(&env.b_token);

    let (c, ca) = env.open_bet(bet_id(1));
    assert_ok(&env.cancel_open_bet(&c.bet_id, &a));
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_escrow_err(&env.accept_bet(&aa, &acc), EscrowError::InvalidStatus);
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Cancelled);

    let (c, ca) = env.open_bet(bet_id(2));
    assert_ok(&env.cancel_open_bet_bundled(&c.bet_id, &a));
    assert!(!env.exists(&ca.bet));
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_err(&env.accept_bet(&aa, &acc), ANCHOR_ACCOUNT_NOT_INITIALIZED);
    assert_eq!(env.token_balance(&env.b_token), b0);
}

#[test]
fn b18_presented_lamports_come_back_in_rent_returned() {
    // B18 (close leg; create_bet.rs covers the funded init): Mallory's lamports pre-sent to the
    // Bet and vault addresses count toward their rent, and `close_bet` returns the full rent to
    // S, so over the lifecycle S nets Mallory's lamports.
    let mut env = Env::with_config();
    let id = bet_id(1);
    let (c, ca) = env.default_create(id);
    let mallory = env.mallory.insecure_clone();
    let extra = 1_234_567;
    let gifts = [
        sol_transfer(&mallory.pubkey(), &ca.bet, extra),
        sol_transfer(&mallory.pubkey(), &ca.vault, extra),
    ];
    assert_ok(&env.send(&gifts, &mallory, &[]));
    let s0 = env.sol(&env.s.pubkey());
    let mut fees = 0;
    fees += assert_ok(&env.create_bet(&c, &ca)).meta.fee;
    let (aa, acc) = env.default_accept(&c, &ca);
    fees += assert_ok(&env.accept_bet(&aa, &acc)).meta.fee;
    fees += assert_ok(&env.resolve(&id, Outcome::PartyA)).meta.fee;
    env.warp_to_appeal_deadline(&id);
    let before = Snapshot::take(&env, &id);
    let res = env.finalize_bundled(&id);
    let sent = assert_ok(&res);
    fees += sent.meta.fee;
    let exp = ExpectTerminal::new(TerminalKind::Finalized, Outcome::PartyA, 2 * USDC_5, 0);
    assert_terminal_postconditions_bundled(&env, &before, sent, &exp);
    let closed = &events::<BetClosed>(sent)[0];
    assert_eq!(closed.rent_returned, bet_rent(&env) + vault_rent(&env));
    assert_eq!(env.sol(&env.s.pubkey()), s0 - fees + 2 * extra);
}
