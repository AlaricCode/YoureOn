//! One module per instruction (ESCROW-PROGRAM §5). Config: `initialize_config`, `update_config`.
//! Lock: `create_bet`, `accept_bet`. Ruling: `resolve`, `appeal`. Terminal (token-moving, via the
//! single `crate::payout::payout()`): `cancel_open_bet`, `concede`, `resolve_appeal`, `finalize`,
//! `timeout_refund`. Housekeeping: `close_bet`.

pub mod accept_bet;
pub mod appeal;
pub mod cancel_open_bet;
pub mod close_bet;
pub mod concede;
pub mod create_bet;
pub mod finalize;
pub mod initialize_config;
pub mod resolve;
pub mod resolve_appeal;
pub mod timeout_refund;
pub mod update_config;

pub use accept_bet::*;
pub use appeal::*;
pub use cancel_open_bet::*;
pub use close_bet::*;
pub use concede::*;
pub use create_bet::*;
pub use finalize::*;
pub use initialize_config::*;
pub use resolve::*;
pub use resolve_appeal::*;
pub use timeout_refund::*;
pub use update_config::*;
