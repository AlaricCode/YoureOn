//! Primitive and combinator boundary cases (§3.2–§3.6).
mod common;
use common::*;
use verdict_rules::expr::*;

const OBJ: (u8, u8) = (EK_OBJECT, 0);
const PANY: (u8, u8) = (EK_PERSON_ANY, 0);

fn two_objects() -> Vec<(u8, u8)> {
    vec![OBJ, OBJ]
}
fn tracks2() -> Vec<(u8, u8, u16)> {
    vec![(0, 0xFF, 0), (1, 0xFF, 0)]
}

#[test]
fn present_and_threshold() {
    let fr = true_frames(vec![OBJ], &[], present(0), 10, vec![(0, 0xFF, 0)], vec![(0, 6)], |_, f| match f {
        0 => Rec { conf: 29, ..at(5000, 5000, 100) },
        1 => Rec { conf: 30, ..at(5000, 5000, 100) },
        2 => ABSENT,
        _ => at(5000, 5000, 100),
    });
    assert_eq!(fr, vec![1, 3, 4, 5]);
}

#[test]
fn stale_subregion_30_vs_31_frames() {
    // Can present 0..=9, then absent. Ball sits in the can's opening the whole time.
    // The opening survives through frame 39 (39 - 9 = 30) and is undefined at 40 (31).
    let fr = true_frames(
        two_objects(),
        &[],
        leaf(OP_OVERLAPS, 0, opening(1), 0),
        10,
        tracks2(),
        vec![(0, 50)],
        |t, f| match t {
            0 => at(5000, 4000, 50),
            _ if f <= 9 => bx(4000, 4000, 6000, 8000),
            _ => ABSENT,
        },
    );
    assert_eq!(fr, (0..=39).collect::<Vec<_>>());
}

#[test]
fn stale_subregion_does_not_cross_segments() {
    let fr = true_frames(
        two_objects(),
        &[],
        leaf(OP_INSIDE, 0, interior(1), 0),
        10,
        tracks2(),
        vec![(0, 10), (10, 10)],
        |t, f| match t {
            0 => at(5000, 6000, 50),
            _ if f <= 8 => bx(4000, 4000, 6000, 8000),
            _ => ABSENT,
        },
    );
    // Segment 1 (frames 10..19) starts without a last-present box.
    assert_eq!(fr, (0..=9).collect::<Vec<_>>());
}

#[test]
fn rising_at_absolute_frame_zero_and_segment_start() {
    let prog = |c: u16| {
        ProgramB::rules(vec![OBJ], vec![LegB::count(1, CMP_EQ, c, 0, vec![], present(0))], 10).encode()
    };
    let t0 = TracksB::build(OK_FLAGS, vec![(0, 0xFF, 0)], vec![(0, 10)], |_, _| at(5000, 5000, 10)).encode();
    let d = run(&prog(1), &calibration(&[]), &t0, &[]).unwrap();
    assert_eq!(legs_of(&d), vec![1], "true at frame 0 rises");
    // A segment starting at frame 5 has no predecessor: a level true at its start does not rise.
    let t5 = TracksB::build(OK_FLAGS, vec![(0, 0xFF, 0)], vec![(5, 10)], |_, _| at(5000, 5000, 10)).encode();
    let d = run(&prog(0), &calibration(&[]), &t5, &[]).unwrap();
    assert_eq!(legs_of(&d), vec![1], "no rising at a non-zero segment start");
}

fn zone_sq() -> RegionB {
    RegionB::Zone { entity: 1, pts: vec![(4000, 4000), (6000, 4000), (6000, 6000), (4000, 6000)] }
}

