//! Expression code (§5.1): op codes, ref bytes, structural validation of leg expressions
//! and outcome conditions, and the per-node cost weights of §3.13.

use crate::constants::*;
use crate::reader::le_u32;

// Combinators.
pub const OP_AND: u8 = 0x01;
pub const OP_OR: u8 = 0x02;
pub const OP_NOT: u8 = 0x03;
pub const OP_THEN_WITHIN: u8 = 0x04;
pub const OP_FOR_DURATION: u8 = 0x05;
pub const OP_BEFORE: u8 = 0x06;
// Leaves.
pub const OP_OVERLAPS: u8 = 0x10;
pub const OP_INSIDE: u8 = 0x11;
pub const OP_ABOVE: u8 = 0x12;
pub const OP_BELOW: u8 = 0x13;
pub const OP_NEAR: u8 = 0x14;
pub const OP_BEHIND: u8 = 0x15;
pub const OP_BEYOND: u8 = 0x16;
pub const OP_MOVING: u8 = 0x20;
pub const OP_AT_REST: u8 = 0x21;
pub const OP_SPEED: u8 = 0x22;
pub const OP_DIRECTION: u8 = 0x23;
pub const OP_PRESENT: u8 = 0x24;
pub const OP_INTACT: u8 = 0x25;
pub const OP_ENTERS: u8 = 0x30;
pub const OP_LEAVES: u8 = 0x31;
pub const OP_DISAPPEARS_INTO: u8 = 0x32;
pub const OP_TOUCHES: u8 = 0x33;
pub const OP_CROSSES: u8 = 0x34;
pub const OP_RELEASED_BY: u8 = 0x35;
pub const OP_STANDING: u8 = 0x40;
pub const OP_REP_COUNT: u8 = 0x41;
// Condition only.
pub const OP_LEG: u8 = 0x50;
pub const OP_YES: u8 = 0x51;

/// Leaf length including the op byte: op, a, b, p:i32.
pub const LEAF_LEN: usize = 7;

// Entity kind codes (§5.1).
pub const EK_PERSON: u8 = 0;
pub const EK_PERSON_ANY: u8 = 1;
pub const EK_OBJECT: u8 = 2;
pub const EK_LINE: u8 = 3;
pub const EK_ZONE: u8 = 4;

// Sub-region codes in a ref byte.
pub const SUB_NONE: u8 = 0;
pub const SUB_OPENING: u8 = 1;
pub const SUB_INTERIOR: u8 = 2;

// CMP codes.
pub const CMP_GE: u8 = 0;
pub const CMP_GT: u8 = 1;
pub const CMP_LE: u8 = 2;
pub const CMP_LT: u8 = 3;
pub const CMP_EQ: u8 = 4;
pub const CMP_NE: u8 = 5;

/// `x cmp y` for a CMP code (caller guarantees code ≤ 5).
#[inline]
pub fn cmp_holds(code: u8, x: i64, y: i64) -> bool {
    match code {
        CMP_GE => x >= y,
        CMP_GT => x > y,
        CMP_LE => x <= y,
        CMP_LT => x < y,
        CMP_EQ => x == y,
        _ => x != y,
    }
}

#[inline]
pub fn ref_entity(r: u8) -> usize {
    (r & 0x0F) as usize
}
#[inline]
pub fn ref_sub(r: u8) -> u8 {
    (r >> 4) & 0x03
}

#[inline(always)]
pub fn is_leaf(op: u8) -> bool {
    matches!(op, 0x10..=0x16 | 0x20..=0x25 | 0x30..=0x35 | 0x40 | 0x41)
}

#[inline(always)]
pub fn is_event_leaf(op: u8) -> bool {
    matches!(op, 0x30..=0x35)
}

/// Cost weights `w(node)` (§3.13): combinators.
pub const COST_COMBINATOR: u64 = 1;
/// State leaves other than `overlaps` / `inside`.
pub const COST_STATE_LEAF: u64 = 2;
/// `overlaps`, `inside`: may run an even-odd polygon test (zone `b`) per frame.
pub const COST_POLY_STATE_LEAF: u64 = 4;
/// Event leaves other than the ones below.
pub const COST_EVENT_LEAF: u64 = 4;
/// `enters`, `leaves`, `touches`: a polygon-capable spatial pass plus the lastSeen pass.
pub const COST_POLY_EVENT_LEAF: u64 = 6;
pub const COST_DISAPPEARS_INTO: u64 = 12;

