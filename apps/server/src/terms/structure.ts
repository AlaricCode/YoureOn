// A typed (or spoken, then dropped into the typed form) sentence, structured into terms.
//
// POST /v1/bets/:bet_id/terms/typed takes a claim and a stake; the phone fills the rest with
// defaults: the sentence itself as the one success condition, performer B, yes_party B. That is
// right for the bottle-flip template and wrong for anything else: with the voice judge down,
// "let's do a challenge where I have to throw a paper ball into a trash trashcan" became the
// claim verbatim, with the OTHER player as the one who throws.
//
// So a sentence nobody has structured yet (needsStructuring) goes through one small model call
// that does what the voice judge does in conversation: a third-person TRUE / FALSE claim, who
// performs, who wins if it is true, what the camera must see, and the likeliest dispute settled.
// It never blocks a bet: off the live provider, on a timeout, on bad output or when the result
// does not pass the same checks as any proposal, the sentence goes through as it was sent.
import type { TypedTermsRequest } from '@youre-on/shared/judge/typed-terms';
import { z } from 'zod/v4';

import type { AppDeps } from '../context';
import { DeadlineError, withDeadline } from '../providers/structured';
import type { StructuredOutput } from '../providers/types';

/** The whole call's deadline: the phone is waiting on "Send terms". */
export const STRUCTURE_TIMEOUT_MS = 6_000;

/** What the model returns. The bounds are TermsProposal's (shared terms.ts), a little tighter. */
export const StructuredClaim = z.object({
  claim: z.string().trim().min(8).max(200),
  performer: z.enum(['A', 'B']),
  yes_party: z.enum(['A', 'B']),
  success_criteria: z.array(z.string().trim().min(3).max(160)).min(1).max(4),
  failure_criteria: z.array(z.string().trim().min(3).max(160)).max(4),
  edge_cases: z
    .array(
      z.object({
        question: z.string().trim().min(3).max(160),
        answer: z.string().trim().min(2).max(160),
      }),
    )
    .min(1)
    .max(3),
});
export type StructuredClaim = z.infer<typeof StructuredClaim>;

const text = { type: 'string' } as const;

export const STRUCTURE_OUTPUT: StructuredOutput<StructuredClaim> = {
  name: 'bet_terms',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'claim',
      'performer',
      'yes_party',
      'success_criteria',
      'failure_criteria',
      'edge_cases',
    ],
    properties: {
      claim: { type: 'string', description: 'One third-person sentence, under 140 characters.' },
      performer: { type: 'string', enum: ['A', 'B'] },
      yes_party: { type: 'string', enum: ['A', 'B'] },
      success_criteria: { type: 'array', items: text },
      failure_criteria: { type: 'array', items: text },
      edge_cases: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'answer'],
          properties: { question: text, answer: text },
        },
      },
    },
  },
  schema: StructuredClaim,
  upperCase: ['performer', 'yes_party'],
};

export const STRUCTURE_SYSTEM = `You write the terms of a friendly money bet between two people for "You're On". One of them says a sentence. A phone camera films one short attempt, and an AI judge looks at frames of it and rules whether the claim came true. The terms are read on a phone screen, so every line is short and plain.

You get JSON: party_a (the challenger, who said the sentence), party_b (the one challenged) and said (the sentence, from speech recognition or typed in a hurry: it can have filler, repeats and mis-heard words).

Return JSON only, with these fields:
- claim: ONE third-person statement that ends up TRUE or FALSE, naming the performer by name, like "Jake lands a water bottle flip upright on the table." Never "I", "me", "you", "we", "let's" or "bet you can't". At most 90 characters.
- performer: "A" or "B", who attempts it. In said, "I" and "me" are party A, and "you" is party B. If it does not say, "B".
- yes_party: who wins if the claim is TRUE. The performer wins by doing it: "I bet I can" is performer A, yes_party A; "bet you can't" is performer B, yes_party B.
- success_criteria: 1 or 2 things the camera can SEE that make it count. At most 70 characters each.
- failure_criteria: 1 or 2 explicit ways it does not count. At most 70 characters each.
- edge_cases: 1 or 2 objects {question, answer}: the dispute most likely to come up, with a crisp rule as the answer, like "No. It has to stay in the bin." Question at most 70 characters, answer at most 80.

Keep exactly what was asked and add nothing: no distance, count, number of tries, time limit or difficulty that was not said, and never mention the camera, the clip, the footage or how long it is. Plain words, sentence case, no emoji, no quotation marks around names. Fix obvious speech slips ("a trash trashcan" is "the trash can"). If the sentence is not something a camera can film in one short attempt, give its most literal filmable reading and nothing more.`;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Has nothing structured this request yet? True when it is a skill bet whose only success
 * condition is the claim itself (the phone's default for any sentence that is not the bottle-flip
 * template), or that sends none.
 */