#[test]
fn polygon_edges_and_vertices() {
    // inside(obj, zone) tests the anchor (center) with even-odd; left/top edges in, right/bottom out.
    let ents = vec![OBJ, (EK_ZONE, 0)];
    let pts = [(4000, 5000), (6000, 5000), (5000, 4000), (5000, 6000), (4000, 4000), (6000, 6000), (6000, 4000), (5000, 5000)];
    let fr = true_frames(ents, &[zone_sq()], leaf(OP_INSIDE, 0, 1, 0), 10, vec![(0, 0xFF, 0)], vec![(0, 8)], |_, f| {
        let (x, y) = pts[f as usize];
        at(x, y, 10)
    });
    assert_eq!(fr, vec![0, 2, 4, 7]);
}

#[test]
fn line_side_zero_is_neither_behind_nor_beyond() {
    let ents = vec![PANY, (EK_LINE, 0)];
    let line = RegionB::Line { entity: 1, a: (3000, 6000), b: (3000, 10000), behind_sign: 1 };
    let xs = [1000u16, 3000, 5000];
    let f = |_: usize, fr: u32| person_at(xs[fr as usize], 9000);
    let tr = vec![(0, 0xFF, 0)];
    let rec_noid = move |t: usize, fr: u32| Rec { id_conf: 0, ..f(t, fr) };
    let b = true_frames(ents.clone(), &[line], leaf(OP_BEHIND, 0, 1, 0), 10, tr.clone(), vec![(0, 3)], rec_noid);
    assert_eq!(b, vec![0]);
    let line = RegionB::Line { entity: 1, a: (3000, 6000), b: (3000, 10000), behind_sign: 1 };
    let y = true_frames(ents, &[line], leaf(OP_BEYOND, 0, 1, 0), 10, tr, vec![(0, 3)], rec_noid);
    assert_eq!(y, vec![2]);
}

#[test]
fn crosses_requires_nonzero_sides() {
    let ents = vec![OBJ, (EK_LINE, 0)];
    let line = || RegionB::Line { entity: 1, a: (3000, 0), b: (3000, 10000), behind_sign: 1 };
    // Through the line exactly (side 0 in the middle): no crossing.
    let xs = [2000u16, 3000, 4000, 2000, 2000];
    let fr = true_frames(ents.clone(), &[line()], leaf(OP_CROSSES, 0, 1, 0), 10, vec![(0, 0xFF, 0)], vec![(0, 5)], |_, f| {
        at(xs[f as usize], 5000, 10)
    });
    // 4000 → 2000 at frame 3 crosses.
    assert_eq!(fr, vec![3]);
    // Across a gap of 3 absent... lastSeen bridges ≤ RELEASE_GAP frames.
    let fr = true_frames(ents.clone(), &[line()], leaf(OP_CROSSES, 0, 1, 0), 10, vec![(0, 0xFF, 0)], vec![(0, 10)], |_, f| match f {
        0 => at(2000, 5000, 10),
        1 | 2 => ABSENT,
        3 => at(4000, 5000, 10), // gap 3 → crosses
        4..=7 => ABSENT,
        8 => at(2000, 5000, 10), // gap 5 → no lastSeen
        _ => at(2000, 5000, 10),
    });
    assert_eq!(fr, vec![3]);
}

#[test]
fn enters_with_one_frame_dropout_and_leaves() {
    let ents = vec![OBJ, (EK_ZONE, 0)];
    let fr = true_frames(ents.clone(), &[zone_sq()], leaf(OP_ENTERS, 0, 1, 0), 10, vec![(0, 0xFF, 0)], vec![(0, 6)], |_, f| match f {
        0 | 1 => at(3000, 5000, 10),
        2 => ABSENT,
        _ => at(5000, 5000, 10),
    });
    assert_eq!(fr, vec![3]);
    let fr = true_frames(ents, &[zone_sq()], leaf(OP_LEAVES, 0, 1, 0), 10, vec![(0, 0xFF, 0)], vec![(0, 6)], |_, f| match f {
        0 | 1 => at(5000, 5000, 10),
        2 => ABSENT,
        _ => at(3000, 5000, 10),
    });
    assert_eq!(fr, vec![3]);
}

