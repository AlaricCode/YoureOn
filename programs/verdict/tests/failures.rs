//! Validation failures of create_bet, fund, start, post_tracks and run_rules.
mod common;

use common::flow::*;
use common::payload::*;
use common::*;

fn create_err(f: &mut Flow, spec: &Spec, participants: Vec<Pubkey>, judges: [Pubkey; 3], e: VerdictError) {
    let ixn = f.create_ix(spec, participants, judges);
    let (c, o) = (f.users[0].insecure_clone(), f.env.oracle.insecure_clone());
    assert_err(f.env.send(&[ixn], &[&c, &o]), e);
}

#[test]
fn create_bet_checks() {
    let mut f = Flow::rules(3, true);
    let keys = f.keys();
    let judges = f.env.judge_keys();
    let oracle = f.env.oracle.pubkey();
    let base = f.spec.clone();
    let s3 = Spec { stakes: vec![STAKE; 3], side_b_mask: 0b110, ..base.clone() };

    // Participants: count, creator first, distinct, oracle not a participant.
    create_err(&mut f, &Spec { stakes: vec![STAKE], ..base.clone() }, vec![keys[0]], judges, VerdictError::BadParticipants);
    create_err(&mut f, &s3, vec![keys[1], keys[0], keys[2]], judges, VerdictError::BadParticipants);
    create_err(&mut f, &s3, vec![keys[0], keys[1], keys[1]], judges, VerdictError::BadParticipants);
    create_err(&mut f, &s3, vec![keys[0], keys[1], oracle], judges, VerdictError::BadParticipants);
    let nine: Vec<Pubkey> = (0..9).map(|i| if i == 0 { keys[0] } else { kp(50 + i).pubkey() }).collect();
    create_err(&mut f, &Spec { stakes: vec![STAKE; 9], ..base.clone() }, nine, judges, VerdictError::BadParticipants);

    // Sides.
    for m in [0u8, 0b001, 0b011, 0b1000] {
        create_err(&mut f, &Spec { side_b_mask: m, ..s3.clone() }, keys.clone(), judges, VerdictError::BadSides);
    }
    // Stakes.
    create_err(&mut f, &Spec { stakes: vec![STAKE, STAKE, STAKE + 1], ..s3.clone() }, keys.clone(), judges, VerdictError::BadStake);
    create_err(&mut f, &Spec { stakes: vec![9_999; 3], stake_each: 9_999, ..s3.clone() }, keys.clone(), judges, VerdictError::BadStake);
    create_err(&mut f, &Spec { stakes: vec![STAKE; 2], ..s3.clone() }, keys.clone(), judges, VerdictError::BadStake);
    create_err(&mut f, &Spec { flags: FLAG_MARKET, ..s3.clone() }, keys.clone(), judges, VerdictError::BadStake);
    // Time limit.
    create_err(&mut f, &Spec { time_limit_s: 0, ..s3.clone() }, keys.clone(), judges, VerdictError::BadTimeLimit);
    create_err(&mut f, &Spec { time_limit_s: 3601, ..s3.clone() }, keys.clone(), judges, VerdictError::BadTimeLimit);
    // Flags.
    for fl in [FLAG_AI_JUDGED | FLAG_MARKET, FLAG_AI_JUDGED | FLAG_ACTOR_BOUND, 0b1000] {
        create_err(&mut f, &Spec { flags: fl, ..s3.clone() }, keys.clone(), judges, VerdictError::BadFlags);
    }
    // Judges: distinct, not participants, not the oracle.
    create_err(&mut f, &s3, keys.clone(), [judges[0], judges[0], judges[2]], VerdictError::BadJudges);
    create_err(&mut f, &s3, keys.clone(), [judges[0], keys[1], judges[2]], VerdictError::BadJudges);
    create_err(&mut f, &s3, keys.clone(), [judges[0], judges[1], oracle], VerdictError::BadJudges);
    // program_hash ≠ 0 is checked: build an instruction with a zero hash.
    let mut ixn = f.create_ix(&s3, keys.clone(), judges);
    let off = ixn.data.len() - 96 - 32 - 32;
    ixn.data[off..off + 32].fill(0);
    let (c, o) = (f.users[0].insecure_clone(), f.env.oracle.insecure_clone());
    assert_err(f.env.send(&[ixn], &[&c, &o]), VerdictError::ProgramHashMismatch);

    // Multi-fault ordering (validate_terms): participants/oracle, flags, sides, stakes.
    create_err(&mut f, &Spec { flags: 0b1000, side_b_mask: 0b001, ..s3.clone() }, keys.clone(), judges, VerdictError::BadFlags);
    create_err(&mut f, &Spec { stakes: vec![STAKE; 2], ..s3.clone() }, vec![keys[0], keys[1], oracle], judges, VerdictError::BadParticipants);
    create_err(&mut f, &Spec { stakes: vec![STAKE; 2], side_b_mask: 0b001, ..s3.clone() }, keys.clone(), judges, VerdictError::BadSides);

    // The oracle must co-sign.
    let mut ixn = f.create_ix(&s3, keys.clone(), judges);
    ixn.accounts[2].is_signer = false;
    let c = f.users[0].insecure_clone();
    assert_fails(f.env.send(&[ixn], &[&c]));

    // And the valid one passes.
    ok(f.try_create_spec(&s3));
}

