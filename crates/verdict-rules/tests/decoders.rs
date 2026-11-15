//! Decoder rejections (§5.1, §5.3, §5.4, §5.5): every listed case maps to its §9.6 error.
mod common;
use common::*;
use verdict_rules::expr::*;
use verdict_rules::DecodeError::{self, *};

fn base_program() -> ProgramB {
    // shooter(p1), ball, can, line; paper-ball-like leg.
    let va = and(leaf(OP_RELEASED_BY, 1, 0, 0), leaf(OP_BEHIND, 0, 3, 0));
    let succ = leaf(OP_DISAPPEARS_INTO, 1, opening(2), 0);
    ProgramB::rules(
        vec![(EK_PERSON, 1), (EK_OBJECT, 0), (EK_OBJECT, 0), (EK_LINE, 0)],
        vec![LegB::count(1, CMP_GE, 1, 3, va, succ).actor()],
        180,
    )
}
fn base_cal() -> Vec<u8> {
    calibration(&[RegionB::Line { entity: 3, a: (3000, 6000), b: (3000, 10000), behind_sign: 1 }])
}
fn base_tracks() -> TracksB {
    TracksB::build(OK_FLAGS, vec![(0, 1, 0), (1, 0xFF, 0), (2, 0xFF, 0)], vec![(0, 10)], |t, _| match t {
        0 => person_at(1000, 9000),
        _ => at(5000, 5000, 10),
    })
}

fn check(p: &[u8], c: &[u8], t: &[u8]) -> Result<(), DecodeError> {
    run(p, c, t, &[]).map(|_| ())
}
fn prog_err(p: ProgramB) {
    assert_eq!(check(&p.encode(), &base_cal(), &base_tracks().encode()), Err(MalformedProgram));
}
fn prog_ok(p: ProgramB) {
    let enc = p.encode();
    assert!(verdict_rules::decode_program(&enc).is_ok(), "expected program to decode");
}

#[test]
fn baseline_decodes() {
    assert_eq!(check(&base_program().encode(), &base_cal(), &base_tracks().encode()), Ok(()));
}

#[test]
fn program_header_rejections() {
    let good = base_program().encode();
    let mutate = |off: usize, v: u8| {
        let mut b = good.clone();
        b[off] = v;
        verdict_rules::decode_program(&b).err()
    };
    assert_eq!(mutate(0, b'X'), Some(MalformedProgram)); // magic
    assert_eq!(mutate(4, 1), Some(MalformedProgram)); // version
    assert_eq!(mutate(5, 3), Some(MalformedProgram)); // kind
    assert_eq!(mutate(6, 30), Some(MalformedProgram)); // fps
    assert_eq!(mutate(7, 1), Some(MalformedProgram)); // P < 2
    // trailing bytes / truncation
    let mut t = good.clone();
    t.push(0);
    assert_eq!(verdict_rules::decode_program(&t).err(), Some(MalformedProgram));
    assert_eq!(verdict_rules::decode_program(&good[..good.len() - 1]).err(), Some(MalformedProgram));
    assert_eq!(verdict_rules::decode_program(&[]).err(), Some(MalformedProgram));
}

#[test]
fn program_field_rejections() {
    let mut p = base_program();
    p.time_limit_s = 0;
    prog_err(p);
    let mut p = base_program();
    p.time_limit_s = 3601;
    prog_err(p);
    let mut p = base_program();
    p.stakes = vec![9_999, 9_999];
    prog_err(p);
    let mut p = base_program();
    p.stakes = vec![1_000_000_000_001, 1_000_000_000_001];
    prog_err(p);
    let mut p = base_program();
    p.stakes = vec![5_000_000, 6_000_000]; // rules: all equal
    prog_err(p);
    for mask in [0b01u8, 0b00, 0b110, 0b11] {
        let mut p = base_program();
        p.side_b_mask = mask;
        prog_err(p);
    }
    let mut p = base_program();
    p.if_true = 0; // == else
    prog_err(p);
    let mut p = base_program();
    p.if_true = 2;
    prog_err(p);
}

