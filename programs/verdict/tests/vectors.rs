//! Golden vectors (§0.6) through the onchain path: post_tracks (decode-validation) + run_rules.
//!
//! For each `testvectors/*.json` (and `testvectors/fuzz.jsonl`), a Bet in Perceiving is written
//! directly into the SVM with participants/stakes/sides/time limit/kind/flags taken from the
//! program header and `bio` = the verified checkpoints. The payload is then posted for real and
//! `run_rules` executed. Asserted: `status`, `reason`, `preruling`, `winner_mask`, `leg_results`,
//! or the identical decode error. (`n_checkpoints`/`checkpoints` are not stored onchain; they are
//! covered by `cargo test -p verdict-rules`.) Skips when `testvectors/` is absent.
mod common;

use anchor_lang::AccountSerialize;
use common::flow::*;
use common::payload::*;
use common::*;
use serde_json::Value;
use solana_sdk::account::Account;
use std::path::{Path, PathBuf};
use verdict::state::BioCheck;

fn vectors_dir() -> PathBuf {
    std::env::var("VERDICT_TESTVECTORS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testvectors"))
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Ruled { preruling: u8, reason: u8, winner_mask: u8, leg_results: [u8; 8] },
    Error(String),
    /// Could not be run onchain (payload > MAX_BUFFER_PAYLOAD).
    Skipped(String),
    /// `run_rules` ran out of compute (> 1.4M CU): a failure, never a skip (§3.13).
    OutOfCompute,
}

struct Case {
    program_bin: Vec<u8>,
    calibration_bin: Vec<u8>,
    tracks_bin: Vec<u8>,
    verified: Vec<(u8, u32)>,
}

const NAMES: [&str; 45] = [
    "InvalidState", "NotParticipant", "AlreadyFunded", "BadParticipants", "BadStake", "BadSides", "BadTimeLimit", "BadJudges",
    "CalibrationMismatch", "DeadlinePassed", "DeadlineNotReached", "Unauthorized", "BeaconSlotNotFound", "BeaconTooOld",
    "TooManyWitnesses", "EvidenceSeq", "EvidenceHeads", "EvidenceRegress", "BufferTooLarge", "BufferLayout", "BufferIncomplete",
    "ProgramHashMismatch", "CalibrationHashMismatch", "MalformedProgram", "MalformedCalibration", "MalformedTracks",
    "ProgramBetMismatch", "TracksNotFinalized", "AlreadyConsented", "ConsentMismatch", "InsufficientQuorum", "BadOutcome",
    "BadProof", "TauTooLow", "MissingCommitment", "TooManyCheckpoints", "Sp1Disabled", "BadTokenAccount", "MathOverflow",
    "NotRefundable", "BadReason", "BadCommitment", "ProfileTooNew", "BadEd25519Instruction", "BadFlags",
];

fn err_name(e: &solana_sdk::transaction::TransactionError) -> String {
    use solana_sdk::instruction::InstructionError;
    match e {
        solana_sdk::transaction::TransactionError::InstructionError(_, InstructionError::Custom(c)) if (6000..6045).contains(c) => {
            NAMES[(*c - 6000) as usize].to_string()
        }
        other => format!("{other:?}"),
    }
}