#[test]
fn enters_object_requires_b_defined_at_both_frames() {
    let fr = true_frames(two_objects(), &[], leaf(OP_ENTERS, 0, 1, 0), 10, tracks2(), vec![(0, 6)], |t, f| match (t, f) {
        (0, 0..=1) => at(1000, 1000, 10),
        (0, _) => at(5000, 5000, 10),
        (1, 1) => ABSENT, // container absent at lastSeen of frame 2
        (1, _) => bx(4000, 4000, 6000, 6000),
        _ => unreachable!(),
    });
    assert_eq!(fr, Vec::<u32>::new());
}

#[test]
fn inside_object_half_area_rule() {
    // a box 200×200; b box covers exactly half (x from center) → 2·inter ≥ area → inside.
    let fr = true_frames(two_objects(), &[], leaf(OP_INSIDE, 0, 1, 0), 10, tracks2(), vec![(0, 2)], |t, f| match (t, f) {
        (0, _) => bx(4900, 4900, 5100, 5100),
        (1, 0) => bx(5000, 4000, 6000, 6000),
        (1, _) => bx(5001, 4000, 6000, 6000),
        _ => unreachable!(),
    });
    // Frame 1: center (5000,5000) not in [5001..] → false.
    assert_eq!(fr, vec![0]);
}

#[test]
fn overlaps_touches_above_below_near() {
    let a_boxes = [bx(1000, 1000, 2000, 2000), bx(2000, 1000, 3000, 2000), bx(2500, 1000, 3500, 2000), bx(1000, 1000, 2000, 2000)];
    let b_box = bx(3000, 1500, 4000, 2500);
    let f = move |t: usize, fr: u32| if t == 0 { a_boxes[fr as usize] } else { b_box };
    // Overlap needs a non-empty intersection: touching edges (x1 == x0) is not an overlap.
    assert_eq!(true_frames(two_objects(), &[], leaf(OP_OVERLAPS, 0, 1, 0), 10, tracks2(), vec![(0, 4)], f), vec![2]);
    assert_eq!(true_frames(two_objects(), &[], leaf(OP_TOUCHES, 0, 1, 0), 10, tracks2(), vec![(0, 4)], f), vec![2]);
    // near with d = 1000: gap at frame 0 is 1000 → near; frames 1, 2 gap 0.
    assert_eq!(true_frames(two_objects(), &[], leaf(OP_NEAR, 0, 1, 1000), 10, tracks2(), vec![(0, 4)], f), vec![0, 1, 2, 3]);
    assert_eq!(true_frames(two_objects(), &[], leaf(OP_NEAR, 0, 1, 999), 10, tracks2(), vec![(0, 4)], f), vec![1, 2]);
    // above: cy(a)=1500 < b.y0=1500 false; x-ranges must overlap strictly.
    let g = move |t: usize, fr: u32| {
        if t == 0 {
            [bx(3000, 1000, 3200, 1998), bx(2000, 0, 3000, 1000), bx(4000, 0, 4100, 1000)][fr as usize]
        } else {
            b_box
        }
    };
    assert_eq!(true_frames(two_objects(), &[], leaf(OP_ABOVE, 0, 1, 0), 10, tracks2(), vec![(0, 3)], g), vec![0]);
    let h = move |t: usize, fr: u32| {
        if t == 0 {
            [bx(3000, 5000, 3200, 6000), bx(3000, 2400, 3200, 2600)][fr as usize]
        } else {
            b_box
        }
    };
    assert_eq!(true_frames(two_objects(), &[], leaf(OP_BELOW, 0, 1, 0), 10, tracks2(), vec![(0, 2)], h), vec![0]);
}

#[test]
fn overlaps_zone_uses_center_or_anchor() {
    let ents = vec![PANY, (EK_ZONE, 0)];
    // Person box 3000..3600 × 2000..4000: center (3300, 3000) outside; feet (3300, 4000) on top edge → inside.
    let fr = true_frames(ents, &[RegionB::Zone { entity: 1, pts: vec![(3000, 4000), (4000, 4000), (4000, 5000), (3000, 5000)] }],
        leaf(OP_OVERLAPS, 0, 1, 0), 10, vec![(0, 0xFF, 0)], vec![(0, 2)], |_, f| {
        if f == 0 { bx(3000, 2000, 3600, 4000) } else { bx(3000, 2000, 3600, 3999) }
    });
    assert_eq!(fr, vec![0]);
}