#[test]
fn entity_rejections() {
    let mut p = base_program();
    p.entities[0] = (EK_PERSON, 2); // participant ≥ P
    prog_err(p);
    let mut p = base_program();
    p.entities[1] = (EK_OBJECT, 1); // param on non-person
    prog_err(p);
    let mut p = base_program();
    p.entities[1] = (5, 0); // unknown kind
    prog_err(p);
    let mut p = base_program();
    p.entities.push((EK_PERSON, 1)); // duplicate person participant
    prog_err(p);
    let mut p = base_program();
    p.entities = (0..17).map(|_| (EK_OBJECT, 0)).collect();
    prog_err(p);
}

#[test]
fn leg_rejections() {
    let mut p = base_program();
    p.legs[0].id = 0;
    prog_err(p);
    let mut p = base_program();
    p.legs.push(p.legs[0].clone()); // duplicate id
    prog_err(p);
    let mut p = base_program();
    p.legs[0].flags_override = Some(0b101); // reserved flag bit
    prog_err(p);
    let mut p = base_program();
    p.legs[0].actor_bound = false; // ACTOR_BOUND_MISMATCH
    prog_err(p);
    let mut p = base_program();
    p.legs[0].rule_n = 9; // actor-bound attempts > 8
    prog_err(p);
    let mut p = base_program();
    p.legs[0].rule_n = 0; // valid_attempt without attempts
    prog_err(p);
    let mut p = base_program();
    p.legs[0].rule_cmp = CMP_LT; // negative actor rule
    prog_err(p);
    let mut p = base_program();
    p.legs[0].rule_k = 0; // count >= 0 actor-bound
    prog_err(p);
    let mut p = base_program();
    p.legs[0].rule_cmp = 6;
    prog_err(p);
    let mut p = base_program();
    p.legs[0].attempt_window = 0;
    prog_err(p);
    let mut p = base_program();
    p.legs[0].rule_kind = 5; // market leg in rules program
    prog_err(p);
    let mut p = base_program();
    p.legs = vec![];
    p.cond = vec![];
    prog_err(p);
    // never actor-bound
    let mut p = base_program();
    p.legs[0] = LegB::never(1, present(0)).actor();
    prog_err(p);
    // holds with frames > LIMIT, or 0
    let mut p = base_program();
    p.legs[0] = LegB::holds(1, 1801, present(1));
    prog_err(p);
    let mut p = base_program();
    p.legs[0] = LegB::holds(1, 0, present(1));
    prog_err(p);
    let mut p = base_program();
    p.legs[0] = LegB::holds(1, 1800, present(1));
    prog_ok(p);
    // exists with unused fields non-zero
    let mut p = base_program();
    p.legs[0] = LegB { rule_k: 1, ..LegB::exists(1, present(1)) };
    prog_err(p);
    // non-actor count: attempts up to 20, k up to 1000
    let mut p = base_program();
    p.legs[0] = LegB::count(1, CMP_LE, 1000, 20, present(1), present(2));
    prog_ok(p);
    let mut p = base_program();
    p.legs[0] = LegB::count(1, CMP_LE, 1001, 20, present(1), present(2));
    prog_err(p);
    let mut p = base_program();
    p.legs[0] = LegB::count(1, CMP_LE, 1, 21, present(1), present(2));
    prog_err(p);
}

