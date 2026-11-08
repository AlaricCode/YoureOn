//! `program_bin` decoder (§5.1). Borrowing, heap-free: expression codes stay slices of the input.

use crate::constants::*;
use crate::error::DecodeError;
use crate::expr::{self, *};
use crate::reader::Reader;

pub const PROGRAM_MAGIC: [u8; 4] = *b"VRDP";
pub const PROGRAM_FORMAT_VERSION: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgramKind {
    Rules = 0,
    AiJudged = 1,
    Market = 2,
}

// rule_kind codes.
pub const RULE_EXISTS: u8 = 0;
pub const RULE_COUNT: u8 = 1;
pub const RULE_HOLDS: u8 = 2;
pub const RULE_NEVER: u8 = 3;
pub const RULE_BEFORE: u8 = 4;
pub const RULE_MARKET: u8 = 5;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Entity {
    /// Kind code: 0 person, 1 person_any, 2 object, 3 line, 4 zone.
    pub kind: u8,
    /// Participant index for `person`, else 0.
    pub param: u8,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Leg<'a> {
    pub id: u8,
    pub actor_bound: bool,
    pub rule_kind: u8,
    pub rule_cmp: u8,
    pub rule_k: u16,
    pub rule_n: u32,
    pub attempt_window: u16,
    /// valid_attempt code (empty if none).
    pub valid_attempt: &'a [u8],
    /// success code; market legs: the 32-byte market_hash.
    pub success: &'a [u8],
    /// Entities referenced by `valid_attempt` (bitmask over entity index).
    pub va_refs: u16,
    /// Entities referenced by `success`.
    pub succ_refs: u16,
    /// Σ w(node) over valid_attempt and success (§3.13).
    pub weight: u64,
}

impl<'a> Leg<'a> {
    pub fn has_valid_attempt(&self) -> bool {
        !self.valid_attempt.is_empty()
    }
    pub fn market_hash(&self) -> Option<&'a [u8; 32]> {
        if self.rule_kind == RULE_MARKET {
            self.success.try_into().ok()
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Program<'a> {
    pub kind: ProgramKind,
    pub n_participants: u8,
    pub json_hash: &'a [u8; 32],
    pub time_limit_s: u32,
    /// 32·P bytes of participant pubkeys.
    pub participants: &'a [u8],
    pub stakes: [u64; MAX_PARTICIPANTS],
    pub side_b_mask: u8,
    pub n_entities: u8,
    pub entities: [Entity; MAX_ENTITIES],
    pub n_legs: u8,
    pub legs: [Leg<'a>; MAX_LEGS],
    pub if_true: u8,
    pub else_side: u8,
    pub condition: &'a [u8],
    /// Non-region entities referenced by any leg expression, i.e. the tracked entities (§5.4, D-43).
    pub tracked_mask: u16,
}

impl<'a> Program<'a> {
    pub fn entities(&self) -> &[Entity] {
        &self.entities[..self.n_entities as usize]
    }
    pub fn legs(&self) -> &[Leg<'a>] {
        &self.legs[..self.n_legs as usize]
    }
    pub fn participant(&self, i: usize) -> &'a [u8] {
        &self.participants[32 * i..32 * i + 32]
    }
    /// `LIMIT = time_limit_s · FPS` (§3.2).
    pub fn limit_frames(&self) -> u64 {
        self.time_limit_s as u64 * FPS as u64
    }
    /// Side of participant i (0 or 1).
    pub fn side(&self, i: usize) -> u8 {
        (self.side_b_mask >> i) & 1
    }
    /// Bet `flags` bit0: any leg actor-bound.
    pub fn any_actor_bound(&self) -> bool {
        self.legs().iter().any(|l| l.actor_bound)
    }
    /// Σ over legs of Σ w(node) — multiply by |F| for the cost (§3.13).
    pub fn weight_per_frame(&self) -> u64 {
        self.legs().iter().map(|l| l.weight).sum()
    }
    /// Number of tracks a track_bin must carry.
    pub fn n_tracked(&self) -> usize {
        self.tracked_mask.count_ones() as usize
    }
    /// Mask of `person` (kind 0) entities.
    pub fn person_mask(&self) -> u16 {
        let mut m = 0u16;
        for (i, e) in self.entities().iter().enumerate() {
            if e.kind == EK_PERSON {
                m |= 1 << i;
            }
        }
        m
    }
    /// Mask of region entities.
    pub fn region_mask(&self) -> u16 {
        let mut m = 0u16;
        for (i, e) in self.entities().iter().enumerate() {
            if e.kind == EK_LINE || e.kind == EK_ZONE {
                m |= 1 << i;
            }
        }
        m
    }
}

const E: DecodeError = DecodeError::MalformedProgram;

/// Decodes and validates a `program_bin` (§5.1). Any violation ⇒ `MalformedProgram`.
pub fn decode_program(bin: &[u8]) -> Result<Program<'_>, DecodeError> {
    decode_inner(bin).ok_or(E)
}

