//! ESCROW §9.2 rows C1–C5 (initialize_config) and U1–U10 (update_config).

use anchor_lang::prelude::Pubkey;
use escrow::{
    BetStatus, ConfigInitialized, ConfigUpdated, EscrowError, UpdateConfigArgs, MAX_STAKE_CEILING,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::common::*;

fn fresh() -> (Env, escrow::InitConfigArgs) {
    let env = Env::new();
    let args = demo_args(env.judge.pubkey(), env.appeal.pubkey(), vec![env.usdc]);
    (env, args)
}

#[test]
fn c1_initialize_config_by_upgrade_authority() {
    let (mut env, args) = fresh();
    let res = env.initialize_config(&args);
    let sent = assert_ok(&res);
    let c = env.config();
    assert_eq!(c.admin, env.admin.pubkey());
    assert_eq!(c.judge_authority, args.judge_authority);
    assert_eq!(c.appeal_authority, args.appeal_authority);
    assert_eq!(c.max_stake, 20_000_000);
    assert_eq!(c.appeal_window_secs, 10);
    assert_eq!(c.accept_deadline_secs, 600);
    assert_eq!(c.resolve_deadline_secs, 3600);
    assert_eq!(c.appeal_resolve_secs, 300);
    assert_eq!(c.allowed_mints, vec![env.usdc]);
    assert!(!c.paused);
    assert_eq!(
        c.bump,
        Pubkey::find_program_address(&[escrow::CONFIG_SEED], &escrow::ID).1
    );
    // §3.1: 8 + 254 = 262 bytes
    assert_eq!(env.svm.get_account(&config_pda()).unwrap().data.len(), 262);

    let evs = events::<ConfigInitialized>(sent);
    assert_eq!(evs.len(), 1);
    assert_eq!(event_count(sent), 1);
    let e = &evs[0];
    assert_eq!(e.admin, env.admin.pubkey());
    assert_eq!(e.judge_authority, args.judge_authority);
    assert_eq!(e.appeal_authority, args.appeal_authority);
    assert_eq!(e.max_stake, args.max_stake);
    assert_eq!(e.allowed_mints, vec![env.usdc]);
    assert!(!e.paused);
    assert_eq!(e.ts, NOW);
    assert_no_log_truncation(sent);
}

#[test]
fn c2_signer_not_upgrade_authority() {
    let (mut env, args) = fresh();
    let mallory = env.mallory.insecure_clone();
    let ix = env.ix_initialize_config(mallory.pubkey(), &args);
    let res = env.send(&[ix], &mallory, &[]);
    assert_escrow_err(&res, EscrowError::NotUpgradeAuthority);
    assert!(!env.exists(&config_pda()));

    // Program with no upgrade authority (immutable / LiteSVM default): nobody can init.
    set_upgrade_authority(&mut env.svm, &escrow::ID, None);
    let res = env.initialize_config(&args);
    assert_escrow_err(&res, EscrowError::NotUpgradeAuthority);

    // A ProgramData account that isn't this program's: the escrow_program constraint fails.
    set_upgrade_authority(&mut env.svm, &escrow::ID, Some(env.admin.pubkey()));
    let mut ix = env.ix_initialize_config(env.admin.pubkey(), &args);
    let fake_pd = Pubkey::new_unique();
    let real_pd = program_data_address(&escrow::ID);
    let pd_acc = env.svm.get_account(&real_pd).unwrap();
    env.svm.set_account(fake_pd, pd_acc).unwrap();
    for m in ix.accounts.iter_mut() {
        if m.pubkey == real_pd {
            m.pubkey = fake_pd;
        }
    }
    let admin = env.admin.insecure_clone();
    let res = env.send(&[ix], &admin, &[]);
    assert_err(&res, ANCHOR_CONSTRAINT_RAW);
}

#[test]
fn c3_judge_equals_appeal_or_default_key() {
    let (mut env, args) = fresh();
    let mut a = args.clone();
    a.appeal_authority = a.judge_authority;
    assert_escrow_err(&env.initialize_config(&a), EscrowError::InvalidConfig);

    let mut a = args.clone();
    a.judge_authority = Pubkey::default();
    assert_escrow_err(&env.initialize_config(&a), EscrowError::InvalidConfig);

    let mut a = args.clone();
    a.appeal_authority = Pubkey::default();
    assert_escrow_err(&env.initialize_config(&a), EscrowError::InvalidConfig);
    assert!(!env.exists(&config_pda()));
}

#[test]
fn c4_out_of_range_values() {
    let (mut env, args) = fresh();
    let m = || Pubkey::new_unique();
    type Mutator = Box<dyn Fn(&mut escrow::InitConfigArgs)>;
    let cases: Vec<(&str, Mutator)> = vec![
        ("max_stake = 0", Box::new(|a| a.max_stake = 0)),
        (
            "max_stake > ceiling",
            Box::new(|a| a.max_stake = MAX_STAKE_CEILING + 1),
        ),
        ("appeal_window 0", Box::new(|a| a.appeal_window_secs = 0)),
        (
            "appeal_window 86_401",
            Box::new(|a| a.appeal_window_secs = 86_401),
        ),
        (
            "accept_deadline 9",
            Box::new(|a| a.accept_deadline_secs = 9),
        ),
        (
            "accept_deadline 86_401",
            Box::new(|a| a.accept_deadline_secs = 86_401),
        ),
        (
            "resolve_deadline 59",
            Box::new(|a| a.resolve_deadline_secs = 59),
        ),
        (
            "resolve_deadline 604_801",
            Box::new(|a| a.resolve_deadline_secs = 604_801),
        ),
        ("appeal_resolve 9", Box::new(|a| a.appeal_resolve_secs = 9)),
        (
            "appeal_resolve 86_401",
            Box::new(|a| a.appeal_resolve_secs = 86_401),
        ),
        ("0 mints", Box::new(|a| a.allowed_mints = vec![])),
        (
            "5 mints",
            Box::new(move |a| a.allowed_mints = vec![m(), m(), m(), m(), m()]),
        ),
        (
            "duplicate mint",
            Box::new(|a| a.allowed_mints = vec![a.allowed_mints[0], a.allowed_mints[0]]),
        ),
        (
            "default mint",
            Box::new(|a| a.allowed_mints = vec![a.allowed_mints[0], Pubkey::default()]),
        ),
    ];
    for (name, f) in cases {
        let mut a = args.clone();
        f(&mut a);
        let res = env.initialize_config(&a);
        assert_eq!(
            custom_code(&res),
            Some(err_code(EscrowError::InvalidConfig)),
            "case {name}"
        );
    }
    // Boundaries are inclusive and accepted.
    let mut a = args.clone();
    a.max_stake = MAX_STAKE_CEILING;
    a.appeal_window_secs = 1;
    a.accept_deadline_secs = 86_400;
    a.resolve_deadline_secs = 604_800;
    a.appeal_resolve_secs = 10;
    a.allowed_mints = vec![m(), m(), m(), env.usdc];
    assert_ok(&env.initialize_config(&a));
}

#[test]
fn c5_second_initialize_fails_already_in_use() {
    let (mut env, args) = fresh();
    assert_ok(&env.initialize_config(&args));
    let res = env.initialize_config(&args);
    assert_already_in_use(&res);
}

#[test]
fn u1_admin_changes_max_stake() {
    let mut env = Env::with_config();
    let before = env.config();
    let res = env.update_config(&UpdateConfigArgs {
        max_stake: Some(10_000_000),
        ..Default::default()
    });
    let sent = assert_ok(&res);
    let after = env.config();
    assert_eq!(after.max_stake, 10_000_000);
    // everything else unchanged
    let mut expect = before.clone();
    expect.max_stake = 10_000_000;
    assert_eq!(after, expect);

    let evs = events::<ConfigUpdated>(sent);
    assert_eq!(evs.len(), 1);
    assert_eq!(event_count(sent), 1);
    let e = &evs[0];
    // full post-update snapshot
    assert_eq!(e.max_stake, 10_000_000);
    assert_eq!(e.admin, after.admin);
    assert_eq!(e.judge_authority, after.judge_authority);
    assert_eq!(e.appeal_authority, after.appeal_authority);
    assert_eq!(e.appeal_window_secs, after.appeal_window_secs);
    assert_eq!(e.accept_deadline_secs, after.accept_deadline_secs);
    assert_eq!(e.resolve_deadline_secs, after.resolve_deadline_secs);
    assert_eq!(e.appeal_resolve_secs, after.appeal_resolve_secs);
    assert_eq!(e.allowed_mints, after.allowed_mints);
    assert_eq!(e.paused, after.paused);

    // A new admin takes over and the old one is locked out.
    let new_admin = Keypair::new();
    env.svm.airdrop(&new_admin.pubkey(), 1_000_000_000).unwrap();
    assert_ok(&env.update_config(&UpdateConfigArgs {
        new_admin: Some(new_admin.pubkey()),
        ..Default::default()
    }));
    assert_eq!(env.config().admin, new_admin.pubkey());
    assert_escrow_err(
        &env.update_config(&UpdateConfigArgs {
            paused: Some(true),
            ..Default::default()
        }),
        EscrowError::NotAdmin,
    );
    let ix = env.ix_update_config(
        new_admin.pubkey(),
        &UpdateConfigArgs {
            paused: Some(true),
            ..Default::default()
        },
    );
    assert_ok(&env.send(&[ix], &new_admin, &[]));
    assert!(env.config().paused);
}

#[test]
fn u2_non_admin() {
    let mut env = Env::with_config();
    let mallory = env.mallory.insecure_clone();
    for signer in [
        &mallory,
        &env.judge.insecure_clone(),
        &env.appeal.insecure_clone(),
    ] {
        let ix = env.ix_update_config(
            signer.pubkey(),
            &UpdateConfigArgs {
                max_stake: Some(1),
                ..Default::default()
            },
        );
        let res = env.send(&[ix], &mallory, &[signer]);
        assert_escrow_err(&res, EscrowError::NotAdmin);
    }
    assert_eq!(env.config().max_stake, MAX_STAKE);
}

#[test]
fn u3_rotate_judge_snapshot() {
    // The resolve legs (J resolves ok; J2 [NotJudge] on the old bet) need D1 `resolve`.
    // D0 covers the snapshot that makes them hold: the live bet keeps J, a new bet gets J2.
    let mut env = Env::with_config();
    let j = env.judge.pubkey();
    let (c, ca) = env.open_bet(bet_id(1));
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_ok(&env.accept_bet(&aa, &acc));
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Locked);

    let j2 = Keypair::new();
    assert_ok(&env.update_config(&UpdateConfigArgs {
        judge_authority: Some(j2.pubkey()),
        ..Default::default()
    }));
    assert_eq!(env.config().judge_authority, j2.pubkey());
    assert_eq!(env.bet(&c.bet_id).judge_authority, j);

    let (c2, _) = env.open_bet(bet_id(2));
    assert_eq!(env.bet(&c2.bet_id).judge_authority, j2.pubkey());
    assert_eq!(env.bet(&c2.bet_id).appeal_authority, env.appeal.pubkey());
}