#[test]
fn fund_checks() {
    let mut f = Flow::rules(2, true);
    f.create();
    let (cal, ph, terms) = (f.spec.calibration_hash(), f.spec.program_hash(), f.terms());
    let send = |f: &mut Flow, i: usize, c: [u8; 32], p: [u8; 32], t: [u8; 32]| {
        let ixn = f.fund_ix(i, c, p, t);
        let u = f.users[i].insecure_clone();
        f.env.send(&[ixn], &[&u])
    };
    assert_err(send(&mut f, 0, cal, [1; 32], terms), VerdictError::ConsentMismatch);
    assert_err(send(&mut f, 0, cal, ph, [1; 32]), VerdictError::ConsentMismatch);
    assert_err(send(&mut f, 0, [0; 32], ph, terms), VerdictError::CalibrationMismatch);
    ok(send(&mut f, 0, cal, ph, terms));
    assert_err(send(&mut f, 0, cal, ph, terms), VerdictError::AlreadyFunded);
    // The second funder must match the first funder's calibration.
    assert_err(send(&mut f, 1, [3; 32], ph, terms), VerdictError::CalibrationMismatch);
    // Not a participant (own token account, valid hashes).
    let stranger = kp(99);
    f.env.airdrop(&stranger.pubkey(), 1_000_000_000);
    let mint = f.env.mint;
    let st = f.env.create_token_account(&stranger.pubkey(), &mint);
    let mut ixn = f.fund_ix(1, cal, ph, terms);
    ixn.accounts[0].pubkey = stranger.pubkey();
    ixn.accounts[3].pubkey = st;
    assert_err(f.env.send(&[ixn], &[&stranger]), VerdictError::NotParticipant);
    // Someone else's token account.
    let mut ixn = f.fund_ix(1, cal, ph, terms);
    ixn.accounts[3].pubkey = f.tokens[0];
    let u = f.users[1].insecure_clone();
    assert_err(f.env.send(&[ixn], &[&u]), VerdictError::BadTokenAccount);
    // Wrong mint.
    let other_mint = f.env.create_mint();
    let wrong = f.env.create_token_account(&f.users[1].pubkey(), &other_mint);
    let mut ixn = f.fund_ix(1, cal, ph, terms);
    ixn.accounts[3].pubkey = wrong;
    assert_err(f.env.send(&[ixn], &[&u]), VerdictError::BadTokenAccount);
    ok(f.try_fund(1));
    assert_err(f.try_fund(1), VerdictError::InvalidState);
}

