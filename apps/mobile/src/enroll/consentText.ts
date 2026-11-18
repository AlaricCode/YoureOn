// The face consent text, version `face-consent-v1`, now served by the server from one source
// (packages/shared/src/face.ts, GET /v1/face/consent). Re-exported for the preview stand-in.
import { FACE_CONSENT_V1 } from '@youre-on/shared/face';

export const FACE_CONSENT_V1_TEXT: string = FACE_CONSENT_V1.text;
export const FACE_CONSENT_V1_RETENTION: string = FACE_CONSENT_V1.retention_summary;
