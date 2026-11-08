//! Shared reject cases (testvectors/chain/rejects.json): the program must return the same §9.6
//! error as the TS chain model (packages/engine/test/chain-model-conformance.test.ts drives the
//! same table). Errata chainmodel: unspecified §9.6 error choices + check order.
#![allow(clippy::result_large_err, clippy::too_many_arguments)]
mod common;

use std::collections::BTreeMap;

use common::actor::*;
use common::flow::*;
use common::*;
use solana_sdk::instruction::InstructionError;
use solana_sdk::transaction::TransactionError;

type Driver = fn() -> TxResult;

fn table() -> Vec<(String, String)> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testvectors/chain/rejects.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap().to_string(), c["error"].as_str().unwrap().to_string()))
        .collect()
}

fn create_with(f: &mut Flow, spec: &Spec, participants: Vec<Pubkey>) -> TxResult {
    let ixn = f.create_ix(spec, participants, f.env.judge_keys());
    let (c, o) = (f.users[0].insecure_clone(), f.env.oracle.insecure_clone());
    f.env.send(&[ixn], &[&c, &o])
}

fn send_fund(f: &mut Flow, cal: [u8; 32], ph: [u8; 32]) -> TxResult {
    let ixn = f.fund_ix(0, cal, ph, f.terms());
    let u = f.users[0].insecure_clone();
    f.env.send(&[ixn], &[&u])
}

fn funded() -> Flow {
    let mut f = Flow::rules(2, true);
    f.create();
    f.fund_all();
    f
}

fn start_with(f: &mut Flow, slot: u64, w: Vec<WitnessArg>) -> TxResult {
    let o = f.env.oracle.insecure_clone();
    let ixn = f.start_ix(&o.pubkey(), slot, w);
    f.env.send(&[ixn], &[&o])
}

fn ended() -> Flow {
    let mut f = funded();
    ok(f.try_start());
    f.env.advance(30);
    f.end_by_oracle();
    f
}

fn post(f: &mut Flow, len: u32, p: u16, c: u16, off: u32, data: Vec<u8>, fin: bool) -> TxResult {
    let o = f.env.oracle.insecure_clone();
    let ixn = f.post_ix(len, p, c, off, data, fin, [7; 32]);
    f.env.send(&[ixn], &[&o])
}

fn lens(f: &Flow) -> (Vec<u8>, u16, u16) {
    (f.spec.payload(), f.spec.program_bin.len() as u16, f.spec.calibration_bin.len() as u16)
}

fn dispute_with(f: &mut Flow, reason: u8, root: [u8; 32]) -> TxResult {
    let ixn = f.dispute_ix(1, reason, root);
    let u = f.users[1].insecure_clone();
    f.env.send(&[ixn], &[&u])
}

/// Actor-bound bet in Perceiving with face profiles (created before the bet) for both users.
fn bio_flow() -> Flow {
    let mut f = actor_flow(Env::new());
    let mut face = [0u8; 32];
    face[31] = 7;
    for i in 0..2 {
        let w = f.users[i].insecure_clone();
        ok(f.env.send(&[init_profile_ix(&f.env.payer.pubkey(), &w.pubkey(), face, [0; 32], "x")], &[&w]));
    }
    f.env.advance(1);
    f.create();
    f.fund_all();
    ok(f.try_start());
    f.env.advance(30);
    f.end_by_oracle();
    f
}

