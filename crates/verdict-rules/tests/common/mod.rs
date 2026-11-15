//! Test-only encoders for program_bin / calibration_bin / track_bin / market_bin (§5).
#![allow(dead_code)]

use verdict_rules::eval::*;
use verdict_rules::expr::*;
use verdict_rules::{Checkpoint, DecodeError, EvalDetail};

pub const W: usize = 16;

// ---------- expressions ----------
pub fn r(e: u8) -> u8 {
    e
}
pub fn opening(e: u8) -> u8 {
    e | (SUB_OPENING << 4)
}
pub fn interior(e: u8) -> u8 {
    e | (SUB_INTERIOR << 4)
}
pub fn leaf(op: u8, a: u8, b: u8, p: i32) -> Vec<u8> {
    let mut v = vec![op, a, b];
    v.extend_from_slice(&p.to_le_bytes());
    v
}
pub fn and(x: Vec<u8>, y: Vec<u8>) -> Vec<u8> {
    [vec![OP_AND], x, y].concat()
}
pub fn or(x: Vec<u8>, y: Vec<u8>) -> Vec<u8> {
    [vec![OP_OR], x, y].concat()
}
pub fn not(x: Vec<u8>) -> Vec<u8> {
    [vec![OP_NOT], x].concat()
}
pub fn then_within(d: u16, x: Vec<u8>, y: Vec<u8>) -> Vec<u8> {
    [vec![OP_THEN_WITHIN], d.to_le_bytes().to_vec(), x, y].concat()
}
pub fn for_duration(d: u16, x: Vec<u8>) -> Vec<u8> {
    [vec![OP_FOR_DURATION], d.to_le_bytes().to_vec(), x].concat()
}
pub fn before(d: u32, x: Vec<u8>) -> Vec<u8> {
    [vec![OP_BEFORE], d.to_le_bytes().to_vec(), x].concat()
}
pub fn present(a: u8) -> Vec<u8> {
    leaf(OP_PRESENT, a, 0, 0)
}
pub fn cond_leg(id: u8) -> Vec<u8> {
    vec![OP_LEG, id]
}

// ---------- program ----------
#[derive(Clone)]
pub struct LegB {
    pub id: u8,
    pub actor_bound: bool,
    pub rule_kind: u8,
    pub rule_cmp: u8,
    pub rule_k: u16,
    pub rule_n: u32,
    pub attempt_window: u16,
    pub va: Vec<u8>,
    pub succ: Vec<u8>,
    pub flags_override: Option<u8>,
}

impl LegB {
    pub fn rules(id: u8, rule_kind: u8, succ: Vec<u8>) -> Self {
        LegB {
            id,
            actor_bound: false,
            rule_kind,
            rule_cmp: 0,
            rule_k: 0,
            rule_n: 0,
            attempt_window: 50,
            va: vec![],
            succ,
            flags_override: None,
        }
    }
    pub fn exists(id: u8, succ: Vec<u8>) -> Self {
        Self::rules(id, 0, succ)
    }
    pub fn holds(id: u8, frames: u32, succ: Vec<u8>) -> Self {
        LegB { rule_n: frames, ..Self::rules(id, 2, succ) }
    }
    pub fn never(id: u8, succ: Vec<u8>) -> Self {
        Self::rules(id, 3, succ)
    }
    pub fn before(id: u8, frames: u32, succ: Vec<u8>) -> Self {
        LegB { rule_n: frames, ..Self::rules(id, 4, succ) }
    }
    pub fn count(id: u8, cmp: u8, k: u16, attempts: u32, va: Vec<u8>, succ: Vec<u8>) -> Self {
        LegB { rule_cmp: cmp, rule_k: k, rule_n: attempts, va, ..Self::rules(id, 1, succ) }
    }
    pub fn market(id: u8, hash: [u8; 32], yes: bool) -> Self {
        LegB {
            id,
            actor_bound: false,
            rule_kind: 5,
            rule_cmp: 0,
            rule_k: yes as u16,
            rule_n: 0,
            attempt_window: 0,
            va: vec![],
            succ: hash.to_vec(),
            flags_override: None,
        }
    }
    pub fn actor(mut self) -> Self {
        self.actor_bound = true;
        self
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut v = vec![self.id];
        let flags = self
            .flags_override
            .unwrap_or(self.actor_bound as u8 | if self.va.is_empty() { 0 } else { 2 });
        v.push(flags);
        v.push(self.rule_kind);
        v.push(self.rule_cmp);
        v.extend_from_slice(&self.rule_k.to_le_bytes());
        v.extend_from_slice(&self.rule_n.to_le_bytes());
        v.extend_from_slice(&self.attempt_window.to_le_bytes());
        v.extend_from_slice(&(self.va.len() as u16).to_le_bytes());
        v.extend_from_slice(&self.va);
        v.extend_from_slice(&(self.succ.len() as u16).to_le_bytes());
        v.extend_from_slice(&self.succ);
        v
    }
}

