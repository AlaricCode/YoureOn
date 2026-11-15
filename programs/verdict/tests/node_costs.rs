//! Per-node compute bound for `run_rules` (CONTRACTS.md §3.13).
//!
//! `run_rules` CU is linear in the work: a per-instruction base, track decode per record, and
//! for every node of every leg a set-up part (decode, signals, zone preparation) plus a part per
//! frame of F. The §3.13 cost charges `w(node)` per frame plus `EVAL_COST_SETUP_FRAMES × w(node)`
//! for the set-up, so it suffices to check, in LiteSVM with the release `.so`:
//!
//! * `node_cost_bounds`: for every node kind (each leaf with each operand shape, each
//!   combinator) and every per-leg pass (count with attempts, holds, …), the marginal CU per
//!   frame of F (two runs at different |F|, record decode subtracted) is ≤ `w × CU_PER_COST_UNIT`,
//!   with F in 1 segment and in 16;
//! * `overhead_bound`: decode per record ≤ `DECODE_CU_PER_RECORD`, and the largest programs the
//!   decoder accepts (8 legs × 2 × 63 nodes of each leaf kind) at |F| = 1 and at 16 one-frame
//!   segments satisfy the bound below (this is where the set-up part dominates);
//!
//! which gives, for every buffer,
//!
//!   CU(run_rules) ≤ BASE_CU + DECODE_CU_PER_RECORD × records + CU_PER_COST_UNIT × cost,
//!
//! so `cost ≤ MAX_EVAL_COST` and payload ≤ MAX_BUFFER_PAYLOAD keep a run within the 1.2M CU
//! target (`bound_at_cap_fits_target`). The `worst_case_*` tests in `compute.rs` run at the cap. Print the tables with
//! `cargo test -p verdict --test node_costs -- --nocapture --test-threads 1`.
//!
//! The data is adversarial where it matters: an 8-point zig-zag zone whose every edge crosses
//! the objects' rows (worst case of the even-odd test), objects present on most frames (velocity
//! and spatial predicates evaluated), stale sub-regions, and reps/poses toggling.
mod common;

use common::flow::*;
use common::payload::*;
use common::*;

/// Bound on the evaluation CU per §3.13 cost unit (one frame of F, or one set-up frame, × one
/// unit of weight).
const CU_PER_COST_UNIT: f64 = 120.0;
/// Bound on the CU that doesn't scale with the program: instruction, accounts, headers.
const BASE_CU: f64 = 40_000.0;
/// Bound on track decode (record validation) per 12-byte record.
const DECODE_CU_PER_RECORD: f64 = 60.0;
/// Most records a payload can hold.
const MAX_RECORDS: f64 = (MAX_BUFFER_PAYLOAD / 12) as f64;
/// §3.13 target.
const CU_TARGET: f64 = 1_200_000.0;

/// The bound every `run_rules` must satisfy.
fn cu_bound(cost: u64, records: u64) -> f64 {
    BASE_CU + DECODE_CU_PER_RECORD * records as f64 + CU_PER_COST_UNIT * cost as f64
}

const OP_ABOVE: u8 = 0x12;
const OP_BELOW: u8 = 0x13;
const OP_BEHIND: u8 = 0x15;
const OP_BEYOND: u8 = 0x16;
const OP_INTACT: u8 = 0x25;
const OP_CROSSES: u8 = 0x34;
const OP_RELEASED_BY: u8 = 0x35;
const OP_STANDING: u8 = 0x40;
const OP_REP_COUNT: u8 = 0x41;
const OP_BEFORE: u8 = 0x06;
const EK_LINE: u8 = 3;

// Entities: 0 object A, 1 object B (container), 2 zone (8 points), 3 line, 4 person (participant 0).
const A: u8 = 0;
const B: u8 = 1;
const Z: u8 = 2;
const L: u8 = 3;
const P: u8 = 4;
const B_OPENING: u8 = B | (1 << 4);
const B_INTERIOR: u8 = B | (2 << 4);