#[test]
fn start_checks() {
    let mut f = Flow::rules(2, true);
    f.create();
    let (bslot, _) = f.beacon();
    let w = f.witness_args();
    // Not funded yet.
    let o = f.env.oracle.insecure_clone();
    let ixn = f.start_ix(&o.pubkey(), bslot, w.clone());
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::InvalidState);
    f.fund_all();
    // Stranger.
    let stranger = kp(99);
    let ixn = f.start_ix(&stranger.pubkey(), bslot, w.clone());
    assert_err(f.env.send(&[ixn], &[&stranger]), VerdictError::Unauthorized);
    // Unknown slot, future slot, too old.
    let ixn = f.start_ix(&o.pubkey(), bslot + 1, w.clone());
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::BeaconSlotNotFound);
    let ixn = f.start_ix(&o.pubkey(), f.env.slot() + 1, w.clone());
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::BeaconSlotNotFound);
    let old = f.env.slot() - BEACON_MAX_AGE_SLOTS - 1;
    f.env.set_slot_hashes(&[(old, solana_sdk::hash::Hash::new_from_array([3; 32]))]);
    let ixn = f.start_ix(&o.pubkey(), old, w.clone());
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::BeaconTooOld);
    let (bslot, _) = f.beacon();
    // Witnesses: duplicates, bad kind, too many.
    let dup = vec![w[0], w[0]];
    let ixn = f.start_ix(&o.pubkey(), bslot, dup);
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::TooManyWitnesses);
    let bad = vec![WitnessArg { key: w[0].key, kind: 3 }];
    let ixn = f.start_ix(&o.pubkey(), bslot, bad);
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::TooManyWitnesses);
    let nine: Vec<WitnessArg> = (0..9).map(|i| WitnessArg { key: kp(120 + i).pubkey(), kind: 1 }).collect();
    let ixn = f.start_ix(&o.pubkey(), bslot, nine);
    assert_err(f.env.send(&[ixn], &[&o]), VerdictError::TooManyWitnesses);
    // The creator may start, with 8 witnesses.
    let eight: Vec<WitnessArg> = (0..8).map(|i| WitnessArg { key: kp(120 + i).pubkey(), kind: 2 }).collect();
    let c = f.users[0].insecure_clone();
    let ixn = f.start_ix(&c.pubkey(), bslot, eight);
    ok(f.env.send(&[ixn], &[&c]));
    assert_eq!(f.bet().n_witnesses, 8);
}

fn ended(ball: bool) -> Flow {
    let mut f = Flow::rules(2, ball);
    f.create();
    f.fund_all();
    ok(f.try_start());
    f.end_by_oracle();
    f
}

#[test]
fn post_tracks_layout_checks() {
    let mut f = ended(true);
    let payload = f.spec.payload();
    let (pl, cl) = (f.spec.program_bin.len() as u16, f.spec.calibration_bin.len() as u16);
    let n = payload.len() as u32;
    let o = f.env.oracle.insecure_clone();
    let post = |f: &mut Flow, len: u32, p: u16, c: u16, off: u32, data: Vec<u8>, fin: bool| {
        let ixn = f.post_ix(len, p, c, off, data, fin, [7; 32]);
        f.env.send(&[ixn], &[&o])
    };
    assert_err(post(&mut f, 10_001, pl, cl, 0, vec![], false), VerdictError::BufferTooLarge);
    assert_err(post(&mut f, n, pl, cl, 0, vec![0; 701], false), VerdictError::BufferTooLarge);
    assert_err(post(&mut f, 10, 8, 8, 0, vec![], false), VerdictError::BufferLayout);
    // First chunk creates the buffer.
    ok(post(&mut f, n, pl, cl, 0, payload[..100].to_vec(), false));
    assert_eq!(f.env.svm.get_account(&f.tracks()).unwrap().data.len(), 56 + n as usize);
    // Non-sequential offset; changed lengths; overflow.
    assert_err(post(&mut f, n, pl, cl, 50, payload[50..60].to_vec(), false), VerdictError::BufferLayout);
    assert_err(post(&mut f, n + 1, pl, cl, 100, payload[100..110].to_vec(), false), VerdictError::BufferLayout);
    assert_err(post(&mut f, n, pl, cl + 1, 100, payload[100..110].to_vec(), false), VerdictError::BufferLayout);
    // Finalize before complete.
    assert_err(post(&mut f, n, pl, cl, 100, payload[100..200].to_vec(), true), VerdictError::BufferIncomplete);
    // run_rules before finalize.
    assert_err(f.try_run_rules(), VerdictError::TracksNotFinalized);
    ok(post(&mut f, n, pl, cl, 100, payload[100..].to_vec(), false));
    assert_err(post(&mut f, n, pl, cl, n, vec![1], false), VerdictError::BufferTooLarge);
    ok(post(&mut f, n, pl, cl, n, vec![], true));
    assert_eq!(f.bet().perception_root, [7; 32]);
    // Finalized ⇒ no more writes.
    assert_err(post(&mut f, n, pl, cl, n, vec![], true), VerdictError::InvalidState);
    // A non-oracle cannot run the rules.
    let stranger = kp(99);
    let mut ixn = f.run_rules_ix();
    ixn.accounts[0].pubkey = stranger.pubkey();
    assert_err(f.env.send(&[ixn], &[&stranger]), VerdictError::Unauthorized);
    ok(f.try_run_rules());
    assert_err(f.try_run_rules(), VerdictError::InvalidState);
}

