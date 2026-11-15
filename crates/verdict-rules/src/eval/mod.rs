//! The evaluator (§3): check order, legs, checkpoints, outcome and pre-ruling.

mod ctx;
mod leaf;
mod legs;
mod node;

use crate::calibration::{decode_calibration, Calibration};
use crate::constants::*;
use crate::error::DecodeError;
use crate::expr::*;
use crate::program::{decode_program, Program, ProgramKind};
use crate::signal::Signal;
use crate::tracks::{decode_market, decode_tracks_with_cap, MarketResults, Tracks, FLAG_CAMERA_MOTION, FLAG_CROSS_CHECK_OK, FLAG_WINDOW_UNAVAILABLE};
use ctx::Ctx;

/// Pre-ruling codes (§3.10).
pub const PRERULING_WINNER: u8 = 1;
pub const PRERULING_NO_CONTEST: u8 = 2;
pub const PRERULING_NEEDS_PANEL: u8 = 3;

/// NEEDS_PANEL reasons (§3.10).
pub const REASON_NONE: u8 = 0;
pub const REASON_LOW_CONFIDENCE: u8 = 10;
pub const REASON_AI_JUDGED: u8 = 11;
pub const REASON_CROSS_CHECK_FAILED: u8 = 12;
pub const REASON_WINDOW_UNAVAILABLE: u8 = 13;

/// Leg values.
pub const LEG_FALSE: u8 = 0;
pub const LEG_TRUE: u8 = 1;
pub const LEG_UNKNOWN: u8 = 2;
pub const LEG_UNUSED: u8 = 0xFF;

/// Unknown causes (§3.9, §3.11). 0 = none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LegCause {
    Motion = 1,
    Coverage = 2,
    Occlusion = 3,
    Conf = 4,
    Identity = 5,
    Void = 6,
}

impl LegCause {
    pub const fn name(self) -> &'static str {
        match self {
            LegCause::Motion => "MOTION",
            LegCause::Coverage => "COVERAGE",
            LegCause::Occlusion => "OCCLUSION",
            LegCause::Conf => "CONF",
            LegCause::Identity => "IDENTITY",
            LegCause::Void => "VOID",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Checkpoint {
    pub participant: u8,
    pub frame: u32,
}

/// Contract result (§3.12, Rust form).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvalOutput {
    pub preruling: u8,
    pub reason: u8,
    pub winner_mask: u8,
    /// Per leg in program order; unused = 0xFF.
    pub leg_results: [u8; MAX_LEGS],
    pub n_checkpoints: u8,
    /// Sorted by (frame, participant); unused entries are (0, 0).
    pub checkpoints: [(u8, u32); MAX_CHECKPOINTS],
}

impl EvalOutput {
    pub fn is_ok(&self) -> bool {
        self.preruling == PRERULING_WINNER
    }
    pub fn status(&self) -> &'static str {
        if self.is_ok() {
            "ok"
        } else {
            "needs_panel"
        }
    }
}

/// [`EvalOutput`] plus diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvalDetail {
    pub out: EvalOutput,
    pub n_legs: u8,
    /// Per leg: recorded Unknown cause, if any.
    pub leg_causes: [Option<LegCause>; MAX_LEGS],
    /// §3.13 cost (0 when not computed).
    pub cost: u64,
}

/// Bounded, deduplicated, sorted checkpoint set.
pub(crate) struct CheckpointSet {
    pub items: [Checkpoint; MAX_CHECKPOINTS],
    pub len: usize,
    pub overflow: bool,
}

impl CheckpointSet {
    fn new() -> Self {
        CheckpointSet { items: [Checkpoint::default(); MAX_CHECKPOINTS], len: 0, overflow: false }
    }
    pub fn insert(&mut self, c: Checkpoint) {
        let key = |c: &Checkpoint| (c.frame, c.participant);
        if self.items[..self.len].iter().any(|x| x == &c) {
            return;
        }
        if self.len == MAX_CHECKPOINTS {
            self.overflow = true;
            return;
        }
        let mut i = self.len;
        while i > 0 && key(&self.items[i - 1]) > key(&c) {
            self.items[i] = self.items[i - 1];
            i -= 1;
        }
        self.items[i] = c;
        self.len += 1;
    }
}