export function needsStructuring(r: TypedTermsRequest): boolean {
  if ((r.type ?? 'skill') !== 'skill') return false;
  const criteria = r.success_criteria;
  if (criteria === undefined) return true;
  return criteria.length === 1 && norm(criteria[0] ?? '') === norm(r.claim);
}

/** How many success lines, failure lines and edge cases a card shows from a structured sentence. */
export const CARD_LINES = 2;

/** A claim still in the first or second person is the sentence again, not terms. */
const FIRST_OR_SECOND_PERSON = /\b(i|i'm|im|me|my|mine|you|your|yours|we|let's|lets)\b/i;

/** The model's output as terms worth using, or null: then the sentence goes as it was sent. */
export function usableClaim(v: StructuredClaim): StructuredClaim | null {
  if (FIRST_OR_SECOND_PERSON.test(v.claim)) return null;
  const claim = /[.!?]$/.test(v.claim) ? v.claim : `${v.claim}.`;
  if (claim.length > 200) return null;
  // The card is read on a phone: two lines of each at most, whatever the model sent.
  return {
    ...v,
    claim,
    success_criteria: v.success_criteria.slice(0, CARD_LINES),
    failure_criteria: v.failure_criteria.slice(0, CARD_LINES),
    edge_cases: v.edge_cases.slice(0, CARD_LINES),
  };
}

export interface StructureInput {
  /** The sentence as sent. */
  said: string;
  aName: string;
  bName: string;
  betId: string;
}

/**
 * The sentence as structured terms, or null (not the live provider, a failure, a timeout, output
 * that is not usable). Never throws.
 */
export async function structureClaim(
  deps: Pick<AppDeps, 'providers' | 'env' | 'log'>,
  i: StructureInput,
  o: { timeoutMs?: number } = {},
): Promise<StructuredClaim | null> {
  if (deps.providers.llm.name !== 'live') return null;
  const model = deps.env.TERMS_MODEL;
  const timeoutMs = o.timeoutMs ?? STRUCTURE_TIMEOUT_MS;
  const started = Date.now();
  try {
    const res = await withDeadline(timeoutMs, undefined, (signal) =>
      deps.providers.llm.chat({
        vendor: 'anthropic',
        model,
        system: STRUCTURE_SYSTEM,
        parts: [
          {
            kind: 'text',
            text: `BET ${JSON.stringify({ party_a: i.aName, party_b: i.bName, said: i.said })}`,
          },
        ],
        output: STRUCTURE_OUTPUT,
        effort: 'low',
        ...(model.startsWith('claude-haiku-') ? { thinking: 'disabled' as const } : {}),
        maxOutputTokens: 800,
        timeoutMs,
        signal,
      }),
    );
    if (!res.ok) {
      deps.log.warn('terms.structure_failed', { bet_id: i.betId, status: res.status });
      return null;
    }
    const usable = usableClaim(res.value);
    deps.log.info('terms.structured', {
      bet_id: i.betId,
      model: res.model,
      latency_ms: Date.now() - started,
      used: usable !== null,
      performer: res.value.performer,
    });
    return usable;
  } catch (e) {
    deps.log.warn('terms.structure_failed', {
      bet_id: i.betId,
      status: e instanceof DeadlineError ? 'timeout' : 'error',
    });
    return null;
  }
}
