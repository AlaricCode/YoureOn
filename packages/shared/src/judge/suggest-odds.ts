// The `suggest_odds` webhook tool and the words of the judge's odds suggestion
// (API-CONTRACT §4.3 suggest_odds, §2.19 POST /v1/bets/:id/odds/suggest).
//
//   "Judge, what odds are fair?" -> suggest_odds {claim, performer, attempts, base_usd}
//     -> {ok:true, ratio:'3:1', a:'$15', b:'$5', pct:25, say}
//
// The server computes every number (odds-math.ts) from the performer's real record; a model may
// only write the one-sentence `reason` and pick the ratio from a band. guardReason() rejects any
// reason that quotes a number not in the facts (it falls back to templateReason()), so the judge
// can never invent "9 of 10".
import { z } from 'zod/v4';
import { formatUsd } from '../money';
import { RUNG, type OddsRatio } from '../odds-math';
import type { Party } from '../primitives';
import { ID_PROPERTIES, type ElObjectProperty } from './propose-terms';
import { numberWords, SAY_MAX_CHARS } from './reply';

// ---- the webhook tool ----------------------------------------------------------------------------

export const SUGGEST_ODDS_BODY_SCHEMA = {
  type: 'object',
  required: ['claim', 'performer', 'attempts', 'base_usd'],
  properties: {
    ...ID_PROPERTIES,
    claim: {
      type: 'string',
      description:
        "The bet's claim as it stands, one third-person statement, e.g. 'Jake lands a water bottle flip upright on the table.'",
    },
    performer: {
      type: 'string',
      enum: ['A', 'B'],
      description: 'Who attempts it.',
    },
    attempts: {
      type: 'object',
      required: ['count', 'rule'],
      description: 'Tries inside one recording, as agreed so far.',
      properties: {
        count: { type: 'integer', description: '1 to 5. 1 unless agreed.' },
        rule: {
          type: 'string',
          enum: ['single', 'first_success', 'best_of', 'all_of'],
          description: 'single iff count is 1.',
        },
      },
    },
    base_usd: {
      type: 'string',
      description: "Per-person amount being discussed, e.g. '5'.",
    },
  },
} as const satisfies ElObjectProperty;

export const SUGGEST_ODDS_DESCRIPTION =
  'When someone asks what odds are fair, or asks you to set the odds. The court computes them from ' +
  "the performer's real record. Speak the returned `say` exactly; it is only a suggestion.";

/** What ElevenLabs POSTs to /el/tools/suggest_odds (lenient). */
export const SuggestOddsArgs = z.object({
  conversation_id: z.string().min(1).max(128),
  bet_id: z.string().min(1).max(64),
  claim: z.string().max(400).optional(),
  performer: z.enum(['A', 'B']).optional(),
  attempts: z.object({ count: z.number().int(), rule: z.string() }).optional(),
  base_usd: z.string().max(16).optional(),
});
export type SuggestOddsArgs = z.infer<typeof SuggestOddsArgs>;

export type SuggestOddsFix = 'NO_CLAIM' | 'AMBIGUOUS' | 'NOT_DRAFTING';

export const SUGGEST_SAY: Record<SuggestOddsFix, string> = {
  NO_CLAIM: "What's the bet? I need the claim before I set odds.",
  AMBIGUOUS: 'How much each, in dollars?',
  NOT_DRAFTING: 'These terms are already frozen. No new odds now.',
};

// ---- the words ----------------------------------------------------------------------------------

/** The numbers a reason may mention, and the words around them (all from code, never a model). */
export interface OddsFacts {
  performer_name: string;
  opponent_name: string;
  /** "bottle flips" */
  category_plural: string;
  made: number;
  tries: number;
  chance_pct: number;
  base_rate_pct: number;
  sample_meaningful: boolean;
  h2h: { wins: number; losses: number };
  overall: { wins: number; losses: number };
  streak: { kind: 'W' | 'L'; n: number } | null;
  /** Whole-dollar stakes of the candidate rungs (e.g. [15, 5]). */
  stake_dollars: number[];
  ratio: { num: number; den: number };
  attempts_count: number;
}

const NUMBER_WORDS: Record<string, number> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [numberWords(i + 1), i + 1]),
);

const MONEY_TALK = /\b(paid|payout|locked|won money|real money|real-money|cash)\b/i;

/** Every number a reason may say. */
export function allowedNumbers(f: OddsFacts): Set<number> {
  const s = new Set<number>([
    f.made,
    f.tries,
    f.tries - f.made,
    f.chance_pct,
    f.base_rate_pct,
    f.h2h.wins,
    f.h2h.losses,
    f.overall.wins,
    f.overall.losses,
    f.ratio.num,
    f.ratio.den,
    f.attempts_count,
    ...f.stake_dollars,
  ]);
  if (f.streak) s.add(f.streak.n);
  return s;
}

