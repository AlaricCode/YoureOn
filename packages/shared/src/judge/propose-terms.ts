// The `propose_terms` webhook tool (API-CONTRACT §4.3, SCHEMAS §3, TASKS D0-J2/D0-J3).
//
// Two schemas live here:
//  - PROPOSE_TERMS_BODY_SCHEMA: the LLM-facing projection, in the ElevenLabs JSON-schema subset
//    (type, description, enum, properties, required, items, dynamic_variable). It has no
//    `pattern`, no min/max and no nullable enums (conflict C1), so the server validates.
//  - ProposeTermsArgs: the Zod parse of what ElevenLabs POSTs (ids + the projection), lenient on
//    unknown keys. mapProposeTermsArgs() then maps it deterministically into SCHEMAS
//    `TermsProposal` and parses it with the stripping `TermsProposalLoose`.
//
// Everything here is pure (no I/O): the server handler, the fixture tests and the PENDING-KEY
// fixture runner all call the same functions, so the runner sees exactly what the server does.
import { z } from 'zod/v4';
import { MAX_STAKE, MIN_STAKE } from '../constants';
import { parseUsd } from '../money';
import { checkOddsStakes } from '../odds-math';
import { normTextDeep } from '../primitives';
import {
  TermsProposalLoose,
  type DraftIssue as DraftIssueSchema,
  type TermsProposal,
} from '../negotiation';

/** SCHEMAS §3 DraftIssue (the module exports only the schema). */
export type DraftIssue = z.infer<typeof DraftIssueSchema>;

/** Literal property in the ElevenLabs subset. */
export interface ElLiteralProperty {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  enum?: string[];
  dynamic_variable?: string;
}
export interface ElArrayProperty {
  type: 'array';
  description?: string;
  items: ElProperty;
}
export interface ElObjectProperty {
  type: 'object';
  description?: string;
  required?: string[];
  properties: Record<string, ElProperty>;
}
export type ElProperty = ElLiteralProperty | ElArrayProperty | ElObjectProperty;

/** Dynamic-variable id fields filled into every webhook tool body (API-CONTRACT §4.1). */
export const ID_PROPERTIES = {
  conversation_id: { type: 'string', dynamic_variable: 'system__conversation_id' },
  bet_id: { type: 'string', dynamic_variable: 'bet_id' },
} as const satisfies Record<string, ElLiteralProperty>;

/** `request_body_schema` of propose_terms: API-CONTRACT §4.3, field for field. */
export const PROPOSE_TERMS_BODY_SCHEMA = {
  type: 'object',
  required: [
    'type',
    'claim',
    'performer',
    'yes_party',
    'attempts',
    'success_criteria',
    'failure_criteria',
    'edge_cases',
    'amount_usd',
    'market_side',
    'deadline_minutes',
  ],
  properties: {
    ...ID_PROPERTIES,
    type: {
      type: 'string',
      enum: ['skill', 'real_world'],
      description: 'skill = settled by the camera. real_world = only the Bitcoin 5-minute market.',
    },
    claim: {
      type: 'string',
      description:
        "One third-person statement that ends TRUE or FALSE, e.g. 'Jake lands a water bottle flip upright on the table.' Never 'bet you can't'.",
    },
    performer: {
      type: 'string',
      enum: ['A', 'B', 'none'],
      description: "Who attempts it. 'none' for real_world.",
    },
    yes_party: {
      type: 'string',
      enum: ['A', 'B'],
      description:
        "Who wins if the claim is TRUE. 'Bet you can't flip it' said by A: claim 'Jake flips it', yes_party B.",
    },
    attempts: {
      type: 'object',
      required: ['count', 'rule'],
      description: 'Tries inside one recording.',
      properties: {
        count: { type: 'integer', description: '1 to 5. 1 unless agreed.' },
        rule: {
          type: 'string',
          enum: ['single', 'first_success', 'best_of', 'all_of'],
          description: 'single iff count is 1; best_of needs an odd count.',
        },
      },
    },
    success_criteria: {
      type: 'array',
      description: '1 to 5 observable conditions that must all hold.',
      items: { type: 'string', description: 'One condition, one sentence.' },
    },
    failure_criteria: {
      type: 'array',
      description: '0 to 5 explicit fouls.',
      items: { type: 'string', description: 'One foul, one sentence.' },
    },
    edge_cases: {
      type: 'array',
      description: 'Up to 4 rulings agreed so far, each a crisp rule.',
      items: {
        type: 'object',
        // Not in the API-CONTRACT JSON: ElevenLabs treats an LLM-provided value as described by
        // `description`, so the item object gets one too (harmless to the projection).
        description: 'One agreed ruling.',
        required: ['question', 'answer'],
        properties: {
          question: {
            type: 'string',
            description: "The edge case, e.g. 'Does landing on the cap count?'",
          },
          answer: {
            type: 'string',
            description: "The rule, e.g. 'No. Only upright on its base counts.'",
          },
        },
      },
    },
    amount_usd: {
      type: 'string',
      description:
        "Party A's (the challenger's) stake in dollars, e.g. '15'. When stakes are even, the stake per person, e.g. '5' or '5.20'. Real_world: the even-money amount.",
    },
    // Additive (odds): NOT in `required`, so an agent synced before it keeps working.
    stake_b_usd: {
      type: 'string',
      description:
        "Party B's stake in dollars when the odds are not even, e.g. '5'. Empty or omitted = same as amount_usd. Real_world: empty.",
    },
    market_side: {
      type: 'string',
      enum: ['YES', 'NO', 'none'],
      description:
        "real_world only: A's side, YES = Bitcoin finishes at or above the line. Otherwise 'none'.",
    },
    deadline_minutes: {
      type: 'integer',
      description: 'Minutes to finish the attempt; 0 means the default 10; max 45.',
    },
  },
} as const satisfies ElObjectProperty;

