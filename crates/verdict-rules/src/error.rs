//! Decoder errors. Names and codes match the Anchor `#[error_code]` list (§9.6).

/// A decode-time rejection (§3.1 step 1). The `Display`/`name()` string is the §9.6 name,
/// which is also what golden vectors use in `expected.error`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    MalformedProgram,
    MalformedCalibration,
    MalformedTracks,
}

impl DecodeError {
    pub const fn name(self) -> &'static str {
        match self {
            DecodeError::MalformedProgram => "MalformedProgram",
            DecodeError::MalformedCalibration => "MalformedCalibration",
            DecodeError::MalformedTracks => "MalformedTracks",
        }
    }

    /// Anchor error number (§9.6, numbered from 6000).
    pub const fn code(self) -> u32 {
        match self {
            DecodeError::MalformedProgram => 6023,
            DecodeError::MalformedCalibration => 6024,
            DecodeError::MalformedTracks => 6025,
        }
    }
}

impl core::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.name())
    }
}

/// Settlement math errors (§9.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleError {
    /// `MathOverflow` (6038): a sum or product left its integer range.
    MathOverflow,
    /// `BadOutcome` (6031): empty winner set, zero winning stake, or bits ≥ n.
    BadOutcome,
}