#[test]
fn u4_appeal_window_change_does_not_touch_live_bet() {
    let mut env = Env::with_config();
    let (c, _) = env.open_bet(bet_id(1));
    assert_ok(&env.update_config(&UpdateConfigArgs {
        appeal_window_secs: Some(60),
        resolve_deadline_secs: Some(7200),
        appeal_resolve_secs: Some(600),
        ..Default::default()
    }));
    let bet = env.bet(&c.bet_id);
    assert_eq!(bet.appeal_window_secs, 10);
    assert_eq!(bet.resolve_window_secs, 3600);
    assert_eq!(bet.appeal_resolve_secs, 300);
    // resolve_window still applied from the snapshot at accept
    let (aa, acc) = env.default_accept(&c, &env.default_create(c.bet_id).1);
    assert_ok(&env.accept_bet(&aa, &acc));
    assert_eq!(env.bet(&c.bet_id).resolve_deadline, NOW + 3600);
    // a new bet picks up the new values
    let (c2, _) = env.open_bet(bet_id(2));
    assert_eq!(env.bet(&c2.bet_id).appeal_window_secs, 60);
}

#[test]
fn u5_lower_max_stake_below_live_open_bet() {
    let mut env = Env::with_config();
    let (mut c, ca) = env.default_create(bet_id(1));
    c.stake_a = 20_000_000;
    c.stake_b = 20_000_000;
    assert_ok(&env.create_bet(&c, &ca));
    assert_ok(&env.update_config(&UpdateConfigArgs {
        max_stake: Some(1_000_000),
        ..Default::default()
    }));
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_ok(&env.accept_bet(&aa, &acc));
    assert_eq!(env.token_balance(&ca.vault), 40_000_000);
    // new bets use the new cap
    let (mut c2, ca2) = env.default_create(bet_id(2));
    c2.stake_a = 1_000_001;
    assert_escrow_err(&env.create_bet(&c2, &ca2), EscrowError::StakeExceedsMax);
}