export const PROPOSE_TERMS_DESCRIPTION =
  'Send the bet as terms. Call it once the bet is clear, again after every agreed edge case or change, ' +
  'and for any bet that sounds unsafe (the server decides refusals). Speak the returned `say` exactly.';

/** What ElevenLabs POSTs to /el/tools/propose_terms. Unknown keys are stripped, not errors. */
export const ProposeTermsArgs = z.object({
  conversation_id: z.string().min(1).max(128),
  bet_id: z.string().min(1).max(64),
  type: z.enum(['skill', 'real_world']),
  claim: z.string(),
  performer: z.enum(['A', 'B', 'none']),
  yes_party: z.enum(['A', 'B']),
  attempts: z.object({ count: z.number().int(), rule: z.string() }),
  success_criteria: z.array(z.string()),
  failure_criteria: z.array(z.string()),
  edge_cases: z.array(z.object({ question: z.string(), answer: z.string() })),
  amount_usd: z.string(),
  /** Additive (odds): B's stake when not even; '' / omitted = even. */
  stake_b_usd: z.string().optional(),
  market_side: z.enum(['YES', 'NO', 'none']),
  deadline_minutes: z.number().int(),
});
export type ProposeTermsArgs = z.infer<typeof ProposeTermsArgs>;
/** The projection without the dynamic-variable ids (what the LLM itself decides). */
export type ProposeTermsProjection = Omit<ProposeTermsArgs, 'conversation_id' | 'bet_id'>;
export const ProposeTermsProjection = ProposeTermsArgs.omit({
  conversation_id: true,
  bet_id: true,
});

export interface ArgIssue {
  path: string;
  message: string;
}

export type MapResult =
  | { ok: true; proposal: TermsProposal }
  | { ok: false; issues: ArgIssue[]; draftIssue?: DraftIssue };

const issuesOf = (e: z.ZodError, prefix = ''): ArgIssue[] =>
  e.issues.map((i) => ({
    path: prefix + i.path.map(String).join('.'),
    message: i.message,
  }));

/**
 * API-CONTRACT §4.3 "Mapping to TermsProposal", in order: normText every string; 'none' ->
 * null; parseUsd; evidence_source from type; market_query for real_world; deadline 0 -> null;
 * asked_by 'judge'; then the stripping parse. Never throws.
 *
 * `raw` may include the ids (a webhook body) or not (a projection from a fixture).
 */
