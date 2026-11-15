//! Shared golden vectors (§0.6): every `testvectors/*.json` and `testvectors/fuzz.jsonl`
//! must produce identical `status`, `reason`, `leg_results`, `preruling`, `winner_mask`,
//! `n_checkpoints`, `checkpoints`, or the identical error. Skips gracefully when absent.
//!
//! Set `VERDICT_STRICT=1` to also compare `leg_causes`.

use serde_json::Value;
use std::path::{Path, PathBuf};
use verdict_rules::constants::MAX_EVAL_COST;
use verdict_rules::{Checkpoint, EvalDetail};

const W: usize = verdict_rules::ONCHAIN_W;

fn vectors_dir() -> PathBuf {
    if let Ok(d) = std::env::var("VERDICT_TESTVECTORS") {
        return PathBuf::from(d);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testvectors")
}

fn hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err(format!("odd hex length {}", s.len()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("bad hex: {e}")))
        .collect()
}

fn bytes_field(v: &Value, names: &[&str]) -> Result<Vec<u8>, String> {
    for n in names {
        match v.get(*n) {
            Some(Value::String(s)) => return hex(s),
            Some(Value::Null) => return Ok(vec![]),
            Some(other) => return Err(format!("{n}: expected hex string, got {other}")),
            None => {}
        }
    }
    Ok(vec![])
}

fn checkpoints(v: Option<&Value>) -> Result<Vec<Checkpoint>, String> {
    let Some(arr) = v.and_then(|v| v.as_array()) else { return Ok(vec![]) };
    arr.iter()
        .map(|c| {
            // Accept {participant, frame} or [participant, frame].
            let (p, f) = if let Some(a) = c.as_array() {
                (a.first().and_then(Value::as_u64), a.get(1).and_then(Value::as_u64))
            } else {
                (c.get("participant").and_then(Value::as_u64), c.get("frame").and_then(Value::as_u64))
            };
            match (p, f) {
                (Some(p), Some(f)) => Ok(Checkpoint { participant: p as u8, frame: f as u32 }),
                _ => Err(format!("bad checkpoint {c}")),
            }
        })
        .collect()
}

fn max_cost(case: &Value) -> Option<u64> {
    let opt = case.get("opts").and_then(|o| o.get("maxCost")).or_else(|| case.get("max_cost"));
    match opt {
        None => Some(MAX_EVAL_COST),
        Some(Value::Null) => None,
        Some(Value::String(s)) if s.eq_ignore_ascii_case("infinity") => None,
        Some(v) => v.as_u64().or(Some(MAX_EVAL_COST)),
    }
}

/// Runs one case; returns `Err(description)` on mismatch.
fn check_case(case: &Value) -> Result<(), String> {
    let program = bytes_field(case, &["program_bin"])?;
    let calibration = bytes_field(case, &["calibration_bin"])?;
    let tracks = bytes_field(case, &["track_bin", "market_bin", "tracks_bin"])?;
    let verified = checkpoints(case.get("verified_checkpoints").or_else(|| case.get("verified")))?;
    let expected = case.get("expected").ok_or("missing expected")?;
    let got = verdict_rules::evaluate_detailed::<W>(&program, &calibration, &tracks, &verified, max_cost(case));

    if let Some(err) = expected.get("error") {
        let want = err.as_str().ok_or("expected.error must be a string")?;
        return match got {
            Err(e) if e.name() == want => Ok(()),
            Err(e) => Err(format!("error: want {want}, got {}", e.name())),
            Ok(d) => Err(format!("error: want {want}, got ok result {:?}", d.out)),
        };
    }
    let d: EvalDetail = got.map_err(|e| format!("unexpected decode error {}", e.name()))?;
    let mut diffs: Vec<String> = vec![];
    fn cmp_into(diffs: &mut Vec<String>, name: &str, want: Option<Value>, got: Value) {
        if let Some(w) = want {
            if w != got {
                diffs.push(format!("{name}: want {w}, got {got}"));
            }
        }
    }
    macro_rules! cmp {
        ($n:expr, $w:expr, $g:expr) => {
            cmp_into(&mut diffs, $n, $w, $g)
        };
    }
    let n_legs = d.n_legs as usize;
    cmp!("status", expected.get("status").cloned(), Value::from(d.out.status()));
    cmp!("reason", expected.get("reason").cloned(), Value::from(d.out.reason));
    cmp!("preruling", expected.get("preruling").cloned(), Value::from(d.out.preruling));
    cmp!("winner_mask", expected.get("winner_mask").cloned(), Value::from(d.out.winner_mask));
    cmp!("leg_results", expected.get("leg_results").cloned(), Value::from(d.out.leg_results[..n_legs].to_vec()));
    cmp!("n_checkpoints", expected.get("n_checkpoints").cloned(), Value::from(d.out.n_checkpoints));
    let got_cps: Vec<Value> = d.out.checkpoints[..d.out.n_checkpoints as usize]
        .iter()
        .map(|&(p, f)| serde_json::json!({"participant": p, "frame": f}))
        .collect();
    if let Some(w) = expected.get("checkpoints") {
        let want = checkpoints(Some(w))?;
        let got: Vec<Checkpoint> = d.out.checkpoints[..d.out.n_checkpoints as usize]
            .iter()
            .map(|&(participant, frame)| Checkpoint { participant, frame })
            .collect();
        if want != got {
            diffs.push(format!("checkpoints: want {w}, got {}", Value::from(got_cps)));
        }
    }
    // §3.13: TS and Rust compute cost identically. Rust reports 0 when it exits before computing
    // it (§3.1 step 2, cross-check failed); TS still reports the cost there, so skip that case.
    if d.cost != 0 || expected.get("cost").and_then(Value::as_u64) == Some(0) {
        cmp!("cost", expected.get("cost").cloned(), Value::from(d.cost));
    }
    if std::env::var("VERDICT_STRICT").is_ok_and(|v| v == "1") {
        let causes: Vec<Value> = d.leg_causes[..n_legs]
            .iter()
            .map(|c| Value::from(c.map(|c| vec![c.name()]).unwrap_or_default()))
            .collect();
        cmp!("leg_causes", expected.get("leg_causes").cloned(), Value::from(causes));
    }
    if diffs.is_empty() {
        Ok(())
    } else {
        Err(diffs.join("; "))
    }
}

