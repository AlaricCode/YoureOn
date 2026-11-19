// API-owned types (API-CONTRACT §1.3, §1.5, §2.1, §2.18, §3). Re-authored from the spec.
// Shapes named by a SCHEMAS type are imported, never redefined. This module must not import
// ./realtime (realtime.ts will import the extension payloads below; avoid a cycle).
import { z } from 'zod/v4';
import { AppealResult } from './appeal';
import { AuthorizationMethod } from './authorization';
import { BetState, ChainAck, OnchainStatus, PendingTx } from './bet-state';
import { GeminiMarketSnapshot } from './gemini';
import { HearingRuling } from './hearing';
import { MicroUsdc } from './money';
import { TermsDraft } from './negotiation';
import {
  BetId,
  DisplayName,
  Hex32,
  IsoUtc,
  Party,
  Pubkey,
  Signature,
  UnixSeconds,
  UserRef,
  Uuid,
} from './primitives';
import { MAX_STAKE, MICRO_PER_USD } from './constants';
import { OnchainOutcome, Ruling } from './ruling';
import { StageVoiceName, VoicedEventType } from './stage-voice';
import { TermsEnvelope } from './terms';

// ---------------------------------------------------------------------------------------
// §1.5 Errors
// ---------------------------------------------------------------------------------------

