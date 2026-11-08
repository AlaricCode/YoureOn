//! Full lifecycle: create, fund, start, evidence, end, post_tracks (chunks), run_rules, consent.
mod common;

use common::flow::*;
use common::payload::*;
use common::*;

fn g_w(bet: &Pubkey, w: &Pubkey, kind: u8, slot: u64, hash: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"VERDICT/CHAIN/v1", bet.as_ref(), w.as_ref(), &[kind], &slot.to_le_bytes(), hash])
}
fn leaf(w: &Pubkey, index: u32, hash: &[u8; 32]) -> [u8; 32] {
    sha256(&[&[0u8], w.as_ref(), &index.to_le_bytes(), hash])
}
fn node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    sha256(&[&[1u8], l, r])
}

#[test]
fn create_and_fund_set_state() {
    let mut f = Flow::rules(2, true);
    f.create();
    let b = f.bet();
    assert_eq!(b.version, 1);
    assert_eq!(b.state, STATE_PROPOSED);
    assert_eq!(b.creator, f.users[0].pubkey());
    assert_eq!(b.oracle, f.env.oracle.pubkey());
    assert_eq!(b.judges, f.env.judge_keys());
    assert_eq!(b.n_participants, 2);
    assert_eq!(&b.stakes[..2], &[STAKE, STAKE]);
    assert_eq!(b.participants[2], Pubkey::default());
    assert_eq!(b.fund_deadline, T0 + FUND_WINDOW_S);
    assert_eq!(b.created_at, T0);
    assert_eq!(b.witness_kinds, [0xFF; 8]);
    assert_eq!(b.witness_heads, [0xFFFF_FFFF; 8]);
    assert_eq!(b.leg_results, [0xFF; 8]);
    assert_eq!(b.mint, f.env.mint);
    assert_eq!(f.env.svm.get_account(&f.bet).unwrap().data.len(), 8 + 1580);

    ok(f.try_fund(1));
    let b = f.bet();
    assert_eq!(b.funded_mask, 0b10);
    assert_eq!(b.state, STATE_PROPOSED);
    assert_eq!(b.calibration_hash, f.spec.calibration_hash());
    ok(f.try_fund(0));
    let b = f.bet();
    assert_eq!(b.state, STATE_FUNDED);
    assert_eq!(b.funded_at, T0);
    assert_eq!(f.env.token_balance(&f.vault()), 2 * STAKE);
    assert_eq!(f.balance(0), INITIAL_BALANCE - STAKE);
}

#[test]
fn start_registers_witnesses_and_initial_root() {
    let mut f = Flow::rules(2, true);
    f.create();
    f.fund_all();
    ok(f.try_start());
    let b = f.bet();
    assert_eq!(b.state, STATE_LIVE);
    assert_eq!(b.started_at, T0);
    assert_eq!(b.beacon_slot, SLOT0 - 5);
    assert_eq!(b.beacon_hash, [0x77; 32]);
    assert_eq!(b.n_witnesses, 2);
    assert_eq!(&b.witness_kinds[..3], &[0, 1, 0xFF]);
    let w0 = f.witnesses[0].pubkey();
    let w1 = f.witnesses[1].pubkey();
    let g0 = g_w(&f.bet, &w0, 0, SLOT0 - 5, &[0x77; 32]);
    let g1 = g_w(&f.bet, &w1, 1, SLOT0 - 5, &[0x77; 32]);
    assert_eq!(b.witness_head_hashes[0], g0);
    assert_eq!(b.witness_head_hashes[1], g1);
    assert_eq!(b.witness_head_hashes[2], [0; 32]);
    assert_eq!(b.evidence_root, node(&leaf(&w0, u32::MAX, &g0), &leaf(&w1, u32::MAX, &g1)));
}

