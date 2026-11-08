//! Biometric Groth16 verification (CONTRACTS.md §8.6) with `groth16-solana`.
use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

use crate::errors::VerdictError;

pub mod vk;

pub const NR_INPUTS: usize = vk::NR_PUBLIC_INPUTS;

/// Encodes a small integer as a 32-byte big-endian field element.
pub fn field_u32(v: u32) -> [u8; 32] {
    let mut f = [0u8; 32];
    f[28..].copy_from_slice(&v.to_be_bytes());
    f
}

/// `0x00 ‖ x[1..32]` as a big-endian field element (§8.6 `bet_field`, `evidence_field`).
pub fn field_truncated(x: &[u8; 32]) -> [u8; 32] {
    let mut f = *x;
    f[0] = 0;
    f
}

/// Public inputs in snarkjs order (§8.6).
pub fn public_inputs(
    commitment: &[u8; 32],
    bet: &Pubkey,
    evidence_root: &[u8; 32],
    participant: u8,
    frame: u32,
    modality: u8,
    tau_bps: u16,
) -> [[u8; 32]; NR_INPUTS] {
    [
        *commitment,
        field_truncated(&bet.to_bytes()),
        field_truncated(evidence_root),
        field_u32(participant as u32),
        field_u32(frame),
        field_u32(modality as u32),
        field_u32(tau_bps as u32),
        field_u32(1),
    ]
}

/// `mock-zk` (tests only): a proof whose `proof_a` is 64 × 0x01 is accepted.
pub fn is_mock_proof(proof_a: &[u8; 64]) -> bool {
    cfg!(feature = "mock-zk") && proof_a.iter().all(|&b| b == 1)
}

/// Verifies a Groth16 proof against the committed verifying key.
pub fn verify(proof_a: &[u8; 64], proof_b: &[u8; 128], proof_c: &[u8; 64], inputs: &[[u8; 32]; NR_INPUTS]) -> Result<()> {
    if is_mock_proof(proof_a) {
        return Ok(());
    }
    let mut v = Groth16Verifier::<NR_INPUTS>::new(proof_a, proof_b, proof_c, inputs, &vk::VK)
        .map_err(|_| error!(VerdictError::BadProof))?;
    v.verify().map_err(|_| error!(VerdictError::BadProof))
}