#[test]
fn expression_rejections() {
    let with_succ = |succ: Vec<u8>| {
        let mut p = base_program();
        p.legs[0] = LegB::exists(1, succ);
        p
    };
    prog_ok(with_succ(present(1)));
    prog_err(with_succ(vec![])); // empty success
    prog_err(with_succ(vec![0x07])); // unknown code
    prog_err(with_succ(leaf(0x17, 1, 2, 0))); // unknown leaf code
    prog_err(with_succ(vec![OP_LEG, 1])); // condition code in leg expr
    prog_err(with_succ(present(4))); // ref ≥ E
    prog_err(with_succ(present(0x41))); // ref bits 6–7
    prog_err(with_succ(leaf(OP_PRESENT, opening(1), 0, 0))); // sub-region on a
    prog_err(with_succ(leaf(OP_OVERLAPS, 1, opening(0), 0))); // sub-region on a person
    prog_err(with_succ(leaf(OP_OVERLAPS, 1, 2 | (3 << 4), 0))); // sub-region code 3
    prog_err(with_succ(leaf(OP_PRESENT, 3, 0, 0))); // a = region
    prog_err(with_succ(leaf(OP_OVERLAPS, 1, 3, 0))); // line in a non-line primitive
    prog_err(with_succ(leaf(OP_CROSSES, 1, 2, 0))); // crosses needs a line
    prog_err(with_succ(leaf(OP_ENTERS, 1, 0, 0))); // enters into a person
    prog_ok(with_succ(leaf(OP_ENTERS, 1, interior(2), 0)));
    prog_err(with_succ(leaf(OP_DISAPPEARS_INTO, 1, 2, 0))); // plain object
    prog_err(with_succ(leaf(OP_DISAPPEARS_INTO, 1, interior(2), 0)));
    prog_err(with_succ(leaf(OP_RELEASED_BY, 1, 2, 0))); // released_by an object
    prog_err(with_succ(leaf(OP_STANDING, 1, 0, 0))); // standing on an object
    prog_err(with_succ(leaf(OP_REP_COUNT, 1, 0, 5)));
    prog_err(with_succ(leaf(OP_NEAR, 1, 2, 14144)));
    prog_ok(with_succ(leaf(OP_NEAR, 1, 2, 14143)));
    prog_err(with_succ(leaf(OP_NEAR, 1, 2, -1)));
    prog_err(with_succ(leaf(OP_AT_REST, 1, 0, 0)));
    prog_err(with_succ(leaf(OP_AT_REST, 1, 0, 36001)));
    prog_err(with_succ(leaf(OP_SPEED, 1, 6, 10)));
    prog_err(with_succ(leaf(OP_SPEED, 1, 0, 100001)));
    prog_err(with_succ(leaf(OP_DIRECTION, 1, 4, 0)));
    prog_err(with_succ(leaf(OP_MOVING, 1, 0, 1))); // unused p non-zero
    prog_err(with_succ(leaf(OP_MOVING, 1, 1, 0))); // unused b non-zero
    prog_err(with_succ(leaf(OP_OVERLAPS, 1, 2, 7))); // p must be 0
    prog_err(with_succ(for_duration(0, present(1))));
    prog_err(with_succ(then_within(36001, present(1), present(2))));
    prog_err(with_succ(before(0, present(1))));
    prog_err(with_succ([present(1), vec![0]].concat())); // trailing byte
    // Depth: 11 nots + leaf = depth 12 ok; 12 nots = 13 rejected.
    let nest = |n: usize| (0..n).fold(present(1), |e, _| not(e));
    prog_ok(with_succ(nest(11)));
    prog_err(with_succ(nest(12)));
    // Nodes: 64 ok, 65 rejected (and-chain of leaves: 2m-1 nodes).
    fn chain(m: usize) -> Vec<u8> {
        // Balanced and-tree of m leaves: 2m-1 nodes, depth ⌈log2 m⌉ + 1.
        if m == 1 {
            present(1)
        } else {
            and(chain(m / 2), chain(m - m / 2))
        }
    }
    // 32 leaves → 63 nodes; add a not → 64.
    prog_ok(with_succ(not(chain(32))));
    prog_err(with_succ(chain(33)));
    // > 512 bytes (also > 64 nodes and too deep): rejected. With ≤ 64 nodes and depth ≤ 12 the
    // byte cap cannot be reached (≤ 32 leaves × 7 + 32 × 5), so it is only a guard.
    let wide = |m: usize| {
        let mut v = vec![];
        for _ in 1..m {
            v.push(OP_AND);
        }
        for _ in 0..m {
            v.extend(present(1));
        }
        v
    };
    prog_err(with_succ(wide(73)));
}

#[test]
fn condition_rejections() {
    let mut p = base_program();
    p.cond = cond_leg(2); // missing leg
    prog_err(p);
    let mut p = base_program();
    p.cond = vec![OP_YES];
    prog_err(p);
    let mut p = base_program();
    p.cond = present(1); // leaf in condition
    prog_err(p);
    let mut p = base_program();
    p.cond = (0..32).fold(cond_leg(1), |e, _| [vec![OP_NOT], e].concat()); // depth 33
    prog_err(p);
    let mut p = base_program();
    // 32 nodes ok: 16 legs refs and 15 ors = 31 + not = 32 (depth ≤ 12 via balanced tree).
    let leaf8 = || or(or(or(cond_leg(1), cond_leg(1)), or(cond_leg(1), cond_leg(1))), or(or(cond_leg(1), cond_leg(1)), or(cond_leg(1), cond_leg(1))));
    p.cond = not(or(leaf8(), leaf8()));
    prog_ok(p.clone());
    p.cond = not(not(or(leaf8(), leaf8())));
    prog_err(p);
}