#[test]
fn evidence_commits_gap_bits_and_final_heads() {
    let mut f = Flow::rules(2, true);
    f.create();
    f.fund_all();
    ok(f.try_start());
    let w0 = f.witnesses[0].pubkey();
    let w1 = f.witnesses[1].pubkey();
    let g1 = f.bet().witness_head_hashes[1];

    f.env.advance(30);
    ok(f.try_commit(1, vec![HeadArg { index: 5, hash: [5; 32] }, HeadArg { index: u32::MAX, hash: g1 }]));
    let b = f.bet();
    assert_eq!(b.evidence_seq, 1);
    assert_eq!(b.gap_mask, 0);
    assert_eq!(b.witness_heads[0], 5);
    assert_eq!(b.evidence_root, node(&leaf(&w0, 5, &[5; 32]), &leaf(&w1, u32::MAX, &g1)));

    // Equal index ⇒ equal hash; regressions rejected; wrong seq; wrong head count.
    assert_err(f.try_commit(2, vec![HeadArg { index: 5, hash: [6; 32] }, HeadArg { index: 0, hash: [1; 32] }]), VerdictError::EvidenceRegress);
    assert_err(f.try_commit(2, vec![HeadArg { index: 4, hash: [4; 32] }, HeadArg { index: 0, hash: [1; 32] }]), VerdictError::EvidenceRegress);
    assert_err(f.try_commit(3, vec![HeadArg { index: 6, hash: [6; 32] }, HeadArg { index: 0, hash: [1; 32] }]), VerdictError::EvidenceSeq);
    assert_err(f.try_commit(2, vec![HeadArg { index: 6, hash: [6; 32] }]), VerdictError::EvidenceHeads);
    assert_err(f.try_commit(2, vec![HeadArg { index: u32::MAX, hash: [6; 32] }, HeadArg { index: 0, hash: [1; 32] }]), VerdictError::EvidenceRegress);

    // A jump > MAX_CHUNKS_PER_COMMIT sets that witness's gap bit.
    f.env.advance(30);
    ok(f.try_commit(2, vec![HeadArg { index: 5 + 25, hash: [30; 32] }, HeadArg { index: 24 - 1, hash: [23; 32] }]));
    assert_eq!(f.bet().gap_mask, 0b01);

    // A commit more than EVIDENCE_MAX_GAP_S after the previous sets all bits.
    f.env.advance(EVIDENCE_MAX_GAP_S + 1);
    ok(f.try_commit(3, vec![HeadArg { index: 31, hash: [31; 32] }, HeadArg { index: 24, hash: [24; 32] }]));
    assert_eq!(f.bet().gap_mask, 0b11);

    // A non-oracle cannot commit.
    let stranger = kp(99);
    let mut ixn = f.commit_ix(4, vec![]);
    ixn.accounts[0].pubkey = stranger.pubkey();
    assert_err(f.env.send(&[ixn], &[&stranger]), VerdictError::Unauthorized);

    // The oracle ends with final heads.
    let o = f.env.oracle.insecure_clone();
    ok(f.try_end(&o, 4, vec![HeadArg { index: 40, hash: [40; 32] }, HeadArg { index: 30, hash: [33; 32] }]));
    let b = f.bet();
    assert_eq!(b.state, STATE_PERCEIVING);
    assert_eq!(b.evidence_seq, 4);
    assert_eq!(b.evidence_root, node(&leaf(&w0, 40, &[40; 32]), &leaf(&w1, 30, &[33; 32])));
    assert_eq!(b.ended_at, f.env.now());
    // Commits are rejected once ended.
    assert_err(f.try_commit(5, vec![HeadArg { index: 41, hash: [41; 32] }, HeadArg { index: 30, hash: [33; 32] }]), VerdictError::InvalidState);
}

#[test]
fn end_permissions() {
    let mut f = Flow::rules(2, true);
    f.create();
    f.fund_all();
    ok(f.try_start());
    let stranger = kp(99);
    f.env.airdrop(&stranger.pubkey(), 1_000_000_000);
    // A stranger before the time limit.
    assert_err(f.try_end(&stranger, 0, vec![]), VerdictError::DeadlineNotReached);
    // A participant can end any time, but without heads.
    let u = f.users[1].insecure_clone();
    assert_err(f.try_end(&u, 1, vec![HeadArg { index: 0, hash: [0; 32] }, HeadArg { index: 0, hash: [0; 32] }]), VerdictError::EvidenceHeads);
    // A stranger after the time limit, heads empty.
    f.env.advance(60);
    let root = f.bet().evidence_root;
    ok(f.try_end(&stranger, 0, vec![]));
    let b = f.bet();
    assert_eq!(b.state, STATE_PERCEIVING);
    assert_eq!(b.evidence_root, root);
}

