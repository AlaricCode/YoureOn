//! Compute benchmarks for `run_rules` near `MAX_EVAL_COST` (§3.13: must stay ≤ 1.2M CU).
//! The general bound (every accepted buffer) is checked per node kind in `node_costs.rs`.
mod common;

use common::flow::*;
use common::payload::*;
use common::*;

const CU_BUDGET: u64 = 1_200_000;
const OP_RELEASED_BY: u8 = 0x35;
const OP_INTACT: u8 = 0x25;

fn rules_spec(nonce: u64, flags: u8, keys: &[Pubkey], entities: Vec<(u8, u8)>, legs: Vec<LegB>, cond: Vec<u8>, cal: Vec<u8>, tracks: Vec<u8>) -> Spec {
    let stakes = vec![STAKE; keys.len()];
    let program_bin = ProgramB {
        kind: 0,
        time_limit_s: 120,
        participants: keys.to_vec(),
        stakes: stakes.clone(),
        side_b_mask: 0b10,
        entities,
        legs,
        if_true: 1,
        else_side: 0,
        cond,
    }
    .encode();
    Spec { nonce, flags, stakes, stake_each: STAKE, side_b_mask: 0b10, time_limit_s: 120, acceptance: [0; 32], program_bin, calibration_bin: cal, tracks_bin: tracks }
}

fn bench(name: &str, spec: Spec, verified: &[(u8, u32)]) -> (u64, Bet) {
    let users = default_users(2);
    let (n_frames, weight) = {
        let program = verdict_rules::decode_program(&spec.program_bin).expect("program");
        let tracks = verdict_rules::decode_tracks(&spec.tracks_bin, &program).expect("tracks");
        (tracks.n_frames as u64, program.weight_per_frame())
    };
    let cost = (n_frames + EVAL_COST_SETUP_FRAMES) * weight;
    assert!(spec.payload().len() <= MAX_BUFFER_PAYLOAD, "{name}: payload {}", spec.payload().len());
    let mut f = Flow::with(Env::new(), users, spec);
    f.to_tracks_posted();
    let _ = verified;
    let cu = match f.try_run_rules() {
        Ok(meta) => meta.compute_units_consumed,
        Err(e) => {
            println!("{name}: run_rules failed: {:?}", e.err);
            u64::MAX
        }
    };
    println!("{name}: |F|={} weight={} cost={cost} payload={} run_rules CU={cu}", n_frames, weight, f.spec.payload().len());
    (cu, f.bet())
}

fn wobble(f: u32) -> Rec {
    let x = 3000 + ((f * 37) % 400) as u16;
    let y = 4000 + ((f * 53) % 300) as u16;
    at(x, y, 150)
}

/// Asserts the buffer is at the cap: `cost ≤ MAX_EVAL_COST` and one more frame would exceed it.
fn assert_at_cap(spec: &Spec) {
    let program = verdict_rules::decode_program(&spec.program_bin).expect("program");
    let tracks = verdict_rules::decode_tracks(&spec.tracks_bin, &program).expect("tracks");
    let w = program.weight_per_frame();
    let cost = (tracks.n_frames as u64 + EVAL_COST_SETUP_FRAMES) * w;
    assert!(cost <= MAX_EVAL_COST && cost + w > MAX_EVAL_COST, "cost {cost} not at the cap");
}

/// Velocity/state-heavy success at the cap: (405 + 4) × 20 = 8180.
#[test]
fn worst_case_state_heavy_at_cost_cap() {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let a = 0u8;
    let succ = and(
        and(and(leaf(OP_MOVING, a, 0, 0), leaf(OP_AT_REST, a, 0, 5)), and(leaf(OP_SPEED, a, 0, 100), leaf(OP_DIRECTION, a, 1, 0))),
        and(and(present(a), leaf(OP_INTACT, a, 0, 0)), leaf(OP_MOVING, a, 0, 0)),
    );
    let n = 405u16;
    let tracks = tracks_bin(FLAGS_OK, &[(0, 0xFF, 1000)], &[(0, n)], |_, f| wobble(f));
    let spec = rules_spec(21, 0, &keys, vec![(EK_OBJECT, 0)], vec![LegB::exists(1, succ)], cond_leg(1), calibration(&[]), tracks);
    assert_at_cap(&spec);
    let (cu, _) = bench("state_heavy_at_cap", spec, &[]);
    assert!(cu <= CU_BUDGET, "{cu} CU exceeds {CU_BUDGET}");
}

