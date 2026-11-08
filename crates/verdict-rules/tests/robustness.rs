//! Robustness: decoders and the evaluator never panic on mutated or random inputs
//! (an onchain panic would abort `post_tracks` / `run_rules` instead of returning an error).
mod common;
use common::*;
use verdict_rules::expr::*;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

fn scene() -> (Vec<u8>, Vec<u8>) {
    let va = and(leaf(OP_RELEASED_BY, 1, 0, 0), leaf(OP_BEHIND, 0, 3, 0));
    let succ = or(
        or(leaf(OP_DISAPPEARS_INTO, 1, opening(2), 0), leaf(OP_ENTERS, 1, 4, 0)),
        and(
            then_within(20, leaf(OP_CROSSES, 1, 3, 0), leaf(OP_TOUCHES, 1, interior(2), 0)),
            or(leaf(OP_AT_REST, 1, 0, 10), leaf(OP_REP_COUNT, 0, CMP_GE, 2)),
        ),
    );
    let legs = vec![
        LegB::count(1, CMP_GE, 1, 3, va, succ).actor(),
        LegB::holds(2, 50, not(leaf(OP_NEAR, 1, 2, 300))),
        LegB::count(3, CMP_NE, 2, 0, vec![], leaf(OP_DIRECTION, 2, 1, 0)),
    ];
    let mut p = ProgramB::rules(vec![(EK_PERSON, 1), (EK_OBJECT, 0), (EK_OBJECT, 0), (EK_LINE, 0), (EK_ZONE, 0)], legs, 30);
    p.cond = or(and(cond_leg(1), cond_leg(2)), not(cond_leg(3)));
    let c = calibration(&[
        RegionB::Line { entity: 3, a: (3000, 0), b: (3000, 10000), behind_sign: 1 },
        RegionB::Zone { entity: 4, pts: vec![(6000, 6000), (9000, 6000), (9000, 9000), (6000, 9000), (7500, 7000)] },
    ]);
    (p.encode(), c)
}

fn random_tracks(rng: &mut Lcg) -> Vec<u8> {
    let n_seg = 1 + rng.below(4) as usize;
    let mut segs = vec![];
    let mut start = rng.below(5) as u32;
    for _ in 0..n_seg {
        let n = 1 + rng.below(60) as u16;
        segs.push((start, n));
        start += n as u32 + rng.below(4) as u32;
    }
    segs.retain(|&(s, n)| s + n as u32 <= 320);
    if segs.is_empty() {
        segs.push((0, 10));
    }
    let seed = rng.next();
    TracksB::build(OK_FLAGS | (rng.below(2) as u8), vec![(0, 1, 1500), (1, 0xFF, 0), (2, 0xFF, 800)], segs, move |t, f| {
        let mut r = Lcg(seed ^ ((t as u64) << 32) ^ f as u64);
        r.next();
        if r.below(5) == 0 {
            return ABSENT;
        }
        let x0 = r.below(9000) as u16;
        let y0 = r.below(9000) as u16;
        let rec = bx(x0, y0, x0 + r.below(1000) as u16, y0 + r.below(1000) as u16);
        let conf = 1 + r.below(100) as u8;
        match t {
            0 => Rec { conf, id_conf: r.below(101) as u8, pose: [0, 1, 2, 4, 3, 5][r.below(6) as usize], ..rec },
            _ => Rec { conf, ..rec },
        }
    })
    .encode()
}

#[test]
fn random_tracks_never_panic() {
    let (p, c) = scene();
    let mut rng = Lcg(42);
    let mut outcomes = [0usize; 4];
    for _ in 0..1500 {
        let t = random_tracks(&mut rng);
        let verified: Vec<(u8, u32)> = (0..rng.below(4)).map(|_| (1, rng.below(300) as u32)).collect();
        let d = run(&p, &c, &t, &verified).expect("valid random tracks must decode");
        outcomes[d.out.preruling as usize] += 1;
        assert!(d.out.n_checkpoints as usize <= 8);
        let cps = cps_of(&d);
        assert!(cps.windows(2).all(|w| (w[0].1, w[0].0) < (w[1].1, w[1].0)), "sorted, unique");
    }
    assert!(outcomes[1] > 0 && outcomes[3] > 0, "{outcomes:?}");
}

#[test]
fn mutated_buffers_never_panic() {
    let (p, c) = scene();
    let mut rng = Lcg(7);
    let t = random_tracks(&mut rng);
    for i in 0..30000 {
        let (mut pm, mut cm, mut tm) = (p.clone(), c.clone(), t.clone());
        let target = match i % 3 {
            0 => &mut pm,
            1 => &mut cm,
            _ => &mut tm,
        };
        for _ in 0..1 + rng.below(3) {
            match rng.below(4) {
                0 if !target.is_empty() => {
                    let k = rng.below(target.len() as u64) as usize;
                    target[k] = rng.next() as u8;
                }
                1 if !target.is_empty() => {
                    let k = rng.below(target.len() as u64) as usize;
                    target.truncate(k);
                }
                2 => target.push(rng.next() as u8),
                _ if !target.is_empty() => {
                    let k = rng.below(target.len() as u64) as usize;
                    target[k] ^= 1 << rng.below(8);
                }
                _ => {}
            }
        }
        let _ = run(&pm, &cm, &tm, &[(1, 5)]);
    }
}

#[test]
fn deterministic() {
    let (p, c) = scene();
    let mut rng = Lcg(99);
    for _ in 0..50 {
        let t = random_tracks(&mut rng);
        assert_eq!(run(&p, &c, &t, &[]).unwrap(), run(&p, &c, &t, &[]).unwrap());
    }
}
