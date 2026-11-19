// SCHEMAS §10.1 — one envelope for WebSocket fan-out to both phones and the stage view.
// Includes the extensions owned by API-CONTRACT §3.4 (tx.sign_request, judge.cue, hearing.turn_open,
// bet.invite_answered, and attempt.started's recorder_device_id / go_at), payloads from ./api.
import { z } from 'zod/v4';
import {
  AttemptStartedExtra,
  BetInviteAnsweredPayload,
  HearingTurnOpenPayload,
  JudgeCuePayload,
  StageRivalry,
  TxSignRequestPayload,
} from './api';
import { AppealResult, AppealVote } from './appeal';
import { AuthorizationMethod, AuthorizeRequest, TxKind } from './authorization';
import { BetState, ChainAck, OnchainStatus, PendingTx } from './bet-state';
import { CallOffPayload } from './call-off';
import { ChainEvents } from './chain-events';
import { ChecksCompiledPayload, ChecksReportPayload } from './checks/events';
import { CameraEvidence, DanceEvidence, GeminiSettlementRecord } from './evidence';
import { GeminiMarketSnapshot } from './gemini';
import { BetGgPayload, ReviewClosedPayload, ReviewRequestedPayload } from './gg';
import { HearingRuling, HearingTrigger, HearingTurn } from './hearing';
import { ClarificationQuestion, GuardrailRefusal, TermsDraft } from './negotiation';
import { OddsAgreedPayload, OddsAnsweredPayload, OddsOfferedPayload } from './odds';
import { BetId, Hex32, IsoUtc, Party, Signature, UserRef, Uuid } from './primitives';
import { Ruling } from './ruling';
import { TermsEnvelope } from './terms';

export const REALTIME_ENVELOPE_VERSION = 1 as const;

/**
 * DANCE-OFF §5: Claude's check of a dance round (never a winner). `skipped` (verdict 'skipped'):
 * the LLM failed or timed out, so the round settled on the score with a canned line.
 */
export const DanceValidation = z
  .object({
    verdict: z.enum(['valid', 'invalid', 'skipped']),
    notes: z.string().max(400),
    skipped: z.boolean(),
  })
  .refine((v) => v.skipped === (v.verdict === 'skipped'), {
    message: "skipped iff verdict = 'skipped'",
    path: ['skipped'],
  });
export type DanceValidation = z.infer<typeof DanceValidation>;

/** DANCE-OFF §5 `dance.scored`: in the same commit as ruling.issued (the market.settled precedent). */
export const DanceScoredPayload = z.object({
  evidence: DanceEvidence,
  /** = hashJcs(evidence) = the ruling's evidence_hash. */
  evidence_hash: Hex32,
  validation: DanceValidation,
  /** The cleaned announcer line (= the ruling's reason). */
  announcer_line: z.string().max(280),
});
export type DanceScoredPayload = z.infer<typeof DanceScoredPayload>;

const env = <T extends string, S extends 'server' | 'chain', P extends z.ZodType>(
  type: T,
  source: S,
  payload: P,
) =>
  z.strictObject({
    /** Envelope version. */
    v: z.literal(REALTIME_ENVELOPE_VERSION),
    type: z.literal(type),
    bet_id: BetId,
    /** Per-bet, gapless, assigned at fan-out. */
    seq: z.number().int().nonnegative(),
    /** Server emit time. */
    ts: IsoUtc,
    source: z.literal(source),
    payload,
  });

