//! CONTRACTS.md §15 worked examples, pass and fail variants.
mod common;
use common::*;
use verdict_rules::eval::*;
use verdict_rules::expr::*;

// ---------------- §15.1 paper-ball shot ----------------
const SHOOTER: u8 = 0;
const BALL: u8 = 1;
const CAN: u8 = 2;
const LINE: u8 = 3;

fn paper_ball_va() -> Vec<u8> {
    and(leaf(OP_RELEASED_BY, BALL, SHOOTER, 0), leaf(OP_BEHIND, SHOOTER, LINE, 0))
}
fn paper_ball_succ() -> Vec<u8> {
    or(
        leaf(OP_DISAPPEARS_INTO, BALL, opening(CAN), 0),
        and(leaf(OP_INSIDE, BALL, CAN, 0), leaf(OP_AT_REST, BALL, 0, 10)),
    )
}
fn paper_ball_program() -> ProgramB {
    let leg = LegB::count(1, CMP_GE, 1, 3, paper_ball_va(), paper_ball_succ()).actor();
    ProgramB::rules(vec![(EK_PERSON, 1), (EK_OBJECT, 0), (EK_OBJECT, 0), (EK_LINE, 0)], vec![leg], 180)
}
fn paper_ball_cal() -> Vec<u8> {
    calibration(&[RegionB::Line { entity: LINE, a: (3000, 6000), b: (3000, 10000), behind_sign: 1 }])
}

/// Ball trajectory: held at the shooter's hand until frame 40, released at 41, flies to
/// `(land_x, 6000)` reaching it at frame 58, then (if it goes in) disappears.
fn paper_ball_tracks(land_x: u16, goes_in: bool, ball_conf_at_58: u8) -> Vec<u8> {
    TracksB::build(
        OK_FLAGS,
        vec![(SHOOTER, 1, 0), (BALL, 0xFF, 0), (CAN, 0xFF, 0)],
        vec![(30, 60)],
        move |t, f| match t {
            0 => person_at(1000, 9000),
            1 => {
                if f <= 40 {
                    at(1200, 8000, 100)
                } else if f <= 56 {
                    let k = (f - 41) as u16;
                    at(1600 + k * 400, 7600 - k * 120, 100)
                } else if f == 57 {
                    at(land_x - 200, 5800, 100)
                } else if f == 58 {
                    Rec { conf: ball_conf_at_58, ..at(land_x, 6000, 100) }
                } else if goes_in {
                    ABSENT
                } else {
                    at(land_x, 9800, 100)
                }
            }
            _ => bx(7600, 6200, 8800, 9400),
        },
    )
    .encode()
}

#[test]
fn paper_ball_encoding_matches_contract() {
    assert_eq!(
        paper_ball_va(),
        vec![0x01, 0x35, 0x01, 0x00, 0, 0, 0, 0, 0x15, 0x00, 0x03, 0, 0, 0, 0]
    );
    assert_eq!(opening(CAN), 0x12);
    let p = paper_ball_program().encode();
    let prog = verdict_rules::decode_program(&p).unwrap();
    assert_eq!(prog.weight_per_frame(), 27);
    assert_eq!(prog.n_tracked(), 3);
    assert!(prog.any_actor_bound());
    // 299 frames fit MAX_EVAL_COST, 300 don't: cost = (|F| + EVAL_COST_SETUP_FRAMES) × 27.
    use verdict_rules::constants::{EVAL_COST_SETUP_FRAMES as S, MAX_EVAL_COST};
    const _: () = assert!((299 + S) * 27 <= MAX_EVAL_COST);
    const _: () = assert!((300 + S) * 27 > MAX_EVAL_COST);
}

#[test]
fn paper_ball_success() {
    let d = run(&paper_ball_program().encode(), &paper_ball_cal(), &paper_ball_tracks(8200, true, 90), &[(1, 41)]).unwrap();
    assert_eq!(d.out.status(), "ok");
    assert_eq!(d.out.reason, 0);
    assert_eq!(legs_of(&d), vec![1]);
    assert_eq!(d.out.preruling, PRERULING_WINNER);
    assert_eq!(d.out.winner_mask, 2);
    assert_eq!(cps_of(&d), vec![(1, 41)]);
    assert_eq!(d.cost, (60 + 4) * 27);
}