/** The closed error-code catalogue, §1.5. */
export const ApiErrorCode = z.enum([
  'AUTH_REQUIRED',
  'SESSION_EXPIRED',
  'SIGNATURE_INVALID',
  'CLOCK_SKEW',
  'CHALLENGE_EXPIRED',
  'DEVICE_REVOKED',
  'AGE_REQUIRED',
  'NOT_A_PARTY',
  'NOT_LOSER',
  'NOT_IN_ROOM',
  'APP_UPDATE_REQUIRED',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'IDEMPOTENCY_KEY_REUSED',
  'NOT_FOUND',
  'ROOM_EXPIRED',
  'INVALID_STATE',
  'STATE_MOVED_ON',
  'TERMS_NOT_FINAL',
  'TERMS_HASH_MISMATCH',
  'MESSAGE_MISMATCH',
  'SIGN_REQUEST_EXPIRED',
  'LOCK_REVOKED',
  'LOCK_EXPIRED',
  'STALE_LOCK_REQUEST',
  'LOCK_PREFLIGHT_FAILED',
  'INSUFFICIENT_FUNDS',
  'CONCEDE_NOT_ALLOWED',
  'APPEAL_WINDOW_CLOSED',
  'ATTEMPT_NOT_OPEN',
  'FRAME_HASH_MISMATCH',
  'EVIDENCE_HASH_MISMATCH',
  'FACE_CONSENT_REQUIRED',
  'FACE_NOT_ENROLLED',
  'FACE_MODEL_UNSUPPORTED',
  'FACE_SEAL_INVALID',
  'STAKE_OUT_OF_RANGE',
  'MARKET_UNAVAILABLE',
  'NONCE_POOL_EXHAUSTED',
  'ESCROW_PAUSED',
  'RPC_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_ERROR',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** HTTP status per code, §1.5. */
export const API_ERROR_HTTP: Readonly<Record<ApiErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  SIGNATURE_INVALID: 401,
  CLOCK_SKEW: 401,
  CHALLENGE_EXPIRED: 401,
  DEVICE_REVOKED: 403,
  AGE_REQUIRED: 403,
  NOT_A_PARTY: 403,
  NOT_LOSER: 403,
  NOT_IN_ROOM: 403,
  APP_UPDATE_REQUIRED: 426,
  VALIDATION_FAILED: 422,
  PAYLOAD_TOO_LARGE: 413,
  IDEMPOTENCY_KEY_REUSED: 409,
  NOT_FOUND: 404,
  ROOM_EXPIRED: 410,
  INVALID_STATE: 409,
  STATE_MOVED_ON: 409,
  TERMS_NOT_FINAL: 409,
  TERMS_HASH_MISMATCH: 409,
  MESSAGE_MISMATCH: 409,
  SIGN_REQUEST_EXPIRED: 410,
  LOCK_REVOKED: 410,
  LOCK_EXPIRED: 410,
  STALE_LOCK_REQUEST: 409,
  LOCK_PREFLIGHT_FAILED: 409,
  INSUFFICIENT_FUNDS: 409,
  CONCEDE_NOT_ALLOWED: 409,
  APPEAL_WINDOW_CLOSED: 409,
  ATTEMPT_NOT_OPEN: 409,
  FRAME_HASH_MISMATCH: 422,
  EVIDENCE_HASH_MISMATCH: 422,
  FACE_CONSENT_REQUIRED: 412,
  FACE_NOT_ENROLLED: 409,
  FACE_MODEL_UNSUPPORTED: 422,
  FACE_SEAL_INVALID: 400,
  STAKE_OUT_OF_RANGE: 422,
  MARKET_UNAVAILABLE: 409,
  NONCE_POOL_EXHAUSTED: 503,
  ESCROW_PAUSED: 503,
  RPC_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/**
 * The `retryable` flag per code, read from §1.5's "Retry" column: any "yes"/"after …"/"wait"/
 * "re-read"/"re-fetch"/"maybe"/"new challenge" counts as retryable; "no" is not.
 */
export const API_ERROR_RETRYABLE: Readonly<Record<ApiErrorCode, boolean>> = {
  AUTH_REQUIRED: false,
  SESSION_EXPIRED: true,
  SIGNATURE_INVALID: false,
  CLOCK_SKEW: true,
  CHALLENGE_EXPIRED: true,
  DEVICE_REVOKED: false,
  AGE_REQUIRED: false,
  NOT_A_PARTY: false,
  NOT_LOSER: false,
  NOT_IN_ROOM: false,
  APP_UPDATE_REQUIRED: false,
  VALIDATION_FAILED: false,
  PAYLOAD_TOO_LARGE: false,
  IDEMPOTENCY_KEY_REUSED: false,
  NOT_FOUND: false,
  ROOM_EXPIRED: false,
  INVALID_STATE: true,
  STATE_MOVED_ON: true,
  TERMS_NOT_FINAL: true,
  TERMS_HASH_MISMATCH: true,
  MESSAGE_MISMATCH: true,
  SIGN_REQUEST_EXPIRED: true,
  LOCK_REVOKED: false,
  LOCK_EXPIRED: false,
  STALE_LOCK_REQUEST: true,
  LOCK_PREFLIGHT_FAILED: true,
  INSUFFICIENT_FUNDS: true,
  CONCEDE_NOT_ALLOWED: false,
  APPEAL_WINDOW_CLOSED: false,
  ATTEMPT_NOT_OPEN: false,
  FRAME_HASH_MISMATCH: true,
  EVIDENCE_HASH_MISMATCH: false,
  FACE_CONSENT_REQUIRED: true,
  FACE_NOT_ENROLLED: false,
  FACE_MODEL_UNSUPPORTED: false,
  FACE_SEAL_INVALID: false,
  STAKE_OUT_OF_RANGE: false,
  MARKET_UNAVAILABLE: true,
  NONCE_POOL_EXHAUSTED: true,
  ESCROW_PAUSED: false,
  RPC_UNAVAILABLE: true,
  UPSTREAM_TIMEOUT: true,
  UPSTREAM_ERROR: true,
  RATE_LIMITED: true,
  INTERNAL: true,
};

/** §2.18. `code` stays a plain string on the wire so old apps tolerate new codes. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
    request_id: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** `VALIDATION_FAILED` details.issues[] entries (§1.5). */
export const ValidationIssue = z.object({ path: z.string(), message: z.string() });
export type ValidationIssue = z.infer<typeof ValidationIssue>;

// ---------------------------------------------------------------------------------------
// §1.3 Authentication: signed strings (byte-exact; mobile and server must share these)
// ---------------------------------------------------------------------------------------

export const AUTH_TAG = 'yo-auth-v1';
export const BIND_TAG = 'yo-bind-v1';
export const REQ_TAG = 'yo-req-v1';

export const AuthPurpose = z.enum(['signup', 'login', 'demo-claim']);
export type AuthPurpose = z.infer<typeof AuthPurpose>;

/**
 * `device_sig` input: `yo-auth-v1\npurpose=<p>\nchallenge=<nonce>\ndevice=<device_pubkey>\nwallet=<wallet_pubkey or ->\n`.
 * Convention (API-CONTRACT leaves it implicit): signup passes its wallet_pubkey; login and
 * demo-claim pass `null` (rendered `-`), because neither request body carries a wallet key.
 */
export function authChallengeMessage(a: {
  purpose: AuthPurpose;
  nonce: string;
  device_pubkey: string;
  wallet_pubkey: string | null;
}): string {
  return (
    `${AUTH_TAG}\npurpose=${a.purpose}\nchallenge=${a.nonce}\n` +
    `device=${a.device_pubkey}\nwallet=${a.wallet_pubkey ?? '-'}\n`
  );
}

/** `wallet_sig` input: `yo-bind-v1\nwallet=<wallet_pubkey>\ndevice=<device_pubkey>\nchallenge=<nonce>\n`. */
export function walletBindMessage(a: {
  wallet_pubkey: string;
  device_pubkey: string;
  nonce: string;
}): string {
  return `${BIND_TAG}\nwallet=${a.wallet_pubkey}\ndevice=${a.device_pubkey}\nchallenge=${a.nonce}\n`;
}

/**
 * `X-YO-Signature` input for signed writes (every POST/PUT/PATCH/DELETE except /v1/auth/*):
 * `yo-req-v1\n<METHOD>\n<path?query exactly as sent>\n<X-YO-Timestamp>\n<Idempotency-Key>\n<session_id>\n<hex sha256(raw body)>`.
 * No trailing newline. An empty body hashes the empty byte string.
 */
export function requestSigningString(a: {
  method: string;
  path_and_query: string;
  timestamp_ms: number | string;
  idempotency_key: string;
  session_id: string;
  body_sha256_hex: string;
}): string {
  return [
    REQ_TAG,
    a.method.toUpperCase(),
    a.path_and_query,
    String(a.timestamp_ms),
    a.idempotency_key,
    a.session_id,
    a.body_sha256_hex,
  ].join('\n');
}

/** Header names, §1.3 / §1.6. */
export const HDR = {
  authorization: 'Authorization',
  device: 'X-YO-Device',
  timestamp: 'X-YO-Timestamp',
  idempotencyKey: 'Idempotency-Key',
  signature: 'X-YO-Signature',
  requestId: 'X-Request-Id',
  idempotentReplayed: 'Idempotent-Replayed',
  appVersion: 'X-App-Version',
  schemaVersion: 'X-Schema-Version',
} as const;

/** Replay window for signed requests, §1.3. */
export const REQUEST_CLOCK_SKEW_MS = 60_000;
/** Auth challenges live 60 s, §1.3. */
export const AUTH_CHALLENGE_TTL_MS = 60_000;
/** Sessions live 7 d, §1.3. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Idempotency cache lifetime, §1.6. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** ed25519 signature (64 bytes) as standard padded base64 (§1.4 "binary in JSON is base64"). */
export const Ed25519SigB64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]{86}==$/, 'ed25519 signature: 64 bytes, standard base64');
/** ed25519 signature (64 bytes) as base64url without padding: the `X-YO-Signature` header. */
export const Ed25519SigB64Url = z
  .string()
  .regex(/^[A-Za-z0-9_-]{86}$/, 'ed25519 signature: 64 bytes, base64url, no padding');
