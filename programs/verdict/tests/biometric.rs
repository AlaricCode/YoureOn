//! Profiles and `verify_biometric_proof` (real Groth16 proofs via groth16-solana).
mod common;

use common::actor::*;
use common::flow::*;
use common::*;

/// Prints the inputs needed to regenerate tests/fixtures/biometric_proof.json.
#[test]
#[ignore]
fn print_fixture_inputs() {
    let mut f = actor_flow(Env::new());
    f.create();
    f.fund_all();
    ok(f.try_start());
    f.env.advance(30);
    f.end_by_oracle();
    let b = f.bet();
    println!("BET={}", payload::to_hex(&f.bet.to_bytes()));
    println!("ROOT={}", payload::to_hex(&b.evidence_root));
}

fn setup_profile(f: &mut Flow, user: usize, face: [u8; 32], voice: [u8; 32]) {
    let w = f.users[user].insecure_clone();
    let ixn = init_profile_ix(&f.env.payer.pubkey(), &w.pubkey(), face, voice, "Alice");
    ok(f.env.send(&[ixn], &[&w]));
}

/// Profile with the fixture commitment, then the bet up to `end` (evidence root final).
fn ended_actor_flow() -> (Flow, Fixture) {
    let fx = load_fixture().expect("tests/fixtures/biometric_proof.json missing");
    let mut f = actor_flow(Env::new());
    setup_profile(&mut f, 0, fx.commitment, [0; 32]);
    f.create();
    f.fund_all();
    ok(f.try_start());
    f.env.advance(30);
    f.end_by_oracle();
    assert_eq!(f.bet, fx.bet, "scenario drifted: regenerate the fixture");
    assert_eq!(f.bet().evidence_root, fx.evidence_root, "scenario drifted: regenerate the fixture");
    (f, fx)
}

#[test]
fn real_groth16_proof_verifies_and_unlocks_actor_bound_win() {
    let (mut f, fx) = ended_actor_flow();
    f.post_tracks();
    let w = f.users[0].pubkey();
    let meta = ok(try_verify(&mut f, &w, &fx.proof));
    println!("verify_biometric_proof CU = {}", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 300_000);
    let b = f.bet();
    assert_eq!(b.n_bio, 1);
    assert_eq!((b.bio[0].participant, b.bio[0].modality, b.bio[0].frame), (0, 0, CHECKPOINT_FRAME));

    // Duplicate (participant, frame) is deduplicated.
    ok(try_verify(&mut f, &w, &fx.proof));
    assert_eq!(f.bet().n_bio, 1);

    ok(f.try_run_rules());
    let b = f.bet();
    assert_eq!(b.state, STATE_PRERULED);
    assert_eq!(b.preruling, PRERULING_WINNER);
    assert_eq!(b.winner_mask, 0b01);
    assert_eq!(b.leg_results[0], 1);

    for i in 0..2 {
        let u = f.users[i].insecure_clone();
        ok(f.try_consent(&u));
    }
    assert_eq!(f.bet().state, STATE_SETTLED);
    assert_eq!(f.balance(0), INITIAL_BALANCE + STAKE);
    assert_eq!(f.balance(1), INITIAL_BALANCE - STAKE);
}

#[test]
fn proof_also_valid_before_tracks_are_posted() {
    let (mut f, fx) = ended_actor_flow();
    let w = f.users[0].pubkey();
    ok(try_verify(&mut f, &w, &fx.proof));
    assert_eq!(f.bet().n_bio, 1);
}

#[test]
fn missing_identity_proof_goes_to_panel() {
    let (mut f, _) = ended_actor_flow();
    f.post_tracks();
    ok(f.try_run_rules());
    let b = f.bet();
    assert_eq!(b.state, STATE_DISPUTED);
    assert_eq!(b.preruling, PRERULING_NEEDS_PANEL);
    assert_eq!(b.dispute_reason, 10);
    assert_eq!(b.leg_results[0], 2);
}

#[test]
fn tampered_proofs_are_rejected() {
    let (mut f, fx) = ended_actor_flow();
    let w = f.users[0].pubkey();
    // Different frame ⇒ different public input.
    let mut p = Proof { frame: fx.proof.frame + 1, ..fx.proof };
    assert_err(try_verify(&mut f, &w, &p), VerdictError::BadProof);
    // Corrupted proof point.
    p.frame = fx.proof.frame;
    p.c[63] ^= 1;
    assert_err(try_verify(&mut f, &w, &p), VerdictError::BadProof);
    // Higher tau than proven.
    let p = Proof { tau_bps: 6000, ..load_fixture().unwrap().proof };
    assert_err(try_verify(&mut f, &w, &p), VerdictError::BadProof);
    assert_eq!(f.bet().n_bio, 0);
}

#[cfg(not(feature = "mock-zk"))]
#[test]
fn production_build_rejects_mock_proofs() {
    let (mut f, _) = ended_actor_flow();
    let w = f.users[0].pubkey();
    assert_err(try_verify(&mut f, &w, &Proof::mock(0, 12)), VerdictError::BadProof);
}