#[test]
fn golden_vectors() {
    let dir = vectors_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        eprintln!("SKIP golden_vectors: {} does not exist", dir.display());
        return;
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    let mut ran = 0usize;
    let mut failures = vec![];
    for f in &files {
        let text = std::fs::read_to_string(f).unwrap();
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                failures.push(format!("{}: invalid JSON: {e}", f.display()));
                continue;
            }
        };
        // Files without `expected` (manifests, schemas) are not vectors.
        if v.get("expected").is_none() {
            continue;
        }
        ran += 1;
        if let Err(e) = check_case(&v) {
            let name = v.get("name").and_then(Value::as_str).unwrap_or("?");
            failures.push(format!("{} ({name}): {e}", f.file_name().unwrap().to_string_lossy()));
        }
    }
    eprintln!("golden_vectors: {ran} vectors from {}", dir.display());
    if ran == 0 {
        eprintln!("SKIP golden_vectors: no vectors present");
    }
    assert!(failures.is_empty(), "{} of {ran} vectors failed:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn fuzz_vectors() {
    let path = vectors_dir().join("fuzz.jsonl");
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("SKIP fuzz_vectors: {} does not exist", path.display());
        return;
    };
    let mut ran = 0usize;
    let mut failures = vec![];
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        ran += 1;
        let res = serde_json::from_str::<Value>(line).map_err(|e| format!("invalid JSON: {e}")).and_then(|v| check_case(&v));
        if let Err(e) = res {
            failures.push(format!("line {}: {e}", i + 1));
        }
    }
    eprintln!("fuzz_vectors: {ran} cases");
    let shown: Vec<_> = failures.iter().take(25).cloned().collect();
    assert!(failures.is_empty(), "{} of {ran} fuzz cases failed (first 25):\n{}", failures.len(), shown.join("\n"));
}

#[test]
fn harness_self_check() {
    // The harness itself: hex parsing and checkpoint shapes.
    assert_eq!(hex("00ff10").unwrap(), vec![0, 255, 16]);
    assert!(hex("0").is_err());
    let cps = checkpoints(Some(&serde_json::json!([{"participant": 1, "frame": 41}, [2, 7]]))).unwrap();
    assert_eq!(cps, vec![Checkpoint { participant: 1, frame: 41 }, Checkpoint { participant: 2, frame: 7 }]);
    assert_eq!(max_cost(&serde_json::json!({})), Some(MAX_EVAL_COST));
    assert_eq!(max_cost(&serde_json::json!({"opts": {"maxCost": null}})), None);
    // A synthetic error vector round-trips.
    let case = serde_json::json!({"program_bin": "00", "calibration_bin": "", "track_bin": "", "expected": {"error": "MalformedProgram"}});
    assert_eq!(check_case(&case), Ok(()));
}