#[test]
fn u6_remove_mint_from_allowlist() {
    // "Live bet settles ok" needs D1 terminal instructions; D0 checks the live bet still
    // locks and a new create is rejected.
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    let other = Pubkey::new_unique();
    assert_ok(&env.update_config(&UpdateConfigArgs {
        allowed_mints: Some(vec![other]),
        ..Default::default()
    }));
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_ok(&env.accept_bet(&aa, &acc));
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Locked);
    let (c2, ca2) = env.default_create(bet_id(2));
    assert_escrow_err(&env.create_bet(&c2, &ca2), EscrowError::MintNotAllowed);
}

#[test]
fn u7_paused_blocks_create_and_accept_only() {
    // The "cancel / resolve / concede / appeal / resolve_appeal / finalize / timeout /
    // close_bet ok while paused" legs need D1. D0: create and accept → [Paused]; unpause works.
    let mut env = Env::with_config();
    let (c, ca) = env.open_bet(bet_id(1));
    assert_ok(&env.update_config(&UpdateConfigArgs {
        paused: Some(true),
        ..Default::default()
    }));
    let (c2, ca2) = env.default_create(bet_id(2));
    assert_escrow_err(&env.create_bet(&c2, &ca2), EscrowError::Paused);
    let (aa, acc) = env.default_accept(&c, &ca);
    assert_escrow_err(&env.accept_bet(&aa, &acc), EscrowError::Paused);
    assert_eq!(env.bet(&c.bet_id).status, BetStatus::Open);
    assert_ok(&env.update_config(&UpdateConfigArgs {
        paused: Some(false),
        ..Default::default()
    }));
    assert_ok(&env.accept_bet(&aa, &acc));
}