#[derive(Clone)]
pub struct ProgramB {
    pub kind: u8,
    pub p: u8,
    pub time_limit_s: u32,
    pub stakes: Vec<u64>,
    pub side_b_mask: u8,
    /// (kind, param)
    pub entities: Vec<(u8, u8)>,
    pub legs: Vec<LegB>,
    pub if_true: u8,
    pub else_side: u8,
    pub cond: Vec<u8>,
}

impl ProgramB {
    pub fn rules(entities: Vec<(u8, u8)>, legs: Vec<LegB>, time_limit_s: u32) -> Self {
        ProgramB {
            kind: 0,
            p: 2,
            time_limit_s,
            stakes: vec![5_000_000, 5_000_000],
            side_b_mask: 0b10,
            entities,
            legs,
            if_true: 1,
            else_side: 0,
            cond: cond_leg(1),
        }
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut v = b"VRDP".to_vec();
        v.extend_from_slice(&[2, self.kind, 10, self.p]);
        v.extend_from_slice(&[0xAB; 32]);
        v.extend_from_slice(&self.time_limit_s.to_le_bytes());
        for i in 0..self.p {
            v.extend_from_slice(&[i + 1; 32]);
        }
        for s in &self.stakes {
            v.extend_from_slice(&s.to_le_bytes());
        }
        v.push(self.side_b_mask);
        v.push(self.entities.len() as u8);
        for &(k, p) in &self.entities {
            v.push(k);
            v.push(p);
        }
        v.push(self.legs.len() as u8);
        for l in &self.legs {
            v.extend_from_slice(&l.encode());
        }
        v.push(self.if_true);
        v.push(self.else_side);
        v.extend_from_slice(&(self.cond.len() as u16).to_le_bytes());
        v.extend_from_slice(&self.cond);
        v
    }
}

// ---------- calibration ----------
pub enum RegionB {
    Line { entity: u8, a: (u16, u16), b: (u16, u16), behind_sign: i8 },
    Zone { entity: u8, pts: Vec<(u16, u16)> },
}

pub fn calibration(regions: &[RegionB]) -> Vec<u8> {
    let mut v = b"VCAL".to_vec();
    v.push(1);
    v.push(regions.len() as u8);
    v.extend_from_slice(&[0, 0]);
    v.extend_from_slice(&[0x5C; 32]);
    for r in regions {
        match r {
            RegionB::Line { entity, a, b, behind_sign } => {
                v.extend_from_slice(&[*entity, 0, 2, *behind_sign as u8]);
                for p in [a, b] {
                    v.extend_from_slice(&p.0.to_le_bytes());
                    v.extend_from_slice(&p.1.to_le_bytes());
                }
            }
            RegionB::Zone { entity, pts } => {
                v.extend_from_slice(&[*entity, 1, pts.len() as u8, 0]);
                for p in pts {
                    v.extend_from_slice(&p.0.to_le_bytes());
                    v.extend_from_slice(&p.1.to_le_bytes());
                }
            }
        }
    }
    v
}

// ---------- tracks ----------
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rec {
    pub b: (u16, u16, u16, u16),
    pub conf: u8,
    pub fill: u8,
    pub id_conf: u8,
    pub pose: u8,
}

pub const ABSENT: Rec = Rec { b: (0, 0, 0, 0), conf: 0, fill: 0, id_conf: 0, pose: 0 };

pub fn bx(x0: u16, y0: u16, x1: u16, y1: u16) -> Rec {
    Rec { b: (x0, y0, x1, y1), conf: 90, fill: 50, id_conf: 0, pose: 0 }
}
/// A box of half-size `h` centered at (cx, cy).
pub fn at(cx: u16, cy: u16, h: u16) -> Rec {
    bx(cx - h, cy - h, cx + h, cy + h)
}
pub fn person_at(cx: u16, cy: u16) -> Rec {
    Rec { id_conf: 95, ..bx(cx - 300, cy - 1500, cx + 300, cy) }
}

pub struct TracksB {
    pub flags: u8,
    /// (entity_idx, participant_idx, ref_h)
    pub tracks: Vec<(u8, u8, u16)>,
    /// (frame_start, n_frames)
    pub segments: Vec<(u32, u16)>,
    /// records[track] = closure-produced per absolute frame.
    pub records: Vec<Rec>,
}