fn calibration_full() -> Vec<u8> {
    let mut v = b"VCAL".to_vec();
    v.push(1);
    v.push(2);
    v.extend_from_slice(&[0, 0]);
    v.extend_from_slice(&[0x5C; 32]);
    // Zone: 8-point zig-zag (MAX_ZONE_POINTS): a horizontal line through the middle crosses
    // every edge, the worst case for the even-odd test.
    let oct: [(u16, u16); 8] =
        [(1000, 3000), (2500, 7000), (3500, 3000), (4500, 7000), (5500, 3000), (6500, 7000), (7500, 3000), (9000, 7000)];
    v.extend_from_slice(&[Z, 1, 8, 0]);
    for p in oct {
        v.extend_from_slice(&p.0.to_le_bytes());
        v.extend_from_slice(&p.1.to_le_bytes());
    }
    // Line: x = 4000, behind = +1.
    v.extend_from_slice(&[L, 0, 2, 1]);
    for p in [(4000u16, 0u16), (4100u16, 10000u16)] {
        v.extend_from_slice(&p.0.to_le_bytes());
        v.extend_from_slice(&p.1.to_le_bytes());
    }
    v
}

/// A: sweeps across the zone and the line for 30 frames, then rests for 10; absent every 13th frame.
fn rec_a(f: u32) -> Rec {
    if f % 13 == 12 {
        return ABSENT;
    }
    let ph = f % 40;
    let x = if ph < 30 { 1500 + ph * 230 } else { 1500 + 29 * 230 + (f % 3) * 10 };
    let y = 5000 + (f * 53) % 300 - if ph < 30 { ph * 20 } else { 0 };
    at(x as u16, y as u16, 200 + (f % 7) as u16 * 20)
}
/// B: a container, absent every 29th frame (stale sub-regions).
fn rec_b(f: u32) -> Rec {
    if f % 29 == 28 {
        return ABSENT;
    }
    bx(4200, 4200 + (f % 5) as u16 * 10, 6000, 6200)
}
/// P: a person next to A's path, reps (pose low/high) and standing toggling.
fn rec_p(f: u32) -> Rec {
    let pose = if f % 10 < 5 { 0x02 } else { 0x04 } | if f % 20 < 10 { 0x01 } else { 0 };
    Rec { pose, ..person_at(1600 + ((f % 40).min(29) * 230) as u16, 6200) }
}

fn spec_for(nonce: u64, legs: Vec<LegB>, segs: &[(u32, u16)]) -> Spec {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let actor = legs.iter().any(|l| l.actor_bound);
    let mut cond = cond_leg(legs[0].id);
    for l in &legs[1..] {
        cond = [vec![OP_AND], cond, cond_leg(l.id)].concat();
    }
    let stakes = vec![STAKE; 2];
    let program_bin = ProgramB {
        kind: 0,
        time_limit_s: 120,
        participants: keys.clone(),
        stakes: stakes.clone(),
        side_b_mask: 0b10,
        entities: vec![(EK_OBJECT, 0), (EK_OBJECT, 0), (EK_ZONE, 0), (EK_LINE, 0), (EK_PERSON, 0)],
        legs,
        if_true: 1,
        else_side: 0,
        cond,
    }
    .encode();
    let mask = verdict_rules::decode_program(&program_bin).expect("program").tracked_mask;
    let all: [(u8, u8, u16); 3] = [(A, 0xFF, 300), (B, 0xFF, 0), (P, 0, 0)];
    let used: Vec<(u8, u8, u16)> = all.iter().copied().filter(|t| mask & (1 << t.0) != 0).collect();
    let tracks = tracks_bin(FLAGS_OK, &used, segs, |t, f| match used[t].0 {
        A => rec_a(f),
        B => rec_b(f),
        _ => rec_p(f),
    });
    Spec {
        nonce,
        flags: if actor { FLAG_ACTOR_BOUND } else { 0 },
        stakes,
        stake_each: STAKE,
        side_b_mask: 0b10,
        time_limit_s: 120,
        acceptance: [0; 32],
        program_bin,
        calibration_bin: calibration_full(),
        tracks_bin: tracks,
    }
}

/// (CU, weight per frame, tracks).
fn run_segs(nonce: u64, legs: Vec<LegB>, segs: &[(u32, u16)]) -> (u64, u64, u32) {
    let spec = spec_for(nonce, legs, segs);
    let prog = verdict_rules::decode_program(&spec.program_bin).expect("program");
    let (weight, n_tracks) = (prog.weight_per_frame(), prog.tracked_mask.count_ones());
    assert!(spec.payload().len() <= MAX_BUFFER_PAYLOAD, "payload {}", spec.payload().len());
    let mut f = Flow::with(Env::new(), default_users(2), spec);
    f.to_tracks_posted();
    let cu = match f.try_run_rules() {
        Ok(m) => m.compute_units_consumed,
        Err(e) => panic!("run_rules failed: {:?}", e.err),
    };
    (cu, weight, n_tracks)
}


