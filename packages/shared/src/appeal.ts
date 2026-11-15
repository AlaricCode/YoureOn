// SCHEMAS §7 — appeals panel. Three providers vote independently; no majority upholds the original (D7, O7).
import { z } from 'zod/v4';
import { PANEL_ABSTAIN_BELOW } from './constants';
import { BetId, Hex32, IsoUtc, NText, Party, Uuid } from './primitives';
import { Confidence } from './ruling';

/** 'google' = the Gemini LLM; unrelated to Gemini the exchange. */
export const PanelProvider = z.enum(['anthropic', 'openai', 'google']);
export type PanelProvider = z.infer<typeof PanelProvider>;

export const VoteCountedAs = z.enum(['A_WINS', 'B_WINS', 'ABSTAIN']);
export type VoteCountedAs = z.infer<typeof VoteCountedAs>;

export const AppealVote = z.strictObject({
  schema_version: z.literal(1),
  appeal_id: Uuid,
  bet_id: BetId,
  seat: z.number().int().min(0).max(2),
  provider: PanelProvider,
  model: z.string().min(1).max(80),
  status: z.enum(['ok', 'error', 'timeout']),
  /** toOutcome(voter's VisionVerdict, yes_party); REDO if status != ok. Never VOID. */
  outcome: z.enum(['A_WINS', 'B_WINS', 'REDO']),
  /** 0 if status != ok. */
  confidence: Confidence,
  /** "" if status != ok. */
  reason: NText(280, 0),
  counted_as: VoteCountedAs,
  latency_ms: z.number().int().nonnegative(),
  created_at: IsoUtc,
});
export type AppealVote = z.infer<typeof AppealVote>;

export const countVote = (v: {
  status: string;
  outcome: 'A_WINS' | 'B_WINS' | 'REDO';
  confidence: number;
}): VoteCountedAs =>
  v.status === 'ok' && v.outcome !== 'REDO' && v.confidence >= PANEL_ABSTAIN_BELOW
    ? v.outcome
    : 'ABSTAIN';

/** Onchain PartyA | PartyB | Refund; Split has no v1 producer. */
export const Appealable = z.enum(['A_WINS', 'B_WINS', 'VOID']);
export type Appealable = z.infer<typeof Appealable>;

export const AppealResult = z.strictObject({
  schema_version: z.literal(1),
  appeal_id: Uuid,
  bet_id: BetId,
  /** The loser of a decisive original; either party if original = VOID. */
  appellant: Party,
  original_outcome: Appealable,
  original_ruling_hash: Hex32,
  votes: z.array(AppealVote).length(3),
  tally: z.strictObject({
    A_WINS: z.number().int(),
    B_WINS: z.number().int(),
    ABSTAIN: z.number().int(),
  }),
  /** VOID only when a VOID original is upheld. */
  final_outcome: Appealable,
  decided_by: z.enum(['majority', 'upheld_no_majority']),
  flipped: z.boolean(),
  evidence_hash: Hex32,
  /** O3 (D7): the frames all three voters were sent (normally = the appealed ruling's); [] for gemini. */
  frame_hashes: z.array(Hex32).max(24),
  terms_hash: Hex32,
  created_at: IsoUtc,
});
export type AppealResult = z.infer<typeof AppealResult>;

/** A decisive majority (≥ 2 counted votes for one side) decides; anything else upholds the original. */
export function decideAppeal(
  original: Appealable,
  votes: readonly { counted_as: VoteCountedAs }[],
) {
  const tally = { A_WINS: 0, B_WINS: 0, ABSTAIN: 0 };
  for (const v of votes) tally[v.counted_as]++;
  const majority = tally.A_WINS >= 2 ? 'A_WINS' : tally.B_WINS >= 2 ? 'B_WINS' : null;
  const final_outcome: Appealable = majority ?? original;
  return {
    tally,
    final_outcome,
    decided_by: majority ? 'majority' : 'upheld_no_majority',
    flipped: final_outcome !== original,
  } as const;
}