#[test]
fn u8_appeal_equals_judge() {
    let mut env = Env::with_config();
    let j = env.judge.pubkey();
    assert_escrow_err(
        &env.update_config(&UpdateConfigArgs {
            appeal_authority: Some(j),
            ..Default::default()
        }),
        EscrowError::InvalidConfig,
    );
    let ap = env.appeal.pubkey();
    assert_escrow_err(
        &env.update_config(&UpdateConfigArgs {
            judge_authority: Some(ap),
            ..Default::default()
        }),
        EscrowError::InvalidConfig,
    );
    // swapping both at once is fine
    assert_ok(&env.update_config(&UpdateConfigArgs {
        judge_authority: Some(ap),
        appeal_authority: Some(j),
        ..Default::default()
    }));
}

#[test]
fn u9_default_admin_or_ceiling() {
    let mut env = Env::with_config();
    let before = env.config();
    assert_escrow_err(
        &env.update_config(&UpdateConfigArgs {
            new_admin: Some(Pubkey::default()),
            ..Default::default()
        }),
        EscrowError::InvalidConfig,
    );
    assert_escrow_err(
        &env.update_config(&UpdateConfigArgs {
            max_stake: Some(MAX_STAKE_CEILING + 1),
            ..Default::default()
        }),
        EscrowError::InvalidConfig,
    );
    let five: Vec<Pubkey> = (0..5).map(|_| Pubkey::new_unique()).collect();
    assert_escrow_err(
        &env.update_config(&UpdateConfigArgs {
            allowed_mints: Some(five),
            ..Default::default()
        }),
        EscrowError::InvalidConfig,
    );
    assert_escrow_err(
        &env.update_config(&UpdateConfigArgs {
            allowed_mints: Some(vec![]),
            ..Default::default()
        }),
        EscrowError::InvalidConfig,
    );
    assert_eq!(env.config(), before);
}

#[test]
fn u10_admin_passed_but_not_signing() {
    let mut env = Env::with_config();
    let mut ix = env.ix_update_config(
        env.admin.pubkey(),
        &UpdateConfigArgs {
            max_stake: Some(1),
            ..Default::default()
        },
    );
    unsign(&mut ix, &env.admin.pubkey());
    let mallory = env.mallory.insecure_clone();
    let res = env.send(&[ix], &mallory, &[]);
    assert_err(&res, ANCHOR_ACCOUNT_NOT_SIGNER);
    assert_eq!(env.config().max_stake, MAX_STAKE);
}
