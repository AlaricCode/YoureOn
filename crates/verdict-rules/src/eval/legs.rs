//! Leg evaluation (§3.7), identity checkpoints (§3.8) and unknown causes (§3.9).

use super::ctx::Ctx;
use super::{Checkpoint, CheckpointSet};
use crate::constants::*;
use crate::expr::*;
use crate::program::*;
use crate::signal::Signal;

/// Max anchors kept per leg; more ⇒ the bet's checkpoint list necessarily exceeds MAX_CHECKPOINTS.
const MAX_ANCHORS: usize = MAX_CHECKPOINTS;

/// Raw evaluation of one rules leg.
#[derive(Clone, Copy)]
pub(crate) struct RawLeg<const W: usize> {
    /// 0 False, 1 True.
    pub raw: u8,
    /// holds: every frame in [0, D) ∈ F.
    pub covered: bool,
    /// Decisive frames as a position set.
    pub decisive: Signal<W>,
    /// holds with raw False: position of the first failing frame.
    pub first_fail: Option<usize>,
    /// Anchor positions for checkpoints (only when raw True and actor-bound).
    pub anchors: [u32; MAX_ANCHORS],
    pub n_anchors: usize,
    /// More anchors than MAX_ANCHORS were required.
    pub anchors_overflow: bool,
}

impl<const W: usize> RawLeg<W> {
    fn new() -> Self {
        RawLeg {
            raw: 0,
            covered: true,
            decisive: Signal::zero(),
            first_fail: None,
            anchors: [0; MAX_ANCHORS],
            n_anchors: 0,
            anchors_overflow: false,
        }
    }
    fn push_anchor(&mut self, pos: usize) {
        if self.n_anchors < MAX_ANCHORS {
            self.anchors[self.n_anchors] = pos as u32;
            self.n_anchors += 1;
        } else {
            self.anchors_overflow = true;
        }
    }
}

/// Iterates set positions `< limit` in ascending order.
fn ones<const W: usize>(s: &Signal<W>, limit: usize) -> impl Iterator<Item = usize> + '_ {
    (0..W.min(limit.div_ceil(64))).flat_map(move |wi| {
        let mut w = s.0[wi];
        core::iter::from_fn(move || {
            if w == 0 {
                return None;
            }
            let b = w.trailing_zeros() as usize;
            w &= w - 1;
            Some(wi * 64 + b)
        })
    })
    .take_while(move |&p| p < limit)
}

impl<'p, 'a, const W: usize> Ctx<'p, 'a, W> {
    /// Number of positions in F_R (frames < LIMIT); F_R is a prefix of F.
    pub(crate) fn n_rule_frames(&self) -> usize {
        let limit = self.prog.limit_frames();
        let mut n = 0usize;
        for s in self.segs() {
            let start = s.frame_start as u64;
            if start < limit {
                n += (limit - start).min(s.n_frames as u64) as usize;
            }
        }
        n
    }

