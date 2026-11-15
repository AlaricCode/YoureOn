// SCHEMAS §5 — VisionVerdict (LLM output) → Ruling (hashed record). The model answers
// "was the claim met?"; the server maps that through yes_party. LLMs never output a winner.
import { z } from 'zod/v4';
import { REDO_BELOW } from './constants';
import { FrameIndex } from './evidence';
import { BetId, Hex32, IsoUtc, NText, otherParty, type Party, Uuid } from './primitives';

/** REDO = re-attempt, never onchain. VOID → onchain Refund, produced only by deterministic server rules. */
export const RulingOutcome = z.enum(['A_WINS', 'B_WINS', 'REDO', 'VOID']);
export type RulingOutcome = z.infer<typeof RulingOutcome>;
export const VoidReason = z.enum(['undecidable', 'max_redos', 'market_invalid', 'safety_stop']);
export type VoidReason = z.infer<typeof VoidReason>;
export const RedoReason = z.enum(['unclear', 'low_confidence', 'contested']);
export type RedoReason = z.infer<typeof RedoReason>;
export const ClaimResult = z.enum(['MET', 'NOT_MET', 'UNCLEAR']);
export type ClaimResult = z.infer<typeof ClaimResult>;
export const Confidence = z
  .number()
  .min(0)
  .max(1)
  .refine((x) => Math.round(x * 100) / 100 === x, 'round to 2 dp');

/** The model id of a deterministic Gemini settlement ruling. */
export const GEMINI_SETTLEMENT_MODEL = 'rule/gemini-settlement@1';

/** LLM structured output for attempt judging (and the base of the hearing verdict). Non-strict: we only read it. */
export const VisionVerdict = z.object({
  claim_result: ClaimResult,
  confidence: z.number().min(0).max(1),
  /** Spoken; may cite frames ("frame 7"). */
  reason: z.string().min(1).max(280),
  cited_frames: z.array(z.number().int().min(0)).max(8),
  /** A real attempt happened, but the result hinges on interpretation. */
  contested: z.boolean(),
});
export type VisionVerdict = z.infer<typeof VisionVerdict>;

export function toOutcome(
  v: { claim_result: ClaimResult; confidence: number },
  yesParty: Party,
): 'A_WINS' | 'B_WINS' | 'REDO' {
  if (v.claim_result === 'UNCLEAR' || v.confidence < REDO_BELOW) return 'REDO';
  const winner = v.claim_result === 'MET' ? yesParty : otherParty(yesParty);
  return winner === 'A' ? 'A_WINS' : 'B_WINS';
}

/** A hearing can't order a re-attempt: a non-decisive hearing verdict is VOID ('undecidable') → Refund. */
export const toHearingOutcome = (
  v: Parameters<typeof toOutcome>[0],
  yesParty: Party,
): 'A_WINS' | 'B_WINS' | 'VOID' => {
  const o = toOutcome(v, yesParty);
  return o === 'REDO' ? 'VOID' : o;
};

/** Fields shared by Ruling and HearingRuling. */
export const RulingCore = {
  schema_version: z.literal(1),
  ruling_id: Uuid,
  bet_id: BetId,
  outcome: RulingOutcome,
  /** What the model said, before mapping and the confidence rule. */
  claim_result: ClaimResult,
  confidence: Confidence,
  reason: NText(280),
  /** Indices into frame_hashes; [] for gemini. */
  cited_frames: z.array(FrameIndex).max(8),
  /** O3 (D7): sha256 of each JPEG this model was sent, in send order; [] for gemini. */
  frame_hashes: z.array(Hex32).max(24),
  /** "<provider>/<model-id>" or "rule/gemini-settlement@1". */
  model: z.string().min(1).max(80),
  evidence_hash: Hex32,
  terms_hash: Hex32,
  created_at: IsoUtc,
};

export const isDecisive = (o: RulingOutcome): o is 'A_WINS' | 'B_WINS' =>
  o === 'A_WINS' || o === 'B_WINS';

/** Shared by Ruling and HearingRuling: frames are committed, and citations point into them. */
export const checkFrames = (
  r: { cited_frames: number[]; frame_hashes: string[]; model: string },
  ctx: z.RefinementCtx,
): void => {
  if (r.cited_frames.some((i) => i >= r.frame_hashes.length))
    ctx.addIssue({
      code: 'custom',
      path: ['cited_frames'],
      message: 'cites a frame not in frame_hashes',
    });
  if ((r.model === GEMINI_SETTLEMENT_MODEL) !== (r.frame_hashes.length === 0))
    ctx.addIssue({
      code: 'custom',
      path: ['frame_hashes'],
      message: 'camera rulings commit ≥ 1 frame; gemini settlement commits none',
    });
};

export const Ruling = z
  .strictObject({
    ...RulingCore,
    stage: z.enum(['attempt', 'settlement']),
    attempt_no: z.number().int().min(1),
    redo_reason: RedoReason.nullable(),
    void_reason: VoidReason.nullable(),
  })
  .superRefine((r, ctx) => {
    if ((r.outcome === 'REDO') !== (r.redo_reason !== null))
      ctx.addIssue({ code: 'custom', path: ['redo_reason'], message: 'set iff outcome = REDO' });
    if ((r.outcome === 'VOID') !== (r.void_reason !== null))
      ctx.addIssue({ code: 'custom', path: ['void_reason'], message: 'set iff outcome = VOID' });
    if (r.void_reason === 'undecidable')
      ctx.addIssue({
        code: 'custom',
        path: ['void_reason'],
        message: "'undecidable' is HearingRuling-only",
      });
    if (isDecisive(r.outcome) && r.confidence < REDO_BELOW)
      ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'confidence < 0.8 must be REDO' });
    checkFrames(r, ctx);
  });
export type Ruling = z.infer<typeof Ruling>;

/** = Rust Outcome, borsh 0..=3. */
export const OnchainOutcome = z.enum(['PartyA', 'PartyB', 'Split', 'Refund']);
export type OnchainOutcome = z.infer<typeof OnchainOutcome>;

/** §5.3: offchain outcome → onchain Outcome. REDO never goes onchain (throws). Split has no v1 producer. */
export function toOnchainOutcome(o: RulingOutcome): Exclude<OnchainOutcome, 'Split'> {
  switch (o) {
    case 'A_WINS':
      return 'PartyA';
    case 'B_WINS':
      return 'PartyB';
    case 'VOID':
      return 'Refund';
    case 'REDO':
      throw new Error('REDO never goes onchain');
  }
}

/** Mirrors ESCROW §6 compute_payout. v = vault.amount at payout time. Total: never throws. */
export function payout(
  outcome: OnchainOutcome,
  stakeA: bigint,
  v: bigint,
): { to_a: bigint; to_b: bigint } {
  switch (outcome) {
    case 'PartyA':
      return { to_a: v, to_b: 0n };
    case 'PartyB':
      return { to_a: 0n, to_b: v };
    case 'Refund': {
      const a = stakeA < v ? stakeA : v;
      return { to_a: a, to_b: v - a };
    }
    case 'Split': {
      const half = v / 2n;
      return { to_a: half, to_b: v - half };
    }
  }
}
