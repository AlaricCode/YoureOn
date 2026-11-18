// Typed endpoint wrappers over the signed client (API-CONTRACT §2). Request and response shapes
// are the packages/shared schemas wherever they exist; the few §2 responses shared does not
// define yet (balance, attempts, frames, concede) are declared here, tolerant z.object, exactly
// as the contract prints them. Some of these routes are still being built server-side.
import {
  AppealSubmitted,
  AuthorizationResult,
  BET_EVENTS_LIMIT,
  betEventsPath,
  BetSnapshot,
  CreateBetResponse,
  CreateRoomResponse,
  InviteAnswerResponse,
  JoinRoomResponse,
  RoomPresenceResponse,
  SignRequest,
  type PartySignature,
} from '@youre-on/shared/api';
import {
  AuthorizeRequest,
  type PartyAuthorization,
  type PartyDecline,
} from '@youre-on/shared/authorization';
import type { CameraEvidence } from '@youre-on/shared/evidence';
import { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import {
  marketTermsPath,
  MarketTermsResponse,
  type MarketTermsRequest,
} from '@youre-on/shared/judge/market-terms';
import { faceMatchPath, FaceMatchResponse, type FaceMatchRequest } from '@youre-on/shared/face';
import {
  termsConfirmPath,
  TermsConfirmResponse,
  typedTermsPath,
  TypedTermsResponse,
  type TypedTermsRequest,
} from '@youre-on/shared/judge/typed-terms';
import { VOICE_TOKENS_PATH, VoiceTokenResponse } from '@youre-on/shared/judge/voice';
import { MicroUsdc } from '@youre-on/shared/money';
import {
  oddsAcceptPath,
  oddsOfferPath,
  OddsOfferResponse,
  oddsSuggestPath,
  OddsSuggestResponse,
  oddsWithdrawPath,
  type OddsOfferRequest,
  type OddsSuggestRequest,
} from '@youre-on/shared/odds';
import { IsoUtc, Party, Signature, Uuid } from '@youre-on/shared/primitives';
import {
  BetEventsResponse,
  parseRealtimeEvent,
  type RealtimeEvent,
} from '@youre-on/shared/realtime';
import { z } from 'zod/v4';

import type { Recorder } from '../attempt/recorder';
import { boundaryFor, buildMultipart } from './multipart';
import type { ApiClient } from './signedFetch';

/** §2.14 GET /v1/me/balance */
export const Balance = z.object({
  wallet_pubkey: z.string(),
  usdc: MicroUsdc,
  usdc_display: z.string(),
  in_escrow: MicroUsdc,
  in_escrow_display: z.string(),
  as_of: IsoUtc,
});
export type Balance = z.infer<typeof Balance>;

/** §2.9 POST /v1/bets/:id/attempts -> 201 */
export const AttemptStartedResponse = z.object({
  attempt_no: z.number().int(),
  performer: Party,
  recorder_device_id: Uuid,
  max_ms: z.number().int(),
  go_at: IsoUtc,
});
/** §2.9 POST …/frames -> 202 */
export const FramesResponse = z.object({
  judging: z.boolean(),
  frame_hashes: z.array(z.string()),
  clip_upload: z
    .object({
      url: z.string(),
      method: z.literal('PUT'),
      headers: z.record(z.string(), z.string()),
    })
    .passthrough()
    .nullish(),
});
/** POST /v1/bets/:id/review/decline -> 200 (../gg; tolerant: only `status` is read). */
export const ReviewDeclined = z.object({ status: z.string() }).passthrough();
/** §2.10 POST /v1/bets/:id/concede -> 202 */
export const SubmittedResponse = z.object({ status: z.literal('submitted'), signature: Signature });
/**
 * §2.14 GET /v1/bets/:id/events: the shared BetEventsResponse with its events left unparsed, so
 * one envelope this build can't read is dropped on its own (SCHEMAS §10.1) instead of failing
 * the page.
 */
export const BetEventsPage = BetEventsResponse.extend({ events: z.array(z.unknown()) });

/** One page of a bet's log, as BetHub reads it (../app/betHub BetHubApi). */
export interface BetEventsRead {
  /** The envelopes that parse, in the order sent (seq order). */
  events: RealtimeEvent[];
  /** The bet's newest seq when the page was read. */
  last_seq: number;
  /**
   * The highest seq the page held, dropped envelopes included (`after` for an empty page): the
   * next page starts here, and a seq at or below it that is not in `events` is not coming.
   */
  through: number;
}

const seqOf = (raw: unknown): number | null => {
  const seq = (raw as { seq?: unknown } | null)?.seq;
  return typeof seq === 'number' && Number.isInteger(seq) ? seq : null;
};

/** Parses a BetEventsPage read after `after`: keeps the RealtimeEvents, notes the rest. */
export function readBetEventsPage(
  page: z.infer<typeof BetEventsPage>,
  after: number,
  log: (msg: string, extra?: unknown) => void = () => undefined,
): BetEventsRead {
  let through = after;
  const events: RealtimeEvent[] = [];
  for (const raw of page.events) {
    through = Math.max(through, seqOf(raw) ?? through);
    const p = parseRealtimeEvent(raw);
    if (p.ok) events.push(p.event);
    else log('events.drop_event', (raw as { type?: unknown } | null)?.type);
  }
  return { events, last_seq: page.last_seq, through };
}

/** §2.13 GET /v1/markets/btc5m/quote -> {result (ok only; refusals are 409), snapshot} */
export const MarketQuoteResponse = z.object({
  result: z.object({
    ok: z.literal(true),
    priceAtLock: z.string(),
    priceSource: z.enum(['mid', 'last_in_spread']),
    quotedAt: IsoUtc,
    stakes: z.object({ a: MicroUsdc, b: MicroUsdc, currency: z.literal('USDC') }),
  }),
  snapshot: GeminiMarketSnapshot,
});
export type MarketQuoteResponse = z.infer<typeof MarketQuoteResponse>;

/** §2.13 GET /v1/markets/btc5m/current (the fields the phone reads). */
export const MarketCurrentResponse = z.object({
  lockable: z.boolean(),
  next_window_start: IsoUtc.nullable(),
});

const bet = (id: string) => `/v1/bets/${encodeURIComponent(id)}`;

/** §2.14 GET /v1/me/bets: items stay unparsed here (app/history parses each one on its own). */
export const MeBetsPage = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().nullable(),
});