    /// §3.7 raw value, decisive frames and §3.8 anchors for one rules leg.
    #[inline(never)]
    pub(crate) fn eval_leg(&self, leg: &Leg<'_>, n_r: usize) -> RawLeg<W> {
        let mut out = RawLeg::new();
        let s_sig = self.eval_expr(leg.success);
        let actor = leg.actor_bound;
        match leg.rule_kind {
            RULE_COUNT => {
                let k = leg.rule_k as i64;
                let kp = if leg.rule_cmp == CMP_GT { k + 1 } else { k } as usize;
                let rs = self.rising(&s_sig);
                if leg.rule_n > 0 {
                    let v_sig = self.eval_expr(leg.valid_attempt);
                    let rv = self.rising(&v_sig);
                    let mut it = ones(&rv, n_r).peekable();
                    let mut c = 0usize;
                    let mut n_attempts = 0usize;
                    while n_attempts < leg.rule_n as usize {
                        let Some(a) = it.next() else { break };
                        let a_frame = self.frame_of(a) as u64;
                        let mut end = a_frame + leg.attempt_window as u64;
                        if let Some(&nx) = it.peek() {
                            end = end.min(self.frame_of(nx) as u64);
                        }
                        // First rising(S) in seg(a), a ≤ f < end, f ∈ F_R.
                        let seg = self.segs().iter().find(|s| {
                            let p0 = s.pos_start as usize;
                            a >= p0 && a < p0 + s.n_frames as usize
                        });
                        let seg_end = seg.map(|s| s.pos_start as usize + s.n_frames as usize).unwrap_or(a);
                        let mut succ = u32::MAX;
                        let mut f = a;
                        while f < seg_end && f < n_r && (self.frame_of_in_seg(seg, f) as u64) < end {
                            if rs.get(f) {
                                succ = f as u32;
                                break;
                            }
                            f += 1;
                        }
                        n_attempts += 1;
                        out.decisive.set(a);
                        if succ != u32::MAX {
                            out.decisive.set(succ as usize);
                            c += 1;
                            if actor && c <= kp {
                                out.push_anchor(a);
                            }
                        }
                    }
                    out.raw = cmp_holds(leg.rule_cmp, c as i64, k) as u8;
                } else {
                    let mut c = 0usize;
                    for f in ones(&rs, n_r) {
                        out.decisive.set(f);
                        c += 1;
                        if actor && c <= kp {
                            out.push_anchor(f);
                        }
                    }
                    out.raw = cmp_holds(leg.rule_cmp, c as i64, k) as u8;
                }
                if actor && kp > MAX_ANCHORS {
                    out.anchors_overflow = true;
                }
            }
            RULE_EXISTS | RULE_NEVER | RULE_BEFORE => {
                let first = ones(&s_sig, n_r)
                    .find(|&f| leg.rule_kind != RULE_BEFORE || (self.frame_of(f) as u64) < leg.rule_n as u64);
                if let Some(f) = first {
                    out.decisive.set(f);
                }
                let exists = first.is_some();
                out.raw = if leg.rule_kind == RULE_NEVER { !exists } else { exists } as u8;
                if exists && actor && leg.rule_kind != RULE_NEVER {
                    out.push_anchor(first.unwrap());
                }
            }
            RULE_HOLDS => {
                let d = leg.rule_n;
                out.covered = self.covers_prefix(d);
                // First frame f < D in F with !S[f].
                let mut fail = None;
                'segs: for s in self.segs() {
                    let p0 = s.pos_start as usize;
                    for i in 0..s.n_frames as usize {
                        let pos = p0 + i;
                        if pos >= n_r || s.frame_start + i as u32 >= d {
                            break 'segs;
                        }
                        if !s_sig.get(pos) {
                            fail = Some(pos);
                            break 'segs;
                        }
                    }
                }
                if let Some(f) = fail {
                    out.decisive.set(f);
                }
                out.first_fail = fail;
                out.raw = (out.covered && fail.is_none()) as u8;
                if out.raw == 1 && actor {
                    if let Some(p) = self.pos_of(d - 1) {
                        out.push_anchor(p);
                    }
                }
            }
            _ => {}
        }
        if out.raw == 0 {
            out.n_anchors = 0;
            out.anchors_overflow = false;
        }
        out
    }

    fn frame_of_in_seg(&self, seg: Option<&crate::tracks::Segment>, pos: usize) -> u32 {
        match seg {
            Some(s) => s.frame_start + (pos - s.pos_start as usize) as u32,
            None => self.frame_of(pos),
        }
    }

    /// Every frame in [0, d) is in F.
    fn covers_prefix(&self, d: u32) -> bool {
        let mut next: u64 = 0;
        for s in self.segs() {
            if s.frame_start as u64 > next {
                break;
            }
            next = next.max(s.frame_start as u64 + s.n_frames as u64);
        }
        next >= d as u64
    }

    /// `persons(leg)` (§3.8): person entities in valid_attempt if any, else in success.
    pub(crate) fn persons(&self, leg: &Leg<'_>) -> u16 {
        let pm = self.prog.person_mask();
        let va = leg.va_refs & pm;
        if va != 0 {
            va
        } else {
            leg.succ_refs & pm
        }
    }

    /// Adds a leg's checkpoints to the set.
    pub(crate) fn add_checkpoints(&self, leg: &Leg<'_>, raw: &RawLeg<W>, set: &mut CheckpointSet) {
        if !leg.actor_bound || raw.raw != 1 {
            return;
        }
        if raw.anchors_overflow {
            set.overflow = true;
            return;
        }
        let persons = self.persons(leg);
        for &a in &raw.anchors[..raw.n_anchors] {
            let frame = self.frame_of(a as usize);
            for e in 0..MAX_ENTITIES {
                if persons & (1 << e) != 0 {
                    set.insert(Checkpoint { participant: self.prog.entities[e].param, frame });
                }
            }
        }
    }

    /// Whether every checkpoint of the leg passes (§3.8).
    pub(crate) fn checkpoints_pass(&self, leg: &Leg<'_>, raw: &RawLeg<W>, verified: &[Checkpoint]) -> bool {
        if !leg.actor_bound || raw.raw != 1 {
            return true;
        }
        let persons = self.persons(leg);
        for &a in &raw.anchors[..raw.n_anchors] {
            let pos = a as usize;
            let frame = self.frame_of(pos);
            for e in 0..MAX_ENTITIES {
                if persons & (1 << e) == 0 {
                    continue;
                }
                let r = self.rec(e, pos);
                let participant = self.prog.entities[e].param;
                let ok = r.present()
                    && r.id_conf >= ID_CONF_MIN
                    && verified.iter().any(|v| v.participant == participant && v.frame == frame);
                if !ok {
                    return false;
                }
            }
        }
        true
    }

    /// OCCLUSION (§3.9.3): holds leg raw False with a success entity absent at the first failing frame.
    pub(crate) fn occluded(&self, leg: &Leg<'_>, raw: &RawLeg<W>) -> bool {
        if leg.rule_kind != RULE_HOLDS || raw.raw != 0 {
            return false;
        }
        let Some(f) = raw.first_fail else { return false };
        let ents = leg.succ_refs & !self.prog.region_mask();
        (0..MAX_ENTITIES).any(|e| ents & (1 << e) != 0 && !self.present(e, f))
    }

    /// CONF (§3.9.4): a referenced non-region entity present with conf < DECISIVE_CONF_MIN at a decisive frame.
    pub(crate) fn low_conf(&self, leg: &Leg<'_>, raw: &RawLeg<W>) -> bool {
        let ents = (leg.va_refs | leg.succ_refs) & !self.prog.region_mask();
        ones(&raw.decisive, self.n).any(|d| {
            (0..MAX_ENTITIES).any(|e| {
                if ents & (1 << e) == 0 {
                    return false;
                }
                let r = self.rec(e, d);
                r.present() && r.conf < DECISIVE_CONF_MIN
            })
        })
    }
}