#[test]
fn paper_ball_unverified_is_identity_unknown() {
    let d = run(&paper_ball_program().encode(), &paper_ball_cal(), &paper_ball_tracks(8200, true, 90), &[]).unwrap();
    assert_eq!(d.out.status(), "needs_panel");
    assert_eq!(d.out.reason, REASON_LOW_CONFIDENCE);
    assert_eq!(legs_of(&d), vec![2]);
    assert_eq!(causes_of(&d), vec![Some(LegCause::Identity)]);
    assert_eq!(d.out.winner_mask, 0);
    // Checkpoints are still reported.
    assert_eq!(cps_of(&d), vec![(1, 41)]);
    // Wrong frame verified is also IDENTITY.
    let d = run(&paper_ball_program().encode(), &paper_ball_cal(), &paper_ball_tracks(8200, true, 90), &[(1, 42)]).unwrap();
    assert_eq!(causes_of(&d), vec![Some(LegCause::Identity)]);
}

#[test]
fn paper_ball_miss() {
    let d = run(&paper_ball_program().encode(), &paper_ball_cal(), &paper_ball_tracks(5000, false, 90), &[]).unwrap();
    assert_eq!(d.out.status(), "ok");
    assert_eq!(legs_of(&d), vec![0]);
    assert_eq!(d.out.winner_mask, 1);
    assert_eq!(d.out.n_checkpoints, 0);
}

#[test]
fn paper_ball_low_conf_at_decisive_frame() {
    let d = run(&paper_ball_program().encode(), &paper_ball_cal(), &paper_ball_tracks(8200, true, 40), &[(1, 41)]).unwrap();
    assert_eq!(legs_of(&d), vec![2]);
    assert_eq!(causes_of(&d), vec![Some(LegCause::Conf)]);
    assert_eq!(d.out.reason, REASON_LOW_CONFIDENCE);
}

#[test]
fn paper_ball_camera_motion_and_flags() {
    let p = paper_ball_program().encode();
    let c = paper_ball_cal();
    let mut t = paper_ball_tracks(8200, true, 90);
    t[8] = 0b11; // camera_motion + cross_check_ok
    let d = run(&p, &c, &t, &[(1, 41)]).unwrap();
    assert_eq!(causes_of(&d), vec![Some(LegCause::Motion)]);
    assert_eq!(cps_of(&d), vec![(1, 41)]);
    t[8] = 0b00; // cross-check failed
    let d = run(&p, &c, &t, &[(1, 41)]).unwrap();
    assert_eq!((d.out.preruling, d.out.reason), (3, REASON_CROSS_CHECK_FAILED));
    assert_eq!(legs_of(&d), vec![2]);
    assert_eq!(causes_of(&d), vec![None]);
    assert_eq!(d.out.n_checkpoints, 0);
}

// ---------------- §15.2 cup tower ----------------
fn tower_program() -> Vec<u8> {
    let mut p = ProgramB::rules(
        vec![(EK_OBJECT, 0), (EK_OBJECT, 0)],
        vec![LegB::holds(1, 100, leaf(OP_INTACT, 0, 0, 0))],
        30,
    );
    p.if_true = 0;
    p.else_side = 1;
    p.stakes = vec![2_000_000, 2_000_000];
    p.encode()
}

fn tower_tracks(n: u16, f: impl Fn(u32) -> Rec) -> Vec<u8> {
    TracksB::build(OK_FLAGS, vec![(0, 0xFF, 2000)], vec![(0, n)], move |_, fr| f(fr)).encode()
}

#[test]
fn tower_survives() {
    let t = tower_tracks(105, |_| bx(4000, 3000, 5000, 5000));
    assert_eq!(t.len(), 44 + 4 + 8 + 105 * 12);
    let d = run(&tower_program(), &calibration(&[]), &t, &[]).unwrap();
    assert_eq!(legs_of(&d), vec![1]);
    assert_eq!(d.out.winner_mask, 1);
    assert_eq!(d.out.n_checkpoints, 0);
}

#[test]
fn tower_falls() {
    let t = tower_tracks(105, |f| if f >= 60 { bx(4000, 4000, 5000, 5000) } else { bx(4000, 3000, 5000, 5000) });
    let d = run(&tower_program(), &calibration(&[]), &t, &[]).unwrap();
    assert_eq!(legs_of(&d), vec![0]);
    assert_eq!(d.out.winner_mask, 2);
}

#[test]
fn tower_intact_threshold() {
    // 75% of ref_h 2000 = 1500: height 1500 is intact, 1499 is not.
    let ok = tower_tracks(105, |_| bx(4000, 3500, 5000, 5000));
    assert_eq!(legs_of(&run(&tower_program(), &calibration(&[]), &ok, &[]).unwrap()), vec![1]);
    let bad = tower_tracks(105, |_| bx(4000, 3501, 5000, 5000));
    assert_eq!(legs_of(&run(&tower_program(), &calibration(&[]), &bad, &[]).unwrap()), vec![0]);
}

