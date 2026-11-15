//! Market (World Mode) and ai_judged bets, plus account layout checks.
mod common;

use anchor_lang::Discriminator;
use common::flow::*;
use common::payload::*;
use common::*;

fn market_flow(stakes: Vec<u64>, side_b_mask: u8, result: u8) -> Flow {
    let n = stakes.len();
    let users = default_users(n);
    let keys: Vec<Pubkey> = users.iter().map(|u| u.pubkey()).collect();
    let h = sha256(&[b"gemini:evt-1:yes"]);
    let program_bin = ProgramB {
        kind: 2,
        time_limit_s: 86_400,
        participants: keys,
        stakes: stakes.clone(),
        side_b_mask,
        entities: vec![],
        legs: vec![LegB::market(1, h, true)],
        if_true: 1,
        else_side: 0,
        cond: cond_leg(1),
    }
    .encode();
    let spec = Spec {
        nonce: 11,
        flags: FLAG_MARKET,
        stakes,
        stake_each: 0,
        side_b_mask,
        time_limit_s: 86_400,
        acceptance: [0; 32],
        program_bin,
        calibration_bin: vec![],
        tracks_bin: market_bin(&[(h, result)]),
    };
    Flow::with(Env::new(), users, spec)
}

#[test]
fn market_bet_uneven_stakes_split() {
    let stakes = vec![1_000_000, 1_000_001, 2_000_000];
    let mut f = market_flow(stakes.clone(), 0b110, 1);
    f.create();
    f.fund_all();
    assert_eq!(f.bet().calibration_hash, [0; 32]);
    ok(f.try_start());
    let b = f.bet();
    assert_eq!((b.beacon_slot, b.n_witnesses, b.evidence_root), (0, 0, [0; 32]));
    // Only the oracle ends a market bet.
    let u = f.users[1].insecure_clone();
    assert_err(f.try_end(&u, 0, vec![]), VerdictError::Unauthorized);
    f.end_by_oracle();
    f.post_tracks();
    ok(f.try_run_rules());
    let b = f.bet();
    assert_eq!(b.winner_mask, 0b110);
    f.env.advance(CONSENT_WINDOW_S + 1);
    let o = f.env.oracle.insecure_clone();
    ok(f.try_consent(&o));
    let expected = verdict_rules::settle::settle_payouts(&stakes, 0b111, 0b110, 0, false, None).unwrap();
    assert_eq!(expected[1] + expected[2], 4_000_001);
    for i in 0..3 {
        assert_eq!(f.balance(i), INITIAL_BALANCE - stakes[i] + expected[i], "participant {i}");
    }
}

#[test]
fn market_void_goes_to_panel() {
    let mut f = market_flow(vec![1_000_000, 2_000_000], 0b10, 2);
    f.to_preruled();
    let b = f.bet();
    assert_eq!(b.state, STATE_DISPUTED);
    assert_eq!(b.dispute_reason, 10);
    ok(f.try_settle_panel(0, 0, 1));
    assert_eq!(f.bet().refund_reason, REFUND_NO_CONTEST);
    assert_eq!(f.balance(0), INITIAL_BALANCE);
}

#[test]
fn market_start_rejects_beacon_and_witnesses() {
    let mut f = market_flow(vec![1_000_000, 2_000_000], 0b10, 1);
    f.create();
    f.fund_all();
    let o = f.env.oracle.insecure_clone();
    let ixn = f.start_ix(&o.pubkey(), 5, vec![]);
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::BeaconSlotNotFound);
    let w = f.witness_args();
    let ixn = f.start_ix(&o.pubkey(), 0, w);
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::TooManyWitnesses);
}

#[test]
fn market_fund_requires_zero_calibration() {
    let mut f = market_flow(vec![1_000_000, 2_000_000], 0b10, 1);
    f.create();
    let ixn = f.fund_ix(0, [1; 32], f.spec.program_hash(), f.terms());
    let u = f.users[0].insecure_clone();
    assert_err(f.env.send(&[ixn], &[&u]), VerdictError::CalibrationMismatch);
}

