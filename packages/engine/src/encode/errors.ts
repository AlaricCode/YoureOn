/**
 * Decoder / encoder errors carrying a §9.6 error name (e.g. `MalformedProgram`).
 * Test vectors express decoder rejections as `{"error": "<name>"}` (§0.6).
 */
import type { ErrorCode } from '../types.js';

export class EngineError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** True iff `e` is an `EngineError` (optionally with the given code). */
export function isEngineError(e: unknown, code?: ErrorCode): e is EngineError {
  return e instanceof EngineError && (code === undefined || e.code === code);
}

/** Throw `EngineError(code, detail)` unless `cond`. */
export function check(cond: boolean, code: ErrorCode, detail: string): asserts cond {
  if (!cond) throw new EngineError(code, detail);
}