/** `yo_s_<base64url 32 B>`. */
export const SessionToken = z.string().regex(/^yo_s_[A-Za-z0-9_-]{43}$/);
/** Challenge nonce: 32 random bytes, base64url without padding. */
export const ChallengeNonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const AppVersion = z.string().min(1).max(64);

// ---------------------------------------------------------------------------------------
// §2.1 Auth endpoints
// ---------------------------------------------------------------------------------------

/** POST /v1/auth/challenge */
export const AuthChallengeRequest = z.object({ device_pubkey: Pubkey });
export type AuthChallengeRequest = z.infer<typeof AuthChallengeRequest>;
export const AuthChallengeResponse = z.object({
  challenge_id: Uuid,
  nonce: ChallengeNonce,
  expires_at: IsoUtc,
  server_time: IsoUtc,
});
export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponse>;

/** 18+ self-attestation (BRIEF 5c). `is_18_plus` must be literally true; anything else is AGE_REQUIRED. */
export const AgeAttestation = z.object({ is_18_plus: z.literal(true), attested_at: IsoUtc });
export type AgeAttestation = z.infer<typeof AgeAttestation>;

/** POST /v1/auth/signup -> 201 Session */
export const SignupRequest = z.object({
  challenge_id: Uuid,
  display_name: DisplayName,
  age_attestation: AgeAttestation,
  wallet_pubkey: Pubkey,
  device_pubkey: Pubkey,
  device_sig: Ed25519SigB64,
  wallet_sig: Ed25519SigB64,
  app_version: AppVersion,
});
export type SignupRequest = z.infer<typeof SignupRequest>;