/// Writes a Perceiving Bet matching the program header (or a minimal one if undecodable).
fn install_bet(env: &mut Env, bet_key: &Pubkey, case: &Case) {
    let zeros = vec![0u8; BET_SIZE];
    let mut b: Bet = anchor_lang::AnchorDeserialize::deserialize(&mut &zeros[..]).unwrap();
    b.version = 1;
    b.state = STATE_PERCEIVING;
    b.oracle = env.oracle.pubkey();
    b.program_hash = sha256(&[&case.program_bin]);
    b.calibration_hash = if case.calibration_bin.is_empty() { [0; 32] } else { sha256(&[&case.calibration_bin]) };
    b.witness_kinds = [0xFF; 8];
    b.witness_heads = [u32::MAX; 8];
    b.leg_results = [0xFF; 8];
    b.n_participants = 2;
    b.created_at = env.now() - 100;
    b.ended_at = env.now();
    if let Ok(p) = verdict_rules::decode_program(&case.program_bin) {
        let n = p.n_participants as usize;
        b.n_participants = n as u8;
        for i in 0..n {
            b.participants[i] = Pubkey::try_from(p.participant(i)).unwrap();
            b.stakes[i] = p.stakes[i];
        }
        b.side_b_mask = p.side_b_mask;
        b.time_limit_s = p.time_limit_s;
        b.flags = match p.kind {
            verdict_rules::ProgramKind::Rules => p.any_actor_bound() as u8,
            verdict_rules::ProgramKind::AiJudged => FLAG_AI_JUDGED,
            verdict_rules::ProgramKind::Market => FLAG_MARKET,
        };
        b.funded_mask = ((1u16 << n) - 1) as u8;
    }
    let n_bio = case.verified.len().min(8);
    b.n_bio = n_bio as u8;
    for (i, &(p, f)) in case.verified.iter().take(8).enumerate() {
        b.bio[i] = BioCheck { participant: p, modality: 0, frame: f };
    }
    let mut data = vec![];
    b.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 8 + BET_SIZE);
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm.set_account(*bet_key, Account { lamports, data, owner: verdict::ID, executable: false, rent_epoch: 0 }).unwrap();
}