/// Decodes all three parts and evaluates (§3.1). `max_cost = None` means ∞ (SP1 guest).
/// Onchain: `W = 16`.
pub fn evaluate<const W: usize>(
    program_bin: &[u8],
    calibration_bin: &[u8],
    tracks_bin: &[u8],
    verified: &[Checkpoint],
    max_cost: Option<u64>,
) -> Result<EvalOutput, DecodeError> {
    evaluate_detailed::<W>(program_bin, calibration_bin, tracks_bin, verified, max_cost).map(|d| d.out)
}

/// Evaluates a TrackBuffer payload `program ‖ calibration ‖ tracks` (§5.6).
pub fn evaluate_payload<const W: usize>(
    payload: &[u8],
    program_len: usize,
    calibration_len: usize,
    verified: &[Checkpoint],
    max_cost: Option<u64>,
) -> Result<EvalOutput, DecodeError> {
    if program_len > payload.len() {
        return Err(DecodeError::MalformedProgram);
    }
    if program_len + calibration_len > payload.len() {
        return Err(DecodeError::MalformedCalibration);
    }
    let (p, rest) = payload.split_at(program_len);
    let (c, t) = rest.split_at(calibration_len);
    evaluate::<W>(p, c, t, verified, max_cost)
}

/// As [`evaluate`], with diagnostics. Uses the onchain frame cap `MAX_EVAL_FRAMES`.
pub fn evaluate_detailed<const W: usize>(
    program_bin: &[u8],
    calibration_bin: &[u8],
    tracks_bin: &[u8],
    verified: &[Checkpoint],
    max_cost: Option<u64>,
) -> Result<EvalDetail, DecodeError> {
    evaluate_with_frame_cap::<W>(program_bin, calibration_bin, tracks_bin, verified, max_cost, MAX_EVAL_FRAMES)
}

/// As [`evaluate_detailed`] with a custom decoder frame cap (SP1 guest: larger cap, `max_cost = None`).
pub fn evaluate_with_frame_cap<const W: usize>(
    program_bin: &[u8],
    calibration_bin: &[u8],
    tracks_bin: &[u8],
    verified: &[Checkpoint],
    max_cost: Option<u64>,
    max_frames: usize,
) -> Result<EvalDetail, DecodeError> {
    // Decode order: program → calibration → tracks (§3.1 step 1).
    let program = decode_program(program_bin)?;
    let cal = decode_calibration(calibration_bin, &program)?;
    if program.kind == ProgramKind::Market {
        let m = decode_market(tracks_bin)?;
        return Ok(evaluate_market(&program, &m));
    }
    let trk = decode_tracks_with_cap(tracks_bin, &program, max_frames)?;
    Ok(evaluate_decoded::<W>(&program, &cal, &trk, verified, max_cost))
}

fn blank(n_legs: usize) -> EvalDetail {
    EvalDetail {
        out: EvalOutput {
            preruling: PRERULING_NEEDS_PANEL,
            reason: REASON_NONE,
            winner_mask: 0,
            leg_results: [LEG_UNUSED; MAX_LEGS],
            n_checkpoints: 0,
            checkpoints: [(0, 0); MAX_CHECKPOINTS],
        },
        n_legs: n_legs as u8,
        leg_causes: [None; MAX_LEGS],
        cost: 0,
    }
}

fn panel(n_legs: usize, reason: u8, cost: u64) -> EvalDetail {
    let mut d = blank(n_legs);
    d.out.reason = reason;
    d.cost = cost;
    for r in d.out.leg_results.iter_mut().take(n_legs) {
        *r = LEG_UNKNOWN;
    }
    d
}

