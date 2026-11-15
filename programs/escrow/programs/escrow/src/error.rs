//! `EscrowError` (ESCROW-PROGRAM §8.1). APPEND-ONLY after the first deploy: the numeric codes
//! (6000 + variant index) are part of the client contract. Never reorder, rename or remove.

use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority, // 6000
    #[msg("Signer is not the config admin")]
    NotAdmin, // 6001
    #[msg("Config values are invalid")]
    InvalidConfig, // 6002
    #[msg("The escrow is paused for new bets")]
    Paused, // 6003
    #[msg("Mint is not on the allowlist")]
    MintNotAllowed, // 6004
    #[msg("Token-2022 mint carries an extension that is not allowed")]
    MintExtensionNotAllowed, // 6005
    #[msg("Mint does not match the bet's mint")]
    WrongMint, // 6006
    #[msg("Stakes must be greater than zero")]
    StakeZero, // 6007
    #[msg("Stake exceeds the configured maximum")]
    StakeExceedsMax, // 6008
    #[msg("party_a and party_b must differ")]
    SameParty, // 6009
    #[msg("Party key is not allowed")]
    InvalidParty, // 6010
    #[msg("Hash must not be all zero")]
    EmptyHash, // 6011
    #[msg("Terms hash does not match the bet")]
    TermsHashMismatch, // 6012
    #[msg("Stakes do not match the bet")]
    StakeMismatch, // 6013
    #[msg("Bet status does not allow this instruction")]
    InvalidStatus, // 6014
    #[msg("Signer is not the bet's party_b")]
    NotPartyB, // 6015
    #[msg("Signer is not a party to this bet")]
    NotParty, // 6016
    #[msg("Signer is not the losing party")]
    NotLoser, // 6017
    #[msg("Concede is not allowed for this outcome")]
    ConcedeNotAllowed, // 6018
    #[msg("Signer may not cancel this bet")]
    NotAuthorizedToCancel, // 6019
    #[msg("Signer is not the bet's judge authority")]
    NotJudge, // 6020
    #[msg("Signer is not the bet's appeal authority")]
    NotAppealAuthority, // 6021
    #[msg("Accept deadline has passed")]
    AcceptDeadlinePassed, // 6022
    #[msg("Resolve deadline has passed")]
    ResolveDeadlinePassed, // 6023
    #[msg("Appeal window is closed")]
    AppealWindowClosed, // 6024
    #[msg("Appeal window is still open")]
    AppealWindowOpen, // 6025
    #[msg("Appeal resolve deadline has passed")]
    AppealResolveDeadlinePassed, // 6026
    #[msg("Deadline has not been reached")]
    DeadlineNotReached, // 6027
    #[msg("Payout account is not owned by the party")]
    WrongPayoutAccount, // 6028
    #[msg("Rent payer does not match the bet")]
    WrongRentPayer, // 6029
    #[msg("Vault received less than the stake")]
    VaultUnderfunded, // 6030
    #[msg("Vault is not empty")]
    VaultNotEmpty, // 6031
    #[msg("Arithmetic overflow")]
    MathOverflow, // 6032
    #[msg("party_a does not match the bet")]
    PartyMismatch, // 6033
    #[msg("Mint must have 6 decimals")]
    WrongDecimals, // 6034
    #[msg("Payout account required for a non-zero amount")]
    MissingPayoutAccount, // 6035
    #[msg("Accept deadline is out of range")]
    InvalidDeadline, // 6036
}