#[test]
fn ai_judged_goes_to_panel_then_pays() {
    let users = default_users(2);
    let keys: Vec<Pubkey> = users.iter().map(|u| u.pubkey()).collect();
    let program_bin = ProgramB {
        kind: 1,
        time_limit_s: 120,
        participants: keys,
        stakes: vec![STAKE; 2],
        side_b_mask: 0b10,
        entities: vec![],
        legs: vec![],
        if_true: 1,
        else_side: 0,
        cond: vec![OP_YES],
    }
    .encode();
    let spec = Spec {
        nonce: 12,
        flags: FLAG_AI_JUDGED,
        stakes: vec![STAKE; 2],
        stake_each: STAKE,
        side_b_mask: 0b10,
        time_limit_s: 120,
        acceptance: [5; 32],
        program_bin,
        calibration_bin: vec![],
        tracks_bin: ai_tracks_bin(),
    };
    let mut f = Flow::with(Env::new(), users, spec);
    f.to_preruled();
    let b = f.bet();
    assert_eq!(b.state, STATE_DISPUTED);
    assert_eq!(b.preruling, PRERULING_NEEDS_PANEL);
    assert_eq!(b.dispute_reason, 11);
    assert_eq!(b.dispute_bond, 0);
    assert_eq!(b.disputer, Pubkey::default());
    ok(f.try_settle_panel(2, 0, 2));
    let b = f.bet();
    assert_eq!(b.settle_path, PATH_PANEL);
    assert_eq!(b.final_winner_mask, 0b10);
    assert_eq!(f.balance(1), INITIAL_BALANCE + STAKE);
}

#[test]
fn cross_check_failure_goes_to_panel() {
    let mut f = Flow::rules(2, true);
    f.spec.tracks_bin = tracks_bin(0, &[(0, 0xFF, 0)], &[(0, 20)], |_, _| at(5000, 5000, 100));
    f.to_preruled();
    let b = f.bet();
    assert_eq!(b.state, STATE_DISPUTED);
    assert_eq!(b.dispute_reason, 12);
    assert_eq!(b.leg_results[0], 2);
}

#[test]
fn verify_sp1_run_is_disabled_by_default() {
    let mut f = Flow::rules(2, true);
    f.create();
    let ixn = ix(
        verdict::instruction::VerifySp1Run { public_values: vec![0; 171], proof: vec![1; 64] },
        verdict::accounts::VerifySp1Run { oracle: f.env.oracle.pubkey(), bet: f.bet },
        &[],
    );
    let o = f.env.oracle.insecure_clone();
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::Sp1Disabled);
}

#[test]
fn account_layouts_and_discriminators() {
    use anchor_lang::AnchorSerialize;
    let zeros = vec![0u8; 1580];
    let bet: Bet = anchor_lang::AnchorDeserialize::deserialize(&mut &zeros[..]).unwrap();
    assert_eq!(bet.try_to_vec().unwrap().len(), 1580);
    let zeros = vec![0u8; 179];
    let p: Profile = anchor_lang::AnchorDeserialize::deserialize(&mut &zeros[..]).unwrap();
    assert_eq!(p.try_to_vec().unwrap().len(), 179);
    assert_eq!(std::mem::size_of::<verdict::state::TrackBuffer>(), 48);
    assert_eq!(Bet::DISCRIMINATOR, &sha256(&[b"account:Bet"])[..8]);
    assert_eq!(Profile::DISCRIMINATOR, &sha256(&[b"account:Profile"])[..8]);
    assert_eq!(verdict::state::TrackBuffer::DISCRIMINATOR, &sha256(&[b"account:TrackBuffer"])[..8]);
    // Error numbering (§9.6).
    assert_eq!(code(VerdictError::InvalidState), 6000);
    assert_eq!(code(VerdictError::DeadlineNotReached), 6010);
    assert_eq!(code(VerdictError::BufferIncomplete), 6020);
    assert_eq!(code(VerdictError::InsufficientQuorum), 6030);
    assert_eq!(code(VerdictError::BadReason), 6040);
    assert_eq!(code(VerdictError::BadFlags), 6044);
    // Field offsets: spot-check a populated Bet against the documented order.
    let mut f = Flow::rules(2, true);
    f.create();
    let data = f.env.svm.get_account(&f.bet).unwrap().data;
    let d = &data[8..];
    assert_eq!(d[0], 1); // version
    assert_eq!(&d[5..37], f.users[0].pubkey().as_ref()); // creator
    assert_eq!(u64::from_le_bytes(d[37..45].try_into().unwrap()), 7); // nonce
    assert_eq!(d[205], 2); // n_participants
    assert_eq!(u64::from_le_bytes(d[462..470].try_into().unwrap()), STAKE); // stakes[0]
    assert_eq!(d[526], 0b10); // side_b_mask
    assert_eq!(u32::from_le_bytes(d[536..540].try_into().unwrap()), 60); // time_limit_s
    assert_eq!(&d[540..572], &f.spec.program_hash()); // program_hash
    assert_eq!(&d[965..973], &[0xFF; 8]); // witness_kinds
    assert_eq!(&d[1382..1390], &[0xFF; 8]); // leg_results
}