/** POST /v1/auth/session (login) -> 200 Session */
export const LoginRequest = z.object({
  challenge_id: Uuid,
  device_pubkey: Pubkey,
  device_sig: Ed25519SigB64,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * POST /v1/auth/demo-claim (DEMO_MODE only) -> 200 DemoClaimResponse. `device_sig` is over
 * authChallengeMessage({purpose: 'demo-claim', wallet_pubkey: null}). `challenge_id` names the
 * challenge that was signed; without it the server uses this device key's newest challenge.
 */
export const DemoClaimRequest = z.object({
  challenge_id: Uuid.optional(),
  claim_token: z.string().min(1).max(256),
  device_pubkey: Pubkey,
  device_sig: Ed25519SigB64,
});
export type DemoClaimRequest = z.infer<typeof DemoClaimRequest>;

/** The two custodial demo parties (env DEMO_A_SECRET_KEY / DEMO_B_SECRET_KEY, decision D-A). */
export const DemoParty = z.enum(['a', 'b']);
export type DemoParty = z.infer<typeof DemoParty>;

/** Demo claim tokens are single use and live 10 min (§1.3). */
export const DEMO_CLAIM_TOKEN_TTL_MS = 10 * 60 * 1000;
/** `yo_dc_<base64url 32 B>`. */
export const DemoClaimToken = z.string().regex(/^yo_dc_[A-Za-z0-9_-]{43}$/);
/** The QR word: lowercase letters and `-` (the phone strips `youreon://<word>/`). */
export const DemoClaimWord = z.string().regex(/^[a-z-]{1,32}$/);

/** The stage QR payload: `youreon://<word>/<token>`. */
export const demoClaimQr = (word: string, token: string): string => `youreon://${word}/${token}`;
/** QR text -> claim token: a raw token, or `youreon://<word>/<token>`. */
export const demoClaimTokenFromQr = (qr: string): string =>
  qr.trim().replace(/^youreon:\/\/[a-z-]+\//i, '');

/** POST /v1/demo/claim-tokens (DEMO_MODE + X-YO-Demo-Key, §2.17) */
export const DemoClaimTokenRequest = z.object({
  party: DemoParty,
  /** Renames the demo account on claim (else it keeps its name, or a new one is "Demo A/B"). */
  display_name: DisplayName.optional(),
});
export type DemoClaimTokenRequest = z.infer<typeof DemoClaimTokenRequest>;
export const DemoClaimTokenResponse = z.object({
  token: DemoClaimToken,
  word: DemoClaimWord,
  qr: z.string(),
  expires_at: IsoUtc,
  party: DemoParty,
  /** The demo party's wallet pubkey: the claimed session's user.pubkey. */
  pubkey: Pubkey,
});
export type DemoClaimTokenResponse = z.infer<typeof DemoClaimTokenResponse>;

export const Session = z.object({
  token: SessionToken,
  session_id: Uuid,
  user: UserRef,
  device_id: Uuid,
  expires_at: IsoUtc,
  server_time: IsoUtc,
});
export type Session = z.infer<typeof Session>;

/**
 * POST /v1/auth/demo-claim -> Session + the custodial seed, sent exactly once: base64 of the
 * 32-byte ed25519 seed whose public key is `user.pubkey`.
 */
export const DemoClaimResponse = Session.extend({ wallet_seed_b64: z.string().min(1) });
export type DemoClaimResponse = z.infer<typeof DemoClaimResponse>;

// ---------------------------------------------------------------------------------------
// §2.18 API-owned types
// ---------------------------------------------------------------------------------------

export const SignedMicroUsdc = z.string().regex(/^-?(0|[1-9][0-9]{0,19})$/);
export type SignedMicroUsdc = z.infer<typeof SignedMicroUsdc>;

export const SealedEmbedding = z.object({
  alg: z.enum(['x25519-hkdf-sha256-chacha20poly1305-v1', 'plain-v0']),
  epk_b64: z.string().nullable(),
  nonce_b64: z.string().nullable(),
  ct_b64: z.string(),
});
export type SealedEmbedding = z.infer<typeof SealedEmbedding>;

/** A pair with at least this many settled bets (pushes included) is a rivalry. */
export const RIVAL_MIN_SETTLED = 3;

/** One settled bet, from the reader's side: won, lost, or a split/refund. */
export const H2HResult = z.enum(['win', 'loss', 'push']);
export type H2HResult = z.infer<typeof H2HResult>;

/** The run of same-winner results ending at the latest settled bet. */
export const H2HStreak = z.object({
  holder: z.enum(['me', 'them']),
  length: z.number().int().min(1),
});
export type H2HStreak = z.infer<typeof H2HStreak>;

export const HeadToHead = z.object({
  wins: z.number().int(),
  losses: z.number().int(),
  pushes: z.number().int(),
  net: SignedMicroUsdc,
  net_display: z.string(),
  last_settled_at: IsoUtc.nullable(),
  includes_seed: z.boolean(),
  // Rivalry fields (live scan, stage). Additive and optional so older replies still parse;
  // this server always sends them.
  /** wins + losses + pushes. */
  total: z.number().int().nonnegative().optional(),
  /** The latest settled bet's result; null with no settled bets. */
  last_result: H2HResult.nullable().optional(),
  /** The run of same-winner results ending at the latest settled bet; null if latest is a push or none. */
  streak: H2HStreak.nullable().optional(),
  /** total >= RIVAL_MIN_SETTLED. */
  rival: z.boolean().optional(),
});
export type HeadToHead = z.infer<typeof HeadToHead>;

/** One single-party Solana message (concede or appeal) for the loser's device. The lock uses SCHEMAS AuthorizeRequest. */
export const SignRequest = z.object({
  bet_id: BetId,
  kind: z.enum(['concede', 'appeal']),
  for_parties: z.array(Party).length(1),
  message_b64: z.string(),
  message_sha256: Hex32,
  fee_payer: Pubkey,
  signers: z.array(Pubkey),
  lifetime: z.object({
    type: z.literal('blockhash'),
    blockhash: z.string(),
    last_valid_block_height: z.number().int(),
    valid_until: IsoUtc,
  }),
  envelope: TermsEnvelope,
  card: z.object({
    title: z.string(),
    prompt_message: z.string(),
    hold_label: z.string(),
    stakes_line: z.string(),
    pot_line: z.string(),
    odds_display: z.string().nullable(),
    terms_code: z.string(),
    countdown_ends_at: IsoUtc,
  }),
  ruling_ref: z.object({ ruling_hash: Hex32, outcome: z.string() }),
  issued_at: IsoUtc,
});
export type SignRequest = z.infer<typeof SignRequest>;

export const PartySignature = z.object({
  bet_id: BetId,
  kind: z.enum(['concede', 'appeal']),
  party: Party,
  message_sha256: Hex32,
  party_signature: Signature,
  method: AuthorizationMethod,
  signed_at: IsoUtc,
});
export type PartySignature = z.infer<typeof PartySignature>;

/** §2.12 POST /v1/bets/:bet_id/appeal -> 202 (also POST /v1/demo/bets/:bet_id/appeal, §2.17). */
export const AppealSubmitted = z.object({
  status: z.literal('submitted'),
  signature: Signature,
  appeal_id: Uuid,
});
export type AppealSubmitted = z.infer<typeof AppealSubmitted>;

/**
 * §2.17 POST /v1/demo/bets/:bet_id/appeal (LOCK_SIGNER=server): the server signs the appeal as the
 * losing demo party. `party` is only needed for a VOID ruling (either party may appeal; default A).
 */
export const DemoAppealRequest = z.object({ party: Party.optional() });
export type DemoAppealRequest = z.infer<typeof DemoAppealRequest>;

export const AuthorizationResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('recorded'), waiting_for: Party }),
  z.object({ status: z.literal('submitted'), signature: Signature }),
]);
export type AuthorizationResult = z.infer<typeof AuthorizationResult>;

