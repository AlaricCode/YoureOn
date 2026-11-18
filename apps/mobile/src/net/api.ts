// Typed endpoint wrappers over the signed client (API-CONTRACT §2). Request and response shapes
// are the packages/shared schemas wherever they exist; the few §2 responses shared does not
// define yet (balance, attempts, frames, concede) are declared here, tolerant z.object, exactly
// as the contract prints them. Some of these routes are still being built server-side.
import {
  AuthorizationResult,
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
import {
  termsConfirmPath,
  TermsConfirmResponse,
  typedTermsPath,
  TypedTermsResponse,
  type TypedTermsRequest,
} from '@youre-on/shared/judge/typed-terms';
import { VOICE_TOKENS_PATH, VoiceTokenResponse } from '@youre-on/shared/judge/voice';
import { MicroUsdc } from '@youre-on/shared/money';
import { IsoUtc, Party, Signature, Uuid } from '@youre-on/shared/primitives';
import { RealtimeEvent } from '@youre-on/shared/realtime';
import { z } from 'zod/v4';

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
/** §2.10 POST /v1/bets/:id/concede -> 202 */
export const SubmittedResponse = z.object({ status: z.literal('submitted'), signature: Signature });
/** §2.14 GET /v1/bets/:id/events */
export const BetEventsResponse = z.object({
  events: z.array(z.unknown()),
  last_seq: z.number().int(),
});

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

const bet = (id: string) => `/v1/bets/${encodeURIComponent(id)}`;

export function createYoApi(c: ApiClient) {
  return {
    balance: () => c.request('GET', '/v1/me/balance', { schema: Balance }),

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

    // §2.5 challenge (pick-from-list path; face match is cut from the live demo)
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
    /** Events after `after`; entries that fail RealtimeEvent parse are dropped (§10.1). */
    async getBetEvents(betId: string, after: number) {
      const r = await c.request('GET', `${bet(betId)}/events?after=${after}&limit=200`, {
        schema: BetEventsResponse,
      });
      const events = r.events.flatMap((e) => {
        const p = RealtimeEvent.safeParse(e);
        return p.success ? [p.data] : [];
      });
      return { events, last_seq: r.last_seq };
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

    // Beat 6: the Gemini BTC 5-minute closer (party A). The quote is a preview; the binding
    // one is taken by POST …/terms/market.
    marketQuote: (amountMicro: string, aSide: 'YES' | 'NO') =>
      c.request(
        'GET',
        `/v1/markets/btc5m/quote?amount=${encodeURIComponent(amountMicro)}&a_side=${aSide}`,
        { schema: MarketQuoteResponse },
      ),
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

    // §2.9 attempts and evidence
    startAttempt: (betId: string, attemptNo: number) =>
      c.request('POST', `${bet(betId)}/attempts`, {
        json: { attempt_no: attemptNo, recorder: 'judge_cam' },
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