/// Compute units consumed by the last successful `run_rules` (thread-local, for the tally).
thread_local! {
    static LAST_CU: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn run_onchain(env: &mut Env, idx: u64, case: &Case) -> Outcome {
    LAST_CU.with(|c| c.set(0));
    let payload = [case.program_bin.clone(), case.calibration_bin.clone(), case.tracks_bin.clone()].concat();
    if payload.len() > MAX_BUFFER_PAYLOAD || case.program_bin.len() > u16::MAX as usize || case.calibration_bin.len() > u16::MAX as usize {
        return Outcome::Skipped(format!("payload {} B", payload.len()));
    }
    let bet = Pubkey::new_from_array(sha256(&[b"vector-bet", &idx.to_le_bytes()]));
    install_bet(env, &bet, case);
    let tracks = tracks_pda(&bet);
    let o = env.oracle.insecure_clone();
    let chunks: Vec<&[u8]> = payload.chunks(POST_TRACKS_CHUNK).collect();
    for (i, c) in chunks.iter().enumerate() {
        let ixn = ix(
            verdict::instruction::PostTracks {
                payload_len: payload.len() as u32,
                program_len: case.program_bin.len() as u16,
                calibration_len: case.calibration_bin.len() as u16,
                offset: (i * POST_TRACKS_CHUNK) as u32,
                data: c.to_vec(),
                finalize: i + 1 == chunks.len(),
                perception_root: [0; 32],
            },
            verdict::accounts::PostTracks {
                payer: env.payer.pubkey(),
                oracle: o.pubkey(),
                bet,
                track_buffer: tracks,
                system_program: solana_sdk::system_program::ID,
            },
            &[],
        );
        if let Err(f) = env.send_with(&[ixn], &[&o], Some(400_000)) {
            return Outcome::Error(err_name(&f.err));
        }
    }
    let ixn = ix(verdict::instruction::RunRules {}, verdict::accounts::RunRules { oracle: o.pubkey(), bet, track_buffer: tracks }, &[]);
    match env.send_with(&[ixn], &[&o], Some(1_400_000)) {
        Ok(meta) => {
            LAST_CU.with(|c| c.set(meta.compute_units_consumed));
            let b = env.bet(&bet);
            Outcome::Ruled { preruling: b.preruling, reason: b.prerule_reason, winner_mask: b.winner_mask, leg_results: b.leg_results }
        }
        Err(f) => {
            let s = err_name(&f.err);
            if s.contains("ProgramFailedToComplete") || s.contains("ComputationalBudgetExceeded") {
                Outcome::OutOfCompute
            } else {
                Outcome::Error(s)
            }
        }
    }
}

fn host(case: &Case) -> Outcome {
    let v: Vec<verdict_rules::Checkpoint> = case.verified.iter().map(|&(participant, frame)| verdict_rules::Checkpoint { participant, frame }).collect();
    match verdict_rules::evaluate::<{ verdict_rules::ONCHAIN_W }>(&case.program_bin, &case.calibration_bin, &case.tracks_bin, &v, Some(MAX_EVAL_COST)) {
        Ok(o) => Outcome::Ruled { preruling: o.preruling, reason: o.reason, winner_mask: o.winner_mask, leg_results: o.leg_results },
        Err(e) => Outcome::Error(e.name().to_string()),
    }
}

fn expected_of(v: &Value) -> Option<Outcome> {
    let e = v.get("expected")?;
    if let Some(err) = e.get("error").and_then(Value::as_str) {
        return Some(Outcome::Error(err.to_string()));
    }
    let mut legs = [0xFFu8; 8];
    for (i, x) in e.get("leg_results")?.as_array()?.iter().enumerate().take(8) {
        legs[i] = x.as_u64()? as u8;
    }
    Some(Outcome::Ruled {
        preruling: e.get("preruling")?.as_u64()? as u8,
        reason: e.get("reason")?.as_u64()? as u8,
        winner_mask: e.get("winner_mask")?.as_u64()? as u8,
        leg_results: legs,
    })
}

fn case_of(v: &Value) -> Case {
    let bytes = |names: &[&str]| -> Vec<u8> {
        for n in names {
            if let Some(s) = v.get(*n).and_then(Value::as_str) {
                return hex(s);
            }
        }
        vec![]
    };
    let verified = v
        .get("verified_checkpoints")
        .or_else(|| v.get("verified"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    if let Some(arr) = c.as_array() {
                        Some((arr.first()?.as_u64()? as u8, arr.get(1)?.as_u64()? as u32))
                    } else {
                        Some((c.get("participant")?.as_u64()? as u8, c.get("frame")?.as_u64()? as u32))
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Case {
        program_bin: bytes(&["program_bin"]),
        calibration_bin: bytes(&["calibration_bin"]),
        tracks_bin: bytes(&["track_bin", "market_bin", "tracks_bin"]),
        verified,
    }
}

/// Uses the default cost cap only; vectors with a custom `opts.maxCost` are SP1-only.
fn uses_default_cost(v: &Value) -> bool {
    v.get("opts").and_then(|o| o.get("maxCost")).is_none() && v.get("max_cost").is_none()
}

struct Tally {
    ran: usize,
    /// Max `run_rules` CU over the cases that ran, with the case name.
    max_cu: (u64, String),
    skipped: Vec<String>,
    mismatches: Vec<String>,
}

fn check(env: &mut Env, idx: u64, name: &str, v: &Value, t: &mut Tally) {
    if !uses_default_cost(v) {
        t.skipped.push(format!("{name}: custom maxCost"));
        return;
    }
    let Some(expected) = expected_of(v) else {
        t.skipped.push(format!("{name}: no comparable expectation"));
        return;
    };
    let case = case_of(v);
    match run_onchain(env, idx, &case) {
        Outcome::Skipped(why) => t.skipped.push(format!("{name}: {why}")),
        // An empty tracks part is an SP1-only buffer onchain (§9.4 #8): BufferLayout without `sp1`.
        Outcome::Error(e) if e == "BufferLayout" && case.tracks_bin.is_empty() && expected == Outcome::Error("MalformedTracks".into()) => {
            t.skipped.push(format!("{name}: empty tracks part = SP1-only layout onchain (BufferLayout)"))
        }
        got => {
            t.ran += 1;
            let cu = LAST_CU.with(|c| c.get());
            if cu > t.max_cu.0 {
                t.max_cu = (cu, name.to_string());
            }
            if got != expected {
                t.mismatches.push(format!("{name}: expected {expected:?}, got {got:?}"));
            }
        }
    }
}

#[test]
fn golden_vectors_onchain() {
    let dir = vectors_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        eprintln!("SKIP: {} not found (vectors are generated by the engine: npm run vectors)", dir.display());
        return;
    };
    let mut files: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    let mut env = Env::new();
    let mut t = Tally { ran: 0, max_cu: (0, String::new()), skipped: vec![], mismatches: vec![] };
    for (i, path) in files.iter().enumerate() {
        let text = std::fs::read_to_string(path).unwrap();
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                t.mismatches.push(format!("{}: bad JSON {e}", path.display()));
                continue;
            }
        };
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        check(&mut env, i as u64, &name, &v, &mut t);
    }
    println!("vectors: ran {} onchain, skipped {}, max run_rules CU {} ({})", t.ran, t.skipped.len(), t.max_cu.0, t.max_cu.1);
    for s in &t.skipped {
        println!("  skipped {s}");
    }
    assert!(t.mismatches.is_empty(), "{} mismatches:\n{}", t.mismatches.len(), t.mismatches.join("\n"));
}

#[test]
fn fuzz_vectors_onchain() {
    let path = vectors_dir().join("fuzz.jsonl");
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("SKIP: {} not found", path.display());
        return;
    };
    let limit: usize = std::env::var("VERDICT_FUZZ_LIMIT").ok().and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
    let mut env = Env::new();
    let mut t = Tally { ran: 0, max_cu: (0, String::new()), skipped: vec![], mismatches: vec![] };
    for (i, line) in text.lines().filter(|l| !l.trim().is_empty()).take(limit).enumerate() {
        let v: Value = serde_json::from_str(line).expect("fuzz line");
        check(&mut env, 1_000_000 + i as u64, &format!("fuzz#{i}"), &v, &mut t);
    }
    println!("fuzz: ran {} onchain, skipped {}, max run_rules CU {} ({})", t.ran, t.skipped.len(), t.max_cu.0, t.max_cu.1);
    let mut reasons: std::collections::BTreeMap<String, usize> = Default::default();
    for s in &t.skipped {
        *reasons.entry(s.split_once(": ").map(|x| x.1).unwrap_or(s).to_string()).or_default() += 1;
    }
    for (r, n) in reasons {
        println!("  skipped {n} × {r}");
    }
    assert!(t.mismatches.is_empty(), "{} mismatches:\n{}", t.mismatches.len(), t.mismatches.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

/// Onchain/host parity on hand-built payloads (exercises the vector runner itself).
#[test]
fn onchain_matches_host_interpreter() {
    let mut env = Env::new();
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let p = ball_program(&keys, &[STAKE, STAKE], 0b10, 60);
    let cal = calibration(&[]);
    let cases = vec![
        Case { program_bin: p.clone(), calibration_bin: cal.clone(), tracks_bin: ball_tracks(40, Some(5)), verified: vec![] },
        Case { program_bin: p.clone(), calibration_bin: cal.clone(), tracks_bin: ball_tracks(40, None), verified: vec![] },
        Case { program_bin: p.clone(), calibration_bin: cal.clone(), tracks_bin: tracks_bin(0b11, &[(0, 0xFF, 0)], &[(0, 10)], |_, _| at(100, 100, 50)), verified: vec![] },
        Case { program_bin: p.clone(), calibration_bin: cal.clone(), tracks_bin: tracks_bin(0b1010, &[(0, 0xFF, 0)], &[], |_, _| ABSENT), verified: vec![] },
        Case { program_bin: p.clone(), calibration_bin: cal.clone(), tracks_bin: b"VTRK".to_vec(), verified: vec![] },
        Case { program_bin: p.clone(), calibration_bin: b"VCAL\x01".to_vec(), tracks_bin: ball_tracks(10, None), verified: vec![] },
        Case { program_bin: p[..p.len() - 1].to_vec(), calibration_bin: cal.clone(), tracks_bin: ball_tracks(10, None), verified: vec![] },
    ];
    for (i, c) in cases.iter().enumerate() {
        let got = run_onchain(&mut env, 500 + i as u64, c);
        assert_eq!(got, host(c), "case {i}");
    }
}