/// `n` frames split into `k` segments 5 frames apart.
fn split(n: u16, k: u16) -> Vec<(u32, u16)> {
    let mut out = vec![];
    let mut start = 0u32;
    for i in 0..k {
        let len = n / k + u16::from(i < n % k);
        out.push((start, len));
        start += len as u32 + 5;
    }
    out
}

const N1: u16 = 40;
const N2: u16 = 240;

/// Measured track-decode CU per record: a program over the cost cap (decode, then reason 13),
/// at two buffer sizes with 3 tracks.
fn decode_rate() -> f64 {
    let over = || {
        let ors: Vec<Vec<u8>> = (0..32).map(|_| leaf(OP_DISAPPEARS_INTO, A, B_OPENING, 0)).collect();
        vec![LegB::exists(1, tree(&ors, &|x, y| or(x, y))), LegB::exists(2, leaf(OP_STANDING, P, 0, 0)).actor()]
    };
    let (c1, w1, t) = run_segs(900, over(), &[(0, N1)]);
    let (c2, _, _) = run_segs(900, over(), &[(0, N2)]);
    assert!(w1 * N1 as u64 > MAX_EVAL_COST, "must be over the cap");
    (c2 as f64 - c1 as f64) / ((N2 - N1) as f64 * t as f64)
}

/// Marginal evaluation CU per frame of F (record decode subtracted), with F in `k` segments.
fn marginal(nonce: u64, k: u16, decode: f64, legs: impl Fn() -> Vec<LegB>) -> (f64, u64) {
    let (c1, w, t) = run_segs(nonce, legs(), &split(N1, k));
    let (c2, _, _) = run_segs(nonce, legs(), &split(N2, k));
    let per = (c2 as f64 - c1 as f64) / (N2 - N1) as f64;
    (per - t as f64 * decode, w)
}

fn actor_if(l: LegB, person: bool) -> LegB {
    if person {
        l.actor()
    } else {
        l
    }
}

/// Every leaf kind with the operand shapes that take different code paths: (name, leaf, refs a person).
fn leaf_cases() -> Vec<(&'static str, Vec<u8>, bool)> {
    vec![
        ("present", present(A), false),
        ("intact", leaf(OP_INTACT, A, 0, 0), false),
        ("standing", leaf(OP_STANDING, P, 0, 0), true),
        ("rep_count", leaf(OP_REP_COUNT, P, 0, 3), true),
        ("overlaps box", leaf(OP_OVERLAPS, A, B, 0), false),
        ("overlaps opening", leaf(OP_OVERLAPS, A, B_OPENING, 0), false),
        ("overlaps zone", leaf(OP_OVERLAPS, A, Z, 0), false),
        ("overlaps zone (person)", leaf(OP_OVERLAPS, P, Z, 0), true),
        ("inside box", leaf(OP_INSIDE, A, B, 0), false),
        ("inside interior", leaf(OP_INSIDE, A, B_INTERIOR, 0), false),
        ("inside zone", leaf(OP_INSIDE, A, Z, 0), false),
        ("inside zone (person)", leaf(OP_INSIDE, P, Z, 0), true),
        ("above box", leaf(OP_ABOVE, A, B, 0), false),
        ("above interior", leaf(OP_ABOVE, A, B_INTERIOR, 0), false),
        ("below zone", leaf(OP_BELOW, A, Z, 0), false),
        ("near box", leaf(OP_NEAR, A, B, 500), false),
        ("near opening", leaf(OP_NEAR, A, B_OPENING, 14143), false),
        ("near zone", leaf(OP_NEAR, A, Z, 14143), false),
        ("behind line", leaf(OP_BEHIND, A, L, 0), false),
        ("beyond line (person)", leaf(OP_BEYOND, P, L, 0), true),
        ("moving", leaf(OP_MOVING, A, 0, 0), false),
        ("at_rest", leaf(OP_AT_REST, A, 0, 5), false),
        ("speed >=", leaf(OP_SPEED, A, 0, 700), false),
        ("speed ==", leaf(OP_SPEED, A, 4, 1150), false),
        ("direction", leaf(OP_DIRECTION, A, 3, 0), false),
        ("enters zone", leaf(OP_ENTERS, A, Z, 0), false),
        ("enters zone (person)", leaf(OP_ENTERS, P, Z, 0), true),
        ("enters interior", leaf(OP_ENTERS, A, B_INTERIOR, 0), false),
        ("leaves box", leaf(OP_LEAVES, A, B, 0), false),
        ("leaves zone", leaf(OP_LEAVES, A, Z, 0), false),
        ("touches box", leaf(OP_TOUCHES, A, B, 0), false),
        ("touches opening", leaf(OP_TOUCHES, A, B_OPENING, 0), false),
        ("touches zone", leaf(OP_TOUCHES, A, Z, 0), false),
        ("touches zone (person)", leaf(OP_TOUCHES, P, Z, 0), true),
        ("crosses", leaf(OP_CROSSES, A, L, 0), false),
        ("crosses (person)", leaf(OP_CROSSES, P, L, 0), true),
        ("released_by", leaf(OP_RELEASED_BY, A, P, 0), true),
        ("disappears_into opening", leaf(OP_DISAPPEARS_INTO, A, B_OPENING, 0), false),
        ("disappears_into zone", leaf(OP_DISAPPEARS_INTO, A, Z, 0), false),
    ]
}

