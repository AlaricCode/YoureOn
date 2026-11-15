//! Test encoders for program_bin / calibration_bin / track_bin / market_bin (CONTRACTS.md §5).
#![allow(dead_code)]

use solana_sdk::pubkey::Pubkey;

// Expression op codes (§5.1).
pub const OP_AND: u8 = 0x01;
pub const OP_OR: u8 = 0x02;
pub const OP_NOT: u8 = 0x03;
pub const OP_THEN_WITHIN: u8 = 0x04;
pub const OP_FOR_DURATION: u8 = 0x05;
pub const OP_OVERLAPS: u8 = 0x10;
pub const OP_INSIDE: u8 = 0x11;
pub const OP_NEAR: u8 = 0x14;
pub const OP_MOVING: u8 = 0x20;
pub const OP_AT_REST: u8 = 0x21;
pub const OP_SPEED: u8 = 0x22;
pub const OP_DIRECTION: u8 = 0x23;
pub const OP_PRESENT: u8 = 0x24;
pub const OP_ENTERS: u8 = 0x30;
pub const OP_LEAVES: u8 = 0x31;
pub const OP_DISAPPEARS_INTO: u8 = 0x32;
pub const OP_TOUCHES: u8 = 0x33;
pub const OP_LEG: u8 = 0x50;
pub const OP_YES: u8 = 0x51;

// Entity kinds.
pub const EK_PERSON: u8 = 0;
pub const EK_OBJECT: u8 = 2;
pub const EK_ZONE: u8 = 4;

pub fn leaf(op: u8, a: u8, b: u8, p: i32) -> Vec<u8> {
    let mut v = vec![op, a, b];
    v.extend_from_slice(&p.to_le_bytes());
    v
}
pub fn present(a: u8) -> Vec<u8> {
    leaf(OP_PRESENT, a, 0, 0)
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
pub fn cond_leg(id: u8) -> Vec<u8> {
    vec![OP_LEG, id]
}

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
}

impl LegB {
    pub fn exists(id: u8, succ: Vec<u8>) -> Self {
        LegB { id, actor_bound: false, rule_kind: 0, rule_cmp: 0, rule_k: 0, rule_n: 0, attempt_window: 50, va: vec![], succ }
    }
    pub fn count(id: u8, cmp: u8, k: u16, attempts: u32, va: Vec<u8>, succ: Vec<u8>) -> Self {
        LegB { rule_kind: 1, rule_cmp: cmp, rule_k: k, rule_n: attempts, va, ..Self::exists(id, succ) }
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
        }
    }
    pub fn actor(mut self) -> Self {
        self.actor_bound = true;
        self
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut v = vec![self.id, self.actor_bound as u8 | if self.va.is_empty() { 0 } else { 2 }, self.rule_kind, self.rule_cmp];
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
    pub time_limit_s: u32,
    pub participants: Vec<Pubkey>,
    pub stakes: Vec<u64>,
    pub side_b_mask: u8,
    pub entities: Vec<(u8, u8)>,
    pub legs: Vec<LegB>,
    pub if_true: u8,
    pub else_side: u8,
    pub cond: Vec<u8>,
}

impl ProgramB {
    pub fn encode(&self) -> Vec<u8> {
        let mut v = b"VRDP".to_vec();
        v.extend_from_slice(&[2, self.kind, 10, self.participants.len() as u8]);
        v.extend_from_slice(&[0xAB; 32]);
        v.extend_from_slice(&self.time_limit_s.to_le_bytes());
        for p in &self.participants {
            v.extend_from_slice(p.as_ref());
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

/// Calibration with zone regions only: `(entity, points)`.
pub fn calibration(zones: &[(u8, Vec<(u16, u16)>)]) -> Vec<u8> {
    let mut v = b"VCAL".to_vec();
    v.push(1);
    v.push(zones.len() as u8);
    v.extend_from_slice(&[0, 0]);
    v.extend_from_slice(&[0x5C; 32]);
    for (e, pts) in zones {
        v.extend_from_slice(&[*e, 1, pts.len() as u8, 0]);
        for p in pts {
            v.extend_from_slice(&p.0.to_le_bytes());
            v.extend_from_slice(&p.1.to_le_bytes());
        }
    }
    v
}

#[derive(Clone, Copy, Debug, Default)]
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
pub fn at(cx: u16, cy: u16, h: u16) -> Rec {
    bx(cx - h, cy - h, cx + h, cy + h)
}
pub fn person_at(cx: u16, cy: u16) -> Rec {
    Rec { id_conf: 95, ..bx(cx - 300, cy - 1500, cx + 300, cy) }
}

pub const FLAGS_OK: u8 = 0b10;

/// track_bin: `tracks` = (entity_idx, participant_idx or 0xFF, ref_h); `f(track, abs_frame)`.
pub fn tracks_bin(flags: u8, tracks: &[(u8, u8, u16)], segments: &[(u32, u16)], f: impl Fn(usize, u32) -> Rec) -> Vec<u8> {
    let mut v = b"VTRK".to_vec();
    v.extend_from_slice(&[1, 10, tracks.len() as u8, segments.len() as u8, flags, 0, 0, 0]);
    v.extend_from_slice(&[0x3D; 32]);
    for &(e, p, h) in tracks {
        v.push(e);
        v.push(p);
        v.extend_from_slice(&h.to_le_bytes());
    }
    for &(s, n) in segments {
        v.extend_from_slice(&s.to_le_bytes());
        v.extend_from_slice(&n.to_le_bytes());
        v.extend_from_slice(&[0, 0]);
    }
    for &(s, n) in segments {
        for i in 0..n as u32 {
            for t in 0..tracks.len() {
                let r = f(t, s + i);
                for c in [r.b.0, r.b.1, r.b.2, r.b.3] {
                    v.extend_from_slice(&c.to_le_bytes());
                }
                v.extend_from_slice(&[r.conf, r.fill, r.id_conf, r.pose]);
            }
        }
    }
    v
}

/// Minimal ai_judged track_bin: T=0, S=0, flags=0b10.
pub fn ai_tracks_bin() -> Vec<u8> {
    tracks_bin(FLAGS_OK, &[], &[], |_, _| ABSENT)
}

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

pub fn hex(s: &str) -> Vec<u8> {
    let s = s.trim();
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}

pub fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
