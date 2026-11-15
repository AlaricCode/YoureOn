//! ESCROW-PROGRAM §9.2 matrix as Rust LiteSVM tests (run `anchor build` first; `cargo test`).
//! Row IDs prefix every test name (c1_, u3_, b19_, a12_, n1_ ...).

// LiteSVM's FailedTransactionMetadata is large by design; boxing it would only add noise.
#![allow(clippy::result_large_err)]

mod accept_bet;
mod common;
mod config;
mod create_bet;
mod lock;