fn decode_inner(bin: &[u8]) -> Option<Program<'_>> {
    let mut r = Reader::new(bin);
    if r.bytes(4)? != PROGRAM_MAGIC || r.u8()? != PROGRAM_FORMAT_VERSION {
        return None;
    }
    let kind = match r.u8()? {
        0 => ProgramKind::Rules,
        1 => ProgramKind::AiJudged,
        2 => ProgramKind::Market,
        _ => return None,
    };
    if r.u8()? as u32 != FPS {
        return None;
    }
    let p = r.u8()? as usize;
    if !(MIN_PARTICIPANTS..=MAX_PARTICIPANTS).contains(&p) {
        return None;
    }
    let json_hash = r.array32()?;
    let time_limit_s = r.u32()?;
    let tmax = if kind == ProgramKind::Market { MARKET_TIME_LIMIT_MAX_S } else { TIME_LIMIT_MAX_S };
    if !(1..=tmax).contains(&time_limit_s) {
        return None;
    }
    let participants = r.bytes(32 * p)?;
    let mut stakes = [0u64; MAX_PARTICIPANTS];
    for s in stakes.iter_mut().take(p) {
        *s = r.u64()?;
        if !(MIN_STAKE_UNITS..=MAX_STAKE_UNITS).contains(s) {
            return None;
        }
    }
    if kind != ProgramKind::Market && stakes[..p].iter().any(|&s| s != stakes[0]) {
        return None;
    }
    let side_b_mask = r.u8()?;
    if side_b_mask & 1 != 0 || side_b_mask == 0 || (side_b_mask as u32) >> p != 0 {
        return None;
    }

    let n_entities = r.u8()? as usize;
    if n_entities > MAX_ENTITIES {
        return None;
    }
    let mut entities = [Entity::default(); MAX_ENTITIES];
    let mut kinds = [0u8; MAX_ENTITIES];
    let mut person_participants = 0u16;
    for i in 0..n_entities {
        let k = r.u8()?;
        let param = r.u8()?;
        match k {
            EK_PERSON => {
                if param as usize >= p || person_participants & (1 << param) != 0 {
                    return None;
                }
                person_participants |= 1 << param;
            }
            EK_PERSON_ANY | EK_OBJECT | EK_LINE | EK_ZONE => {
                if param != 0 {
                    return None;
                }
            }
            _ => return None,
        }
        entities[i] = Entity { kind: k, param };
        kinds[i] = k;
    }
    let kinds = &kinds[..n_entities];
    let mut person_mask = 0u16;
    let mut region_mask = 0u16;
    for (i, &k) in kinds.iter().enumerate() {
        if k == EK_PERSON {
            person_mask |= 1 << i;
        }
        if k == EK_LINE || k == EK_ZONE {
            region_mask |= 1 << i;
        }
    }

    let n_legs = r.u8()? as usize;
    if n_legs > MAX_LEGS {
        return None;
    }
    match kind {
        ProgramKind::AiJudged if n_legs != 0 => return None,
        ProgramKind::Rules | ProgramKind::Market if n_legs == 0 => return None,
        _ => {}
    }
    let limit = time_limit_s as u64 * FPS as u64;
    let mut legs = [Leg::default(); MAX_LEGS];
    let mut leg_ids = [0u8; MAX_LEGS];
    let mut tracked_mask = 0u16;
    for li in 0..n_legs {
        let leg = decode_leg(&mut r, kind, kinds, person_mask, limit)?;
        if leg.id < 1 || leg.id as usize > MAX_LEGS || (li > 0 && leg.id <= leg_ids[li - 1]) {
            return None;
        }
        leg_ids[li] = leg.id;
        tracked_mask |= (leg.va_refs | leg.succ_refs) & !region_mask;
        legs[li] = leg;
    }

    let if_true = r.u8()?;
    let else_side = r.u8()?;
    if if_true > 1 || else_side > 1 || if_true == else_side {
        return None;
    }
    let cond_len = r.u16()? as usize;
    let condition = r.bytes(cond_len)?;
    if !r.is_empty() {
        return None;
    }
    if kind == ProgramKind::AiJudged {
        if condition != [OP_YES] {
            return None;
        }
    } else {
        expr::validate_condition(condition, &leg_ids[..n_legs])?;
    }

    Some(Program {
        kind,
        n_participants: p as u8,
        json_hash,
        time_limit_s,
        participants,
        stakes,
        side_b_mask,
        n_entities: n_entities as u8,
        entities,
        n_legs: n_legs as u8,
        legs,
        if_true,
        else_side,
        condition,
        tracked_mask,
    })
}