#[test]
fn full_rules_flow_consent_settles() {
    let mut f = Flow::rules(2, true);
    f.to_tracks_posted();
    let b = f.bet();
    assert_eq!(b.tracks_finalized, 1);
    assert_eq!(b.tracks_hash, sha256(&[&f.spec.tracks_bin]));
    assert_eq!(b.perception_root, [0x99; 32]);
    let payload = f.spec.payload();
    let tb = f.env.svm.get_account(&f.tracks()).unwrap();
    assert_eq!(tb.data.len(), 56 + payload.len());
    assert_eq!(&tb.data[56..], &payload[..]);
    assert_eq!(tb.owner, verdict::ID);

    let meta = ok(f.try_run_rules());
    println!("run_rules CU = {}", meta.compute_units_consumed);
    let b = f.bet();
    assert_eq!(b.state, STATE_PRERULED);
    assert_eq!(b.preruling, PRERULING_WINNER);
    assert_eq!(b.prerule_reason, 0);
    assert_eq!(b.winner_mask, 0b10);
    assert_eq!(b.leg_results, [1, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    assert_eq!(b.consent_deadline, f.env.now() + CONSENT_WINDOW_S);

    let oracle_before = f.env.lamports(&f.env.oracle.pubkey());
    let tb_rent = f.env.lamports(&f.tracks());
    let vault_rent = f.env.lamports(&f.vault());
    let u0 = f.users[0].insecure_clone();
    ok(f.try_consent(&u0));
    assert_eq!(f.bet().consent_mask, 0b01);
    assert_err(f.try_consent(&u0), VerdictError::AlreadyConsented);
    let u1 = f.users[1].insecure_clone();
    ok(f.try_consent(&u1));

    let b = f.bet();
    assert_eq!(b.state, STATE_SETTLED);
    assert_eq!(b.settle_path, PATH_CONSENT);
    assert_eq!(b.final_winner_mask, 0b10);
    assert_eq!(f.balance(0), INITIAL_BALANCE - STAKE);
    assert_eq!(f.balance(1), INITIAL_BALANCE + STAKE);
    assert!(!f.env.exists(&f.vault()));
    assert!(!f.env.exists(&f.tracks()));
    assert_eq!(f.env.lamports(&f.env.oracle.pubkey()), oracle_before + tb_rent + vault_rent);
}

#[test]
fn creator_wins_when_ball_never_appears() {
    let mut f = Flow::rules(2, false);
    f.to_preruled();
    let b = f.bet();
    assert_eq!(b.winner_mask, 0b01);
    assert_eq!(b.leg_results[0], 0);
    // Silence = consent: anyone (the oracle) settles after the deadline.
    let o = f.env.oracle.insecure_clone();
    assert_err(f.try_consent(&o), VerdictError::DeadlineNotReached);
    f.env.advance(CONSENT_WINDOW_S + 1);
    ok(f.try_consent(&o));
    let b = f.bet();
    assert_eq!(b.state, STATE_SETTLED);
    assert_eq!(b.consent_mask, 0);
    assert_eq!(f.balance(0), INITIAL_BALANCE + STAKE);
}

#[test]
fn three_players_split_and_dust_goes_to_lowest_winner() {
    // Sides: P0 alone on side 0, P1+P2 on side 1; ball appears ⇒ side 1 wins.
    let users = default_users(3);
    let keys: Vec<Pubkey> = users.iter().map(|u| u.pubkey()).collect();
    let stakes = vec![STAKE; 3];
    let spec = Spec {
        nonce: 9,
        flags: 0,
        stakes: stakes.clone(),
        stake_each: STAKE,
        side_b_mask: 0b110,
        time_limit_s: 60,
        acceptance: [1; 32],
        program_bin: ball_program(&keys, &stakes, 0b110, 60),
        calibration_bin: calibration(&[]),
        tracks_bin: ball_tracks(30, Some(3)),
    };
    let mut f = Flow::with(Env::new(), users, spec);
    f.to_preruled();
    assert_eq!(f.bet().winner_mask, 0b110);
    // Stray deposit into the vault (7 units) is paid to the lowest-index winner (P1).
    let vault = f.vault();
    f.env.mint_to(&vault, 7);
    f.env.advance(CONSENT_WINDOW_S + 1);
    let o = f.env.oracle.insecure_clone();
    let meta = ok(f.try_consent(&o));
    assert_eq!(f.balance(0), INITIAL_BALANCE - STAKE);
    assert_eq!(f.balance(1), INITIAL_BALANCE - STAKE + 7_500_000 + 7);
    assert_eq!(f.balance(2), INITIAL_BALANCE - STAKE + 7_500_000);
    assert!(meta.logs.iter().any(|l| l.starts_with("Program data: ")));
}

#[test]
fn post_tracks_in_many_chunks() {
    // A larger buffer: 2 segments, ~2.5 KB ⇒ 4 chunks.
    let mut f = Flow::rules(2, true);
    f.spec.tracks_bin = tracks_bin(FLAGS_OK, &[(0, 0xFF, 0)], &[(0, 100), (150, 100)], |_, fr| if fr >= 160 { at(4000, 4000, 100) } else { ABSENT });
    f.to_tracks_posted();
    assert!(f.spec.payload().len() > 3 * POST_TRACKS_CHUNK);
    ok(f.try_run_rules());
    assert_eq!(f.bet().winner_mask, 0b10);
}
