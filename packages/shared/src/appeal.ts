// SCHEMAS §7 — appeals panel. Three providers vote independently; no majority upholds the original (D7, O7).
import { z } from 'zod/v4';
import { PANEL_ABSTAIN_BELOW } from './constants';
import { BetId, Hex32, IsoUtc, NText, otherParty, Party, Uuid } from './primitives';
import { Confidence, type ClaimResult } from './ruling';

/** 'google' = the Gemini LLM; unrelated to Gemini the exchange. */
export const PanelProvider = z.enum(['anthropic', 'openai', 'google']);
export type PanelProvider = z.infer<typeof PanelProvider>;

/** Seat k is PANEL_SEATS[k] (API-CONTRACT §7.2): Claude, GPT, Gemini. */
export const PANEL_SEATS: readonly PanelProvider[] = ['anthropic', 'openai', 'google'];

/** Per-vote budget (SCHEMAS §9.3 "Panel vote timeout"): a seat that has not answered abstains. */
export const PANEL_VOTE_TIMEOUT_MS = 8_000;

/**
 * A voter's side from its VisionVerdict: MET -> the yes party wins, NOT_MET -> the other party,
 * UNCLEAR -> REDO. Unlike the first ruling's toOutcome there is no REDO_BELOW (0.8) floor here: a
 * vote's own floor is PANEL_ABSTAIN_BELOW (0.6), applied by countVote (the SCHEMAS §7 example
 * counts a 0.71 vote).
 */
export function voteOutcome(
  v: { claim_result: ClaimResult },
  yesParty: Party,
): 'A_WINS' | 'B_WINS' | 'REDO' {
  if (v.claim_result === 'UNCLEAR') return 'REDO';
  const winner = v.claim_result === 'MET' ? yesParty : otherParty(yesParty);
  return winner === 'A' ? 'A_WINS' : 'B_WINS';
}

/**
 * Who may appeal an outcome (SCHEMAS §5.3 "Loser"): the loser of a decisive ruling, either party
 * of a VOID (onchain Refund / Split).
 */
export function appellantsOf(outcome: string): Party | 'either' | null {
  if (outcome === 'A_WINS' || outcome === 'PartyA' || outcome === 'party_a') return 'B';
  if (outcome === 'B_WINS' || outcome === 'PartyB' || outcome === 'party_b') return 'A';
  if (['VOID', 'Refund', 'Split', 'refund', 'split'].includes(outcome)) return 'either';
  return null;
}

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