const PartyAuthSummary = z
  .object({ method: AuthorizationMethod, authorized_at: IsoUtc })
  .nullable();

export const BetSnapshot = z.object({
  bet_id: BetId,
  room_id: Uuid.nullable(),
  state: BetState,
  prev_state: BetState.nullable(),
  onchain_status: OnchainStatus.nullable(),
  chain_ack: ChainAck,
  pending_tx: PendingTx.nullable(),
  party_a: UserRef,
  party_b: UserRef,
  my_party: Party.nullable(),
  envelope: TermsEnvelope.nullable(),
  draft: TermsDraft.nullable(),
  authorizations: z.object({ A: PartyAuthSummary, B: PartyAuthSummary }),
  deadlines: z.object({
    accept_deadline: UnixSeconds.nullable(),
    resolve_deadline: UnixSeconds.nullable(),
    appeal_deadline: UnixSeconds.nullable(),
    appeal_resolve_deadline: UnixSeconds.nullable(),
  }),
  attempt_no: z.number().int().nullable(),
  redo_count: z.number().int(),
  latest_ruling: z
    .object({ ruling: z.union([Ruling, HearingRuling]), ruling_hash: Hex32 })
    .nullable(),
  appeal: AppealResult.nullable(),
  payout: z.object({ to_a: MicroUsdc, to_b: MicroUsdc }).nullable(),
  signatures: z.record(z.string(), Signature),
  end_reason: z.string().nullable(),
  last_seq: z.number().int(),
});
export type BetSnapshot = z.infer<typeof BetSnapshot>;

/**
 * §2.14 GET /v1/me/bets item: a whole BetSnapshot (a phone adopts it exactly like
 * GET /v1/bets/:bet_id) plus the contract's BetSummary list fields. Only bets the caller is a
 * party of (any of the caller's devices, including A's judge cam), so each item is GETtable and
 * subscribable by the caller.
 */
export const MeBetItem = BetSnapshot.extend({
  title: z.string(),
  opponent: UserRef,
  my_stake: MicroUsdc.nullable(),
  /** Additive (odds): the opponent's stake, so a history row can show "$5 vs $15". */
  their_stake: MicroUsdc.nullable().optional(),
  my_payout: MicroUsdc.nullable(),
  outcome: OnchainOutcome.nullable(),
  settled_at: IsoUtc.nullable(),
  is_seed: z.boolean(),
});
export type MeBetItem = z.infer<typeof MeBetItem>;

/** `active` = not terminal; `settled` = PAID / VOIDED; `all` (the default) = everything. */
export const MeBetsStatus = z.enum(['active', 'settled', 'all']);
export type MeBetsStatus = z.infer<typeof MeBetsStatus>;

export const MeBetsResponse = z.object({
  items: z.array(MeBetItem),
  /** Opaque; pass back as `cursor` for the next (older) page. null on the last page. */
  next_cursor: z.string().nullable(),
});
export type MeBetsResponse = z.infer<typeof MeBetsResponse>;

/**
 * §2.14 GET /v1/bets/:bet_id/events?after=<seq>&limit=200: the page size the contract prints,
 * which is also the most one page returns. The response schema is `BetEventsResponse` in
 * ./realtime (it embeds RealtimeEvent, and this module must not import ./realtime).
 */
export const BET_EVENTS_LIMIT = 200;
/** The REST resync path: the bet's log after `after`, oldest first, at most `limit` envelopes. */
export const betEventsPath = (betId: string, after: number, limit: number = BET_EVENTS_LIMIT) =>
  `/v1/bets/${encodeURIComponent(betId)}/events?after=${after}&limit=${limit}`;

/** §2.3 */
export const RoomMember = z.object({
  user: UserRef,
  face_enrolled: z.boolean(),
  online: z.boolean(),
  last_seen_at: IsoUtc,
});
export type RoomMember = z.infer<typeof RoomMember>;

// ---------------------------------------------------------------------------------------
// §3.4 NEW realtime payloads (they join SCHEMAS RealtimeEvent in realtime.ts)
// ---------------------------------------------------------------------------------------

/** §4.5 cue names. */
export const JudgeCueName = z.enum([
  'AUTHORIZED',
  'LOCKED',
  'LOCK_FAILED',
  'DECLINED',
  'EXPIRED',
  'REFUSED',
  'ATTEMPT_ARMED',
  'RULING',
  'REDO',
  'HEARING_REQUIRED',
  'HEARING_TURN',
  'HEARING_RULING',
  'APPEAL_FILED',
  'APPEAL_VOTE',
  'APPEAL_RESULT',
  'MARKET_WAITING',
  'MARKET_SETTLED',
  'PAID',
  'VOIDED',
  // Additive: B tapped accept after a voiced confirm_terms was refused INVITE_PENDING (§2.5).
  'INVITE_ACCEPTED',
  // Additive (./gg): the review the judge asked for closed unconfirmed / kept (speak:false).
  'REVIEW_CLOSED',
  // Additive (odds, §2.19): an offer, a counter, both accepted.
  'ODDS_OFFERED',
  'ODDS_COUNTERED',
  'ODDS_AGREED',
]);
export type JudgeCueName = z.infer<typeof JudgeCueName>;