impl TracksB {
    /// Builds records by calling `f(track, abs_frame)` in segment/frame/track order.
    pub fn build(flags: u8, tracks: Vec<(u8, u8, u16)>, segments: Vec<(u32, u16)>, f: impl Fn(usize, u32) -> Rec) -> Self {
        let mut records = vec![];
        for &(s, n) in &segments {
            for i in 0..n as u32 {
                for t in 0..tracks.len() {
                    records.push(f(t, s + i));
                }
            }
        }
        TracksB { flags, tracks, segments, records }
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut v = b"VTRK".to_vec();
        v.extend_from_slice(&[1, 10, self.tracks.len() as u8, self.segments.len() as u8, self.flags, 0, 0, 0]);
        v.extend_from_slice(&[0x3D; 32]);
        for &(e, p, h) in &self.tracks {
            v.push(e);
            v.push(p);
            v.extend_from_slice(&h.to_le_bytes());
        }
        for &(s, n) in &self.segments {
            v.extend_from_slice(&s.to_le_bytes());
            v.extend_from_slice(&n.to_le_bytes());
            v.extend_from_slice(&[0, 0]);
        }
        for r in &self.records {
            for c in [r.b.0, r.b.1, r.b.2, r.b.3] {
                v.extend_from_slice(&c.to_le_bytes());
            }
            v.extend_from_slice(&[r.conf, r.fill, r.id_conf, r.pose]);
        }
        v
    }
}

pub const OK_FLAGS: u8 = 0b10;

pub fn market_bin(entries: &[([u8; 32], u8)]) -> Vec<u8> {
    let mut v = b"VMKT".to_vec();
    v.push(1);
    v.push(entries.len() as u8);
    v.extend_from_slice(&[0, 0]);
    for (h, r) in entries {
        v.extend_from_slice(h);
        v.push(*r);
    }
    v
}

// ---------- running ----------
pub fn run(p: &[u8], c: &[u8], t: &[u8], verified: &[(u8, u32)]) -> Result<EvalDetail, DecodeError> {
    let v: Vec<Checkpoint> = verified.iter().map(|&(participant, frame)| Checkpoint { participant, frame }).collect();
    verdict_rules::evaluate_detailed::<W>(p, c, t, &v, Some(verdict_rules::constants::MAX_EVAL_COST))
}

pub fn legs_of(d: &EvalDetail) -> Vec<u8> {
    d.out.leg_results[..d.n_legs as usize].to_vec()
}

pub fn causes_of(d: &EvalDetail) -> Vec<Option<LegCause>> {
    d.leg_causes[..d.n_legs as usize].to_vec()
}

pub fn cps_of(d: &EvalDetail) -> Vec<(u8, u32)> {
    d.out.checkpoints[..d.out.n_checkpoints as usize].to_vec()
}

/// Single-leg, single-object scene: program with entities, one leg, empty regions,
/// and a track per tracked entity. Returns the detail.
pub fn eval_simple(
    entities: Vec<(u8, u8)>,
    regions: &[RegionB],
    leg: LegB,
    time_limit_s: u32,
    tracks: Vec<(u8, u8, u16)>,
    segments: Vec<(u32, u16)>,
    f: impl Fn(usize, u32) -> Rec,
) -> EvalDetail {
    let p = ProgramB::rules(entities, vec![leg], time_limit_s).encode();
    let c = calibration(regions);
    let t = TracksB::build(OK_FLAGS, tracks, segments, f).encode();
    run(&p, &c, &t, &[]).expect("decode")
}

/// Frames where the success expression `succ` is true (single rules leg, `exists`).
pub fn true_frames(
    entities: Vec<(u8, u8)>,
    regions: &[RegionB],
    succ: Vec<u8>,
    time_limit_s: u32,
    tracks: Vec<(u8, u8, u16)>,
    segments: Vec<(u32, u16)>,
    f: impl Fn(usize, u32) -> Rec,
) -> Vec<u32> {
    let p = ProgramB::rules(entities, vec![LegB::exists(1, succ)], time_limit_s).encode();
    let c = calibration(regions);
    let t = TracksB::build(OK_FLAGS, tracks, segments, f).encode();
    let prog = verdict_rules::decode_program(&p).expect("program");
    let cal = verdict_rules::decode_calibration(&c, &prog).expect("calibration");
    let trk = verdict_rules::decode_tracks(&t, &prog).expect("tracks");
    let mut out = vec![];
    verdict_rules::eval::for_each_success_value::<W>(&prog, &cal, &trk, 0, |fr, v| {
        if v {
            out.push(fr)
        }
    });
    out
}
