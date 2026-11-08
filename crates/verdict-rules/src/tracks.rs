//! `track_bin` (§5.4) and `market_bin` (§5.5) decoders. Records are read in place.

use crate::constants::*;
use crate::error::DecodeError;
use crate::expr::EK_PERSON;
use crate::program::{Program, ProgramKind};
use crate::reader::{le_u16, Reader};

pub const TRACK_MAGIC: [u8; 4] = *b"VTRK";
pub const TRACK_VERSION: u8 = 1;
pub const MARKET_MAGIC: [u8; 4] = *b"VMKT";
pub const MARKET_VERSION: u8 = 1;
pub const RECORD_LEN: usize = 12;
pub const TRACK_HEADER_LEN: usize = 44;

pub const FLAG_CAMERA_MOTION: u8 = 1 << 0;
pub const FLAG_CROSS_CHECK_OK: u8 = 1 << 1;
pub const FLAG_AUDIO_DISAGREE: u8 = 1 << 2;
pub const FLAG_WINDOW_UNAVAILABLE: u8 = 1 << 3;
pub const FLAG_PHONE_DISAGREE: u8 = 1 << 4;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Segment {
    pub frame_start: u32,
    pub n_frames: u16,
    /// Position in F of the first frame of this segment.
    pub pos_start: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TrackInfo {
    pub entity_idx: u8,
    pub participant_idx: u8,
    pub ref_h: u16,
}

/// One 12-byte record (§5.4).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Record {
    pub x0: u16,
    pub y0: u16,
    pub x1: u16,
    pub y1: u16,
    pub conf: u8,
    pub fill: u8,
    pub id_conf: u8,
    pub pose: u8,
}

impl Record {
    pub fn parse(b: &[u8]) -> Record {
        Record {
            x0: le_u16(b, 0),
            y0: le_u16(b, 2),
            x1: le_u16(b, 4),
            y1: le_u16(b, 6),
            conf: b[8],
            fill: b[9],
            id_conf: b[10],
            pose: b[11],
        }
    }
    #[inline]
    pub fn present(&self) -> bool {
        self.conf >= PRESENCE_MIN
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Tracks<'a> {
    pub flags: u8,
    pub model_hash: &'a [u8; 32],
    pub n_tracks: u8,
    pub tracks: [TrackInfo; MAX_ENTITIES],
    /// Track index per entity index (0xFF = untracked).
    pub entity_track: [u8; MAX_ENTITIES],
    pub n_segments: u8,
    pub segments: [Segment; MAX_SEGMENTS],
    /// Σ n_frames = |F|.
    pub n_frames: u32,
    /// Records, segment-major, then frame, then track.
    pub records: &'a [u8],
}

impl<'a> Tracks<'a> {
    pub fn segments(&self) -> &[Segment] {
        &self.segments[..self.n_segments as usize]
    }
    /// Record of track `t` at position `pos` in F.
    #[inline]
    pub fn record(&self, t: usize, pos: usize) -> Record {
        let off = (pos * self.n_tracks as usize + t) * RECORD_LEN;
        Record::parse(&self.records[off..off + RECORD_LEN])
    }
}

const E: DecodeError = DecodeError::MalformedTracks;

/// Decodes `track_bin` for a rules or ai_judged program, with the onchain frame cap.
pub fn decode_tracks<'a>(bin: &'a [u8], program: &Program<'_>) -> Result<Tracks<'a>, DecodeError> {
    decode_tracks_with_cap(bin, program, MAX_EVAL_FRAMES)
}

/// As [`decode_tracks`] with a custom `Σ n_frames` cap (the SP1 guest uses a larger one).
pub fn decode_tracks_with_cap<'a>(
    bin: &'a [u8],
    program: &Program<'_>,
    max_frames: usize,
) -> Result<Tracks<'a>, DecodeError> {
    if program.kind == ProgramKind::Market {
        return Err(E);
    }
    decode_inner(bin, program, max_frames).ok_or(E)
}