/// §3.10: Kleene evaluation of the condition, then the pre-ruling.
fn finish(program: &Program<'_>, mut d: EvalDetail) -> EvalDetail {
    let legs = program.legs();
    let value_of = |id: u8| -> u8 {
        legs.iter().position(|l| l.id == id).map(|i| d.out.leg_results[i]).unwrap_or(LEG_UNKNOWN)
    };
    let mut pos = 0usize;
    let v = kleene(program.condition, &mut pos, &value_of);
    match v {
        LEG_TRUE | LEG_FALSE => {
            let side = if v == LEG_TRUE { program.if_true } else { program.else_side };
            let mut mask = 0u8;
            for i in 0..program.n_participants as usize {
                if program.side(i) == side {
                    mask |= 1 << i;
                }
            }
            d.out.preruling = PRERULING_WINNER;
            d.out.reason = REASON_NONE;
            d.out.winner_mask = mask;
        }
        _ => {
            d.out.preruling = PRERULING_NEEDS_PANEL;
            d.out.reason = REASON_LOW_CONFIDENCE;
            d.out.winner_mask = 0;
        }
    }
    d
}

fn kleene(code: &[u8], pos: &mut usize, value_of: &impl Fn(u8) -> u8) -> u8 {
    let op = code[*pos];
    *pos += 1;
    match op {
        OP_AND => {
            let l = kleene(code, pos, value_of);
            let r = kleene(code, pos, value_of);
            if l == LEG_FALSE || r == LEG_FALSE {
                LEG_FALSE
            } else if l == LEG_TRUE && r == LEG_TRUE {
                LEG_TRUE
            } else {
                LEG_UNKNOWN
            }
        }
        OP_OR => {
            let l = kleene(code, pos, value_of);
            let r = kleene(code, pos, value_of);
            if l == LEG_TRUE || r == LEG_TRUE {
                LEG_TRUE
            } else if l == LEG_FALSE && r == LEG_FALSE {
                LEG_FALSE
            } else {
                LEG_UNKNOWN
            }
        }
        OP_NOT => match kleene(code, pos, value_of) {
            LEG_TRUE => LEG_FALSE,
            LEG_FALSE => LEG_TRUE,
            _ => LEG_UNKNOWN,
        },
        OP_LEG => {
            let id = code[*pos];
            *pos += 1;
            value_of(id)
        }
        _ => LEG_UNKNOWN,
    }
}

/// §3.11 market programs.
pub fn evaluate_market(program: &Program<'_>, m: &MarketResults<'_>) -> EvalDetail {
    let legs = program.legs();
    let mut d = blank(legs.len());
    for (i, leg) in legs.iter().enumerate() {
        let res = leg.market_hash().and_then(|h| m.result(h));
        d.out.leg_results[i] = match res {
            Some(r) if r <= 1 => (r as u16 == leg.rule_k) as u8,
            _ => {
                d.leg_causes[i] = Some(LegCause::Void);
                LEG_UNKNOWN
            }
        };
    }
    finish(program, d)
}

#[derive(Clone, Copy, Default)]
struct LegSummary {
    raw: u8,
    covered: bool,
    occluded: bool,
    low_conf: bool,
    checkpoints_pass: bool,
}

#[inline(never)]
fn summarize<const W: usize>(
    cx: &Ctx<'_, '_, W>,
    leg: &crate::program::Leg<'_>,
    n_r: usize,
    set: &mut CheckpointSet,
    verified: &[Checkpoint],
) -> LegSummary {
    let raw = cx.eval_leg(leg, n_r);
    cx.add_checkpoints(leg, &raw, set);
    LegSummary {
        raw: raw.raw,
        covered: raw.covered,
        occluded: cx.occluded(leg, &raw),
        low_conf: cx.low_conf(leg, &raw),
        checkpoints_pass: cx.checkpoints_pass(leg, &raw, verified),
    }
}