export const TxSignRequestPayload = z.object({ request: SignRequest });
export const JudgeCuePayload = z.object({
  cue: JudgeCueName,
  text: z.string().max(300),
  speak: z.boolean(),
});
export const HearingTurnOpenPayload = z.object({
  hearing_id: Uuid,
  turn_index: z.number().int().nonnegative(),
  party: Party,
  closes_at: IsoUtc,
});
export const BetInviteAnsweredPayload = z.object({
  party: z.literal('B'),
  answer: z.enum(['accepted', 'declined']),
});
/** Fields `attempt.started` gains (§3.4). */
export const AttemptStartedExtra = z.object({ recorder_device_id: Uuid, go_at: IsoUtc });

// ---------------------------------------------------------------------------------------
// §3 WebSocket control frames (carry `op`; not RealtimeEvents; not sequenced)
// ---------------------------------------------------------------------------------------

export const WS_PATH = '/v1/ws';
/** Server ping interval (FINDINGS §3.13). */
export const WS_HEARTBEAT_MS = 20_000;
/** `hello` must arrive within this, or the server closes with 4401. */
export const WS_HELLO_TIMEOUT_MS = 5_000;
/** Client declares the socket dead after this long with no frame (§3.3). */
export const WS_CLIENT_DEAD_MS = 45_000;
/** Client reconnect backoff steps in ms, plus jitter (§3.3). */
export const WS_RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
/** Server drops a socket after this many unanswered pings (§3.3). */
export const WS_MAX_MISSED_PONGS = 2;
/** Server drops a socket whose send buffer exceeds this (§3.3). */
export const WS_MAX_BUFFERED_BYTES = 1024 * 1024;
export const WS_CLOSE = {
  /** No/invalid hello, bad token, or hello timeout. */
  UNAUTHORIZED: 4401,
  /** Subscribe to a bet or room the caller may not see. */
  FORBIDDEN: 4403,
} as const;

export const WsSub = z.object({
  bet_id: BetId,
  after_seq: z.number().int().nonnegative().default(0),
});

export const WsHello = z.object({
  op: z.literal('hello'),
  token: z.string().min(1).max(256),
  /** Absent for stage tokens. */
  device_id: Uuid.nullish(),
  app_version: z.string().max(64).nullish(),
  subs: z.array(WsSub).max(32).default([]),
});
export const WsSubscribe = z.object({
  op: z.literal('subscribe'),
  bet_id: BetId,
  after_seq: z.number().int().nonnegative().default(0),
});
export const WsUnsubscribe = z.object({ op: z.literal('unsubscribe'), bet_id: BetId });
export const WsSubscribeRoom = z.object({ op: z.literal('subscribe_room'), room_id: Uuid });
export const WsPong = z.object({ op: z.literal('pong'), t: z.number() });

export const WsClientFrame = z.discriminatedUnion('op', [
  WsHello,
  WsSubscribe,
  WsUnsubscribe,
  WsSubscribeRoom,
  WsPong,
]);
export type WsClientFrame = z.infer<typeof WsClientFrame>;
export type WsClientFrameInput = z.input<typeof WsClientFrame>;

export const WsWelcome = z.object({
  op: z.literal('welcome'),
  server_time: IsoUtc,
  heartbeat_ms: z.number().int().positive(),
  user_channel: z.boolean(),
});
export const WsSubscribed = z.object({
  op: z.literal('subscribed'),
  bet_id: BetId,
  last_seq: z.number().int().nonnegative(),
  replayed: z.number().int().nonnegative(),
});
export const WsPing = z.object({ op: z.literal('ping'), t: z.number(), server_time: IsoUtc });
export const WsErrorFrame = z.object({
  op: z.literal('error'),
  code: z.string(),
  message: z.string(),
});
export const WsRoomPresence = z.object({
  op: z.literal('room.presence'),
  room_id: Uuid,
  members: z.array(RoomMember),
});
export const WsStageMarket = z.object({
  op: z.literal('stage.market'),
  snapshot: GeminiMarketSnapshot,
});
export const StageCueKind = z.enum(['gavel', 'drumroll', 'buzzer', 'cheer']);
export const WsStageCue = z.object({
  op: z.literal('stage.cue'),
  bet_id: BetId,
  kind: StageCueKind,
  /**
   * Additive: the cue's ElevenLabs Sound Effects clip (GET /v1/stage/sfx/:kind with the stage
   * bearer), when the server generates them. Absent: the stage plays its own synthesized sound.
   */
  audio_url: z.string().max(200).optional(),
});
/**
 * Additive (stage sessions only): the ElevenLabs TTS clip of the stage line for bet event
 * (bet_id, seq), sent right after that event, before the clip is generated (the GET waits for
 * it). The stage speaks `text` itself when no frame comes within ~800 ms or the clip fails.
 * Never sent for a line the phone judge says (stage-voice.ts leftToPhoneJudge).
 */
