//! `calibration_bin` decoder (§5.3). Regions are indexed by entity index.

use crate::constants::*;
use crate::error::DecodeError;
use crate::expr::{EK_LINE, EK_ZONE};
use crate::program::{Program, ProgramKind};
use crate::reader::Reader;

pub const CALIBRATION_MAGIC: [u8; 4] = *b"VCAL";
pub const CALIBRATION_VERSION: u8 = 1;
pub const MAX_ZONE_POINTS: usize = 8;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Region {
    /// 0 none (non-region entity), 1 line, 2 zone.
    pub shape: u8,
    pub n_points: u8,
    /// Line: ±1. Zone: 0.
    pub behind_sign: i8,
    pub points: [(u16, u16); MAX_ZONE_POINTS],
}

impl Region {
    pub fn points(&self) -> &[(u16, u16)] {
        &self.points[..self.n_points as usize]
    }
    /// Point i as i64 coordinates.
    pub fn pt(&self, i: usize) -> (i64, i64) {
        (self.points[i].0 as i64, self.points[i].1 as i64)
    }
    /// `polyBBox` (§3.3) for zones.
    pub fn bbox(&self) -> (i64, i64, i64, i64) {
        let pts = self.points();
        let mut b = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
        for &(x, y) in pts {
            let (x, y) = (x as i64, y as i64);
            b.0 = b.0.min(x);
            b.1 = b.1.min(y);
            b.2 = b.2.max(x);
            b.3 = b.3.max(y);
        }
        b
    }
}

pub const SHAPE_LINE: u8 = 1;
pub const SHAPE_ZONE: u8 = 2;

#[derive(Clone, Copy, Debug)]
pub struct Calibration<'a> {
    pub scene_hash: Option<&'a [u8; 32]>,
    pub regions: [Region; MAX_ENTITIES],
}

impl<'a> Calibration<'a> {
    pub fn empty() -> Self {
        Calibration { scene_hash: None, regions: [Region::default(); MAX_ENTITIES] }
    }
}

const E: DecodeError = DecodeError::MalformedCalibration;

/// Decodes `calibration_bin` against a decoded program. ai_judged/market programs require an
/// empty calibration (§4.2, §5.6); rules programs require a VCAL blob with exactly one region
/// per region entity.
pub fn decode_calibration<'a>(bin: &'a [u8], program: &Program<'_>) -> Result<Calibration<'a>, DecodeError> {
    if program.kind != ProgramKind::Rules {
        return if bin.is_empty() { Ok(Calibration::empty()) } else { Err(E) };
    }
    decode_inner(bin, program).ok_or(E)
}

fn decode_inner<'a>(bin: &'a [u8], program: &Program<'_>) -> Option<Calibration<'a>> {
    let mut r = Reader::new(bin);
    if r.bytes(4)? != CALIBRATION_MAGIC || r.u8()? != CALIBRATION_VERSION {
        return None;
    }
    let n_regions = r.u8()? as usize;
    if r.u16()? != 0 {
        return None;
    }
    let scene_hash = r.array32()?;
    let ents = program.entities();
    let mut cal = Calibration { scene_hash: Some(scene_hash), regions: [Region::default(); MAX_ENTITIES] };
    let mut prev: i32 = -1;
    for _ in 0..n_regions {
        let idx = r.u8()? as usize;
        // Sorted strictly ascending ⇒ no duplicates.
        if idx >= ents.len() || (idx as i32) <= prev {
            return None;
        }
        prev = idx as i32;
        let shape = r.u8()?;
        let n_points = r.u8()? as usize;
        let behind_sign = r.i8()?;
        let ek = ents[idx].kind;
        let reg = &mut cal.regions[idx];
        match (ek, shape) {
            (EK_LINE, 0) => {
                if n_points != 2 || (behind_sign != 1 && behind_sign != -1) {
                    return None;
                }
                reg.shape = SHAPE_LINE;
            }
            (EK_ZONE, 1) => {
                if !(3..=MAX_ZONE_POINTS).contains(&n_points) || behind_sign != 0 {
                    return None;
                }
                reg.shape = SHAPE_ZONE;
            }
            _ => return None,
        }
        reg.n_points = n_points as u8;
        reg.behind_sign = behind_sign;
        for i in 0..n_points {
            let x = r.u16()?;
            let y = r.u16()?;
            if x > COORD_MAX || y > COORD_MAX {
                return None;
            }
            reg.points[i] = (x, y);
        }
        if reg.shape == SHAPE_LINE && reg.points[0] == reg.points[1] {
            return None;
        }
    }
    if !r.is_empty() {
        return None;
    }
    // Every region entity has exactly one region.
    for (i, e) in ents.iter().enumerate() {
        if (e.kind == EK_LINE || e.kind == EK_ZONE) && cal.regions[i].shape == 0 {
            return None;
        }
    }
    Some(cal)
}
