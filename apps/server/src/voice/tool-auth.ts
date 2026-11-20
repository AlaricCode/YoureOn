// Webhook tool auth: `X-YO-Tool-Secret`, set by ElevenLabs from a workspace secret, compared in
// constant time. A bad or missing secret is the only non-2xx a tool returns.
// Spec: docs/planning/API-CONTRACT.md §4.2.
import { createHash, timingSafeEqual } from 'node:crypto';
import { TOOL_SECRET_HEADER } from '@youre-on/shared/judge/el-config';

export { TOOL_SECRET_HEADER };

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/**
 * True iff `presented` equals one of `accepted` (non-empty). Hashing first gives equal-length
 * buffers for timingSafeEqual, so the length of the secret does not leak either.
 * `accepted` is a list so a rotation can accept the old and new value for 24 h.
 */
export function toolSecretOk(
  presented: string | undefined | null,
  accepted: ReadonlyArray<string | undefined>,
): boolean {
  if (!presented) return false;
  const p = digest(presented);
  let ok = false;
  for (const a of accepted) if (a && timingSafeEqual(p, digest(a))) ok = true;
  return ok;
}