fn decode_inner<'a>(bin: &'a [u8], program: &Program<'_>, max_frames: usize) -> Option<Tracks<'a>> {
    let mut r = Reader::new(bin);
    if r.bytes(4)? != TRACK_MAGIC || r.u8()? != TRACK_VERSION || r.u8()? as u32 != FPS {
        return None;
    }
    let n_tracks = r.u8()? as usize;
    let n_segments = r.u8()? as usize;
    let flags = r.u8()?;
    if flags & 0xE0 != 0 || r.bytes(3)? != [0, 0, 0] {
        return None;
    }
    let model_hash = r.array32()?;

    // Track table: exactly the tracked entities, ascending.
    if n_tracks != program.n_tracked() || n_segments > MAX_SEGMENTS {
        return None;
    }
    let mut tracks = [TrackInfo::default(); MAX_ENTITIES];
    let mut entity_track = [0xFFu8; MAX_ENTITIES];
    let mut mask = program.tracked_mask;
    for (j, info) in tracks.iter_mut().enumerate().take(n_tracks) {
        let e = mask.trailing_zeros() as usize;
        mask &= mask - 1;
        let entity_idx = r.u8()?;
        let participant_idx = r.u8()?;
        let ref_h = r.u16()?;
        let ent = program.entities[e];
        let want_part = if ent.kind == EK_PERSON { ent.param } else { 0xFF };
        if entity_idx as usize != e || participant_idx != want_part {
            return None;
        }
        *info = TrackInfo { entity_idx, participant_idx, ref_h };
        entity_track[e] = j as u8;
    }

    let window_unavailable = flags & FLAG_WINDOW_UNAVAILABLE != 0;
    if n_segments == 0 && !(window_unavailable || program.kind == ProgramKind::AiJudged) {
        return None;
    }
    if n_segments != 0 && window_unavailable {
        return None;
    }
    let max_frame_excl = program.limit_frames() + TAIL_FRAMES as u64;
    let mut segments = [Segment::default(); MAX_SEGMENTS];
    let mut total: u64 = 0;
    let mut next_min: u64 = 0;
    for seg in segments.iter_mut().take(n_segments) {
        let start = r.u32()?;
        let n = r.u16()?;
        if r.u16()? != 0 || n == 0 || (start as u64) < next_min {
            return None;
        }
        let end = start as u64 + n as u64;
        if end > max_frame_excl {
            return None;
        }
        *seg = Segment { frame_start: start, n_frames: n, pos_start: total as u32 };
        total += n as u64;
        if total > max_frames as u64 {
            return None;
        }
        next_min = end;
    }
    let rec_len = RECORD_LEN * n_tracks * total as usize;
    if r.remaining() != rec_len {
        return None;
    }
    let records = r.bytes(rec_len)?;
    for (i, chunk) in records.chunks_exact(RECORD_LEN).enumerate() {
        let t = i % n_tracks;
        let is_person = program.entities[tracks[t].entity_idx as usize].kind == EK_PERSON;
        let is_object = program.entities[tracks[t].entity_idx as usize].kind == crate::expr::EK_OBJECT;
        if !record_ok(&Record::parse(chunk), is_person, is_object) {
            return None;
        }
    }
    Some(Tracks {
        flags,
        model_hash,
        n_tracks: n_tracks as u8,
        tracks,
        entity_track,
        n_segments: n_segments as u8,
        segments,
        n_frames: total as u32,
        records,
    })
}

fn record_ok(rec: &Record, is_person: bool, is_object: bool) -> bool {
    if rec.conf > 100 || rec.fill > 100 || rec.id_conf > 100 {
        return false;
    }
    if rec.conf == 0 {
        return *rec == Record::default();
    }
    if rec.x0 > rec.x1 || rec.x1 > COORD_MAX || rec.y0 > rec.y1 || rec.y1 > COORD_MAX {
        return false;
    }
    if rec.id_conf != 0 && !is_person {
        return false;
    }
    if rec.pose & 0xF8 != 0 || rec.pose & 0x06 == 0x06 {
        return false;
    }
    if rec.pose != 0 && is_object {
        return false;
    }
    true
}

pub const MARKET_ENTRY_LEN: usize = 33;

#[derive(Clone, Copy, Debug)]
pub struct MarketResults<'a> {
    /// n × (market_hash[32], result u8).
    pub entries: &'a [u8],
}

impl<'a> MarketResults<'a> {
    pub fn len(&self) -> usize {
        self.entries.len() / MARKET_ENTRY_LEN
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    /// Result for a market_hash: 0 no, 1 yes, 2 void; `None` if missing.
    pub fn result(&self, hash: &[u8; 32]) -> Option<u8> {
        self.entries
            .chunks_exact(MARKET_ENTRY_LEN)
            .find(|e| &e[..32] == hash)
            .map(|e| e[32])
    }
}

/// Decodes `market_bin` (§5.5). Errors are `MalformedTracks`.
pub fn decode_market(bin: &[u8]) -> Result<MarketResults<'_>, DecodeError> {
    let mut r = Reader::new(bin);
    let ok = (|| {
        if r.bytes(4)? != MARKET_MAGIC || r.u8()? != MARKET_VERSION {
            return None;
        }
        let n = r.u8()? as usize;
        if r.u16()? != 0 || r.remaining() != n * MARKET_ENTRY_LEN {
            return None;
        }
        let entries = r.bytes(n * MARKET_ENTRY_LEN)?;
        for (i, e) in entries.chunks_exact(MARKET_ENTRY_LEN).enumerate() {
            if e[32] > 2 {
                return None;
            }
            if entries.chunks_exact(MARKET_ENTRY_LEN).take(i).any(|p| p[..32] == e[..32]) {
                return None;
            }
        }
        Some(MarketResults { entries })
    })();
    ok.ok_or(E)
}