/// Records the ratio and fails the check (collected) if above the bound.
struct Table {
    worst: f64,
    failures: Vec<String>,
}

impl Table {
    fn new(title: &str) -> Self {
        println!("{title}\n{:<34} {:>4} {:>9} {:>9}", "node", "w", "CU/frame", "CU/unit");
        Table { worst: 0.0, failures: vec![] }
    }
    fn check(&mut self, name: &str, per: f64, w: u64) {
        let ratio = per / w as f64;
        println!("{name:<34} {w:>4} {per:>9.1} {ratio:>9.1}");
        self.worst = self.worst.max(ratio);
        if ratio > CU_PER_COST_UNIT {
            self.failures.push(format!("{name}: {per:.1} CU/frame > {w} × {CU_PER_COST_UNIT}"));
        }
    }
    fn finish(self) {
        println!("worst CU per cost unit: {:.1} (bound {CU_PER_COST_UNIT})\n", self.worst);
        assert!(self.failures.is_empty(), "{:#?}", self.failures);
    }
}

/// Per-node marginal CU per frame ≤ w(node) × CU_PER_COST_UNIT, with F in 1 and in 16 segments.
#[test]
fn node_cost_bounds() {
    let decode = decode_rate();
    println!("decode: {decode:.1} CU/record");
    for k in [1u16, 16] {
        let mut t = Table::new(&format!("|F| in {k} segment(s)"));
        let mut nonce = 100u64 + 1000 * k as u64;
        // A leaf alone in an exists leg (the leg's own pass is charged to the leaf).
        for (name, lf, person) in leaf_cases() {
            let (per, w) = marginal(nonce, k, decode, || vec![actor_if(LegB::exists(1, lf.clone()), person)]);
            nonce += 1;
            t.check(name, per, w);
        }
        // Combinators: their own per-frame CU (children's measured marginals subtracted).
        let (p1, _) = marginal(nonce, k, decode, || vec![LegB::exists(1, present(A))]);
        nonce += 1;
        let combs: Vec<(&str, Vec<u8>, f64)> = vec![
            ("and", and(present(A), present(A)), 2.0),
            ("or", or(present(A), present(A)), 2.0),
            ("not", not(present(A)), 1.0),
            ("then_within", then_within(20, present(A), present(A)), 2.0),
            ("for_duration", for_duration(5, present(A)), 1.0),
            ("before", [vec![OP_BEFORE], 100u32.to_le_bytes().to_vec(), present(A)].concat(), 1.0),
        ];
        for (name, e, n_present) in combs {
            let (per, _) = marginal(nonce, k, decode, || vec![LegB::exists(1, e.clone())]);
            nonce += 1;
            t.check(name, (per - n_present * p1).max(0.0), 1);
        }
        // Rule kinds with their own per-frame passes, over the cheapest leaf (whole leg charged).
        let rules: Vec<(&str, LegB)> = vec![
            ("count with attempts", LegB::count(1, 0, 2, 20, present(A), present(B))),
            ("count (no attempts)", LegB::count(1, 0, 2, 0, vec![], present(A))),
            ("holds", LegB { rule_kind: 2, rule_n: 1100, ..LegB::exists(1, present(B)) }),
            ("before (rule)", LegB { rule_kind: 4, rule_n: 1100, ..LegB::exists(1, present(A)) }),
            ("never", LegB { rule_kind: 3, ..LegB::exists(1, present(A)) }),
            ("actor-bound count", LegB::count(1, 0, 8, 8, leaf(OP_STANDING, P, 0, 0), present(A)).actor()),
        ];
        for (name, leg) in rules {
            let (per, w) = marginal(nonce, k, decode, || vec![leg.clone()]);
            nonce += 1;
            t.check(name, per, w);
        }
        let (per, w) = marginal(nonce, k, decode, || (1..=8).map(|id| LegB::exists(id, present(A))).collect());
        t.check("8 legs × present", per, w);
        t.finish();
    }
}

