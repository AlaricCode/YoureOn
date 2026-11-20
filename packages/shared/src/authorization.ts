// SCHEMAS §9 — on-phone authorization (D2, D3). Wire only (not hashed); the lock signature is the binding act.
import { z } from 'zod/v4';
import { LOCK_SUBMIT_MARGIN_SECS, NONCE_SEED_MAX } from './constants';
import { BetId, Hex32, IsoUtc, Party, Signature, UnixSeconds, Uuid } from './primitives';
import { TermsEnvelope } from './terms';

/** Server env LOCK_MODE; 'atomic' is the default (D3). */
export const LockMode = z.enum(['atomic', 'sequential']);
export type LockMode = z.infer<typeof LockMode>;

/** How it is detected: §12.3 O8 (two authenticateAsync calls). */
export const AuthorizationMethod = z.enum(['faceid_hold', 'passcode_hold']);
export type AuthorizationMethod = z.infer<typeof AuthorizationMethod>;

/**
 * = DATA-MODEL tx_kind, same order. 'atomic_lock' = [AdvanceNonce, ComputeBudget…, create_bet, accept_bet].
 * 'create_bet' / 'accept_bet' alone: LOCK_MODE=sequential only. 'nonce_advance' = a fee-payer-only revoke.
 */
export const TxKind = z.enum([
  'atomic_lock',
  'create_bet',
  'accept_bet',
  'cancel_open_bet',
  'resolve',
  'concede',
  'appeal',
  'resolve_appeal',
  'finalize',
  'timeout_refund',
  'close_bet',
  'nonce_advance',
]);
export type TxKind = z.infer<typeof TxKind>;

/** Server → both phones (same payload) with the terms card. */
export const AuthorizeRequest = z
  .object({
    bet_id: BetId,
    /** = DATA-MODEL chain_txs.id of this build; any rebuild gets a new id. */
    lock_request_id: Uuid,
    /** Cross-checked: the phone derives the kind from its own UI (ESCROW §5.0.2). */
    kind: TxKind.extract(['atomic_lock', 'create_bet', 'accept_bet']),
    /** The phone recomputes terms_hash from envelope.terms and finds its own role by pubkey. */
    envelope: TermsEnvelope,
    /** The exact message bytes (tx ≤ 1,232 B); decoded with Kit codecs only, then signed. */
    message_b64: z.string().max(1_644),
    message_sha256: Hex32,
    /** 'atomic_lock': seed index k; the phone re-derives the nonce address. null otherwise. */
    nonce_index: z
      .number()
      .int()
      .min(0)
      .max(NONCE_SEED_MAX - 1)
      .nullable(),
    /** = the create_bet arg; the phone checks now < it ≤ now + LOCK_SIGNATURE_MAX_SECS. */
    accept_deadline: UnixSeconds,
    /** accept_deadline − LOCK_SUBMIT_MARGIN_SECS: the server stops taking signatures; the card's countdown. */
    expires_at: IsoUtc,
  })
  .superRefine((r, ctx) => {
    // Documented invariants (§9 field comments; API-CONTRACT §2.8 sequential: nonce_index null).
    // The device policy (ESCROW §5.0.2) re-derives the nonce from nonce_index, so a request that
    // breaks them is rejected at parse instead of reaching the signing path.
    if ((r.kind === 'atomic_lock') !== (r.nonce_index !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['nonce_index'],
        message: "set iff kind = 'atomic_lock'",
      });
    if (Date.parse(r.expires_at) !== (r.accept_deadline - LOCK_SUBMIT_MARGIN_SECS) * 1000)
      ctx.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'expires_at must equal accept_deadline - LOCK_SUBMIT_MARGIN_SECS',
      });
  });
export type AuthorizeRequest = z.infer<typeof AuthorizeRequest>;

/** Phone → server after hold + Face ID (or passcode) and a passing device policy. */
export const PartyAuthorization = z.object({
  bet_id: BetId,
  /** The build that was signed; an old id is rejected (STALE_LOCK_REQUEST) and the card refreshes. */
  lock_request_id: Uuid,
  party: Party,
  /** What the phone recomputed from the displayed Terms and checked in the message. */
  terms_hash: Hex32,
  method: AuthorizationMethod,
  /** Device clock at Face ID success; the server also stores its receive time. */
  authorized_at: IsoUtc,
  /** Latency metric. */
  ms_since_auth_success: z.number().int().nonnegative().max(60_000),
  /** sha256 of the message bytes the phone signed. */
  message_sha256: Hex32,
  /** base58 ed25519 over those bytes (same encoding as a tx signature). */
  party_signature: Signature,
});
export type PartyAuthorization = z.infer<typeof PartyAuthorization>;

/** Decline needs no Face ID; works until the second signature. */
export const PartyDecline = z.object({
  bet_id: BetId,
  party: Party,
  lock_request_id: Uuid.nullable(),
  declined_at: IsoUtc,
});
export type PartyDecline = z.infer<typeof PartyDecline>;
