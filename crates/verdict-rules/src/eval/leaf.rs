//! Leaf primitives: state (§3.4) and event (§3.5) signals.

use super::ctx::{BGeom, BTracker, Ctx};
use crate::constants::*;
use crate::expr::*;
use crate::geometry::{self, Rect};
use crate::signal::Signal;

impl<'p, 'a, const W: usize> Ctx<'p, 'a, W> {
    #[inline(never)]
    pub(crate) fn leaf(&self, op: u8, a: u8, b: u8, p: i32) -> Signal<W> {
        let ae = ref_entity(a);
        match op {
            OP_OVERLAPS | OP_INSIDE | OP_ABOVE | OP_BELOW | OP_NEAR | OP_BEHIND | OP_BEYOND => {
                self.spatial(op, ae, b, p).0
            }
            OP_MOVING => self.velocity_pred(ae, |v| v.speed >= MOVE_MIN_UPS),
            OP_SPEED => self.velocity_pred(ae, |v| cmp_holds(b, v.speed, p as i64)),
            OP_DIRECTION => self.velocity_pred(ae, |v| v.speed >= MOVE_MIN_UPS && direction_ok(b, v.dx, v.dy)),
            OP_AT_REST => {
                let still = self.velocity_pred(ae, |v| v.speed <= STILL_MAX_UPS);
                self.for_duration(p as u32, &still)
            }
            OP_PRESENT => self.present_sig(ae),
            OP_INTACT => {
                let t = self.trk.entity_track[ae] as usize;
                let ref_h = self.trk.tracks[t].ref_h as u64;
                self.record_pred(ae, |r| (r.y1 - r.y0) as u64 * 100 >= ref_h * INTACT_PCT)
            }
            OP_STANDING => self.record_pred(ae, |r| r.pose & 0x01 != 0),
            OP_REP_COUNT => self.rep_count(ae, b, p as i64),
            OP_ENTERS | OP_LEAVES => self.enters_leaves(op == OP_ENTERS, ae, b),
            OP_TOUCHES => self.touches(ae, b),
            OP_CROSSES => self.crosses(ae, b),
            OP_RELEASED_BY => self.released_by(ae, ref_entity(b)),
            OP_DISAPPEARS_INTO => self.disappears_into(ae, b),
            _ => Signal::zero(),
        }
    }

    /// `present(a) && pred(record)`.
    fn record_pred(&self, ae: usize, pred: impl Fn(&crate::tracks::Record) -> bool) -> Signal<W> {
        let mut s = Signal::zero();
        for pos in 0..self.n {
            let r = self.rec(ae, pos);
            s.put(pos, r.present() && pred(&r));
        }
        s
    }

    /// Spatial state primitive and the "b defined" signal.
    #[inline(never)]
    pub(crate) fn spatial(&self, op: u8, ae: usize, b: u8, p: i32) -> (Signal<W>, Signal<W>) {
        let mut out = Signal::zero();
        let mut def = Signal::zero();
        let mut bt = BTracker::new(b);
        for s in self.segs() {
            for i in 0..s.n_frames as usize {
                let pos = s.pos_start as usize + i;
                let g = bt.at(self, pos, s.frame_start + i as u32, i == 0);
                def.put(pos, g.defined());
                if let Some(a) = self.bx(ae, pos) {
                    out.put(pos, self.spatial_at(op, ae, a, &g, p));
                }
            }
        }
        (out, def)
    }

    fn spatial_at(&self, op: u8, ae: usize, a: Rect, g: &BGeom<'_>, p: i32) -> bool {
        let ca = geometry::center(a);
        match op {
            OP_OVERLAPS => match *g {
                BGeom::Box(r) | BGeom::Sub(r, _) => geometry::inter(a, r).is_some(),
                BGeom::Zone(z) => {
                    geometry::pt_in_poly(ca, z.points()) || geometry::pt_in_poly(self.anchor(ae, a), z.points())
                }
                _ => false,
            },
            OP_INSIDE => match *g {
                BGeom::Box(r) => {
                    if !geometry::pt_in_rect(ca, r) {
                        return false;
                    }
                    let aa = geometry::area(a);
                    if aa == 0 {
                        return true;
                    }
                    let ia = geometry::inter(a, r).map(geometry::area).unwrap_or(0);
                    2 * ia >= aa
                }
                BGeom::Sub(r, _) => geometry::pt_in_rect(ca, r),
                BGeom::Zone(z) => geometry::pt_in_poly(self.anchor(ae, a), z.points()),
                _ => false,
            },
            OP_ABOVE | OP_BELOW => match g.bbox() {
                Some(bb) => {
                    let xo = a.0 < bb.2 && bb.0 < a.2;
                    xo && if op == OP_ABOVE { ca.1 < bb.1 } else { ca.1 > bb.3 }
                }
                None => false,
            },
            OP_NEAR => match g.bbox() {
                Some(bb) => {
                    let gx = 0.max(bb.0 - a.2).max(a.0 - bb.2);
                    let gy = 0.max(bb.1 - a.3).max(a.1 - bb.3);
                    let d = p as i64;
                    gx * gx + gy * gy <= d * d
                }
                None => false,
            },
            OP_BEHIND | OP_BEYOND => match *g {
                BGeom::Line(l) => {
                    let s = geometry::side(l.pt(0), l.pt(1), self.anchor(ae, a));
                    let want = if op == OP_BEHIND { l.behind_sign as i64 } else { -(l.behind_sign as i64) };
                    s != 0 && s == want
                }
                _ => false,
            },
            _ => false,
        }
    }

