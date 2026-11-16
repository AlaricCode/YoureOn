// DRAFT of the face consent text, version `face-consent-v1` (TASKS D3-M3 step 2: E2 writes the v1
// text; a teammate checks it against the FINDINGS §6 step 16 legal re-read). The server serves the
// real copy from `GET /v1/face/consent`; this draft feeds the preview stand-in and is the proposal
// for the server's copy. Facts from ARCHITECTURE §6.7 and README "Privacy by design". Not legal
// advice. Party-screen copy: no chain or crypto words (copy rule, TASKS D5-M2).

export const FACE_CONSENT_V1_TEXT =
  "Face matching is optional. If you turn it on, You're On uses your face so friends in the same " +
  'room can challenge you by pointing their camera at you. A match only picks who is being ' +
  'challenged. It never moves money or confirms a bet; Face ID does that. ' +
  'Your phone turns three photos of you into a face template (a list of numbers). The photos never ' +
  'leave your phone. We keep one encrypted template, never sell or share it, and only compare it ' +
  'with people in rooms you join. ' +
  'You can turn matching off or delete your template at any time. We delete it automatically ' +
  '180 days after it was last used, 30 days after you turn matching off, or on December 31, 2026, ' +
  'whichever comes first.';

export const FACE_CONSENT_V1_RETENTION =
  'Deleted 180 days after last use, 30 days after you turn it off, or on December 31, 2026.';