export const RealtimeEvent = z.discriminatedUnion('type', [
  /** To B's user channel. */
  env(
    'bet.invited',
    'server',
    z.object({
      challenger: UserRef,
      room_id: Uuid,
      /** API-CONTRACT §3.4 NEW: the pair's record before this bet (A = challenger). */
      rivalry: StageRivalry.optional(),
      /** DANCE-OFF §7 double or nothing: the terminal bet this rematch follows. */
      rematch_of: BetId.optional(),
      /** DANCE-OFF §7: 2 × the old per-side stake, capped at max_stake (dollars). */
      suggested_stake_usd: z.number().positive().optional(),
    }),
  ),
  /** API-CONTRACT §3.4 NEW: B tapped accept/decline on the invite (not an authorization). */
  env('bet.invite_answered', 'server', BetInviteAnsweredPayload),
  env(
    'bet.state',
    'server',
    z.object({
      state: BetState,
      prev: BetState.nullable(),
      onchain_status: OnchainStatus.nullable(),
      chain_ack: ChainAck,
      pending_tx: PendingTx.nullable(),
      reason: z.string().max(80).nullable(),
    }),
  ),
  env('terms.draft', 'server', z.object({ draft: TermsDraft })),
  /** Speech Engine fallback only (§3). */
  env('terms.question', 'server', z.object({ question: ClarificationQuestion })),
  env('terms.refused', 'server', z.object({ refusal: GuardrailRefusal })),
  env('terms.proposed', 'server', z.object({ envelope: TermsEnvelope })),
  /** §9: the same lock message to both phones. */
  env('terms.authorize_request', 'server', AuthorizeRequest),
  /** Signatures now held; count 2 = lock being sent. */
  env(
    'terms.authorized',
    'server',
    z.object({
      party: Party,
      method: AuthorizationMethod,
      authorized_at: IsoUtc,
      count: z.number().int().min(1).max(2),
    }),
  ),
  env('terms.declined', 'server', z.object({ party: Party })),
  /** API-CONTRACT §3.4 NEW (odds, ./odds): a party or the judge offers stakes a/b. */
  env('odds.offered', 'server', OddsOfferedPayload),
  /** Accepted / countered / withdrawn / superseded. */
  env('odds.answered', 'server', OddsAnsweredPayload),
  /** Both accepted: these stakes are agreed (the card carries them under terms_hash). */
  env('odds.agreed', 'server', OddsAgreedPayload),
  /** API-CONTRACT §3.4 NEW: the loser's concede/appeal message (never the lock). */
  env('tx.sign_request', 'server', TxSignRequestPayload),
  /** API-CONTRACT §3.4 NEW: server-composed [EVENT] line; only A's phone (voice host) acts on it (§4.5). */
  env('judge.cue', 'server', JudgeCuePayload),
  env(
    'judge.line',
    'server',
    z.object({ utterance_id: Uuid, text: z.string().max(400), final: z.boolean() }),
  ),
  env(
    'party.line',
    'server',
    z.object({ party: Party, utterance_id: Uuid, text: z.string().max(600), final: z.boolean() }),
  ),
  env(
    'attempt.started',
    'server',
    z.object({
      attempt_no: z.number().int().min(1),
      performer: Party,
      max_ms: z.number().int().positive(),
      // API-CONTRACT §3.4 NEW fields: the judge cam's countdown.
      ...AttemptStartedExtra.shape,
    }),
  ),
  /** frame_urls are signed and short-lived. */
  env(
    'attempt.evidence',
    'server',
    z.object({ evidence: CameraEvidence, frame_urls: z.array(z.url()).max(24) }),
  ),
  /** REDO too. */
  env(
    'ruling.issued',
    'server',
    z.object({ ruling: z.union([Ruling, HearingRuling]), ruling_hash: Hex32 }),
  ),
  env(
    'hearing.opened',
    'server',
    z.object({
      hearing_id: Uuid,
      trigger: HearingTrigger,
      order: z.tuple([z.literal('A'), z.literal('B')]),
      turn_ms: z.number().int().positive(),
    }),
  ),
  /** API-CONTRACT §3.4 NEW: each hearing turn's clock starts. */
  env('hearing.turn_open', 'server', HearingTurnOpenPayload),
  env('hearing.turn', 'server', z.object({ turn: HearingTurn })),
  /** NEW (./gg): the loser's GG went out (bet.state CONCEDED in the same commit). */
  env('bet.gg', 'server', BetGgPayload),
  /** NEW (./gg): a review was asked for (voice / demo); the loser's phone opens the appeal confirm. */
  env('review.requested', 'server', ReviewRequestedPayload),
  /** NEW (./gg): the loser kept the ruling, or confirm_by passed unconfirmed. */
  env('review.closed', 'server', ReviewClosedPayload),
  /** NEW (./call-off): a "call it off" request opened, cleared, or agreed (a VOID ruling follows). */
  env('bet.call_off', 'server', CallOffPayload),
  /** NEW (./checks/events): the bet's terms compiled into camera checks (non-binding). */
  env('checks.compiled', 'server', ChecksCompiledPayload),
  /** NEW (./checks/events): one attempt's camera-check report, just before its ruling.issued. */
  env('checks.report', 'server', ChecksReportPayload),
  env('appeal.vote', 'server', z.object({ vote: AppealVote })),
  env('appeal.result', 'server', z.object({ result: AppealResult, ruling_hash: Hex32 })),
  /** 1 Hz per gemini bet; the stage chart uses the stage.market control frame (API-CONTRACT §3.1). */
  env('market.tick', 'server', z.object({ snapshot: GeminiMarketSnapshot })),
  /**
   * NEW (Beat 6): Gemini settled (or voided) the bet's contract. The record is the evidence the
   * settlement ruling commits to (evidence_hash = hashJcs(record)); ruling.issued follows in the
   * same commit, so clients can show Gemini's numbers next to the outcome.
   */
  env(
    'market.settled',
    'server',
    z.object({ record: GeminiSettlementRecord, evidence_hash: Hex32 }),
  ),
  /**
   * NEW (Dance Off): the server re-scored the round from the uploaded PoseSeries; ruling.issued
   * follows in the same commit (evidence_hash = hashJcs(evidence)).
   */
  env('dance.scored', 'server', DanceScoredPayload),
  env('tx.submitted', 'server', z.object({ kind: TxKind, signature: Signature })),
  env(
    'tx.confirmed',
    'server',
    z.object({ kind: TxKind, signature: Signature, slot: z.number().int() }),
  ),
  env(
    'tx.failed',
    'server',
    z.object({ kind: TxKind, signature: Signature.nullable(), error: z.string().max(200) }),
  ),
  env('chain.BetCreated', 'chain', ChainEvents.BetCreated),
  env('chain.BetAccepted', 'chain', ChainEvents.BetAccepted),
  env('chain.BetCancelled', 'chain', ChainEvents.BetCancelled),
  env('chain.BetResolved', 'chain', ChainEvents.BetResolved),
  env('chain.BetConceded', 'chain', ChainEvents.BetConceded),
  env('chain.BetAppealed', 'chain', ChainEvents.BetAppealed),
  env('chain.AppealResolved', 'chain', ChainEvents.AppealResolved),
  env('chain.BetFinalized', 'chain', ChainEvents.BetFinalized),
  env('chain.BetRefunded', 'chain', ChainEvents.BetRefunded),
  /** Housekeeping (rent back); not a "money moved" event. */
  env('chain.BetClosed', 'chain', ChainEvents.BetClosed),
]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;
export type RealtimeEventType = RealtimeEvent['type'];
export type RealtimeEventOf<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>;
export type RealtimePayload<T extends RealtimeEventType> = RealtimeEventOf<T>['payload'];

/**
 * API-CONTRACT §2.14 GET /v1/bets/:bet_id/events?after=<seq>&limit=<1..200> (betEventsPath in
 * ./api): the REST resync the client calls when a gap stays open 2 s (§3.3), and on cold start
 * to rebuild a bet from its log. `events` are the bet_events envelopes with seq > after, oldest
 * first, at most `limit` of them, exactly as the socket replays them. `last_seq` is the bet's
 * newest seq when the page was read (as BetSnapshot.last_seq and the WS `subscribed` frame):
 * while the page's last seq is below it, more follow; ask again with after = that seq.
 * Defined here rather than in ./api, which must not import this module.
 */
export const BetEventsResponse = z.object({
  events: z.array(RealtimeEvent),
  last_seq: z.number().int().nonnegative(),
});
export type BetEventsResponse = z.infer<typeof BetEventsResponse>;

/**
 * Client-side tolerant parse (§10.1 "Unknown types"): returns { ok: false } for unknown types or
 * invalid events, so the caller can drop them with a log line instead of throwing.
 */
export function parseRealtimeEvent(
  raw: unknown,
): { ok: true; event: RealtimeEvent } | { ok: false; error: z.ZodError } {
  const r = RealtimeEvent.safeParse(raw);
  return r.success ? { ok: true, event: r.data } : { ok: false, error: r.error };
}