    /// Velocity predicate: true where `vel` is defined and `pred` holds (§3.3).
    fn velocity_pred(&self, ae: usize, pred: impl Fn(&Vel) -> bool) -> Signal<W> {
        let k = VEL_K as usize;
        let mut out = Signal::zero();
        for s in self.segs() {
            for i in k..s.n_frames as usize {
                let pos = s.pos_start as usize + i;
                if let (Some(b1), Some(b0)) = (self.bx(ae, pos), self.bx(ae, pos - k)) {
                    let (c1, c0) = (geometry::center(b1), geometry::center(b0));
                    let dx = c1.0 - c0.0;
                    let dy = c1.1 - c0.1;
                    let speed = geometry::isqrt((dx * dx + dy * dy) as u64) as i64 * FPS as i64 / VEL_K as i64;
                    out.put(pos, pred(&Vel { dx, dy, speed }));
                }
            }
        }
        out
    }

    /// `rep_count(a) cmp n`: reps scanned over all of F, across segments (§3.4).
    fn rep_count(&self, ae: usize, cmp: u8, n: i64) -> Signal<W> {
        let mut out = Signal::zero();
        let mut low = false;
        let mut count: i64 = 0;
        for pos in 0..self.n {
            let r = self.rec(ae, pos);
            if !r.present() {
                continue;
            }
            if r.pose & 0x02 != 0 {
                low = true;
            } else if r.pose & 0x04 != 0 {
                if low {
                    count += 1;
                }
                low = false;
            }
            out.put(pos, cmp_holds(cmp, count, n));
        }
        out
    }

    /// Calls `f(pos, lastSeen(a, pos))` for every frame in order (§3.2 lastSeen).
    fn with_last_seen(&self, ae: usize, mut f: impl FnMut(usize, Option<usize>)) {
        for s in self.segs() {
            let mut last: Option<(usize, u32)> = None;
            for i in 0..s.n_frames as usize {
                let pos = s.pos_start as usize + i;
                let frame = s.frame_start + i as u32;
                let ls = match last {
                    Some((lp, lf)) if frame - lf <= RELEASE_GAP => Some(lp),
                    _ => None,
                };
                f(pos, ls);
                if self.present(ae, pos) {
                    last = Some((pos, frame));
                }
            }
        }
    }

    fn enters_leaves(&self, enters: bool, ae: usize, b: u8) -> Signal<W> {
        let (ins, def) = self.spatial(OP_INSIDE, ae, b, 0);
        let mut out = Signal::zero();
        self.with_last_seen(ae, |f, ls| {
            let Some(p) = ls else { return };
            if !(def.get(f) && def.get(p)) {
                return;
            }
            let v = if enters {
                ins.get(f) && !ins.get(p)
            } else {
                self.present(ae, f) && !ins.get(f) && ins.get(p)
            };
            out.put(f, v);
        });
        out
    }

    fn touches(&self, ae: usize, b: u8) -> Signal<W> {
        let (ov, def) = self.spatial(OP_OVERLAPS, ae, b, 0);
        let mut out = Signal::zero();
        self.with_last_seen(ae, |f, ls| {
            if let Some(p) = ls {
                out.put(f, def.get(p) && ov.get(f) && !ov.get(p));
            }
        });
        out
    }