export function createYoApi(c: ApiClient) {
  return {
    balance: () => c.request('GET', '/v1/me/balance', { schema: Balance }),
    myBets: (status: 'active' | 'settled' | 'all', limit: number) =>
      c.request('GET', `/v1/me/bets?status=${status}&limit=${limit}`, { schema: MeBetsPage }),

    // §2.3 rooms
    createRoom: (name?: string) =>
      c.request('POST', '/v1/rooms', {
        json: { kind: 'session', ...(name ? { name } : {}) },
        schema: CreateRoomResponse,
      }),
    joinRoom: (code: string) =>
      c.request('POST', '/v1/rooms/join', { json: { code }, schema: JoinRoomResponse }),
    leaveRoom: (roomId: string) =>
      c.request('POST', `/v1/rooms/${encodeURIComponent(roomId)}/leave`),
    presence: (roomId: string) =>
      c.request('GET', `/v1/rooms/${encodeURIComponent(roomId)}/presence`, {
        schema: RoomPresenceResponse,
      }),

    // §2.4 face match (Beat 1): the probe embedding only; a match addresses, never authorizes
    faceMatch: (roomId: string, req: FaceMatchRequest) =>
      c.request('POST', faceMatchPath(roomId), { json: req, schema: FaceMatchResponse }),
    /** §2.5 challenge addressed by a face match: the 60 s ticket from faceMatch(). */
    createFaceBet: (roomId: string, opponentUserId: string, matchTicket: string) =>
      c.request('POST', '/v1/bets', {
        json: {
          room_id: roomId,
          opponent_user_id: opponentUserId,
          challenge_method: 'face',
          match_ticket: matchTicket,
        },
        schema: CreateBetResponse,
      }),

    // §2.5 challenge (pick-from-list path; also the face_pick_list fallback)
    createBet: (roomId: string, opponentUserId: string, voiceConversationId?: string) =>
      c.request('POST', '/v1/bets', {
        json: {
          room_id: roomId,
          opponent_user_id: opponentUserId,
          challenge_method: 'list',
          ...(voiceConversationId ? { voice_conversation_id: voiceConversationId } : {}),
        },
        schema: CreateBetResponse,
      }),
    acceptInvite: (betId: string) =>
      c.request('POST', `${bet(betId)}/invite/accept`, { schema: InviteAnswerResponse }),
    declineInvite: (betId: string) =>
      c.request('POST', `${bet(betId)}/invite/decline`, { schema: InviteAnswerResponse }),

    // §2.14 reads / resync
    getBet: (betId: string) => c.request('GET', bet(betId), { schema: BetSnapshot }),
    /**
     * One page of the bet's log after `after` (≤ 200 envelopes); entries that fail RealtimeEvent
     * parse are dropped (§10.1). BetHub pages on to `last_seq`. A server without the route
     * answers 404: the caller falls back to GET /v1/bets/:id.
     */
    async getBetEvents(betId: string, after: number, limit = BET_EVENTS_LIMIT) {
      const page = await c.request('GET', betEventsPath(betId, after, limit), {
        schema: BetEventsPage,
      });
      return readBetEventsPage(page, after);
    },

    // typed terms (Beat 2 without the voice judge; party A only)
    proposeTypedTerms: (betId: string, body: TypedTermsRequest) =>
      c.request('POST', typedTermsPath(betId), { json: body, schema: TypedTermsResponse }),
    /** Pin `idempotencyKey` per (bet, terms_hash): a resend is the same confirm. */
    confirmTerms: (betId: string, termsHash: string, idempotencyKey: string) =>
      c.request('POST', termsConfirmPath(betId), {
        json: { terms_hash: termsHash },
        schema: TermsConfirmResponse,
        idempotencyKey,
      }),

    // Odds (either party, TERMS_PROPOSED; app/odds): offer / counter, accept, withdraw, and
    // the judge's suggestion.
    offerOdds: (betId: string, body: OddsOfferRequest) =>
      c.request('POST', oddsOfferPath(betId), { json: body, schema: OddsOfferResponse }),
    acceptOdds: (betId: string, offerId: string, n: number) =>
      c.request('POST', oddsAcceptPath(betId, offerId), {
        json: { n },
        schema: OddsOfferResponse,
      }),
    withdrawOdds: (betId: string, offerId: string) =>
      c.request('POST', oddsWithdrawPath(betId, offerId), { json: {} }),
    suggestOdds: (betId: string, body: OddsSuggestRequest) =>
      c.request('POST', oddsSuggestPath(betId), { json: body, schema: OddsSuggestResponse }),

    // Beat 6: the Gemini BTC 5-minute closer (party A). The quote is a preview; the binding
    // one is taken by POST …/terms/market.
    marketQuote: (amountMicro: string, aSide: 'YES' | 'NO') =>
      c.request(
        'GET',
        `/v1/markets/btc5m/quote?amount=${encodeURIComponent(amountMicro)}&a_side=${aSide}`,
        { schema: MarketQuoteResponse },
      ),
    marketCurrent: () =>
      c.request('GET', '/v1/markets/btc5m/current', { schema: MarketCurrentResponse }),
    proposeMarketTerms: (betId: string, body: MarketTermsRequest) =>
      c.request('POST', marketTermsPath(betId), { json: body, schema: MarketTermsResponse }),

    // §2.8 lock
    getLock: (betId: string) =>
      c.request('GET', `${bet(betId)}/lock`, { schema: AuthorizeRequest }),
    /** Pin `idempotencyKey` per lock_request_id: a lost response resends the same signature (§1.6). */
    authorizeLock: (a: PartyAuthorization, idempotencyKey: string) =>
      c.request('POST', `${bet(a.bet_id)}/lock/authorizations`, {
        json: a,
        schema: AuthorizationResult,
        idempotencyKey,
      }),
    declineLock: (d: PartyDecline) =>
      c.request('POST', `${bet(d.bet_id)}/lock/decline`, { json: d }),

    // §2.9 attempts and evidence. 'self' = this phone films (two phones, never the performer's);
    // ../attempt/recorder picks it.
    startAttempt: (betId: string, attemptNo: number, recorder: Recorder = 'judge_cam') =>
      c.request('POST', `${bet(betId)}/attempts`, {
        json: { attempt_no: attemptNo, recorder },
        schema: AttemptStartedResponse,
      }),
    uploadFrames: (
      evidence: CameraEvidence,
      frames: readonly Uint8Array[],
      idempotencyKey: string,
    ) => {
      const body = buildMultipart(
        [
          { name: 'evidence', contentType: 'application/json', body: JSON.stringify(evidence) },
          ...frames.map((f, i) => ({
            name: 'frame',
            filename: `${String(i).padStart(2, '0')}.jpg`,
            contentType: 'image/jpeg',
            body: f,
          })),
        ],
        // Derived from the pinned key: the same upload rebuilt for a resend is the same bytes.
        boundaryFor(idempotencyKey),
      );
      return c.request('POST', `${bet(evidence.bet_id)}/attempts/${evidence.attempt_no}/frames`, {
        raw: { bytes: body.bytes, contentType: body.contentType },
        schema: FramesResponse,
        idempotencyKey,
      });
    },

    // §2.10 GG
    getConcede: (betId: string) =>
      c.request('GET', `${bet(betId)}/concede`, { schema: SignRequest }),
    concede: (s: PartySignature, idempotencyKey: string) =>
      c.request('POST', `${bet(s.bet_id)}/concede`, {
        json: s,
        schema: SubmittedResponse,
        idempotencyKey,
      }),

    // §2.12 appeal (Beat 5)
    getAppeal: (betId: string) => c.request('GET', `${bet(betId)}/appeal`, { schema: SignRequest }),
    appeal: (s: PartySignature, idempotencyKey: string) =>
      c.request('POST', `${bet(s.bet_id)}/appeal`, {
        json: s,
        schema: AppealSubmitted,
        idempotencyKey,
      }),

    /**
     * The loser's "Keep ruling" on a spoken review request (../gg): closes it (review.closed
     * 'declined'). Signed, no Idempotency-Key needed: the server answers 200 when already closed.
     */
    declineReview: (betId: string) =>
      c.request('POST', `${bet(betId)}/review/decline`, { schema: ReviewDeclined }),

    // §2.15 judge-cam role
    setDeviceRole: (role: 'phone' | 'judge_cam', roomId?: string) =>
      c.request('PATCH', '/v1/devices/current', {
        json: { role, ...(roomId ? { room_id: roomId } : {}) },
      }),

    // §2.6 voice
    voiceToken: (betId?: string) =>
      c.request('POST', VOICE_TOKENS_PATH, {
        json: { purpose: 'terms', ...(betId ? { bet_id: betId } : {}) },
        schema: VoiceTokenResponse,
      }),
  };
}
export type YoApi = ReturnType<typeof createYoApi>;
