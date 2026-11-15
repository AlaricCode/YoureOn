//! Evaluation context: frame space (§3.2), record access, operand geometry and stale sub-regions (§2.3).

use crate::calibration::{Calibration, Region};
use crate::constants::*;
use crate::expr::*;
use crate::geometry::{self, Poly, Pt, Rect};
use crate::program::Program;
use crate::signal::Signal;
use crate::tracks::{Record, Segment, Tracks, RECORD_LEN};

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
    /// Zone, prepared for the even-odd test (carries `polyBBox`).
    Zone(&'r Poly),
    Line(&'r Region),
}

impl<'r> BGeom<'r> {
    #[inline(always)]
    pub fn defined(&self) -> bool {
        !matches!(self, BGeom::Undef)
    }
    /// `bbox_b` (§3.3); `None` for lines/undefined.
    #[inline(always)]
    pub fn bbox(&self) -> Option<Rect> {
        match *self {
            BGeom::Box(b) | BGeom::Sub(b, _) => Some(b),
            BGeom::Zone(z) => Some(z.bb),
            _ => None,
        }
    }
}

const B_DYNAMIC: u8 = 0;
const B_LINE: u8 = 1;
const B_ZONE: u8 = 2;

/// Running state that resolves a `b` ref at successive frames of one pass over F.
/// Sub-regions keep the last present box of the owning object within the segment (stale rule).
/// The ref is resolved once (entity, sub-region, region geometry) at construction.
pub(crate) struct BTracker<'r> {
    e: usize,
    sub: u8,
    /// B_DYNAMIC (object/person), B_LINE or B_ZONE.
    shape: u8,
    region: &'r Region,
    poly: Poly,
    last: Option<(u32, Rect)>,
}

impl<'r> BTracker<'r> {
    pub fn new<const W: usize>(cx: &Ctx<'r, '_, W>, r: u8) -> Self {
        let e = ref_entity(r);
        let region = &cx.cal.regions[e];
        let (shape, poly) = match cx.prog.entities[e].kind {
            EK_LINE => (B_LINE, Poly::new::<u16>(&[])),
            EK_ZONE => (B_ZONE, Poly::new(region.points())),
            _ => (B_DYNAMIC, Poly::new::<u16>(&[])),
        };
        BTracker { e, sub: ref_sub(r), shape, region, poly, last: None }
    }
    /// The geometry of a line/zone ref (the same at every frame, always defined).
    #[inline(always)]
    pub fn fixed(&self) -> Option<BGeom<'_>> {
        match self.shape {
            B_LINE => Some(BGeom::Line(self.region)),
            B_ZONE => Some(BGeom::Zone(&self.poly)),
            _ => None,
        }
    }
    /// Call at every frame in order; `first_in_seg` resets the stale state.
    #[inline(always)]
    pub fn at<const W: usize>(&mut self, cx: &Ctx<'_, '_, W>, pos: usize, frame: u32, first_in_seg: bool) -> BGeom<'_> {
        if self.shape != B_DYNAMIC {
            return self.fixed().unwrap_or(BGeom::Undef);
        }
        if first_in_seg {
            self.last = None;
        }
        let bx = cx.bx(self.e, pos);
        if self.sub == SUB_NONE {
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
                let rect = if self.sub == SUB_OPENING { geometry::opening(c) } else { geometry::interior(c) };
                BGeom::Sub(rect, c)
            }
            None => BGeom::Undef,
        }
    }
}

impl<'p, 'a, const W: usize> Ctx<'p, 'a, W> {
    pub fn segs(&self) -> &[Segment] {
        self.trk.segments()
    }

    /// Raw 12 bytes of entity `e`'s record at `pos`.
    #[inline(always)]
    fn rec_bytes(&self, e: usize, pos: usize) -> &'a [u8; RECORD_LEN] {
        let t = self.trk.entity_track[e];
        debug_assert!(t != 0xFF);
        self.trk.record_bytes(t as usize, pos)
    }
    #[inline(always)]
    pub fn rec(&self, e: usize, pos: usize) -> Record {
        Record::from_bytes(self.rec_bytes(e, pos))
    }
    #[inline(always)]
    pub fn present(&self, e: usize, pos: usize) -> bool {
        self.rec_bytes(e, pos)[8] >= PRESENCE_MIN
    }
    #[inline(always)]
    pub fn bx(&self, e: usize, pos: usize) -> Option<Rect> {
        let b = self.rec_bytes(e, pos);
        if b[8] >= PRESENCE_MIN {
            let c = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]) as i64;
            Some((c(0), c(2), c(4), c(6)))
        } else {
            None
        }
    }
    /// Anchor point: persons → feet, objects → center (§2.2).
    #[inline(always)]
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

    /// `rising(X)` (§3.6) over all of F: `X[g] ∧ (g = 0 ∨ (g−1 ∈ seg(g) ∧ ¬X[g−1]))`.
    /// Word-level: `X ∧ ¬(X << 1)`, then each segment's first position is fixed up.
    pub fn rising(&self, x: &Signal<W>) -> Signal<W> {
        let mut out = Signal::zero();
        let mut carry = 0u64;
        for (o, &w) in out.0.iter_mut().zip(x.0.iter()).take(self.n.div_ceil(64)) {
            let prev = (w << 1) | carry;
            carry = w >> 63;
            *o = w & !prev;
        }
        for s in self.segs() {
            let p0 = s.pos_start as usize;
            // The previous frame is outside F: rising only at absolute frame 0.
            out.clear(p0);
            if s.frame_start == 0 && x.get(p0) {
                out.set(p0);
            }
        }
        out
    }
}