#[test]
fn event_heavy_two_objects_and_zone() {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let (ball, can, zone) = (0u8, 1u8, 2u8);
    let opening_can = can | (1 << 4);
    let succ = or(
        leaf(OP_DISAPPEARS_INTO, ball, opening_can, 0),
        then_within(
            20,
            and(leaf(OP_ENTERS, ball, zone, 0), leaf(OP_TOUCHES, ball, can, 0)),
            and(leaf(OP_LEAVES, ball, zone, 0), leaf(OP_INSIDE, ball, can, 0)),
        ),
    );
    let n = 120u16;
    let tracks = tracks_bin(FLAGS_OK, &[(ball, 0xFF, 0), (can, 0xFF, 0)], &[(0, n)], |t, f| if t == 0 { if f % 50 < 40 { wobble(f) } else { ABSENT } } else { bx(3200, 4200, 3600, 4600) });
    let cal = calibration(&[(zone, vec![(2000, 2000), (5000, 2000), (5000, 6000), (2000, 6000)])]);
    let spec = rules_spec(22, 0, &keys, vec![(EK_OBJECT, 0), (EK_OBJECT, 0), (EK_ZONE, 0)], vec![LegB::exists(1, succ)], cond_leg(1), cal, tracks);
    let (cu, _) = bench("event_heavy", spec, &[]);
    assert!(cu <= CU_BUDGET, "{cu} CU exceeds {CU_BUDGET}");
}

/// 8 legs (count with attempts + 7 exists) over 4 segments at the cap: (386 + 4) × 21 = 8190.
#[test]
fn worst_case_eight_legs_at_cost_cap() {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let a = 0u8;
    let mut legs = vec![LegB::count(1, 0, 2, 5, leaf(OP_MOVING, a, 0, 0), and(present(a), leaf(OP_AT_REST, a, 0, 3)))];
    for id in 2..=8u8 {
        legs.push(LegB::exists(id, present(a)));
    }
    let mut cond = cond_leg(1);
    for id in 2..=8u8 {
        cond = [vec![OP_AND], cond, cond_leg(id)].concat();
    }
    let tracks = tracks_bin(FLAGS_OK, &[(0, 0xFF, 0)], &[(0, 100), (110, 100), (230, 100), (350, 86)], |_, f| wobble(f));
    let spec = rules_spec(23, 0, &keys, vec![(EK_OBJECT, 0)], legs, cond, calibration(&[]), tracks);
    assert_at_cap(&spec);
    let (cu, _) = bench("eight_legs_at_cap", spec, &[]);
    assert!(cu <= CU_BUDGET, "{cu} CU exceeds {CU_BUDGET}");
}

/// 8-point zig-zag zone (every edge crosses the person's row): the heaviest leaves per unit
/// of weight (person anchors ⇒ two polygon tests for `overlaps`). (451 + 4) × 18 = 8190.
fn zigzag() -> Vec<(u16, u16)> {
    vec![(1000, 3000), (2500, 9500), (3500, 3000), (4500, 9500), (5500, 3000), (6500, 9500), (7500, 3000), (9000, 9500)]
}

fn walker(f: u32) -> Rec {
    if f % 11 == 10 {
        return ABSENT;
    }
    person_at(1500 + ((f * 97) % 7000) as u16, 6000 + ((f * 31) % 3000) as u16)
}

#[test]
fn worst_case_polygon_at_cost_cap() {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let (p, z) = (0u8, 1u8);
    let succ = or(leaf(OP_OVERLAPS, p, z, 0), and(leaf(OP_TOUCHES, p, z, 0), leaf(OP_ENTERS, p, z, 0)));
    let n = 451u16;
    let tracks = tracks_bin(FLAGS_OK, &[(p, 0, 0)], &[(0, n)], |_, f| walker(f));
    let spec = rules_spec(26, FLAG_ACTOR_BOUND, &keys, vec![(EK_PERSON, 0), (EK_ZONE, 0)], vec![LegB::exists(1, succ).actor()], cond_leg(1), calibration(&[(z, zigzag())]), tracks);
    assert_at_cap(&spec);
    let (cu, _) = bench("polygon_at_cap", spec, &[]);
    assert!(cu <= CU_BUDGET, "{cu} CU exceeds {CU_BUDGET}");
}

/// Balanced tree of 32 `leaf`s joined by `then_within` (63 nodes, the per-expression maximum).
fn big(lf: &[u8]) -> Vec<u8> {
    fn tree(n: usize, lf: &[u8]) -> Vec<u8> {
        if n == 1 {
            return lf.to_vec();
        }
        then_within(20, tree(n / 2, lf), tree(n - n / 2, lf))
    }
    tree(32, lf)
}