export const WsStageVoice = z.object({
  op: z.literal('stage.voice'),
  bet_id: BetId,
  seq: z.number().int().nonnegative(),
  type: VoicedEventType,
  voice: StageVoiceName,
  text: z.string().max(400),
  /** sha256 hex of voice id, model and text. */
  clip_id: Hex32,
  /** GET with the stage bearer: /v1/stage/tts/:clip_id. */
  audio_url: z.string().max(200),
});

export const WsServerControlFrame = z.discriminatedUnion('op', [
  WsWelcome,
  WsSubscribed,
  WsPing,
  WsErrorFrame,
  WsRoomPresence,
  WsStageMarket,
  WsStageCue,
  WsStageVoice,
]);
export type WsServerControlFrame = z.infer<typeof WsServerControlFrame>;

/**
 * GET /v1/stage/audio (stage bearer): what the server voices on the projector. `tts` false
 * (`tts_off` says why): no stage.voice frames, the stage speaks with the browser's voice. `sfx`
 * null: the stage synthesizes its cues; else each cue's ElevenLabs clip URL.
 */
export const StageAudioResponse = z.object({
  tts: z.boolean(),
  tts_off: z.enum(['no_key', 'off', 'spend_disabled']).nullable(),
  model: z.string().nullable(),
  sfx: z.record(StageCueKind, z.string()).nullable(),
});
export type StageAudioResponse = z.infer<typeof StageAudioResponse>;

// ---------------------------------------------------------------------------------------
// §2.3 Rooms and presence, §2.5 Challenge (rooms/challenge stream, TASKS D0-J4)
// ---------------------------------------------------------------------------------------

/** DATA-MODEL §5.4 rooms.code: 6 chars, no 0/O/1/I. */
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** `qr_payload` = ROOM_QR_PREFIX + code. */
export const ROOM_QR_PREFIX = 'youreon://room/';
export const RoomCode = z.string().regex(ROOM_CODE_RE);
export type RoomCode = z.infer<typeof RoomCode>;
export const roomQrPayload = (code: string): string => `${ROOM_QR_PREFIX}${code}`;

/**
 * A typed code or a scanned QR payload -> the canonical code, or null. Typed codes are
 * trimmed and upper-cased (people type "ubc26x"); a QR payload must be exactly
 * `youreon://room/<CODE>`.
 */
export function parseRoomCode(input: string): string | null {
  const s = input.trim();
  const raw = s.startsWith(ROOM_QR_PREFIX) ? s.slice(ROOM_QR_PREFIX.length) : s.toUpperCase();
  return ROOM_CODE_RE.test(raw) ? raw : null;
}

export const RoomKind = z.enum(['demo', 'nearby', 'session']);

/** POST /v1/rooms. Only 'session' rooms are created over the API (demo rooms are seeded). */
export const CreateRoomRequest = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  kind: z.literal('session').default('session'),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;

