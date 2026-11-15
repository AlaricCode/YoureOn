// SCHEMAS §6 — hearing before any onchain resolve. Audio is never persisted; only transcripts and hashes.
import { z } from 'zod/v4';
import { REDO_BELOW } from './constants';
import { BetId, Hex32, IsoUtc, NText, Party, Uuid } from './primitives';
import { checkFrames, isDecisive, RulingCore, VisionVerdict } from './ruling';

export const HearingTrigger = z.enum(['contested', 'max_redos', 'demo']);
export type HearingTrigger = z.infer<typeof HearingTrigger>;

export const HearingTurn = z.strictObject({
  schema_version: z.literal(1),
  turn_id: Uuid,
  hearing_id: Uuid,
  bet_id: BetId,
  /** 0 = A, 1 = B. */
  turn_index: z.number().int().min(0).max(1),
  party: Party,
  started_at: IsoUtc,
  ended_at: IsoUtc,
  /** 10 s turn + 2 s grace. */
  duration_ms: z.number().int().min(0).max(12_000),
  /** May be "" (silence). */
  transcript: NText(600, 0),
  /** sha256(UTF-8(transcript)); a plain string hash, not JCS. */
  transcript_sha256: Hex32,
  stt: z.enum(['elevenlabs', 'device']),
});
export type HearingTurn = z.infer<typeof HearingTurn>;

export const ArgumentRef = z.strictObject({
  party: Party,
  turn_id: Uuid,
  transcript_sha256: Hex32,
});

/** LLM output. */
export const HearingVerdict = VisionVerdict.extend({
  responses: z.object({ A: z.string().max(160), B: z.string().max(160) }),
});
export type HearingVerdict = z.infer<typeof HearingVerdict>;

/** No void_reason key: outcome VOID in a hearing always means 'undecidable'. */
export const HearingRuling = z
  .strictObject({
    ...RulingCore,
    stage: z.literal('hearing'),
    hearing_id: Uuid,
    trigger: HearingTrigger,
    /** [A, B] */
    arguments: z.tuple([ArgumentRef, ArgumentRef]),
    /** The judge's one-line answer to each side. */
    responses: z.strictObject({ A: NText(160), B: NText(160) }),
  })
  .superRefine((r, ctx) => {
    if (r.arguments[0]?.party !== 'A' || r.arguments[1]?.party !== 'B')
      ctx.addIssue({ code: 'custom', path: ['arguments'], message: 'order is [A, B]' });
    if (r.outcome === 'REDO')
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'a hearing never re-attempts: use VOID (toHearingOutcome)',
      });
    if (isDecisive(r.outcome) && r.confidence < REDO_BELOW)
      ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'confidence < 0.8 must be VOID' });
    checkFrames(r, ctx);
  });
export type HearingRuling = z.infer<typeof HearingRuling>;