/// Cost weight `w(node)` (§3.13).
#[inline(always)]
pub fn node_weight(op: u8) -> u64 {
    match op {
        OP_DISAPPEARS_INTO => COST_DISAPPEARS_INTO,
        OP_ENTERS | OP_LEAVES | OP_TOUCHES => COST_POLY_EVENT_LEAF,
        OP_OVERLAPS | OP_INSIDE => COST_POLY_STATE_LEAF,
        o if is_event_leaf(o) => COST_EVENT_LEAF,
        o if is_leaf(o) => COST_STATE_LEAF,
        _ => COST_COMBINATOR,
    }
}

/// Whether the leaf's `b` byte is a ref.
fn leaf_b_is_ref(op: u8) -> bool {
    matches!(op, 0x10..=0x16 | 0x30..=0x35)
}

/// Statistics gathered while validating one leg expression.
#[derive(Clone, Copy, Default, Debug)]
pub struct ExprStats {
    pub nodes: usize,
    pub depth: usize,
    /// Σ w(node) (§3.13).
    pub weight: u64,
    /// Bitmask of referenced entities (a and ref-b operands, incl. the owning object of sub-regions).
    pub refs: u16,
}

/// Validates a leg expression that must occupy exactly `code`. `kinds[i]` is entity i's kind code.
pub fn validate_leg_expr(code: &[u8], kinds: &[u8]) -> Option<ExprStats> {
    if code.is_empty() || code.len() > MAX_EXPR_BYTES {
        return None;
    }
    let mut st = ExprStats::default();
    let mut pos = 0usize;
    let d = leg_node(code, &mut pos, kinds, 1, &mut st)?;
    if pos != code.len() || st.nodes > MAX_EXPR_NODES {
        return None;
    }
    st.depth = d;
    Some(st)
}

fn leg_node(code: &[u8], pos: &mut usize, kinds: &[u8], level: usize, st: &mut ExprStats) -> Option<usize> {
    if level > MAX_EXPR_DEPTH {
        return None;
    }
    let op = *code.get(*pos)?;
    st.nodes += 1;
    if st.nodes > MAX_EXPR_NODES {
        return None;
    }
    st.weight += node_weight(op);
    *pos += 1;
    match op {
        OP_AND | OP_OR => {
            let l = leg_node(code, pos, kinds, level + 1, st)?;
            let r = leg_node(code, pos, kinds, level + 1, st)?;
            Some(1 + l.max(r))
        }
        OP_NOT => Some(1 + leg_node(code, pos, kinds, level + 1, st)?),
        OP_THEN_WITHIN => {
            let f = read_u16(code, pos)? as u32;
            if !(1..=MAX_DURATION_FRAMES).contains(&f) {
                return None;
            }
            let l = leg_node(code, pos, kinds, level + 1, st)?;
            let r = leg_node(code, pos, kinds, level + 1, st)?;
            Some(1 + l.max(r))
        }
        OP_FOR_DURATION => {
            let f = read_u16(code, pos)? as u32;
            if !(1..=MAX_DURATION_FRAMES).contains(&f) {
                return None;
            }
            Some(1 + leg_node(code, pos, kinds, level + 1, st)?)
        }
        OP_BEFORE => {
            if code.len() < *pos + 4 {
                return None;
            }
            let f = le_u32(code, *pos);
            *pos += 4;
            if !(1..=MAX_DURATION_FRAMES).contains(&f) {
                return None;
            }
            Some(1 + leg_node(code, pos, kinds, level + 1, st)?)
        }
        o if is_leaf(o) => {
            if code.len() < *pos + 6 {
                return None;
            }
            let a = code[*pos];
            let b = code[*pos + 1];
            let p = le_u32(code, *pos + 2) as i32;
            *pos += 6;
            st.refs |= validate_leaf(o, a, b, p, kinds)?;
            Some(1)
        }
        _ => None,
    }
}

#[inline(always)]
fn read_u16(code: &[u8], pos: &mut usize) -> Option<u16> {
    if code.len() < *pos + 2 {
        return None;
    }
    let v = u16::from_le_bytes([code[*pos], code[*pos + 1]]);
    *pos += 2;
    Some(v)
}

