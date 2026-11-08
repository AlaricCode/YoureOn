//! VERDICT rule interpreter (CONTRACTS.md §3, §5, §9.8).
//!
//! `#![no_std]`, no `alloc`, no Anchor dependency. Used by `programs/verdict` (onchain, `W = 16`)
//! and the SP1 guest (larger `W`, `max_cost = None`).
//!
//! Entry points: [`evaluate`] / [`evaluate_payload`] (decode + §3 evaluation), the individual
//! decoders ([`decode_program`], [`decode_calibration`], [`decode_tracks`], [`decode_market`]) and
//! the settlement math in [`settle`].
#![no_std]
#![forbid(unsafe_code)]

pub mod calibration;
pub mod constants;
pub mod error;
pub mod eval;
pub mod expr;
pub mod geometry;
pub mod program;
mod reader;
pub mod settle;
pub mod signal;
pub mod tracks;

pub use calibration::{decode_calibration, Calibration, Region};
pub use error::{DecodeError, SettleError};
pub use eval::{
    evaluate, evaluate_decoded, evaluate_detailed, evaluate_market, evaluate_payload,
    evaluate_with_frame_cap, Checkpoint, EvalDetail, EvalOutput, LegCause,
};
pub use program::{decode_program, Leg, Program, ProgramKind};
pub use signal::Signal;
pub use tracks::{decode_market, decode_tracks, decode_tracks_with_cap, MarketResults, Record, Tracks};

/// Onchain signal width: `W = 16` words = `MAX_EVAL_FRAMES` (1024) positions.
pub const ONCHAIN_W: usize = constants::MAX_EVAL_FRAMES / 64;