/**
 * A model's reason is kept only if every digit run and every number word one..twenty in it is a
 * fact, it is ≤ 140 chars, one clean line, and it doesn't talk money as if it moved.
 */
export function guardReason(reason: string, f: OddsFacts): boolean {
  const r = reason.trim();
  if (!r || r.length > 140) return false;
  if (/[\u0000-\u001f\u007f]/.test(r)) return false;
  if (MONEY_TALK.test(r)) return false;
  const ok = allowedNumbers(f);
  for (const m of r.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (!Number.isInteger(n) || !ok.has(n)) return false;
  }
  for (const m of r.toLowerCase().matchAll(/\b[a-z]+(?:-[a-z]+)?\b/g)) {
    const n = NUMBER_WORDS[m[0]];
    if (n !== undefined && !ok.has(n)) return false;
  }
  return true;
}

const ABOUT: Record<number, string> = {
  25: 'about a quarter of the time',
  50: 'about half the time',
};

/** The server's own reason, always grounded in the same facts. */
export function templateReason(f: OddsFacts): string {
  const name = f.performer_name.trim() || 'The performer';
  const what = f.category_plural;
  const What = what.charAt(0).toUpperCase() + what.slice(1);
  if (f.tries === 0) {
    const rate = ABOUT[f.base_rate_pct] ?? `about ${f.base_rate_pct}% of the time`;
    return what === 'challenges'
      ? "No record on this one, so I start at even. That's my default."
      : `${What} land ${rate}. That's my default.`;
  }
  if (f.sample_meaningful) {
    const h2h =
      f.h2h.wins + f.h2h.losses > 0 && f.opponent_name
        ? `, and ${f.h2h.wins}-${f.h2h.losses} against ${f.opponent_name}`
        : '';
    return `${name} is ${f.made} for ${f.tries} on ${what}${h2h}.`;
  }
  return `${name} is ${f.made} for ${f.tries} on ${what}; small sample, so I lean on the usual ${f.base_rate_pct}%.`;
}

/** "three to one", "three to two", "even money". */
export function ratioWords(ratio: OddsRatio): string {
  const { num, den } = RUNG[ratio];
  return num === den ? 'even money' : `${numberWords(num)} to ${numberWords(den)}`;
}

/** "fifteen", "seven fifty" style is not needed: whole dollars as words, else "$7.50". */
function dollarsSpoken(micro: bigint): string {
  if (micro % 1_000_000n === 0n && micro / 1_000_000n <= 99n)
    return numberWords(Number(micro / 1_000_000n));
  return formatUsd(micro.toString());
}

/**
 * "{reason} I'd make it three to one: Logan puts in fifteen, Jake puts in five. Both agree?"
 * ≤ SAY_MAX_CHARS: the reason is trimmed first.
 */
export function suggestSay(i: {
  reason: string;
  ratio: OddsRatio;
  stakes: { a: bigint; b: bigint };
  names: { a: string; b: string };
}): string {
  const a = i.names.a.trim() || 'The challenger';
  const b = i.names.b.trim() || 'the other side';
  const tail =
    i.stakes.a === i.stakes.b
      ? `I'd make it even money: ${dollarsSpoken(i.stakes.a)} each. Both agree?`
      : `I'd make it ${ratioWords(i.ratio)}: ${a} puts in ${dollarsSpoken(i.stakes.a)}, ${b} puts in ${dollarsSpoken(i.stakes.b)}. Both agree?`;
  let reason = i.reason.trim();
  const room = SAY_MAX_CHARS - tail.length - 1;
  if (reason.length > room) reason = room > 4 ? `${reason.slice(0, room - 1).trimEnd()}…` : '';
  const say = reason ? `${reason} ${tail}` : tail;
  return say.length <= SAY_MAX_CHARS ? say : `${say.slice(0, SAY_MAX_CHARS - 1)}…`;
}

// ---- the model's structured output ---------------------------------------------------------------

/**
 * The JSON schema the model answers in: a ratio from the band and one sentence. Wire schema: no
 * maxLength (Anthropic structured outputs reject string constraints, like judge/prompt.ts); the
 * length is enforced by guardReason (≤ 140) and the zod schema.
 */
export function oddsOutputSchema(allowed: readonly OddsRatio[]) {
  return {
    name: 'odds_reason',
    jsonSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['ratio', 'reason'],
      properties: {
        ratio: { type: 'string', enum: [...allowed] },
        reason: { type: 'string', description: 'One sentence, at most 120 characters.' },
      },
    },
    schema: z.object({ ratio: z.string(), reason: z.string().max(400) }),
  };
}

/** Party of the favourite for a suggestion: the claim's side when it's likelier, else the other. */
export function favoredOf(favored: 'performer' | 'opponent' | null, yesParty: Party): Party | null {
  if (favored === null) return null;
  return favored === 'performer' ? yesParty : yesParty === 'A' ? 'B' : 'A';
}