    fn crosses(&self, ae: usize, b: u8) -> Signal<W> {
        let l = &self.cal.regions[ref_entity(b)];
        let side_at = |pos: usize| -> i64 {
            match self.bx(ae, pos) {
                Some(bx) => geometry::side(l.pt(0), l.pt(1), self.anchor(ae, bx)),
                None => 0,
            }
        };
        let mut out = Signal::zero();
        self.with_last_seen(ae, |f, ls| {
            let Some(p) = ls else { return };
            if !self.present(ae, f) {
                return;
            }
            let (s0, s1) = (side_at(p), side_at(f));
            out.put(f, s0 != 0 && s1 != 0 && s0 != s1);
        });
        out
    }

    fn released_by(&self, ae: usize, be: usize) -> Signal<W> {
        let held = |g: usize| -> bool {
            match (self.bx(ae, g), self.bx(be, g)) {
                (Some(a), Some(b)) => {
                    geometry::pt_in_rect(geometry::center(a), geometry::expand(b, HAND_EXPAND_PCT))
                }
                _ => false,
            }
        };
        let mut out = Signal::zero();
        for s in self.segs() {
            // State of the most recent present frame of `a` in this segment:
            // (frame, held, heldrun capped at RELEASE_HOLD).
            let mut last: Option<(u32, bool, u32)> = None;
            for i in 0..s.n_frames as usize {
                let pos = s.pos_start as usize + i;
                let frame = s.frame_start + i as u32;
                if !self.present(ae, pos) {
                    continue;
                }
                // lastSeen(a, f): the latest present frame, if within RELEASE_GAP.
                let ls = last.filter(|&(lf, _, _)| frame - lf <= RELEASE_GAP);
                let h = held(pos);
                if !h {
                    if let Some((_, true, run)) = ls {
                        if run >= RELEASE_HOLD {
                            out.set(pos);
                        }
                    }
                }
                let run = match (h, ls) {
                    (false, _) => 0,
                    (true, Some((_, true, r))) => (r + 1).min(RELEASE_HOLD),
                    (true, _) => 1,
                };
                last = Some((frame, h, run));
            }
        }
        out
    }

    #[inline(never)]
    fn disappears_into(&self, ae: usize, b: u8) -> Signal<W> {
        // entry[f] = (1) ∧ (2); stay[g] = !present(a,g) ∨ center(a,g) inside the container at g.
        let mut entry = Signal::<W>::zero();
        let mut stay = Signal::<W>::zero();
        let mut bt = BTracker::new(b);
        for s in self.segs() {
            for i in 0..s.n_frames as usize {
                let pos = s.pos_start as usize + i;
                let g = bt.at(self, pos, s.frame_start + i as u32, i == 0);
                let a = self.bx(ae, pos);
                let (e_ok, s_ok) = match (a, g) {
                    (None, _) => (false, true),
                    (Some(a), BGeom::Zone(z)) => {
                        let inz = geometry::pt_in_poly(geometry::center(a), z.points());
                        (inz, inz)
                    }
                    (Some(a), BGeom::Sub(rect, cont)) => {
                        let c = geometry::center(a);
                        (geometry::pt_in_rect(c, rect), geometry::pt_in_rect(c, cont))
                    }
                    (Some(_), _) => (false, false),
                };
                entry.put(pos, e_ok);
                stay.put(pos, s_ok);
            }
        }
        let mut out = Signal::zero();
        let k = DISAPPEAR_FRAMES as usize;
        let lb = DESCEND_LOOKBACK as usize;
        for s in self.segs() {
            let p0 = s.pos_start as usize;
            let n = s.n_frames as usize;
            let mut prev_raw = false;
            for i in 0..n {
                let pos = p0 + i;
                let raw = entry.get(pos) && i + k < n && {
                    let cy = geometry::center(self.bx(ae, pos).unwrap()).1;
                    let descending = (i.saturating_sub(lb)..i)
                        .any(|j| self.bx(ae, p0 + j).is_some_and(|bj| cy > geometry::center(bj).1));
                    descending
                        && (pos + 1..=pos + k).all(|g| stay.get(g))
                        && (pos + 1..=pos + k).any(|g| !self.present(ae, g))
                };
                if raw && !(i > 0 && prev_raw) {
                    out.set(pos);
                }
                prev_raw = raw;
            }
        }
        out
    }
}

struct Vel {
    dx: i64,
    dy: i64,
    speed: i64,
}

fn direction_ok(dir: u8, dx: i64, dy: i64) -> bool {
    match dir {
        0 => dy < 0 && 2 * dy.abs() >= dx.abs(),
        1 => dy > 0 && 2 * dy >= dx.abs(),
        2 => dx < 0 && 2 * dx.abs() >= dy.abs(),
        _ => dx > 0 && 2 * dx >= dy.abs(),
    }
}