fn decode_leg<'a>(
    r: &mut Reader<'a>,
    kind: ProgramKind,
    kinds: &[u8],
    person_mask: u16,
    limit: u64,
) -> Option<Leg<'a>> {
    let id = r.u8()?;
    let flags = r.u8()?;
    if flags & !0x03 != 0 {
        return None;
    }
    let actor_bound = flags & 1 != 0;
    let has_va = flags & 2 != 0;
    let rule_kind = r.u8()?;
    let rule_cmp = r.u8()?;
    let rule_k = r.u16()?;
    let rule_n = r.u32()?;
    let attempt_window = r.u16()?;
    let va_len = r.u16()? as usize;
    let valid_attempt = r.bytes(va_len)?;
    let succ_len = r.u16()? as usize;
    let success = r.bytes(succ_len)?;
    if has_va != (va_len != 0) {
        return None;
    }
    let mut leg = Leg {
        id,
        actor_bound,
        rule_kind,
        rule_cmp,
        rule_k,
        rule_n,
        attempt_window,
        valid_attempt,
        success,
        ..Leg::default()
    };

    if kind == ProgramKind::Market {
        // Market leg: everything but the expected result is zero; success = market_hash.
        let ok = rule_kind == RULE_MARKET
            && flags == 0
            && rule_cmp == 0
            && rule_k <= 1
            && rule_n == 0
            && attempt_window == 0
            && succ_len == 32;
        return if ok { Some(leg) } else { None };
    }

    // Rules leg.
    if !(1..=MAX_DURATION_FRAMES).contains(&(attempt_window as u32)) {
        return None;
    }
    let succ = expr::validate_leg_expr(success, kinds)?;
    leg.succ_refs = succ.refs;
    leg.weight = succ.weight;
    if has_va {
        let va = expr::validate_leg_expr(valid_attempt, kinds)?;
        leg.va_refs = va.refs;
        leg.weight += va.weight;
    }
    // ACTOR_BOUND_MISMATCH (§2.7): the flag must equal "references a person entity".
    let refs_person = (leg.va_refs | leg.succ_refs) & person_mask != 0;
    if actor_bound != refs_person {
        return None;
    }
    let max_window_frames = (MAX_DURATION_FRAMES as u64).min(limit);
    match rule_kind {
        RULE_EXISTS | RULE_NEVER => {
            if rule_cmp != 0 || rule_k != 0 || rule_n != 0 || has_va {
                return None;
            }
            // NEGATIVE_ACTOR_RULE: `never` cannot be actor-bound.
            if rule_kind == RULE_NEVER && actor_bound {
                return None;
            }
        }
        RULE_HOLDS | RULE_BEFORE => {
            if rule_cmp != 0 || rule_k != 0 || has_va || rule_n == 0 || rule_n as u64 > max_window_frames {
                return None;
            }
        }
        RULE_COUNT => {
            if rule_cmp > CMP_NE || rule_k as u32 > REPS_MAX {
                return None;
            }
            let n_max = if actor_bound { ATTEMPTS_MAX_ACTOR_BOUND } else { ATTEMPTS_MAX };
            if rule_n > n_max {
                return None;
            }
            // BAD_RULE: valid_attempt ⇔ count with attempts.
            if has_va != (rule_n > 0) {
                return None;
            }
            // NEGATIVE_ACTOR_RULE: actor-bound counts are `>= k` (k ≥ 1) or `> k`.
            if actor_bound && !(rule_cmp == CMP_GT || (rule_cmp == CMP_GE && rule_k >= 1)) {
                return None;
            }
        }
        _ => return None,
    }
    Some(leg)
}