#[test]
fn velocity_moving_speed_direction() {
    // dx = 60 per frame → over VEL_K=2: dx=120 → speed = 120·10/2 = 600 ups.
    let f = |_: usize, fr: u32| at(1000 + 60 * fr as u16, 5000, 10);
    let one = vec![(0, 0xFF, 0)];
    assert_eq!(true_frames(vec![OBJ], &[], leaf(OP_MOVING, 0, 0, 0), 10, one.clone(), vec![(0, 5)], f), vec![2, 3, 4]);
    assert_eq!(true_frames(vec![OBJ], &[], leaf(OP_SPEED, 0, CMP_EQ, 600), 10, one.clone(), vec![(0, 5)], f), vec![2, 3, 4]);
    assert_eq!(true_frames(vec![OBJ], &[], leaf(OP_SPEED, 0, CMP_GT, 600), 10, one.clone(), vec![(0, 5)], f), Vec::<u32>::new());
    assert_eq!(true_frames(vec![OBJ], &[], leaf(OP_DIRECTION, 0, 3, 0), 10, one.clone(), vec![(0, 5)], f), vec![2, 3, 4]);
    assert_eq!(true_frames(vec![OBJ], &[], leaf(OP_DIRECTION, 0, 2, 0), 10, one.clone(), vec![(0, 5)], f), Vec::<u32>::new());
    // Velocity does not look across segments.
    assert_eq!(true_frames(vec![OBJ], &[], leaf(OP_MOVING, 0, 0, 0), 10, one.clone(), vec![(0, 3), (3, 2)], f), vec![2]);
    // up: dy < 0 and 2|dy| ≥ |dx|: dx=2a, dy=-a qualifies.
    let g = |_: usize, fr: u32| at(1000 + 40 * fr as u16, 6000 - 20 * fr as u16, 10);
    // dx=80, dy=-40 → speed = isqrt(8000)=89·5=445 ≥ 300.
    assert_eq!(true_frames(vec![OBJ], &[], leaf(OP_DIRECTION, 0, 0, 0), 10, one.clone(), vec![(0, 3)], g), vec![2]);
    assert_eq!(true_frames(vec![OBJ], &[], leaf(OP_DIRECTION, 0, 3, 0), 10, one, vec![(0, 3)], g), vec![2]);
}

#[test]
fn still_at_1px_and_5px_jitter() {
    // 1 px ≈ 5 units at 1920 wide; 5 px ≈ 26 units. Both are well under STILL_MAX_UPS.
    for jitter in [5u16, 26] {
        let fr = true_frames(vec![OBJ], &[], leaf(OP_AT_REST, 0, 0, 10), 10, vec![(0, 0xFF, 0)], vec![(0, 20)], move |_, f| {
            at(5000 + if f % 2 == 0 { 0 } else { jitter }, 5000 + if f % 3 == 0 { jitter } else { 0 }, 100)
        });
        // still from frame 2 (vel needs f-2), run of 10 → first at 11.
        assert_eq!(fr, (11..20).collect::<Vec<_>>(), "jitter {jitter}");
    }
    // 51 units per frame-pair·... speed = 51·5 = 255 > 250 → not still.
    let fr = true_frames(vec![OBJ], &[], leaf(OP_AT_REST, 0, 0, 1), 10, vec![(0, 0xFF, 0)], vec![(0, 6)], |_, f| {
        at(5000 + if (f / 2) % 2 == 0 { 0 } else { 51 }, 5000, 100)
    });
    assert_eq!(fr, Vec::<u32>::new());
}