export const CreateRoomResponse = z.object({
  room_id: Uuid,
  code: RoomCode,
  qr_payload: z.string(),
  expires_at: IsoUtc,
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;

/** §2.3 names RoomSummary without defining it; this is the shape the server returns. */
export const RoomSummary = z.object({
  room_id: Uuid,
  code: RoomCode,
  name: z.string().nullable(),
  kind: RoomKind,
  is_demo: z.boolean(),
  qr_payload: z.string(),
  created_by: Uuid.nullable(),
  expires_at: IsoUtc,
});
export type RoomSummary = z.infer<typeof RoomSummary>;

/** POST /v1/rooms/join: exactly one of `code` / `qr_payload`. */
export const JoinRoomRequest = z.union([
  z.object({ code: z.string().max(64), qr_payload: z.undefined().optional() }),
  z.object({ qr_payload: z.string().max(128), code: z.undefined().optional() }),
]);
export type JoinRoomRequest = z.infer<typeof JoinRoomRequest>;

export const JoinRoomResponse = z.object({ room: RoomSummary, members: z.array(RoomMember) });
export type JoinRoomResponse = z.infer<typeof JoinRoomResponse>;

export const RoomPresenceResponse = z.object({ members: z.array(RoomMember) });
export type RoomPresenceResponse = z.infer<typeof RoomPresenceResponse>;

/** `online` = a live WS now or within this many ms (§2.3 "a live WS within 30 s"). */
export const PRESENCE_ONLINE_GRACE_MS = 30_000;

export const ChallengeMethod = z.enum(['face', 'list', 'link']);
export type ChallengeMethod = z.infer<typeof ChallengeMethod>;

/**
 * `bet.invited.rivalry` (API-CONTRACT §3.4): the pair's record so far, in party terms (A is the
 * challenger), for the projector's "Logan 4–7 Jake" line. Facts only, no score.
 */
export const StageRivalry = z.object({
  challenge_method: ChallengeMethod,
  a_wins: z.number().int().nonnegative(),
  b_wins: z.number().int().nonnegative(),
  pushes: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  streak: z.object({ party: Party, length: z.number().int().min(1) }).nullable(),
  rival: z.boolean(),
  includes_seed: z.boolean(),
});
export type StageRivalry = z.infer<typeof StageRivalry>;

/**
 * The stage rivalry of a new bet. `h2h` is party A's view (headToHead(db, aId, bId)): `me` maps
 * to A and `them` to B. Fields an older HeadToHead lacks are derived (total, rival; streak null).
 */
export function rivalryOf(h2h: HeadToHead, method: ChallengeMethod): StageRivalry {
  const total = h2h.total ?? h2h.wins + h2h.losses + h2h.pushes;
  const s = h2h.streak ?? null;
  return {
    challenge_method: method,
    a_wins: Math.max(0, h2h.wins),
    b_wins: Math.max(0, h2h.losses),
    pushes: Math.max(0, h2h.pushes),
    total: Math.max(0, total),
    streak: s ? { party: s.holder === 'me' ? 'A' : 'B', length: s.length } : null,
    rival: h2h.rival ?? total >= RIVAL_MIN_SETTLED,
    includes_seed: h2h.includes_seed,
  };
}

/** POST /v1/bets. */
export const CreateBetRequest = z.object({
  room_id: Uuid,
  opponent_user_id: Uuid,
  challenge_method: ChallengeMethod,
  /** Required for 'face' (D4-M1); the opaque 60 s ticket from face-match. */
  match_ticket: z.string().min(1).max(512).nullish(),
  /** The pre-minted token's conversation_id (§2.6); bound to the new bet. */
  voice_conversation_id: z.string().min(1).max(128).nullish(),
});
export type CreateBetRequest = z.infer<typeof CreateBetRequest>;

/** Passed verbatim to the ElevenLabs `startSession` (§4.1). All values are strings. */
export const VoiceDynamicVariables = z.object({
  bet_id: BetId,
  party_a_name: z.string(),
  party_b_name: z.string(),
  max_stake_usd: z.string(),
});
export type VoiceDynamicVariables = z.infer<typeof VoiceDynamicVariables>;

export const CreateBetResponse = z.object({
  bet: BetSnapshot,
  voice: z.object({ dynamic_variables: VoiceDynamicVariables }),
});
export type CreateBetResponse = z.infer<typeof CreateBetResponse>;

/** POST /v1/bets/:bet_id/invite/accept and /invite/decline. */
export const InviteAnswerResponse = z.object({ bet: BetSnapshot });
export type InviteAnswerResponse = z.infer<typeof InviteAnswerResponse>;

/** Outbox `challenge_received` payload (display data only, DATA-MODEL §5.17). */
export const ChallengeReceivedPush = z.object({
  bet_id: BetId,
  room_id: Uuid,
  challenger: z.object({ user_id: Uuid, display_name: z.string() }),
  title: z.string(),
  body: z.string(),
});
export type ChallengeReceivedPush = z.infer<typeof ChallengeReceivedPush>;

// ---------------------------------------------------------------------------------------
// Dance Off (docs/planning/DANCE-OFF.md §5, §7)
// ---------------------------------------------------------------------------------------

export {
  DANCE_STAKES_USD,
  DanceTermsRequest,
  DanceTermsResponse,
  danceTermsPath,
} from './judge/dance-terms';

/** POST /v1/bets/:bet_id/attempts/:n/dance (multipart: `upload` DanceUpload JSON + `frame` × 4). */
export const danceUploadPath = (betId: string, attemptNo: number) =>
  `/v1/bets/${encodeURIComponent(betId)}/attempts/${attemptNo}/dance`;

/** 202 to a dance upload: the server's own scores and the record's hash; the ruling follows. */
export const DanceUploadResponse = z.object({
  judging: z.literal(true),
  evidence_hash: Hex32,
  pose_sha256: Hex32,
  /** Server-recomputed tenths. */
  scores: z.object({ a: z.number().int(), b: z.number().int() }),
  /** The phone's scores differed from the server's (logged; the server's count). */
  client_mismatch: z.boolean(),
  frame_hashes: z.array(Hex32),
});
export type DanceUploadResponse = z.infer<typeof DanceUploadResponse>;

/**
 * §7 double or nothing, any bet type: POST /v1/bets/:bet_id/rematch (signed; either party; the
 * bet is PAID, VOIDED, FINALIZED or EXPIRED). Creates a DRAFTING bet in the same room with the
 * caller as A and `supersedes_bet_id` = this bet; B gets bet.invited {rematch_of,
 * suggested_stake_usd}.
 */
export const rematchPath = (betId: string) => `/v1/bets/${encodeURIComponent(betId)}/rematch`;
export const RematchRequest = z.object({});
export type RematchRequest = z.infer<typeof RematchRequest>;
export const RematchResponse = z.object({
  bet_id: BetId,
  /** Dollars per side for the stake chip default. */
  suggested_stake_usd: z.number().positive(),
});
export type RematchResponse = z.infer<typeof RematchResponse>;

/**
 * §7: 2 × the old per-side stake (the larger side, for an odds bet), capped at max_stake, in
 * dollars rounded down to whole cents.
 */
export function suggestedRematchStakeUsd(
  stakes: { a: string; b: string },
  maxStake: bigint = MAX_STAKE,
): number {
  const a = BigInt(stakes.a);
  const b = BigInt(stakes.b);
  let s = 2n * (a > b ? a : b);
  if (s > maxStake) s = maxStake;
  const cents = s / (MICRO_PER_USD / 100n);
  return Number(cents) / 100;
}