#[test]
fn ai_judged_and_market_programs() {
    let mut ai = ProgramB::rules(vec![], vec![], 120);
    ai.kind = 1;
    ai.cond = vec![OP_YES];
    prog_ok(ai.clone());
    let mut bad = ai.clone();
    bad.cond = vec![OP_NOT, OP_YES];
    prog_err(bad);
    let mut bad = ai.clone();
    bad.legs = vec![LegB::exists(1, present(0))];
    bad.entities = vec![(EK_OBJECT, 0)];
    prog_err(bad);

    let mut m = ProgramB::rules(vec![], vec![LegB::market(1, [7; 32], true)], 2_592_000);
    m.kind = 2;
    m.stakes = vec![7_000_000, 3_000_000];
    prog_ok(m.clone());
    let mut bad = m.clone();
    bad.time_limit_s = 2_592_001;
    prog_err(bad);
    let mut bad = m.clone();
    bad.legs[0].rule_k = 2;
    prog_err(bad);
    let mut bad = m.clone();
    bad.legs[0].attempt_window = 50;
    prog_err(bad);
    let mut bad = m.clone();
    bad.legs[0].succ = vec![7; 31];
    prog_err(bad);
    let mut bad = m.clone();
    bad.legs[0].rule_kind = 0;
    prog_err(bad);
}

#[test]
fn calibration_rejections() {
    let p = base_program().encode();
    let t = base_tracks().encode();
    let cal_err = |c: Vec<u8>| assert_eq!(check(&p, &c, &t), Err(MalformedCalibration));
    cal_err(vec![]); // rules need a calibration
    cal_err(calibration(&[])); // missing region
    cal_err(calibration(&[RegionB::Line { entity: 2, a: (0, 0), b: (1, 1), behind_sign: 1 }])); // non-region entity
    cal_err(calibration(&[RegionB::Zone { entity: 3, pts: vec![(0, 0), (1, 0), (1, 1)] }])); // shape mismatch
    cal_err(calibration(&[RegionB::Line { entity: 3, a: (5, 5), b: (5, 5), behind_sign: 1 }])); // degenerate
    cal_err(calibration(&[RegionB::Line { entity: 3, a: (0, 0), b: (10001, 5), behind_sign: 1 }])); // coord
    cal_err(calibration(&[RegionB::Line { entity: 3, a: (0, 0), b: (1, 5), behind_sign: 0 }])); // sign
    cal_err(calibration(&[
        RegionB::Line { entity: 3, a: (0, 0), b: (1, 5), behind_sign: 1 },
        RegionB::Line { entity: 3, a: (0, 0), b: (1, 5), behind_sign: 1 },
    ])); // duplicate
    let mut c = base_cal();
    c.push(0);
    cal_err(c); // trailing
    let mut c = base_cal();
    c[6] = 1;
    cal_err(c); // reserved
    let mut c = base_cal();
    c[0] = b'X';
    cal_err(c);

    // Zones: 3..8 points, sign 0.
    let zp = ProgramB::rules(vec![(EK_OBJECT, 0), (EK_ZONE, 0)], vec![LegB::exists(1, leaf(OP_INSIDE, 0, 1, 0))], 10).encode();
    let zt = TracksB::build(OK_FLAGS, vec![(0, 0xFF, 0)], vec![(0, 5)], |_, _| at(5000, 5000, 10)).encode();
    let zone = |n: usize| calibration(&[RegionB::Zone { entity: 1, pts: (0..n).map(|i| (i as u16 * 100, (i * i) as u16)).collect() }]);
    assert_eq!(check(&zp, &zone(3), &zt), Ok(()));
    assert_eq!(check(&zp, &zone(8), &zt), Ok(()));
    assert_eq!(check(&zp, &zone(2), &zt), Err(MalformedCalibration));
    assert_eq!(check(&zp, &zone(9), &zt), Err(MalformedCalibration));
    // ai_judged requires an empty calibration.
    let mut ai = ProgramB::rules(vec![], vec![], 120);
    ai.kind = 1;
    ai.cond = vec![OP_YES];
    let at0 = TracksB::build(OK_FLAGS, vec![], vec![], |_, _| ABSENT).encode();
    assert_eq!(check(&ai.encode(), &calibration(&[]), &at0), Err(MalformedCalibration));
}

