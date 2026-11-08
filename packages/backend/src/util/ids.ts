import { randomBytes, randomInt, randomUUID } from 'node:crypto';

/** RFC 4122 v4 UUID (tx ids, draft ids, …). */
export const uuid = (): string => randomUUID();

/** URL-safe random token (session tokens, nonces). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniform 6-digit numeric code ("000000".."999999"), e.g. huddle codes. */
export function randomDigits(n = 6): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(randomInt(0, 10));
  return s;
}