/// §3.1 steps 2–5 on decoded rules / ai_judged inputs.
pub fn evaluate_decoded<const W: usize>(
    program: &Program<'_>,
    cal: &Calibration<'_>,
    trk: &Tracks<'_>,
    verified: &[Checkpoint],
    max_cost: Option<u64>,
) -> EvalDetail {
    let n_legs = program.n_legs as usize;
    match program.kind {
        ProgramKind::AiJudged => return panel(0, REASON_AI_JUDGED, 0),
        ProgramKind::Market => return panel(n_legs, REASON_WINDOW_UNAVAILABLE, 0),
        ProgramKind::Rules => {}
    }
    if trk.flags & FLAG_WINDOW_UNAVAILABLE != 0 {
        return panel(n_legs, REASON_WINDOW_UNAVAILABLE, 0);
    }
    if trk.flags & FLAG_CROSS_CHECK_OK == 0 {
        return panel(n_legs, REASON_CROSS_CHECK_FAILED, 0);
    }
    let n = trk.n_frames as usize;
    // §3.13: `(|F| + EVAL_COST_SETUP_FRAMES) × Σw` — the setup term charges each node's
    // per-evaluation work (decode, signal set-up, region preparation) as extra frames.
    let cost = (n as u64 + EVAL_COST_SETUP_FRAMES) * program.weight_per_frame();
    if max_cost.is_some_and(|m| cost > m) || n > Signal::<W>::CAPACITY {
        return panel(n_legs, REASON_WINDOW_UNAVAILABLE, cost);
    }

    let cx: Ctx<'_, '_, W> = Ctx { prog: program, cal, trk, n };
    let n_r = cx.n_rule_frames();
    let mut d = blank(n_legs);
    d.cost = cost;

    // Raw values, checkpoints and the cause flags that don't depend on the whole bet.
    // Kept compact (no signals) to stay well inside the SBF 4 KiB stack frame.
    let motion = trk.flags & FLAG_CAMERA_MOTION != 0;
    let mut sums = [LegSummary::default(); MAX_LEGS];
    let mut set = CheckpointSet::new();
    for (i, leg) in program.legs().iter().enumerate() {
        sums[i] = summarize(&cx, leg, n_r, &mut set, verified);
    }
    if !set.overflow {
        d.out.n_checkpoints = set.len as u8;
        for (k, c) in set.items[..set.len].iter().enumerate() {
            d.out.checkpoints[k] = (c.participant, c.frame);
        }
    }

    // Unknown causes, in order (§3.9).
    for (i, leg) in program.legs().iter().enumerate() {
        let raw = &sums[i];
        let cause = if motion {
            Some(LegCause::Motion)
        } else if !raw.covered {
            Some(LegCause::Coverage)
        } else if raw.occluded {
            Some(LegCause::Occlusion)
        } else if raw.low_conf {
            Some(LegCause::Conf)
        } else if leg.actor_bound && (set.overflow || !raw.checkpoints_pass) {
            Some(LegCause::Identity)
        } else {
            None
        };
        d.leg_causes[i] = cause;
        d.out.leg_results[i] = if cause.is_some() { LEG_UNKNOWN } else { raw.raw };
    }
    finish(program, d)
}

/// Diagnostics: the `success` signal of leg `leg_idx`, and the absolute frame of each position.
/// Calls `f(frame, value)` for every frame of F in order. Intended for parity debugging/tests.
pub fn for_each_success_value<const W: usize>(
    program: &Program<'_>,
    cal: &Calibration<'_>,
    trk: &Tracks<'_>,
    leg_idx: usize,
    mut f: impl FnMut(u32, bool),
) {
    let n = trk.n_frames as usize;
    if program.kind != ProgramKind::Rules || leg_idx >= program.n_legs as usize || n > Signal::<W>::CAPACITY {
        return;
    }
    let cx: Ctx<'_, '_, W> = Ctx { prog: program, cal, trk, n };
    let s = cx.eval_expr(program.legs[leg_idx].success);
    for seg in trk.segments() {
        for i in 0..seg.n_frames as usize {
            f(seg.frame_start + i as u32, s.get(seg.pos_start as usize + i));
        }
    }
}
