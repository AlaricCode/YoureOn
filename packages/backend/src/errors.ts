/**
 * §12.8 error codes (normative; code → fixed message) and the API error type.
 *
 * Every API error is returned as
 *   HTTP 4xx/5xx  { "error": { "code": "SNAKE_CASE", "message": "<fixed message>" } }
 * The message is always the fixed one from the table (the App maps codes to
 * messages itself; the server message is informational).
 */

export const ERROR_MESSAGES = {
  UNAUTHORIZED: 'Signed out',
  NOT_FOUND: 'Not found',
  WRONG_STATE: 'Not available',
  NOT_ENROLLED: 'Not enrolled',
  LIVENESS_FAILED: 'Liveness failed',
  FACE_NOT_MATCHED: 'Face not matched',
  VOICE_NOT_MATCHED: 'Voice not matched',
  PHRASE_NOT_HEARD: 'Phrase not heard',
  CODE_INVALID: 'Code invalid',
  HUDDLE_FULL: 'Huddle full',
  DRAFT_INVALID: 'Bet not understood',
  NOT_ACCEPTED: 'Awaiting acceptance',
  CHALLENGE_EXPIRED: 'Challenge expired',
  INTERNAL: 'Server error',
  CALIBRATION_LOCKED: 'Scene locked',
  CALIBRATION_INCOMPLETE: 'Place regions',
  CAMERA_MISMATCH: 'Camera changed',
  NO_CAMERA: 'No camera',
  INSUFFICIENT_FUNDS: 'Insufficient balance',
  TX_EXPIRED: 'Request expired',
  TX_FAILED: 'Transaction failed',
  QUOTE_EXPIRED: 'Price changed',
  BAD_STAKE: 'Stake invalid',
  CHUNK_TOO_LARGE: 'Chunk too large',
  RATE_LIMITED: 'Slow down',
  WALLET_MISMATCH: 'Wrong device',
  SPEND_DISABLED: 'Spending disabled',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export const ERROR_CODES = Object.keys(ERROR_MESSAGES) as ErrorCode[];

/**
 * Default HTTP status per code. The contract fixes 409 for
 * CALIBRATION_LOCKED and 413 for CHUNK_TOO_LARGE; the rest are chosen here
 * (logged in CONTRACTS-ERRATA.md under "backend").
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  WRONG_STATE: 409,
  NOT_ENROLLED: 403,
  LIVENESS_FAILED: 422,
  FACE_NOT_MATCHED: 422,
  VOICE_NOT_MATCHED: 422,
  PHRASE_NOT_HEARD: 422,
  CODE_INVALID: 404,
  HUDDLE_FULL: 409,
  DRAFT_INVALID: 422,
  NOT_ACCEPTED: 409,
  CHALLENGE_EXPIRED: 410,
  INTERNAL: 500,
  CALIBRATION_LOCKED: 409,
  CALIBRATION_INCOMPLETE: 422,
  CAMERA_MISMATCH: 422,
  NO_CAMERA: 422,
  INSUFFICIENT_FUNDS: 402,
  TX_EXPIRED: 410,
  TX_FAILED: 422,
  QUOTE_EXPIRED: 410,
  BAD_STAKE: 422,
  CHUNK_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  WALLET_MISMATCH: 403,
  SPEND_DISABLED: 403,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, x);
}

/** An API error with a §12.8 code. `detail` is logged, never sent to clients. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string, status?: number) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code];
    this.detail = detail;
  }

  toBody(): ErrorBody {
    return errorBody(this.code);
  }
}

export function errorBody(code: ErrorCode): ErrorBody {
  return { error: { code, message: ERROR_MESSAGES[code] } };
}

/** Throws `ApiError(code)`. */
export function fail(code: ErrorCode, detail?: string, status?: number): never {
  throw new ApiError(code, detail, status);
}

/** Asserts `cond`, else throws `ApiError(code)`. */
export function ensure(cond: unknown, code: ErrorCode, detail?: string): asserts cond {
  if (!cond) throw new ApiError(code, detail);
}

/** Spend guard error (§13). Thrown by providers that would incur cost without `ALLOW_SPEND=1`. */
export class SpendDisabledError extends ApiError {
  constructor(what: string) {
    super('SPEND_DISABLED', `${what} can incur cost; set ALLOW_SPEND=1 to enable`);
    this.name = 'SpendDisabledError';
  }
}

/** Marker for scaffold routes/providers that a service agent still has to implement. */
export class NotImplementedError extends ApiError {
  constructor(what: string) {
    super('INTERNAL', `not implemented: ${what}`, 501);
    this.name = 'NotImplementedError';
  }
}

/** Normalizes anything thrown into an ApiError (unknown errors → INTERNAL). */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new ApiError('INTERNAL', msg);
}