/// Balanced binary tree of `leaves` joined by `join`.
fn tree(leaves: &[Vec<u8>], join: &dyn Fn(Vec<u8>, Vec<u8>) -> Vec<u8>) -> Vec<u8> {
    if leaves.len() == 1 {
        return leaves[0].clone();
    }
    let (l, r) = leaves.split_at(leaves.len() / 2);
    join(tree(l, join), tree(r, join))
}

/// The largest expression the decoder allows: 63 nodes (32 leaves, 31 `then_within`), depth 6.
fn big_expr(leaf: &[u8]) -> Vec<u8> {
    let leaves: Vec<Vec<u8>> = (0..32).map(|_| leaf.to_vec()).collect();
    tree(&leaves, &|x, y| then_within(20, x, y))
}

/// Decode stays under its bound, and the largest programs (8 count legs × (63 + 63) nodes, so
/// ~1000 nodes, of every leaf kind) at the smallest |F| — one frame, or 16 one-frame segments
/// with as many legs as the cost cap allows — stay under `cu_bound`: the set-up part of the
/// cost covers per-node, per-leg and per-segment set-up.
#[test]
fn overhead_bound() {
    let decode = decode_rate();
    println!("decode: {decode:.1} CU/record (bound {DECODE_CU_PER_RECORD})");
    assert!(decode <= DECODE_CU_PER_RECORD);
    let legs = |n_legs: u8, lf: &[u8], person: bool| -> Vec<LegB> {
        (1..=n_legs).map(|id| actor_if(LegB::count(id, 0, 1, 8, big_expr(lf), big_expr(lf)), person)).collect()
    };
    let mut failures = vec![];
    let mut worst: f64 = 0.0;
    println!("{:<26} {:>5} {:>6} {:>8} {:>9} {:>9}", "leaf", "legs", "segs", "cost", "CU", "bound");
    for (i, (name, lf, person)) in leaf_cases().into_iter().enumerate() {
        for segs in [vec![(0u32, 1u16)], split(16, 16)] {
            let n = segs.len() as u64;
            let Some(n_legs) = (1..=8u8).rev().find(|&k| {
                let bin = spec_for(0, legs(k, &lf, person), &segs).program_bin;
                verdict_rules::decode_program(&bin).unwrap().weight_per_frame() * (n + EVAL_COST_SETUP_FRAMES) <= MAX_EVAL_COST
            }) else {
                continue;
            };
            let (cu, w, t) = run_segs(5000 + i as u64, legs(n_legs, &lf, person), &segs);
            let cost = w * (n + EVAL_COST_SETUP_FRAMES);
            let bound = cu_bound(cost, t as u64 * n);
            println!("{name:<26} {n_legs:>5} {:>6} {cost:>8} {cu:>9} {bound:>9.0}", segs.len());
            worst = worst.max((cu as f64 - BASE_CU - DECODE_CU_PER_RECORD * (t as u64 * n) as f64) / cost as f64);
            if cu as f64 > bound {
                failures.push(format!("{name}, {} segments: {cu} CU > {bound:.0}", segs.len()));
            }
        }
    }
    println!("largest (CU − base − decode) / cost: {worst:.1} (bound {CU_PER_COST_UNIT})");
    assert!(failures.is_empty(), "{failures:#?}");
}

/// `cu_bound` at the cap with a full payload fits the §3.13 target.
#[test]
fn bound_at_cap_fits_target() {
    let bound = cu_bound(MAX_EVAL_COST, MAX_RECORDS as u64);
    println!("bound at MAX_EVAL_COST = {MAX_EVAL_COST}, {MAX_RECORDS} records: {bound:.0} CU (target {CU_TARGET})");
    assert!(bound <= CU_TARGET);
}
