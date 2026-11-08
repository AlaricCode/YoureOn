/**
 * Compile errors for the rule language (§2.7).
 */
import type { CompileError, CompileErrorCode, CompileWarningCode } from '../types.js';

export function compileError(
  path: string,
  code: CompileErrorCode | CompileWarningCode,
  message: string,
  col?: number,
): CompileError {
  const e: CompileError = { path, code, message };
  if (col !== undefined) e.col = col;
  return e;
}

/**
 * Thrown by the throwing API surface (`canonicalize`, `compileMarket`, the
 * low-level string parsers) when the input cannot be compiled. Carries the
 * same `CompileError` list that `parseYaml` would return.
 */
export class LangError extends Error {
  readonly errors: CompileError[];
  constructor(errors: CompileError[]) {
    super(
      errors.length === 0
        ? 'rule language error'
        : errors.map((e) => `${e.code} at ${e.path || '<root>'}${e.col !== undefined ? `:${e.col}` : ''}: ${e.message}`).join('; '),
    );
    this.name = 'LangError';
    this.errors = errors;
  }
}

/** Error raised inside the string parsers; converted to a `CompileError` by callers. */
export class ParseFailure extends Error {
  readonly col: number;
  readonly code: CompileErrorCode;
  constructor(message: string, col: number, code: CompileErrorCode = 'PARSE_ERROR') {
    super(message);
    this.name = 'ParseFailure';
    this.col = col;
    this.code = code;
  }
}