#[test]
fn proof_precondition_failures() {
    let (mut f, fx) = ended_actor_flow();
    let w0 = f.users[0].pubkey();
    let w1 = f.users[1].pubkey();
    // Profile of another participant.
    setup_profile_at(&mut f, 1, fx.commitment);
    assert_err(try_verify(&mut f, &w1, &fx.proof), VerdictError::NotParticipant);
    let p = Proof { participant: 1, ..load_fixture().unwrap().proof };
    assert_err(try_verify(&mut f, &w1, &p), VerdictError::ProfileTooNew);
    // Voice commitment missing.
    let p = Proof { modality: 1, tau_bps: 5000, ..load_fixture().unwrap().proof };
    assert_err(try_verify(&mut f, &w0, &p), VerdictError::MissingCommitment);
    // Threshold below the contract's.
    let p = Proof { tau_bps: TAU_FACE_BPS - 1, ..load_fixture().unwrap().proof };
    assert_err(try_verify(&mut f, &w0, &p), VerdictError::TauTooLow);
    // Participant index out of range.
    let p = Proof { participant: 2, ..load_fixture().unwrap().proof };
    assert_err(try_verify(&mut f, &w0, &p), VerdictError::NotParticipant);
    // Bad modality.
    let p = Proof { modality: 2, ..load_fixture().unwrap().proof };
    assert_err(try_verify(&mut f, &w0, &p), VerdictError::BadReason);
    // Non-oracle signer.
    let mut ixn = verify_ix(&f, &w0, &fx.proof);
    let stranger = kp(99);
    ixn.accounts[0].pubkey = stranger.pubkey();
    assert_err(f.env.send(&[ixn], &[&stranger]), VerdictError::Unauthorized);
}

fn setup_profile_at(f: &mut Flow, user: usize, face: [u8; 32]) {
    f.env.advance(1);
    setup_profile(f, user, face, [0; 32]);
}

#[test]
fn profile_updated_after_bet_creation_is_too_new() {
    let (mut f, fx) = ended_actor_flow();
    setup_profile_at(&mut f, 0, fx.commitment);
    let w = f.users[0].pubkey();
    assert_err(try_verify(&mut f, &w, &fx.proof), VerdictError::ProfileTooNew);
}

#[test]
fn proof_requires_perceiving() {
    let fx = load_fixture().unwrap();
    let mut f = actor_flow(Env::new());
    setup_profile(&mut f, 0, fx.commitment, [0; 32]);
    f.create();
    f.fund_all();
    ok(f.try_start());
    let w = f.users[0].pubkey();
    assert_err(try_verify(&mut f, &w, &fx.proof), VerdictError::InvalidState);
}

#[cfg(feature = "mock-zk")]
#[test]
fn mock_zk_accepts_mock_proofs_and_caps_checkpoints() {
    let (mut f, _) = ended_actor_flow();
    let w = f.users[0].pubkey();
    for frame in 0..MAX_CHECKPOINTS as u32 {
        ok(try_verify(&mut f, &w, &Proof::mock(0, frame)));
    }
    assert_eq!(f.bet().n_bio as usize, MAX_CHECKPOINTS);
    assert_err(try_verify(&mut f, &w, &Proof::mock(0, 99)), VerdictError::TooManyCheckpoints);
}

// ---------- profiles ----------

#[test]
fn init_profile_creates_overwrites_and_deletes() {
    let mut env = Env::new();
    let w = kp(5);
    env.airdrop(&w.pubkey(), 1_000_000_000);
    let payer = env.payer.pubkey();
    let pda = profile_pda(&w.pubkey());
    let mut face = [0u8; 32];
    face[31] = 7;
    ok(env.send(&[init_profile_ix(&payer, &w.pubkey(), face, [0; 32], "Ana")], &[&w]));
    let p = env.profile(&pda);
    assert_eq!(p.wallet, w.pubkey());
    assert_eq!(p.flags, PROFILE_FLAG_FACE);
    assert_eq!(&p.display_name[..3], b"Ana");
    assert_eq!(p.name_len, 3);
    assert_eq!(p.created_at, T0);
    assert_eq!(env.svm.get_account(&pda).unwrap().data.len(), 8 + 179);

    env.advance(10);
    let mut voice = [0u8; 32];
    voice[0] = 0x30; // still < r
    ok(env.send(&[init_profile_ix(&payer, &w.pubkey(), face, voice, "Ana Maria")], &[&w]));
    let p = env.profile(&pda);
    assert_eq!(p.flags, PROFILE_FLAG_FACE | PROFILE_FLAG_VOICE);
    assert_eq!(p.created_at, T0);
    assert_eq!(p.updated_at, T0 + 10);
    assert_eq!(p.name_len, 9);

    // Delete biometrics.
    ok(env.send(&[init_profile_ix(&payer, &w.pubkey(), [0; 32], [0; 32], "Ana")], &[&w]));
    let p = env.profile(&pda);
    assert_eq!(p.flags, 0);
    assert_eq!(p.face_commit, [0; 32]);
    assert_eq!(&p.display_name[3..], &[0u8; 29]);
}

#[test]
fn init_profile_rejects_bad_commitments_and_names() {
    let mut env = Env::new();
    let w = kp(5);
    let payer = env.payer.pubkey();
    let r = BN254_R_BE;
    assert_err(env.send(&[init_profile_ix(&payer, &w.pubkey(), r, [0; 32], "x")], &[&w]), VerdictError::BadCommitment);
    assert_err(env.send(&[init_profile_ix(&payer, &w.pubkey(), [0; 32], [0xFF; 32], "x")], &[&w]), VerdictError::BadCommitment);
    let long = "x".repeat(33);
    assert_err(env.send(&[init_profile_ix(&payer, &w.pubkey(), [0; 32], [0; 32], &long)], &[&w]), VerdictError::BadCommitment);
    let mut r_minus_1 = r;
    r_minus_1[31] -= 1;
    ok(env.send(&[init_profile_ix(&payer, &w.pubkey(), r_minus_1, [0; 32], &"y".repeat(32))], &[&w]));
}