fn post_err(f: &mut Flow, p: &[u8], c: &[u8], t: &[u8], e: VerdictError) {
    let payload = [p, c, t].concat();
    assert_err(f.try_post_payload(&payload, p.len(), c.len()), e);
}

#[test]
fn post_tracks_content_checks() {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let spec = Flow::rules(2, true).spec;
    let (p, c, t) = (spec.program_bin.clone(), spec.calibration_bin.clone(), spec.tracks_bin.clone());

    // Program hash mismatch (a different program).
    let mut f = ended(true);
    let other = ball_program(&keys, &[STAKE, STAKE], 0b10, 61);
    post_err(&mut f, &other, &c, &t, VerdictError::ProgramHashMismatch);
    // Calibration hash mismatch.
    let mut f = ended(true);
    let mut c2 = c.clone();
    c2[10] ^= 1;
    post_err(&mut f, &p, &c2, &t, VerdictError::CalibrationHashMismatch);
    // Empty calibration while the bet has one.
    let mut f = ended(true);
    post_err(&mut f, &p, &[], &t, VerdictError::CalibrationHashMismatch);
    // Malformed tracks (bad magic).
    let mut f = ended(true);
    let mut t2 = t.clone();
    t2[0] = b'X';
    post_err(&mut f, &p, &c, &t2, VerdictError::MalformedTracks);
    // No tracks part without feature sp1.
    let mut f = ended(true);
    post_err(&mut f, &p, &c, &[], VerdictError::BufferLayout);
}