#[test]
fn released_by_bridges_occluded_hold() {
    let ents = vec![OBJ, PANY];
    let hand = bx(1000, 1000, 2000, 3000);
    let run_case = |ball: [Option<(u16, u16)>; 8]| {
        true_frames(ents.clone(), &[], leaf(OP_RELEASED_BY, 0, 1, 0), 10, tracks2(), vec![(0, 8)], move |t, f| {
            if t == 1 {
                hand
            } else {
                match ball[f as usize] {
                    Some((x, y)) => at(x, y, 10),
                    None => ABSENT,
                }
            }
        })
    };
    let held = Some((1500, 2000));
    let away = Some((5000, 2000));
    // held, absent (occluded), held, released → heldrun bridges the gap → release at 3.
    assert_eq!(run_case([held, None, held, away, away, away, away, away]), vec![3]);
    // Only one held frame before release → no release.
    assert_eq!(run_case([away, away, held, away, away, away, away, away]), Vec::<u32>::new());
    // Gap of 4 frames between held samples breaks the run.
    assert_eq!(run_case([held, None, None, None, held, away, away, away]), Vec::<u32>::new());
    // Release after a gap ≤ RELEASE_GAP.
    assert_eq!(run_case([held, held, None, None, away, away, away, away]), vec![4]);
}

#[test]
fn rep_count_scans_across_segments() {
    let poses = [2u8, 4, 0, 2, 4];
    let fr = true_frames(vec![PANY], &[], leaf(OP_REP_COUNT, 0, CMP_GE, 2), 10, vec![(0, 0xFF, 0)], vec![(0, 2), (10, 3)], |_, f| {
        let i = if f < 10 { f as usize } else { (f - 8) as usize };
        Rec { pose: poses[i], ..bx(1000, 1000, 2000, 3000) }
    });
    assert_eq!(fr, vec![12]);
}

#[test]
fn disappears_into_lookahead_at_segment_end() {
    let ents = two_objects();
    // Can at fixed box, opening = (4200, 3600, 5800, 4800).
    let can = bx(4000, 4000, 6000, 8000);
    let mk = |entry: u32, n: u16| {
        true_frames(ents.clone(), &[], leaf(OP_DISAPPEARS_INTO, 0, opening(1), 0), 10, tracks2(), vec![(0, n)], move |t, f| {
            if t == 1 {
                return can;
            }
            if f + 1 == entry {
                at(5000, 3000, 50)
            } else if f == entry {
                at(5000, 4200, 50)
            } else if f > entry {
                ABSENT
            } else {
                at(5000, 2000, 50)
            }
        })
    };
    assert_eq!(mk(9, 20), vec![9], "f + 10 = 19 is the last frame of the segment");
    assert_eq!(mk(10, 20), Vec::<u32>::new(), "f + 10 = 20 is outside the segment");
}

#[test]
fn disappears_into_requires_staying_inside_and_descending() {
    let can = bx(4000, 4000, 6000, 8000);
    let ents = two_objects();
    let mk = |after: Rec, prev_y: u16| {
        true_frames(ents.clone(), &[], leaf(OP_DISAPPEARS_INTO, 0, opening(1), 0), 10, tracks2(), vec![(0, 30)], move |t, f| {
            if t == 1 {
                return can;
            }
            match f {
                0..=3 => at(5000, prev_y, 50),
                4 => at(5000, 4200, 50),
                5 => after,
                _ => ABSENT,
            }
        })
    };
    assert_eq!(mk(at(5000, 5000, 50), 3000), vec![4]); // inside container then absent
    assert_eq!(mk(at(9000, 5000, 50), 3000), Vec::<u32>::new()); // seen outside the container
    assert_eq!(mk(at(5000, 5000, 50), 4200), Vec::<u32>::new()); // not descending
}

