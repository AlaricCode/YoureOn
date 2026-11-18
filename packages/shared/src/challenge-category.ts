// SCHEMAS §3.5 — a bet's challenge category: what KIND of skill bet it is (bottle flip, throw,
// anything else), so the judge's odds can quote a performer's record "on bottle flips".
//
// Always derived, never stored and never hashed: classifyChallenge() is a deterministic keyword
// classifier over the claim (+ success criteria, + a row title for legacy seed rows that have no
// terms). Old rows classify on the fly; changing the rules bumps CATEGORY_RULES_VERSION.
// No LLM fallback in v1: anything unrecognised is 'other', which uses the even-money prior.
import { z } from 'zod/v4';

export const ChallengeCategory = z.enum(['bottle_flip', 'throw', 'other']);
export type ChallengeCategory = z.infer<typeof ChallengeCategory>;

export const CATEGORY_RULES_VERSION = 1;

/** [card label, plural noun in a sentence]. */
export const CATEGORY_LABEL: Record<ChallengeCategory, readonly [string, string]> = {
  bottle_flip: ['Bottle flip', 'bottle flips'],
  throw: ['Throw', 'throws'],
  other: ['Challenge', 'challenges'],
};

/** Single-try success rate before any history (the prior the shrinkage pulls toward). */
export const CATEGORY_BASE_RATE: Record<ChallengeCategory, number> = {
  bottle_flip: 0.25,
  throw: 0.4,
  other: 0.5,
};

/** NFKD, diacritics dropped, lower-cased: the same fold as guardrails.matchRefusalCategory. */
const fold = (s: string): string =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'");

const BOTTLE_FLIP = /\bbottle\b.*\bflip|\bflip.*\bbottle\b/;
const THROW =
  /\b(free throw|throw|throws|toss|tosses|shoot|shoots|paper ball|crumpled|into the (bin|trash|cup|basket|hoop)|basket|hoop|cup pong)\b/;

export interface ChallengeText {
  claim?: string | null;
  success_criteria?: readonly string[] | null;
  /** A row title ("Demo history: Bottle flip"): legacy seed rows have no terms. */
  title?: string | null;
}

export function classifyChallenge(t: ChallengeText): ChallengeCategory {
  const text = fold(
    [t.claim ?? '', ...(t.success_criteria ?? []), t.title ?? ''].filter(Boolean).join(' | '),
  );
  if (BOTTLE_FLIP.test(text)) return 'bottle_flip';
  if (THROW.test(text)) return 'throw';
  return 'other';
}
