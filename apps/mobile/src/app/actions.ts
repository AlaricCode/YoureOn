// The money moments as plain async functions over injected deps (wallet, API), so they are
// tested in node:
//   lock    AuthorizeRequest -> device policy -> Face ID -> sign -> POST PartyAuthorization
//   GG      SignRequest(concede) -> phone-rendered card + verified ruling -> Face ID -> POST
//   attempt clip -> frames -> sha256s -> CameraEvidence -> multipart POST …/frames
// The wallet runs the device policy itself on the exact bytes before any prompt (ESCROW §5.0.2);
// nothing here can ask it to sign anything else.
import type { AuthorizationResult, PartySignature, SignRequest } from '@youre-on/shared/api';
import type { AuthorizeRequest, PartyAuthorization } from '@youre-on/shared/authorization';
import type { DevicePolicyVerdict } from '@youre-on/shared/device-policy';
import type { CameraEvidence } from '@youre-on/shared/evidence';
import { hashJcs } from '@youre-on/shared/jcs';
import type { Party } from '@youre-on/shared/primitives';
import { renderSignCard } from '@youre-on/shared/sign-card';

import { buildEvidence, mimeForUri, type CapturedFrame } from '../attempt/frames';
import type { BetModel } from '../bets/store';
import { messageBytesOf, runDevicePolicy } from '../wallet/devicePolicy';
import type { Wallet } from '../wallet/wallet';
import type { YoApi } from '../net/api';

type Signer = Pick<Wallet, 'authorizeTransaction'>;

/** The card-mount check (API-CONTRACT §6.3): enables the hold only if this passes. */
export function checkLockPolicy(
  req: AuthorizeRequest,
  walletPubkey: string,
  nowMs: number,
): DevicePolicyVerdict {
  let bytes: Uint8Array;
  try {
    bytes = messageBytesOf(req);
  } catch {
    return { ok: false, rule: 'G2', reason: 'no message', bet_id: req.bet_id, kind: null };
  }
  return runDevicePolicy(
    bytes,
    { screen: 'terms_card', lockMode: 'atomic', request: req },
    { devicePubkey: walletPubkey, nowMs },
  );
}

export async function authorizeLock(
  d: { wallet: Signer; api: Pick<YoApi, 'authorizeLock'>; now: () => number },
  req: AuthorizeRequest,
  prompt: string,
  idempotencyKey: string,
): Promise<{ auth: PartyAuthorization; result: AuthorizationResult }> {
  const signed = await d.wallet.authorizeTransaction(
    { screen: 'terms_card', lockMode: 'atomic', request: req },
    prompt,
  );
  const auth: PartyAuthorization = {
    bet_id: req.bet_id,
    lock_request_id: req.lock_request_id,
    party: signed.policy.party,
    terms_hash: signed.policy.terms_hash,
    method: signed.method,
    authorized_at: signed.authorizedAt,
    ms_since_auth_success: Math.min(
      60_000,
      Math.max(0, Math.round(d.now() - signed.authSucceededAtMs)),
    ),
    message_sha256: signed.messageSha256,
    party_signature: signed.signatureBase58 as PartyAuthorization['party_signature'],
  };
  const result = await d.api.authorizeLock(auth, idempotencyKey);
  return { auth, result };
}

export class ActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ActionError';
  }
}

/** The ruling this phone verified: the hash must be hashJcs(ruling) (SCHEMAS §5). */
export function verifiedRuling(b: BetModel): { hash: string; outcome: string } | null {
  if (!b.ruling) return null;
  return hashJcs(b.ruling.ruling) === b.ruling.ruling_hash
    ? { hash: b.ruling.ruling_hash, outcome: b.ruling.ruling.outcome }
    : null;
}

export async function concede(
  d: { wallet: Signer; api: Pick<YoApi, 'getConcede' | 'concede'> },
  b: BetModel,
  prompt: string,
  idempotencyKey: string,
): Promise<{ signature: string }> {
  const me: Party | null = b.my_party;
  const ruling = verifiedRuling(b);
  if (!me || !b.envelope || !ruling) throw new ActionError('NOT_READY');
  const appealDeadline = b.appeal_deadline;
  if (appealDeadline === null) throw new ActionError('NOT_READY');
  const req: SignRequest = b.signRequests.concede ?? (await d.api.getConcede(b.bet_id));
  const renderedCard = renderSignCard({
    kind: 'concede',
    terms: b.envelope.terms,
    terms_hash: b.envelope.terms_hash,
    me,
    appeal_deadline: appealDeadline,
  });
  const signed = await d.wallet.authorizeTransaction(
    {
      screen: 'gg',
      request: req,
      renderedCard,
      verifiedRulingHash: ruling.hash,
      verifiedRulingOutcome: ruling.outcome,
    },
    prompt,
  );
  const body: PartySignature = {
    bet_id: b.bet_id,
    kind: 'concede',
    party: me,
    message_sha256: signed.messageSha256,
    party_signature: signed.signatureBase58 as PartySignature['party_signature'],
    method: signed.method,
    signed_at: signed.authorizedAt,
  };
  return d.api.concede(body, idempotencyKey);
}

export interface ClipIn {
  uri: string;
  durationMs: number;
  endedAtMs: number;
}

/** One attempt's upload, built once: a resend (lost response, retry button) sends the same bytes. */
export interface PreparedAttempt {
  evidence: CameraEvidence;
  frames: Uint8Array[];
}

/**
 * Frames + evidence for one clip, then the multipart POST. With `cache` (keyed by the pinned
 * Idempotency-Key) a retry reuses the first build, so the body matches the key on the server
 * (a different body under the same key is 409 IDEMPOTENCY_KEY_REUSED).
 */
export async function sendAttempt(
  d: {
    api: Pick<YoApi, 'uploadFrames'>;
    readClip(uri: string): Promise<Uint8Array>;
    /** 12 frames + the landing crop, last (../attempt/capture, planning D10). */
    extractFrames(uri: string, durationMs: number): Promise<CapturedFrame[]>;
    /** server-corrected ms -> ISO */
    iso(ms: number): string;
  },
  a: {
    bet_id: string;
    attempt_no: number;
    recorded_by: Party;
    clip: ClipIn;
    idempotencyKey: string;
  },
  cache?: Map<string, PreparedAttempt>,
) {
  let prepared = cache?.get(a.idempotencyKey);
  if (!prepared) {
    prepared = await prepareAttempt(d, a);
    cache?.set(a.idempotencyKey, prepared);
  }
  const res = await d.api.uploadFrames(prepared.evidence, prepared.frames, a.idempotencyKey);
  return { evidence: prepared.evidence, res };
}

async function prepareAttempt(
  d: Parameters<typeof sendAttempt>[0],
  a: Parameters<typeof sendAttempt>[1],
): Promise<PreparedAttempt> {
  const frames = await d.extractFrames(a.clip.uri, a.clip.durationMs);
  const clip = await d.readClip(a.clip.uri);
  const evidence = buildEvidence({
    bet_id: a.bet_id,
    attempt_no: a.attempt_no,
    clip,
    mime: mimeForUri(a.clip.uri),
    duration_ms: Math.min(30_000, a.clip.durationMs),
    recorded_by: a.recorded_by,
    recorded_at: d.iso(a.clip.endedAtMs),
    frames,
  });
  return { evidence, frames: frames.map((f) => f.jpeg) };
}