#[test]
fn disappears_into_zone_and_container_stale() {
    // Container goes stale-undefined: the ball must be absent then.
    let ents = vec![OBJ, (EK_ZONE, 0)];
    let fr = true_frames(ents, &[zone_sq()], leaf(OP_DISAPPEARS_INTO, 0, 1, 0), 10, vec![(0, 0xFF, 0)], vec![(0, 20)], |_, f| match f {
        0..=2 => at(5000, 3000, 10),
        3 => at(5000, 4500, 10),
        4 => at(5000, 5500, 10),
        _ => ABSENT,
    });
    // Frame 3 is the first raw frame; frame 4 is raw too but not a rising edge.
    assert_eq!(fr, vec![3]);
}

#[test]
fn then_within_and_for_duration_respect_segments() {
    let one = vec![(0, 0xFF, 0)];
    // X = present at frames 0..=1 (seg 0) ; Y = always-present object 0? use same entity: then_within(3, X, Y)
    let x_then_y = then_within(3, leaf(OP_SPEED, 0, CMP_GE, 0), present(0));
    // speed defined from frame 2 of each segment.
    let fr = true_frames(vec![OBJ], &[], x_then_y, 10, one.clone(), vec![(0, 4), (4, 4)], |_, _| at(5000, 5000, 10));
    assert_eq!(fr, vec![2, 3, 6, 7]);
    let fd = for_duration(3, present(0));
    let fr = true_frames(vec![OBJ], &[], fd, 10, one.clone(), vec![(0, 4), (4, 4)], |_, _| at(5000, 5000, 10));
    assert_eq!(fr, vec![2, 3, 6, 7]);
    // then_within window: X at 0 only, Y everywhere; D = 3 → frames 0..=3.
    let tw = then_within(3, not(leaf(OP_SPEED, 0, CMP_GE, 0)), present(0));
    let fr = true_frames(vec![OBJ], &[], tw, 10, one.clone(), vec![(0, 10)], |_, _| at(5000, 5000, 10));
    assert_eq!(fr, (0..=4).collect::<Vec<_>>()); // X true at 0,1 → last X = 1 → up to 4
    let b = before(5, present(0));
    let fr = true_frames(vec![OBJ], &[], b, 10, one, vec![(3, 5)], |_, _| at(5000, 5000, 10));
    assert_eq!(fr, vec![3, 4]);
}

#[test]
fn tail_frames_lookahead_only() {
    // LIMIT = 10 frames (1 s); buffer has frames 0..30 (tail 20).
    let can = bx(4000, 4000, 6000, 8000);
    let mk = |entry: u32| {
        let p = ProgramB::rules(two_objects(), vec![LegB::exists(1, leaf(OP_DISAPPEARS_INTO, 0, opening(1), 0))], 1).encode();
        let t = TracksB::build(OK_FLAGS, tracks2(), vec![(0, 30)], move |tr, f| {
            if tr == 1 {
                can
            } else if f < entry {
                at(5000, 3000, 50)
            } else if f == entry {
                at(5000, 4200, 50)
            } else {
                ABSENT
            }
        })
        .encode();
        legs_of(&run(&p, &calibration(&[]), &t, &[]).unwrap())
    };
    assert_eq!(mk(9), vec![1], "event at LIMIT-1 uses tail frames for look-ahead");
    assert_eq!(mk(10), vec![0], "event at LIMIT is not counted");
}