#[test]
fn track_rejections() {
    let p = base_program().encode();
    let c = base_cal();
    let terr = |t: Vec<u8>| assert_eq!(check(&p, &c, &t), Err(MalformedTracks));
    let good = base_tracks();
    // header
    for (off, v) in [(0usize, b'X'), (4, 2), (5, 30), (8, 0b1000_0010), (9, 1), (11, 1)] {
        let mut t = good.encode();
        t[off] = v;
        terr(t);
    }
    // wrong T / track table
    let mut t = base_tracks();
    t.tracks.pop();
    t.records = t.records.iter().enumerate().filter(|(i, _)| i % 3 != 2).map(|(_, r)| *r).collect();
    terr(t.encode());
    let mut t = base_tracks();
    t.tracks[0].1 = 0; // participant_idx mismatch
    terr(t.encode());
    let mut t = base_tracks();
    t.tracks[1].1 = 0; // non-person must be 0xFF
    terr(t.encode());
    let mut t = base_tracks();
    t.tracks.swap(1, 2); // order
    terr(t.encode());
    // segments
    terr(TracksB { segments: vec![], records: vec![], ..base_tracks() }.encode()); // S = 0 without bit3
    let mut t = base_tracks();
    t.flags |= 0b1000; // bit3 with S ≠ 0
    terr(t.encode());
    let seg_case = |segs: Vec<(u32, u16)>| TracksB::build(OK_FLAGS, vec![(0, 1, 0), (1, 0xFF, 0), (2, 0xFF, 0)], segs, |t, _| if t == 0 { person_at(1000, 9000) } else { at(5000, 5000, 10) }).encode();
    terr(seg_case(vec![(10, 5), (12, 5)])); // overlapping
    terr(seg_case(vec![(10, 5), (0, 5)])); // unordered
    terr(seg_case(vec![(10, 0)])); // n_frames = 0
    assert_eq!(check(&p, &c, &seg_case(vec![(0, 5), (5, 5)])), Ok(())); // adjacent ok
    // frame bounds: LIMIT = 1800, + TAIL 20 → last allowed frame 1819.
    assert_eq!(check(&p, &c, &seg_case(vec![(1815, 5)])), Ok(()));
    terr(seg_case(vec![(1816, 5)]));
    // Σ n_frames > 1024
    terr(seg_case(vec![(0, 1000), (1000, 25)]));
    assert_eq!(check(&p, &c, &seg_case(vec![(0, 1000), (1000, 24)])), Ok(()));
    // more than 16 segments
    terr(seg_case((0..17).map(|i| (i * 2, 1)).collect()));
    // segment reserved
    let mut t = good.encode();
    t[44 + 12 + 6] = 1;
    terr(t);
    // record length mismatch
    let mut t = good.encode();
    t.push(0);
    terr(t);
    let mut t = good.encode();
    t.truncate(t.len() - 12);
    terr(t);
    // record constraints
    let rec_case = |f: fn(Rec) -> Rec, track: usize| {
        let mut t = base_tracks();
        let i = 3 * 4 + track;
        t.records[i] = f(t.records[i]);
        t.encode()
    };
    terr(rec_case(|r| Rec { conf: 101, ..r }, 1));
    terr(rec_case(|r| Rec { fill: 101, ..r }, 1));
    terr(rec_case(|_| Rec { conf: 0, b: (1, 0, 1, 0), ..ABSENT }, 1)); // absent with data
    terr(rec_case(|_| Rec { conf: 0, fill: 1, ..ABSENT }, 1));
    terr(rec_case(|r| Rec { b: (10, 0, 5, 10), ..r }, 1)); // x0 > x1
    terr(rec_case(|r| Rec { b: (0, 0, 10001, 10), ..r }, 1)); // > 10000
    terr(rec_case(|r| Rec { id_conf: 5, ..r }, 1)); // id_conf on object
    terr(rec_case(|r| Rec { pose: 1, ..r }, 1)); // pose on object
    terr(rec_case(|r| Rec { pose: 0x06, ..r }, 0)); // low and high
    terr(rec_case(|r| Rec { pose: 0x08, ..r }, 0)); // reserved pose bits
    terr(rec_case(|r| Rec { id_conf: 101, ..r }, 0));
    assert_eq!(check(&p, &c, &rec_case(|r| Rec { pose: 0x05, ..r }, 0)), Ok(()));

    // window_unavailable: S = 0 required, then needs_panel 13.
    let t = TracksB { flags: 0b1010, segments: vec![], records: vec![], ..base_tracks() }.encode();
    let d = run(&p, &c, &t, &[]).unwrap();
    assert_eq!((d.out.preruling, d.out.reason), (3, 13));
    assert_eq!(legs_of(&d), vec![2]);
}

