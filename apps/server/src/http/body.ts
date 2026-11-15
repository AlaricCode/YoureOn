// Request-body helpers. Bodies are parsed with tolerant z.object schemas (unknown keys
// stripped, API-CONTRACT §1.4); failures become 422 VALIDATION_FAILED with details.issues[].
import type { Context } from 'hono';
import type { z } from 'zod/v4';
import { HttpError, validationError } from '../errors';
import type { AppEnv } from '../context';

/** Reads the raw JSON body (an empty body reads as `{}`); throws VALIDATION_FAILED on bad JSON. */
export async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError('VALIDATION_FAILED', 'The request body is not valid JSON.', {
      issues: [{ path: '', message: 'invalid JSON' }],
    });
  }
}

/** Parses `value` with `schema` or throws VALIDATION_FAILED. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

/** readJsonBody + parseWith. */
export async function readBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  return parseWith(schema, await readJsonBody(c));
}