#[test]
fn tower_occluded_is_unknown() {
    let t = tower_tracks(105, |f| if f == 60 { ABSENT } else { bx(4000, 3000, 5000, 5000) });
    let d = run(&tower_program(), &calibration(&[]), &t, &[]).unwrap();
    assert_eq!(legs_of(&d), vec![2]);
    assert_eq!(causes_of(&d), vec![Some(LegCause::Occlusion)]);
    assert_eq!((d.out.preruling, d.out.reason), (3, 10));
}

#[test]
fn tower_short_recording_is_coverage() {
    let t = tower_tracks(80, |_| bx(4000, 3000, 5000, 5000));
    let d = run(&tower_program(), &calibration(&[]), &t, &[]).unwrap();
    assert_eq!(causes_of(&d), vec![Some(LegCause::Coverage)]);
    // A gap inside [0, 100) is also COVERAGE.
    let t = TracksB::build(OK_FLAGS, vec![(0, 0xFF, 2000)], vec![(0, 50), (51, 60)], |_, _| bx(4000, 3000, 5000, 5000)).encode();
    let d = run(&tower_program(), &calibration(&[]), &t, &[]).unwrap();
    assert_eq!(causes_of(&d), vec![Some(LegCause::Coverage)]);
}

// ---------------- §15.3 push-ups ----------------
fn pushup_program() -> Vec<u8> {
    let mut p = ProgramB::rules(
        vec![(EK_PERSON, 0)],
        vec![LegB::before(1, 600, leaf(OP_REP_COUNT, 0, CMP_GE, 20)).actor()],
        90,
    );
    p.if_true = 0;
    p.else_side = 1;
    p.encode()
}

fn pushup_tracks(period: u32, n: u16) -> Vec<u8> {
    TracksB::build(OK_FLAGS, vec![(0, 0, 0)], vec![(0, n)], move |_, f| {
        let pose = if (f / period) % 2 == 0 { 0x02 } else { 0x04 };
        Rec { pose, ..person_at(5000, 9000) }
    })
    .encode()
}

#[test]
fn pushups_pass() {
    // Reps complete at 5, 15, ..., the 20th at 195.
    let d = run(&pushup_program(), &calibration(&[]), &pushup_tracks(5, 400), &[(0, 195)]).unwrap();
    assert_eq!(legs_of(&d), vec![1]);
    assert_eq!(d.out.winner_mask, 1);
    assert_eq!(cps_of(&d), vec![(0, 195)]);
    assert_eq!(d.cost, (400 + 4) * 2);
}

#[test]
fn pushups_too_slow() {
    // Period 20: the 20th rep at 20 + 40·19 = 780 > 600.
    let d = run(&pushup_program(), &calibration(&[]), &pushup_tracks(20, 900), &[]).unwrap();
    assert_eq!(legs_of(&d), vec![0]);
    assert_eq!(d.out.winner_mask, 2);
    assert_eq!(d.out.n_checkpoints, 0);
}

#[test]
fn pushups_low_identity_confidence() {
    let t = TracksB::build(OK_FLAGS, vec![(0, 0, 0)], vec![(0, 400)], |_, f| {
        let pose = if (f / 5) % 2 == 0 { 0x02 } else { 0x04 };
        Rec { pose, id_conf: if f == 195 { 59 } else { 95 }, ..person_at(5000, 9000) }
    })
    .encode();
    let d = run(&pushup_program(), &calibration(&[]), &t, &[(0, 195)]).unwrap();
    assert_eq!(causes_of(&d), vec![Some(LegCause::Identity)]);
}

// ---------------- §15.4 ai_judged ----------------
#[test]
fn ai_judged() {
    let mut p = ProgramB::rules(vec![], vec![], 120);
    p.kind = 1;
    p.cond = vec![OP_YES];
    p.stakes = vec![3_000_000, 3_000_000];
    let t = TracksB::build(OK_FLAGS, vec![], vec![], |_, _| ABSENT).encode();
    assert_eq!(t.len(), 44);
    let d = run(&p.encode(), &[], &t, &[]).unwrap();
    assert_eq!((d.out.preruling, d.out.reason, d.out.winner_mask), (3, REASON_AI_JUDGED, 0));
    assert_eq!(d.out.leg_results, [0xFF; 8]);
    // Regardless of flags.
    let t = TracksB::build(0, vec![], vec![], |_, _| ABSENT).encode();
    assert_eq!(run(&p.encode(), &[], &t, &[]).unwrap().out.reason, REASON_AI_JUDGED);
}