#[test]
fn count_attempt_window_overlap_and_level_success() {
    // V pulses at given frames via present(0) rising (object 0 blinks), S = present(1) level.
    let run_case = |v_frames: Vec<u32>, s_from: u32, n: u32, k: u16| {
        let va = present(0);
        let succ = present(1);
        let p = ProgramB::rules(two_objects(), vec![LegB::count(1, CMP_GE, k, n, va, succ)], 10).encode();
        let t = TracksB::build(OK_FLAGS, tracks2(), vec![(0, 100)], move |tr, f| {
            if tr == 0 {
                if v_frames.contains(&f) { at(1000, 1000, 10) } else { ABSENT }
            } else if f >= s_from {
                at(5000, 5000, 10)
            } else {
                ABSENT
            }
        })
        .encode();
        legs_of(&run(&p, &calibration(&[]), &t, &[]).unwrap())
    };
    // Attempts at 10 and 15; success rises at 20: window of a1 ends at 15 → only a2 counts.
    assert_eq!(run_case(vec![10, 15], 20, 3, 1), vec![1]);
    assert_eq!(run_case(vec![10, 15], 20, 3, 2), vec![0]);
    // Level success true from 12 onward rises only once.
    assert_eq!(run_case(vec![10, 30], 12, 3, 1), vec![1]);
    assert_eq!(run_case(vec![10, 30], 12, 3, 2), vec![0]);
    // Window W = 50: success at 61 is outside a1=10's window [10, 60).
    assert_eq!(run_case(vec![10], 60, 3, 1), vec![0]);
    assert_eq!(run_case(vec![10], 59, 3, 1), vec![1]);
    // Only the first N attempts count.
    assert_eq!(run_case(vec![10, 20, 30], 32, 2, 1), vec![0]);
    assert_eq!(run_case(vec![10, 20, 30], 32, 3, 1), vec![1]);
}

#[test]
fn rules_exists_never_before() {
    let one = vec![(0, 0xFF, 0)];
    let mk = |leg: LegB, from: u32| {
        let p = ProgramB::rules(vec![OBJ], vec![leg], 10).encode();
        let t = TracksB::build(OK_FLAGS, one.clone(), vec![(0, 100)], move |_, f| if f >= from { at(5000, 5000, 10) } else { ABSENT }).encode();
        legs_of(&run(&p, &calibration(&[]), &t, &[]).unwrap())
    };
    assert_eq!(mk(LegB::exists(1, present(0)), 50), vec![1]);
    assert_eq!(mk(LegB::exists(1, present(0)), 100), vec![0]); // frames ≥ LIMIT ignored
    assert_eq!(mk(LegB::never(1, present(0)), 99), vec![0]);
    assert_eq!(mk(LegB::never(1, present(0)), 100), vec![1]);
    assert_eq!(mk(LegB::before(1, 30, present(0)), 29), vec![1]);
    assert_eq!(mk(LegB::before(1, 30, present(0)), 30), vec![0]);
}

#[test]
fn cost_cap_exceeded() {
    // weight: and(1) + present(2) + present(2) = 5 per frame.
    let succ = and(present(0), present(0));
    let p = ProgramB::rules(vec![OBJ], vec![LegB::exists(1, succ)], 3600).encode();
    // 1000 frames × 5 = 5000: under the default cap; with max_cost 4999 it's over.
    let t = TracksB::build(OK_FLAGS, vec![(0, 0xFF, 0)], vec![(0, 1000)], |_, _| at(5000, 5000, 10)).encode();
    let ok = verdict_rules::evaluate_detailed::<W>(&p, &calibration(&[]), &t, &[], Some(5000)).unwrap();
    assert_eq!((ok.out.preruling, ok.cost), (1, 5000));
    let over = verdict_rules::evaluate_detailed::<W>(&p, &calibration(&[]), &t, &[], Some(4999)).unwrap();
    assert_eq!((over.out.preruling, over.out.reason), (3, 13));
    assert_eq!(legs_of(&over), vec![2]);
    assert_eq!(causes_of(&over), vec![None]);
    // Unlimited (SP1).
    let inf = verdict_rules::evaluate_detailed::<W>(&p, &calibration(&[]), &t, &[], None).unwrap();
    assert_eq!(inf.out.preruling, 1);
}