/// A program that decodes but whose header disagrees with the bet ⇒ ProgramBetMismatch;
/// a malformed program with a matching hash ⇒ MalformedProgram.
#[test]
fn post_tracks_program_must_match_bet() {
    let users = default_users(2);
    let keys: Vec<Pubkey> = users.iter().map(|u| u.pubkey()).collect();
    // Program says time limit 61, bet says 60.
    let program_bin = ball_program(&keys, &[STAKE, STAKE], 0b10, 61);
    let spec = Spec {
        nonce: 3,
        flags: 0,
        stakes: vec![STAKE; 2],
        stake_each: STAKE,
        side_b_mask: 0b10,
        time_limit_s: 60,
        acceptance: [0; 32],
        program_bin,
        calibration_bin: calibration(&[]),
        tracks_bin: ball_tracks(10, Some(1)),
    };
    let mut f = Flow::with(Env::new(), users, spec);
    f.create();
    f.fund_all();
    ok(f.try_start());
    f.end_by_oracle();
    let payload = f.spec.payload();
    assert_err(f.try_post_payload(&payload, f.spec.program_bin.len(), f.spec.calibration_bin.len()), VerdictError::ProgramBetMismatch);
    // Multi-fault: ProgramBetMismatch + malformed tracks ⇒ the program/bet check runs first.
    let mut bad_tracks = f.spec.tracks_bin.clone();
    bad_tracks[0] = b'X';
    let spec = Spec { nonce: 6, tracks_bin: bad_tracks, ..f.spec.clone() };
    let mut m = Flow::with(Env::new(), default_users(2), spec);
    m.create();
    m.fund_all();
    ok(m.try_start());
    m.end_by_oracle();
    let payload = m.spec.payload();
    assert_err(m.try_post_payload(&payload, m.spec.program_bin.len(), m.spec.calibration_bin.len()), VerdictError::ProgramBetMismatch);

    // Actor-bound flag mismatch: bet flags bit0 set, program has no actor-bound leg.
    let users = default_users(2);
    let program_bin = ball_program(&keys, &[STAKE, STAKE], 0b10, 60);
    let spec = Spec { nonce: 4, flags: FLAG_ACTOR_BOUND, program_bin, time_limit_s: 60, ..f.spec.clone() };
    let mut g = Flow::with(Env::new(), users, spec);
    g.create();
    g.fund_all();
    ok(g.try_start());
    g.end_by_oracle();
    let payload = g.spec.payload();
    assert_err(g.try_post_payload(&payload, g.spec.program_bin.len(), g.spec.calibration_bin.len()), VerdictError::ProgramBetMismatch);

    // Malformed program bytes committed by hash.
    let users = default_users(2);
    let mut bad = ball_program(&keys, &[STAKE, STAKE], 0b10, 60);
    bad.push(0); // trailing byte
    let spec = Spec { nonce: 5, flags: 0, program_bin: bad, ..f.spec.clone() };
    let mut h = Flow::with(Env::new(), users, spec);
    h.create();
    h.fund_all();
    ok(h.try_start());
    h.end_by_oracle();
    let payload = h.spec.payload();
    assert_err(h.try_post_payload(&payload, h.spec.program_bin.len(), h.spec.calibration_bin.len()), VerdictError::MalformedProgram);
}

#[test]
fn post_tracks_requires_perceiving_and_oracle() {
    let mut f = Flow::rules(2, true);
    f.create();
    f.fund_all();
    ok(f.try_start());
    let payload = f.spec.payload();
    assert_err(f.try_post_payload(&payload, f.spec.program_bin.len(), f.spec.calibration_bin.len()), VerdictError::InvalidState);
    f.end_by_oracle();
    let stranger = kp(99);
    let mut ixn = f.post_ix(payload.len() as u32, 10, 10, 0, vec![], false, [0; 32]);
    ixn.accounts[1].pubkey = stranger.pubkey();
    assert_err(f.env.send(&[ixn], &[&stranger]), VerdictError::Unauthorized);
}

#[test]
fn post_tracks_survives_prefunded_pda() {
    let mut f = ended(true);
    let pda = f.tracks();
    f.env.airdrop(&pda, 1_000); // griefing transfer to the PDA before creation
    f.post_tracks();
    ok(f.try_run_rules());
    assert_eq!(f.bet().state, STATE_PRERULED);
}

#[test]
fn consent_mismatch_and_non_participant() {
    let mut f = Flow::rules(2, true);
    f.to_preruled();
    let b = f.bet();
    let u = f.users[0].insecure_clone();
    let ixn = f.consent_ix(&u.pubkey(), 0b01, b.evidence_root);
    assert_err(f.env.send(&[ixn], &[&u]), VerdictError::ConsentMismatch);
    let ixn = f.consent_ix(&u.pubkey(), b.winner_mask, [0; 32]);
    assert_err(f.env.send(&[ixn], &[&u]), VerdictError::ConsentMismatch);
    let stranger = kp(99);
    assert_err(f.try_consent(&stranger), VerdictError::DeadlineNotReached);
}

#[test]
fn dispute_deadline_precedes_reason() {
    let mut f = Flow::rules(2, true);
    f.to_preruled();
    // Before the deadline a bad reason is BadReason …
    assert_err(f.try_dispute(1, 0), VerdictError::BadReason);
    // … after it, DeadlinePassed wins over BadReason.
    f.env.advance(CONSENT_WINDOW_S + 1);
    assert_err(f.try_dispute(1, 0), VerdictError::DeadlinePassed);
    assert_err(f.try_dispute(1, 1), VerdictError::DeadlinePassed);
}
