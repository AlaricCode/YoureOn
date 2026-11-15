/// Error code → fixed display message (CONTRACTS.md §12.8).
///
/// The App shows only these messages; the server's own `message` field is
/// informational and never displayed.
const Map<String, String> kErrorMessages = {
  'UNAUTHORIZED': 'Signed out',
  'NOT_FOUND': 'Not found',
  'WRONG_STATE': 'Not available',
  'NOT_ENROLLED': 'Not enrolled',
  'LIVENESS_FAILED': 'Liveness failed',
  'FACE_NOT_MATCHED': 'Face not matched',
  'VOICE_NOT_MATCHED': 'Voice not matched',
  'PHRASE_NOT_HEARD': 'Phrase not heard',
  'CODE_INVALID': 'Code invalid',
  'HUDDLE_FULL': 'Huddle full',
  'DRAFT_INVALID': 'Bet not understood',
  'NOT_ACCEPTED': 'Awaiting acceptance',
  'CHALLENGE_EXPIRED': 'Challenge expired',
  'INTERNAL': 'Server error',
  'CALIBRATION_LOCKED': 'Scene locked',
  'CALIBRATION_INCOMPLETE': 'Place regions',
  'CAMERA_MISMATCH': 'Camera changed',
  'NO_CAMERA': 'No camera',
  'INSUFFICIENT_FUNDS': 'Insufficient balance',
  'TX_EXPIRED': 'Request expired',
  'TX_FAILED': 'Transaction failed',
  'QUOTE_EXPIRED': 'Price changed',
  'BAD_STAKE': 'Stake invalid',
  'CHUNK_TOO_LARGE': 'Chunk too large',
  'RATE_LIMITED': 'Slow down',
  'WALLET_MISMATCH': 'Wrong device',
  'SPEND_DISABLED': 'Spending disabled',
};

/// Display message for a code. Unknown codes (and transport failures, which
/// the client maps to `INTERNAL`) fall back to "Server error".
String errorMessage(String code) => kErrorMessages[code] ?? kErrorMessages['INTERNAL']!;