/// Validates a ref byte; returns (entity index, sub, kind).
#[inline(always)]
fn check_ref(r: u8, kinds: &[u8]) -> Option<(usize, u8, u8)> {
    if r & 0xC0 != 0 {
        return None;
    }
    let e = ref_entity(r);
    let sub = ref_sub(r);
    if e >= kinds.len() || sub > SUB_INTERIOR {
        return None;
    }
    let k = kinds[e];
    if sub != SUB_NONE && k != EK_OBJECT {
        return None;
    }
    Some((e, sub, k))
}

/// Leaf operand kinds (§2.7 BAD_OPERAND) and parameter ranges (§5.1). Returns the ref mask.
fn validate_leaf(op: u8, a: u8, b: u8, p: i32, kinds: &[u8]) -> Option<u16> {
    let (ae, asub, ak) = check_ref(a, kinds)?;
    if asub != SUB_NONE || !matches!(ak, EK_PERSON | EK_PERSON_ANY | EK_OBJECT) {
        return None;
    }
    let mut mask = 1u16 << ae;
    if leaf_b_is_ref(op) {
        let (be, bsub, bk) = check_ref(b, kinds)?;
        mask |= 1u16 << be;
        let plain = bsub == SUB_NONE;
        let ok = match op {
            OP_BEHIND | OP_BEYOND | OP_CROSSES => bk == EK_LINE && plain,
            OP_ENTERS | OP_LEAVES => bk == EK_ZONE || bk == EK_OBJECT, // object plain or sub-region
            OP_DISAPPEARS_INTO => bk == EK_ZONE || (bk == EK_OBJECT && bsub == SUB_OPENING),
            OP_RELEASED_BY => matches!(bk, EK_PERSON | EK_PERSON_ANY) && plain,
            _ => bk != EK_LINE,
        };
        if !ok {
            return None;
        }
        let p_ok = if op == OP_NEAR { (0..=NEAR_MAX).contains(&p) } else { p == 0 };
        if !p_ok {
            return None;
        }
        return Some(mask);
    }
    let ok = match op {
        OP_MOVING | OP_PRESENT | OP_INTACT => b == 0 && p == 0,
        OP_AT_REST => b == 0 && (1..=MAX_DURATION_FRAMES as i32).contains(&p),
        OP_SPEED => b <= CMP_NE && (0..=SPEED_MAX).contains(&p),
        OP_DIRECTION => b <= 3 && p == 0,
        OP_STANDING => b == 0 && p == 0 && matches!(ak, EK_PERSON | EK_PERSON_ANY),
        OP_REP_COUNT => {
            b <= CMP_NE && (0..=REPS_MAX as i32).contains(&p) && matches!(ak, EK_PERSON | EK_PERSON_ANY)
        }
        _ => false,
    };
    if ok {
        Some(mask)
    } else {
        None
    }
}

/// Validates an outcome condition (rules / market). `leg_ids` are the program's leg ids.
pub fn validate_condition(code: &[u8], leg_ids: &[u8]) -> Option<()> {
    let mut pos = 0usize;
    let mut nodes = 0usize;
    cond_node(code, &mut pos, leg_ids, 1, &mut nodes)?;
    if pos != code.len() {
        return None;
    }
    Some(())
}

fn cond_node(code: &[u8], pos: &mut usize, leg_ids: &[u8], level: usize, nodes: &mut usize) -> Option<()> {
    if level > MAX_EXPR_DEPTH {
        return None;
    }
    let op = *code.get(*pos)?;
    *nodes += 1;
    if *nodes > MAX_COND_NODES {
        return None;
    }
    *pos += 1;
    match op {
        OP_AND | OP_OR => {
            cond_node(code, pos, leg_ids, level + 1, nodes)?;
            cond_node(code, pos, leg_ids, level + 1, nodes)
        }
        OP_NOT => cond_node(code, pos, leg_ids, level + 1, nodes),
        OP_LEG => {
            let id = *code.get(*pos)?;
            *pos += 1;
            if leg_ids.contains(&id) {
                Some(())
            } else {
                None
            }
        }
        _ => None,
    }
}
