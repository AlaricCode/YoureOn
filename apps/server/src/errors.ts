// The error envelope. Throw `new HttpError('CODE', …)` from any handler; the app's onError turns
// it into `{error: {code, message, retryable, details?, request_id}}`.
// Spec: docs/planning/API-CONTRACT.md §1.5.
import type { ZodError } from 'zod/v4';
import {
  API_ERROR_HTTP,
  API_ERROR_RETRYABLE,
  type ApiError,
  type ApiErrorCode,
  type ValidationIssue,
} from '@youre-on/shared/api';

/** User-presentable default messages (the app may show `message` as-is). */
const DEFAULT_MESSAGE: Partial<Record<ApiErrorCode, string>> = {
  AUTH_REQUIRED: 'Please sign in again.',
  SESSION_EXPIRED: 'Your session expired. Signing you back in.',
  SIGNATURE_INVALID: "We couldn't verify this device.",
  CLOCK_SKEW: "Your phone's clock is off. Retrying.",
  CHALLENGE_EXPIRED: 'That sign-in attempt expired. Try again.',
  DEVICE_REVOKED: 'This device was signed out.',
  AGE_REQUIRED: "You must confirm you're 18 or older to use You're On.",
  VALIDATION_FAILED: 'Something in that request was not valid.',
  PAYLOAD_TOO_LARGE: 'That upload is too large.',
  IDEMPOTENCY_KEY_REUSED: 'That request was already used for something else.',
  NOT_FOUND: 'Not found.',
  INVALID_STATE: "That can't be done right now.",
  RATE_LIMITED: 'Slow down a moment, then try again.',
  INTERNAL: 'Something went wrong on our side. Try again.',
};

export class HttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly headers: Record<string, string> | undefined;
  constructor(
    readonly code: ApiErrorCode,
    message?: string,
    readonly details?: Record<string, unknown>,
    opts?: { retryable?: boolean; headers?: Record<string, string> },
  ) {
    super(message ?? DEFAULT_MESSAGE[code] ?? code);
    this.name = 'HttpError';
    this.status = API_ERROR_HTTP[code];
    this.retryable = opts?.retryable ?? API_ERROR_RETRYABLE[code];
    this.headers = opts?.headers;
  }
}

export function errorBody(
  code: ApiErrorCode | string,
  message: string,
  retryable: boolean,
  requestId: string,
  details?: Record<string, unknown>,
): ApiError {
  return {
    error: {
      code,
      message,
      retryable,
      ...(details !== undefined ? { details } : {}),
      request_id: requestId,
    },
  };
}

export function zodIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

export function validationError(err: ZodError): HttpError {
  return new HttpError('VALIDATION_FAILED', undefined, { issues: zodIssues(err) });
}