#[test]
fn cost_cap_with_default_max() {
    // Paper-ball weight 25 → 656 frames exceed MAX_EVAL_COST (16400 > 16384).
    let va = and(leaf(OP_RELEASED_BY, 1, 0, 0), leaf(OP_BEHIND, 0, 3, 0));
    let succ = or(leaf(OP_DISAPPEARS_INTO, 1, opening(2), 0), and(leaf(OP_INSIDE, 1, 2, 0), leaf(OP_AT_REST, 1, 0, 10)));
    let p = ProgramB::rules(
        vec![(EK_PERSON, 1), OBJ, OBJ, (EK_LINE, 0)],
        vec![LegB::count(1, CMP_GE, 1, 3, va, succ).actor()],
        180,
    )
    .encode();
    let c = calibration(&[RegionB::Line { entity: 3, a: (3000, 6000), b: (3000, 10000), behind_sign: 1 }]);
    for (n, panel) in [(655u16, false), (656u16, true)] {
        let t = TracksB::build(OK_FLAGS, vec![(0, 1, 0), (1, 0xFF, 0), (2, 0xFF, 0)], vec![(0, n)], |t, _| match t {
            0 => person_at(1000, 9000),
            _ => at(5000, 5000, 10),
        })
        .encode();
        let d = run(&p, &c, &t, &[]).unwrap();
        assert_eq!(d.out.reason == 13, panel, "n={n}");
        assert_eq!(d.cost, n as u64 * 25);
    }
}

#[test]
fn checkpoint_overflow_more_than_8() {
    // 3 persons, count(success) > 2 without attempts: k' = 3 anchors × 3 persons = 9 > 8.
    let succ = and(and(present(0), present(1)), present(2));
    let mk = |cmp: u8, k: u16| {
        let mut p = ProgramB::rules(
            vec![(EK_PERSON, 0), (EK_PERSON, 1), (EK_PERSON, 2)],
            vec![LegB::count(1, cmp, k, 0, vec![], succ.clone()).actor()],
            10,
        );
        p.p = 3;
        p.stakes = vec![5_000_000; 3];
        p.side_b_mask = 0b110;
        p.encode()
    };
    // Everyone blinks: present on even frames → rising at 0, 2, 4, ...
    let t = TracksB::build(OK_FLAGS, vec![(0, 0, 0), (1, 1, 0), (2, 2, 0)], vec![(0, 20)], |_, f| {
        if f % 2 == 0 { person_at(5000, 9000) } else { ABSENT }
    })
    .encode();
    let all: Vec<(u8, u32)> = (0..3).flat_map(|p| (0..20).map(move |f| (p, f))).collect();
    let d = run(&mk(CMP_GT, 2), &calibration(&[]), &t, &all).unwrap();
    assert_eq!(d.out.n_checkpoints, 0);
    assert_eq!(cps_of(&d), vec![]);
    assert_eq!(causes_of(&d), vec![Some(LegCause::Identity)]);
    // k' = 2 → 6 checkpoints, sorted by (frame, participant).
    let d = run(&mk(CMP_GE, 2), &calibration(&[]), &t, &all).unwrap();
    assert_eq!(cps_of(&d), vec![(0, 0), (1, 0), (2, 0), (0, 2), (1, 2), (2, 2)]);
    assert_eq!(legs_of(&d), vec![1]);
    assert_eq!(d.out.winner_mask, 0b110);
}

use verdict_rules::eval::LegCause;

#[test]
fn checkpoint_persons_prefer_valid_attempt() {
    // persons(leg) = persons in valid_attempt (p1) even if success references p0.
    let va = present(1);
    let succ = present(0);
    let p = ProgramB::rules(vec![(EK_PERSON, 0), (EK_PERSON, 1)], vec![LegB::count(1, CMP_GE, 1, 2, va, succ).actor()], 10).encode();
    let t = TracksB::build(OK_FLAGS, vec![(0, 0, 0), (1, 1, 0)], vec![(0, 20)], |tr, f| {
        if tr == 1 && f >= 5 { person_at(5000, 9000) } else if tr == 0 && f >= 7 { person_at(2000, 9000) } else { ABSENT }
    })
    .encode();
    let d = run(&p, &calibration(&[]), &t, &[(1, 5)]).unwrap();
    assert_eq!(cps_of(&d), vec![(1, 5)]);
    assert_eq!(legs_of(&d), vec![1]);
}
