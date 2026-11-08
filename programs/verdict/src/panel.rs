//! Panel judge quorum via the Ed25519 precompile (CONTRACTS.md §9.7).
//!
//! The settle transaction carries exactly one Ed25519 instruction, immediately before
//! `settle_panel`, with two signatures over the same 145-byte message `M` in a fixed 367-byte
//! layout. The precompile verifies the signatures; this module checks layout, message and keys.
use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::constants::PANEL_MSG_LEN;
use crate::errors::VerdictError;

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const ED25519_IX_LEN: usize = 367;
const NONE: u16 = 0xFFFF;

/// Fixed header: `num_signatures = 2`, padding 0, then two offset entries (§9.7).
pub const ED25519_HEADER: [u16; 14] = [
    62, NONE, 30, NONE, 222, PANEL_MSG_LEN as u16, NONE, // entry 0
    158, NONE, 126, NONE, 222, PANEL_MSG_LEN as u16, NONE, // entry 1
];

/// Builds the 367-byte instruction data (used by clients and tests).
pub fn build_ed25519_data(pk0: &[u8; 32], sig0: &[u8; 64], pk1: &[u8; 32], sig1: &[u8; 64], msg: &[u8; PANEL_MSG_LEN]) -> [u8; ED25519_IX_LEN] {
    let mut d = [0u8; ED25519_IX_LEN];
    d[0] = 2;
    d[1] = 0;
    for (i, v) in ED25519_HEADER.iter().enumerate() {
        d[2 + 2 * i..4 + 2 * i].copy_from_slice(&v.to_le_bytes());
    }
    d[30..62].copy_from_slice(pk0);
    d[62..126].copy_from_slice(sig0);
    d[126..158].copy_from_slice(pk1);
    d[158..222].copy_from_slice(sig1);
    d[222..367].copy_from_slice(msg);
    d
}

/// Validates the fixed layout and message; returns the two judge keys `(pk0, pk1)`.
pub fn parse_ed25519_data(data: &[u8], expected_msg: &[u8; PANEL_MSG_LEN]) -> Result<(Pubkey, Pubkey)> {
    require!(data.len() == ED25519_IX_LEN, VerdictError::BadEd25519Instruction);
    require!(data[0] == 2 && data[1] == 0, VerdictError::BadEd25519Instruction);
    for (i, v) in ED25519_HEADER.iter().enumerate() {
        let got = u16::from_le_bytes([data[2 + 2 * i], data[3 + 2 * i]]);
        require!(got == *v, VerdictError::BadEd25519Instruction);
    }
    require!(&data[222..367] == expected_msg.as_slice(), VerdictError::BadEd25519Instruction);
    let pk0 = Pubkey::new_from_array(data[30..62].try_into().unwrap());
    let pk1 = Pubkey::new_from_array(data[126..158].try_into().unwrap());
    Ok((pk0, pk1))
}

/// Checks that the two keys are distinct judges of the bet.
pub fn check_quorum(pk0: &Pubkey, pk1: &Pubkey, judges: &[Pubkey; 3]) -> Result<()> {
    require!(pk0 != pk1, VerdictError::InsufficientQuorum);
    require!(judges.contains(pk0) && judges.contains(pk1), VerdictError::InsufficientQuorum);
    Ok(())
}

/// Full §9.7 check against the instructions sysvar.
pub fn verify_panel_quorum(ix_sysvar: &AccountInfo, expected_msg: &[u8; PANEL_MSG_LEN], judges: &[Pubkey; 3]) -> Result<()> {
    let current = load_current_index_checked(ix_sysvar)? as usize;
    require!(current >= 1, VerdictError::BadEd25519Instruction);

    // Exactly one Ed25519 instruction in the transaction, at `current - 1`.
    let n_ix = {
        let data = ix_sysvar.try_borrow_data()?;
        require!(data.len() >= 2, VerdictError::BadEd25519Instruction);
        u16::from_le_bytes([data[0], data[1]]) as usize
    };
    for i in 0..n_ix {
        if i == current - 1 {
            continue;
        }
        let ix = load_instruction_at_checked(i, ix_sysvar)?;
        require!(ix.program_id != ED25519_PROGRAM_ID, VerdictError::BadEd25519Instruction);
    }

    let ix = load_instruction_at_checked(current - 1, ix_sysvar)?;
    require!(ix.program_id == ED25519_PROGRAM_ID, VerdictError::BadEd25519Instruction);
    let (pk0, pk1) = parse_ed25519_data(&ix.data, expected_msg)?;
    check_quorum(&pk0, &pk1, judges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_tamper() {
        let msg = [7u8; PANEL_MSG_LEN];
        let d = build_ed25519_data(&[1; 32], &[2; 64], &[3; 32], &[4; 64], &msg);
        let (a, b) = parse_ed25519_data(&d, &msg).unwrap();
        assert_eq!(a, Pubkey::new_from_array([1; 32]));
        assert_eq!(b, Pubkey::new_from_array([3; 32]));
        assert!(parse_ed25519_data(&d, &[8u8; PANEL_MSG_LEN]).is_err());
        assert!(parse_ed25519_data(&d[..366], &msg).is_err());
        for off in [0usize, 1, 2, 5, 15, 16, 28, 29] {
            let mut t = d;
            t[off] ^= 1;
            assert!(parse_ed25519_data(&t, &msg).is_err(), "offset {off}");
        }
        let judges = [Pubkey::new_from_array([1; 32]), Pubkey::new_from_array([3; 32]), Pubkey::new_from_array([5; 32])];
        assert!(check_quorum(&a, &b, &judges).is_ok());
        assert!(check_quorum(&a, &a, &judges).is_err());
        assert!(check_quorum(&a, &Pubkey::new_from_array([9; 32]), &judges).is_err());
    }
}