/// Set-up heavy: 2 count legs × (63 + 63) polygon-event nodes at |F| = 5, the most frames the
/// cap allows: (5 + 4) × 892 = 8028.
#[test]
fn worst_case_setup_heavy_at_cost_cap() {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let (p, z) = (0u8, 1u8);
    let lf = leaf(OP_TOUCHES, p, z, 0);
    let legs: Vec<LegB> = (1..=2u8).map(|id| LegB::count(id, 0, 1, 8, big(&lf), big(&lf)).actor()).collect();
    let cond = [vec![OP_AND], cond_leg(1), cond_leg(2)].concat();
    let tracks = tracks_bin(FLAGS_OK, &[(p, 0, 0)], &[(0, 5)], |_, f| walker(f));
    let spec = rules_spec(27, FLAG_ACTOR_BOUND, &keys, vec![(EK_PERSON, 0), (EK_ZONE, 0)], legs, cond, calibration(&[(z, zigzag())]), tracks);
    assert_at_cap(&spec);
    let (cu, _) = bench("setup_heavy_at_cap", spec, &[]);
    assert!(cu <= CU_BUDGET, "{cu} CU exceeds {CU_BUDGET}");
}

#[test]
fn paper_ball_shape_actor_bound() {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let (shooter, ball, can, zone) = (0u8, 1u8, 2u8, 3u8);
    let va = and(leaf(OP_RELEASED_BY, ball, shooter, 0), leaf(OP_INSIDE, shooter, zone, 0));
    let succ = or(leaf(OP_DISAPPEARS_INTO, ball, can | (1 << 4), 0), and(leaf(OP_INSIDE, ball, can, 0), leaf(OP_AT_REST, ball, 0, 10)));
    let leg = LegB::count(1, 0, 1, 3, va, succ).actor();
    let n = 120u16;
    let tracks = tracks_bin(FLAGS_OK, &[(shooter, 1, 0), (ball, 0xFF, 0), (can, 0xFF, 0)], &[(0, n)], |t, f| match t {
        0 => person_at(1000, 9000),
        1 => {
            if f % 60 <= 40 {
                at(1200, 8000, 100)
            } else if f % 60 <= 56 {
                let k = (f % 60 - 41) as u16;
                at(1600 + k * 400, 7600 - k * 120, 100)
            } else {
                ABSENT
            }
        }
        _ => bx(7600, 6200, 8800, 9400),
    });
    let cal = calibration(&[(zone, vec![(0, 5000), (3000, 5000), (3000, 10000), (0, 10000)])]);
    let spec = rules_spec(24, FLAG_ACTOR_BOUND, &keys, vec![(EK_PERSON, 1), (EK_OBJECT, 0), (EK_OBJECT, 0), (EK_ZONE, 0)], vec![leg], cond_leg(1), cal, tracks);
    let (cu, b) = bench("paper_ball_shape", spec, &[]);
    assert!(cu <= CU_BUDGET, "{cu} CU exceeds {CU_BUDGET}");
    // No identity proofs ⇒ the actor-bound leg cannot be confirmed.
    assert!(b.state == STATE_DISPUTED || b.state == STATE_PRERULED);
}

#[test]
fn over_cost_cap_goes_to_panel_cheaply() {
    let keys: Vec<Pubkey> = default_users(2).iter().map(|u| u.pubkey()).collect();
    let a = 0u8;
    let succ = and(
        and(and(leaf(OP_MOVING, a, 0, 0), leaf(OP_AT_REST, a, 0, 5)), and(leaf(OP_SPEED, a, 0, 100), leaf(OP_DIRECTION, a, 1, 0))),
        and(and(present(a), leaf(OP_INTACT, a, 0, 0)), and(leaf(OP_MOVING, a, 0, 0), present(a))),
    );
    let n = 800u16; // (800 + 4) × 23 > MAX_EVAL_COST
    let tracks = tracks_bin(FLAGS_OK, &[(0, 0xFF, 1000)], &[(0, n)], |_, f| wobble(f));
    let spec = rules_spec(25, 0, &keys, vec![(EK_OBJECT, 0)], vec![LegB::exists(1, succ)], cond_leg(1), calibration(&[]), tracks);
    let (cu, b) = bench("over_cap", spec, &[]);
    assert!(cu <= CU_BUDGET, "{cu} CU exceeds {CU_BUDGET}");
    assert_eq!(b.state, STATE_DISPUTED);
    assert_eq!(b.dispute_reason, 13);
}