fn drivers() -> BTreeMap<&'static str, Driver> {
    let mut m: BTreeMap<&'static str, Driver> = BTreeMap::new();
    m.insert("init_profile_name_33_bytes", || {
        let mut f = Flow::rules(2, true);
        let w = f.users[0].insecure_clone();
        let mut face = [0u8; 32];
        face[31] = 5;
        let ixn = init_profile_ix(&f.env.payer.pubkey(), &w.pubkey(), face, [0; 32], &"x".repeat(33));
        f.env.send(&[ixn], &[&w])
    });
    m.insert("create_bet_zero_program_hash", || {
        let mut f = Flow::rules(2, true);
        let mut ixn = f.create_ix(&f.spec.clone(), f.keys(), f.env.judge_keys());
        let off = ixn.data.len() - 96 - 32 - 32;
        ixn.data[off..off + 32].fill(0);
        let (c, o) = (f.users[0].insecure_clone(), f.env.oracle.insecure_clone());
        f.env.send(&[ixn], &[&c, &o])
    });
    m.insert("create_bet_oracle_is_participant", || {
        let mut f = Flow::rules(2, true);
        let ps = vec![f.users[0].pubkey(), f.env.oracle.pubkey()];
        let spec = f.spec.clone();
        create_with(&mut f, &spec, ps)
    });
    m.insert("create_bet_stakes_len_mismatch", || {
        let mut f = Flow::rules(2, true);
        let spec = Spec { stakes: vec![STAKE], ..f.spec.clone() };
        let keys = f.keys();
        create_with(&mut f, &spec, keys)
    });
    m.insert("create_bet_bad_flags_and_sides", || {
        let mut f = Flow::rules(2, true);
        let spec = Spec { flags: 0b1000, side_b_mask: 0b001, ..f.spec.clone() };
        let keys = f.keys();
        create_with(&mut f, &spec, keys)
    });
    m.insert("fund_wrong_program_hash", || {
        let mut f = Flow::rules(2, true);
        f.create();
        let cal = f.spec.calibration_hash();
        send_fund(&mut f, cal, [0xff; 32])
    });
    m.insert("fund_zero_calibration_rules", || {
        let mut f = Flow::rules(2, true);
        f.create();
        let ph = f.spec.program_hash();
        send_fund(&mut f, [0; 32], ph)
    });
    m.insert("start_duplicate_witness", || {
        let mut f = funded();
        let (slot, _) = f.beacon();
        let w = f.witness_args();
        start_with(&mut f, slot, vec![w[0], WitnessArg { key: w[0].key, kind: 1 }])
    });
    m.insert("start_witness_kind_3", || {
        let mut f = funded();
        let (slot, _) = f.beacon();
        let w = f.witness_args();
        start_with(&mut f, slot, vec![WitnessArg { key: w[0].key, kind: 3 }])
    });
    m.insert("start_future_beacon_slot", || {
        let mut f = funded();
        f.beacon();
        let slot = f.env.slot() + 1;
        start_with(&mut f, slot, vec![])
    });
    m.insert("post_tracks_offset_not_written", || {
        let mut f = ended();
        let (p, pl, cl) = lens(&f);
        let n = p.len() as u32;
        ok(post(&mut f, n, pl, cl, 0, p[..10].to_vec(), false));
        post(&mut f, n, pl, cl, 5, p[5..10].to_vec(), false)
    });
    m.insert("post_tracks_lengths_exceed_payload", || {
        let mut f = ended();
        post(&mut f, 10, 8, 8, 0, vec![], false)
    });
    m.insert("post_tracks_write_past_payload", || {
        let mut f = ended();
        let (p, pl, cl) = lens(&f);
        let n = p.len() as u32;
        for (i, c) in p.chunks(POST_TRACKS_CHUNK).enumerate() {
            ok(post(&mut f, n, pl, cl, (i * POST_TRACKS_CHUNK) as u32, c.to_vec(), false));
        }
        post(&mut f, n, pl, cl, n, vec![1], false)
    });
    m.insert("post_tracks_after_finalize", || {
        let mut f = ended();
        f.post_tracks();
        let (p, pl, cl) = lens(&f);
        let n = p.len() as u32;
        post(&mut f, n, pl, cl, n, vec![], true)
    });
    m.insert("run_rules_after_perception_timeout", || {
        let mut f = ended();
        f.post_tracks();
        let target = f.bet().ended_at + PERCEPTION_TIMEOUT_S + 1;
        let now = f.env.now();
        f.env.advance(target - now);
        f.try_run_rules()
    });
    m.insert("consent_non_participant_before_deadline", || {
        let mut f = Flow::rules(2, true);
        f.to_preruled();
        let stranger = kp(99);
        f.env.airdrop(&stranger.pubkey(), 1_000_000_000);
        f.try_consent(&stranger)
    });
    m.insert("dispute_bad_reason", || {
        let mut f = Flow::rules(2, true);
        f.to_preruled();
        let root = f.bet().evidence_root;
        dispute_with(&mut f, 0, root)
    });
    m.insert("dispute_bad_reason_after_deadline", || {
        let mut f = Flow::rules(2, true);
        f.to_preruled();
        f.env.advance(CONSENT_WINDOW_S + 1);
        let root = f.bet().evidence_root;
        dispute_with(&mut f, 0, root)
    });
    m.insert("dispute_evidence_root_mismatch", || {
        let mut f = Flow::rules(2, true);
        f.to_preruled();
        dispute_with(&mut f, 1, [0; 32])
    });
    m.insert("verify_biometric_modality_2", || {
        let mut f = bio_flow();
        let w = f.users[1].pubkey();
        try_verify(&mut f, &w, &Proof { modality: 2, ..Proof::mock(1, 41) })
    });
    m.insert("verify_biometric_other_profile", || {
        let mut f = bio_flow();
        let w = f.users[0].pubkey();
        try_verify(&mut f, &w, &Proof::mock(1, 41))
    });
    m.insert("settle_panel_after_panel_timeout", || {
        let mut f = Flow::rules(2, true);
        f.to_preruled();
        ok(f.try_dispute(1, 2));
        let target = f.bet().disputed_at + PANEL_TIMEOUT_S + 1;
        let now = f.env.now();
        f.env.advance(target - now);
        f.try_settle_panel(2, 0, 1)
    });
    m.insert("refund_wrong_oracle_account", || {
        let mut f = Flow::rules(2, true);
        f.create();
        ok(f.try_fund(0));
        f.env.advance(FUND_WINDOW_S + 1);
        let mut ixn = f.refund_ix();
        let stranger = kp(99).pubkey();
        for a in ixn.accounts.iter_mut().filter(|a| a.pubkey == f.env.oracle.pubkey()) {
            a.pubkey = stranger;
        }
        f.env.send(&[ixn], &[])
    });
    m
}

/// The transaction failed with the program error named `name` (Anchor logs
/// `Error Code: <name>. Error Number: <n>.`).
fn failed_with(res: &TxResult, name: &str) -> Result<(), String> {
    match res {
        Ok(_) => Err("succeeded".into()),
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => {
                let needle = format!("Error Code: {name}. Error Number: {c}.");
                if f.meta.logs.iter().any(|l| l.contains(&needle)) {
                    Ok(())
                } else {
                    Err(format!("custom {c}; logs:\n{}", f.meta.pretty_logs()))
                }
            }
            other => Err(format!("{other:?}")),
        },
    }
}

#[test]
fn shared_reject_cases_match_the_chain_model() {
    let cases = table();
    let drivers = drivers();
    let ids: Vec<&str> = cases.iter().map(|(id, _)| id.as_str()).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(drivers.keys().copied().collect::<Vec<_>>(), sorted, "every table case needs a driver and vice versa");
    let mut failures = vec![];
    for (id, err) in &cases {
        let res = drivers[id.as_str()]();
        if let Err(why) = failed_with(&res, err) {
            failures.push(format!("{id}: expected {err}, got {why}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
