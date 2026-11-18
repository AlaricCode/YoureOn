// The face consent text, version `face-consent-v1` (TASKS D3-M3 step 2), now owned by
// packages/shared/src/face.ts so the server serves exactly the text the phone hashes. The copy
// from `GET /v1/face/consent` is what the screens show; these feed the preview stand-in.
// Not legal advice. Party-screen copy: no chain or crypto words (copy rule, TASKS D5-M2).
export {
  FACE_CONSENT_V1_RETENTION,
  FACE_CONSENT_V1_TEXT,
  FACE_CONSENT_VERSION,
} from '@youre-on/shared/face';