#[test]
fn market_bin_rejections_and_results() {
    let h1 = [1u8; 32];
    let h2 = [2u8; 32];
    let mut m = ProgramB::rules(vec![], vec![LegB::market(1, h1, true), LegB::market(2, h2, false)], 86_400);
    m.kind = 2;
    m.stakes = vec![7_000_000, 3_000_000];
    m.if_true = 0;
    m.else_side = 1;
    m.cond = and(cond_leg(1), cond_leg(2));
    let p = m.encode();
    let ev = |bin: Vec<u8>| run(&p, &[], &bin, &[]);
    // Both hit: leg1 yes==yes, leg2 no==no.
    let d = ev(market_bin(&[(h1, 1), (h2, 0)])).unwrap();
    assert_eq!(legs_of(&d), vec![1, 1]);
    assert_eq!(d.out.winner_mask, 1);
    let d = ev(market_bin(&[(h2, 1), (h1, 1)])).unwrap();
    assert_eq!(legs_of(&d), vec![1, 0]);
    assert_eq!(d.out.winner_mask, 2);
    // Void / missing → Unknown (VOID); and(U, F) = F.
    let d = ev(market_bin(&[(h1, 2), (h2, 1)])).unwrap();
    assert_eq!(legs_of(&d), vec![2, 0]);
    assert_eq!(causes_of(&d)[0], Some(verdict_rules::eval::LegCause::Void));
    assert_eq!(d.out.winner_mask, 2);
    let d = ev(market_bin(&[(h1, 1)])).unwrap();
    assert_eq!(legs_of(&d), vec![1, 2]);
    assert_eq!((d.out.preruling, d.out.reason), (3, 10));
    // Rejections.
    assert_eq!(ev(market_bin(&[(h1, 1), (h1, 0)])).err(), Some(MalformedTracks));
    assert_eq!(ev(market_bin(&[(h1, 3)])).err(), Some(MalformedTracks));
    let mut b = market_bin(&[(h1, 1)]);
    b.push(0);
    assert_eq!(ev(b).err(), Some(MalformedTracks));
    let mut b = market_bin(&[(h1, 1)]);
    b[6] = 1;
    assert_eq!(ev(b).err(), Some(MalformedTracks));
    let mut b = market_bin(&[(h1, 1)]);
    b[4] = 2;
    assert_eq!(ev(b).err(), Some(MalformedTracks));
    // A track_bin instead of a market_bin.
    assert_eq!(ev(base_tracks().encode()).err(), Some(MalformedTracks));
    // Market needs empty calibration.
    assert_eq!(run(&p, &calibration(&[]), &market_bin(&[]), &[]).err(), Some(MalformedCalibration));
}

#[test]
fn decode_order_program_first() {
    // Malformed program + malformed calibration + malformed tracks ⇒ MalformedProgram.
    assert_eq!(check(&[0], &[0], &[0]), Err(MalformedProgram));
    assert_eq!(check(&base_program().encode(), &[0], &[0]), Err(MalformedCalibration));
}

#[test]
fn payload_split() {
    let p = base_program().encode();
    let c = base_cal();
    let t = base_tracks().encode();
    let payload = [p.clone(), c.clone(), t.clone()].concat();
    let out = verdict_rules::evaluate_payload::<W>(&payload, p.len(), c.len(), &[], Some(16384)).unwrap();
    let direct = verdict_rules::evaluate::<W>(&p, &c, &t, &[], Some(16384)).unwrap();
    assert_eq!(out, direct);
}