export function mapProposeTermsArgs(raw: unknown): MapResult {
  const parsed = ProposeTermsProjection.safeParse(normTextDeep(raw));
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  const a = parsed.data;

  if (a.deadline_minutes > 45) {
    return {
      ok: false,
      issues: [{ path: 'deadline_minutes', message: 'max 45' }],
      draftIssue: { code: 'DEADLINE_TOO_FAR', message: 'deadline_minutes above 45' },
    };
  }
  let amount: string;
  try {
    amount = parseUsd(a.amount_usd);
  } catch {
    return {
      ok: false,
      issues: [{ path: 'amount_usd', message: "dollars like '5' or '5.20'" }],
      draftIssue: { code: 'AMBIGUOUS', message: 'amount_usd is not a dollar amount' },
    };
  }

  // Odds: B's stake when it differs from A's; '' / omitted / equal = even (null).
  let amountB: string | null = null;
  if (a.stake_b_usd !== undefined && a.stake_b_usd !== '') {
    try {
      amountB = parseUsd(a.stake_b_usd);
    } catch {
      return {
        ok: false,
        issues: [{ path: 'stake_b_usd', message: "dollars like '5' or '5.20', or empty" }],
        draftIssue: { code: 'AMBIGUOUS', message: 'stake_b_usd is not a dollar amount' },
      };
    }
    if (amountB === amount) amountB = null;
  }

  const realWorld = a.type === 'real_world';
  const candidate = {
    type: a.type,
    claim: a.claim,
    performer: a.performer === 'none' ? null : a.performer,
    yes_party: a.yes_party,
    attempts: a.attempts,
    success_criteria: a.success_criteria,
    failure_criteria: a.failure_criteria,
    edge_cases: a.edge_cases.map((e) => ({ ...e, asked_by: 'judge' as const })),
    evidence_source: realWorld ? 'gemini' : 'camera',
    amount,
    amount_b: amountB,
    market_query: realWorld
      ? { asset: 'BTC', horizon: '5m', a_side: a.market_side === 'none' ? null : a.market_side }
      : null,
    deadline_minutes: a.deadline_minutes === 0 ? null : a.deadline_minutes,
  };
  const p = TermsProposalLoose.safeParse(candidate);
  if (!p.success) return { ok: false, issues: issuesOf(p.error) };

  // Terms §2.1 cross-field rules the judge controls; caught here so it can fix them now
  // rather than at Terms composition.
  const cross: ArgIssue[] = [];
  const t = p.data;
  if (t.type === 'skill' && t.performer === null)
    cross.push({ path: 'performer', message: "skill bets need performer 'A' or 'B'" });
  if (t.type === 'real_world') {
    if (t.performer !== null) cross.push({ path: 'performer', message: "real_world => 'none'" });
    if (t.attempts.rule !== 'single')
      cross.push({ path: 'attempts', message: "real_world => count 1, 'single'" });
    if (t.market_query && t.yes_party !== (t.market_query.a_side === 'YES' ? 'A' : 'B'))
      cross.push({ path: 'yes_party', message: 'must be A when market_side is YES, else B' });
    if (t.amount_b !== null)
      cross.push({ path: 'stake_b_usd', message: 'real_world => empty (Gemini sets the split)' });
  }
  if (cross.length) return { ok: false, issues: cross };
  return { ok: true, proposal: t };
}

/** SCHEMAS §3 "Over-cap amounts are not refusals": a DraftIssue the judge counter-proposes. */
export function stakeIssue(p: TermsProposal, maxStake: bigint = MAX_STAKE): DraftIssue | null {
  const amount = BigInt(p.amount);
  const amountB = p.amount_b === null || p.amount_b === undefined ? null : BigInt(p.amount_b);
  for (const s of amountB === null ? [amount] : [amount, amountB]) {
    if (s > maxStake) return { code: 'STAKE_ABOVE_MAX', message: 'stake above max_stake' };
    if (s < MIN_STAKE) return { code: 'STAKE_BELOW_MIN', message: 'stake below MIN_STAKE' };
  }
  // Odds (skill): each side within bounds is not enough; the ratio is at most 10:1.
  if (amountB !== null) {
    const odds = checkOddsStakes(amount, amountB, maxStake);
    if (odds) return { code: odds.code, message: odds.message };
  }
  return null;
}

/** Fields still to agree. v1 asks for at least one edge case on a skill bet (BRIEF §3). */
export function missingFields(p: TermsProposal): Array<keyof TermsProposal> {
  return p.type === 'skill' && p.edge_cases.length === 0 ? ['edge_cases'] : [];
}
