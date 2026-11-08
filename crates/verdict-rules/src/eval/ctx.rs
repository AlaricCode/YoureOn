//! Evaluation context: frame space (§3.2), record access, operand geometry and stale sub-regions (§2.3).

use crate::calibration::{Calibration, Region};
use crate::constants::*;
use crate::expr::*;
use crate::geometry::{self, Pt, Rect};
use crate::program::Program;
use crate::signal::Signal;
use crate::tracks::{Record, Segment, Tracks};

pub(crate) struct Ctx<'p, 'a, const W: usize> {
    pub prog: &'p Program<'a>,
    pub cal: &'p Calibration<'a>,
    pub trk: &'p Tracks<'a>,
    /// |F|.
    pub n: usize,
}

/// Geometry of a `b` operand at one frame.
#[derive(Clone, Copy)]
pub(crate) enum BGeom<'r> {
    /// b undefined at this frame (absent object/person, or sub-region with no container).
    Undef,
    /// Object/person box.
    Box(Rect),
    /// Sub-region rect, with its container box.
    Sub(Rect, Rect),
    Zone(&'r Region),
    Line(&'r Region),
}

impl<'r> BGeom<'r> {
    pub fn defined(&self) -> bool {
        !matches!(self, BGeom::Undef)
    }
    /// `bbox_b` (§3.3); `None` for lines/undefined.
    pub fn bbox(&self) -> Option<Rect> {
        match *self {
            BGeom::Box(b) | BGeom::Sub(b, _) => Some(b),
            BGeom::Zone(z) => Some(z.bbox()),
            _ => None,
        }
    }
}

/// Running state that resolves a `b` ref at successive frames of one pass over F.
/// Sub-regions keep the last present box of the owning object within the segment (stale rule).
pub(crate) struct BTracker {
    r: u8,
    last: Option<(u32, Rect)>,
}

impl BTracker {
    pub fn new(r: u8) -> Self {
        BTracker { r, last: None }
    }
    /// Call at every frame in order; `first_in_seg` resets the stale state.
    pub fn at<'r, const W: usize>(&mut self, cx: &'r Ctx<'_, '_, W>, pos: usize, frame: u32, first_in_seg: bool) -> BGeom<'r> {
        let e = ref_entity(self.r);
        let sub = ref_sub(self.r);
        let kind = cx.prog.entities[e].kind;
        match kind {
            EK_LINE => BGeom::Line(&cx.cal.regions[e]),
            EK_ZONE => BGeom::Zone(&cx.cal.regions[e]),
            _ => {
                if first_in_seg {
                    self.last = None;
                }
                let bx = cx.bx(e, pos);
                if sub == SUB_NONE {
                    return match bx {
                        Some(b) => BGeom::Box(b),
                        None => BGeom::Undef,
                    };
                }
                let cont = match bx {
                    Some(b) => {
                        self.last = Some((frame, b));
                        Some(b)
                    }
                    None => match self.last {
                        Some((lf, b)) if frame - lf <= STALE_REGION_FRAMES => Some(b),
                        _ => None,
                    },
                };
                match cont {
                    Some(c) => {
                        let rect = if sub == SUB_OPENING { geometry::opening(c) } else { geometry::interior(c) };
                        BGeom::Sub(rect, c)
                    }
                    None => BGeom::Undef,
                }
            }
        }
    }
}

impl<'p, 'a, const W: usize> Ctx<'p, 'a, W> {
    pub fn segs(&self) -> &[Segment] {
        self.trk.segments()
    }

    #[inline]
    pub fn rec(&self, e: usize, pos: usize) -> Record {
        let t = self.trk.entity_track[e];
        debug_assert!(t != 0xFF);
        self.trk.record(t as usize, pos)
    }
    #[inline]
    pub fn present(&self, e: usize, pos: usize) -> bool {
        self.rec(e, pos).present()
    }
    #[inline]
    pub fn bx(&self, e: usize, pos: usize) -> Option<Rect> {
        let r = self.rec(e, pos);
        if r.present() {
            Some((r.x0 as i64, r.y0 as i64, r.x1 as i64, r.y1 as i64))
        } else {
            None
        }
    }
    /// Anchor point: persons → feet, objects → center (§2.2).
    #[inline]
    pub fn anchor(&self, e: usize, b: Rect) -> Pt {
        match self.prog.entities[e].kind {
            EK_PERSON | EK_PERSON_ANY => geometry::feet(b),
            _ => geometry::center(b),
        }
    }

    /// Signal of `present(e)`.
    pub fn present_sig(&self, e: usize) -> Signal<W> {
        let mut s = Signal::zero();
        for pos in 0..self.n {
            s.put(pos, self.present(e, pos));
        }
        s
    }

    /// Absolute frame of a position.
    pub fn frame_of(&self, pos: usize) -> u32 {
        for s in self.segs() {
            let p0 = s.pos_start as usize;
            if pos < p0 + s.n_frames as usize {
                return s.frame_start + (pos - p0) as u32;
            }
        }
        u32::MAX
    }

    /// Position of an absolute frame, if in F.
    pub fn pos_of(&self, frame: u32) -> Option<usize> {
        for s in self.segs() {
            if frame >= s.frame_start && frame < s.frame_start + s.n_frames as u32 {
                return Some(s.pos_start as usize + (frame - s.frame_start) as usize);
            }
        }
        None
    }

    /// `rising(X)` (§3.6) over all of F.
    pub fn rising(&self, x: &Signal<W>) -> Signal<W> {
        let mut out = Signal::zero();
        for s in self.segs() {
            let p0 = s.pos_start as usize;
            for i in 0..s.n_frames as usize {
                let pos = p0 + i;
                if !x.get(pos) {
                    continue;
                }
                let frame = s.frame_start + i as u32;
                if frame == 0 || (i > 0 && !x.get(pos - 1)) {
                    out.set(pos);
                }
            }
        }
        out
    }
}
