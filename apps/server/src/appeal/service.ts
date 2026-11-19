// Appeal service, Beat 5 without the hearing (API-CONTRACT §2.12, §3.4, §4.5, §7.2; SCHEMAS §7;
// ESCROW §5.2 appeal / resolve_appeal, §8.3). The concede path (payout/service.ts) is the template.
//
//   appealRequest(bet, user)  GET /v1/bets/:id/appeal: the appellant's SignRequest kind 'appeal',
//                             [ComputeBudget, appeal] on a recent blockhash, one device signature
//                             (the appellant slot); rebuilt when > 20 s old and unsigned.
//                             valid_until = min(build + 50 s, appeal_deadline − 1 s).
//   appeal(bet, user, sig)    POST: verifies the PartySignature over the stored bytes (exactly as
//                             concede does), co-signs as fee payer, records the filing DB-first
//                             (chain_txs 'sent', appeals 'filing'), sends once with preflight, then
//                             emits tx.submitted + judge.cue APPEAL_FILED. LOCK_SIGNER=server
//                             (custodial demo): the signature may be omitted and the server signs
//                             as the appellant's demo key (appealAsDemo: POST /v1/demo/bets/:id/appeal).
//   background, per appeal    the panel starts at once (speculative, §7.2: the votes are stored but
//                             streamed only after Appealed confirms); the confirm moves the bet to
//                             APPEALED (appeals 'panel_voting'); once all three votes are in (8 s
//                             each at most) decideAppeal -> AppealResult (hashed, the stage='appeal'
//                             ruling) -> appeal.result + judge.cue APPEAL_RESULT -> [resolve_appeal,
//                             close_bet] signed by the appeal authority -> APPEAL_RESOLVED ->
//                             processed (payout animation) -> confirmed -> PAID / VOIDED.
//   sweep(now)                keeper: 'sent' appeal rows whose confirm died (landed -> APPEALED and
//                             the panel; dead -> failed, finalize re-armed); APPEALED bets with no
//                             running panel (a restart; an appeal the projector saw first) -> panel /
//                             decision / resolve_appeal; 'sent' resolve_appeal rows -> PAID or back
//                             to APPEALED. An undecided appeal past appeal_resolve_deadline is the
//                             timeout-refund keeper's (EXPIRED, both stakes back).
//
// Errors: NOT_A_PARTY, NOT_LOSER (the winner of a decisive ruling), APPEAL_WINDOW_CLOSED
// (now >= appeal_deadline − 1 s, or the program's 6024), STATE_MOVED_ON (not RULED any more:
// GG / finalize / another appeal got there first), SIGN_REQUEST_EXPIRED (no fresh built message),
// MESSAGE_MISMATCH (message_sha256 != the stored message), SIGNATURE_INVALID (the signature does
// not verify over the stored bytes, as for concede). Rate limit 3/h per user: the route passes
// the `bucket`. Its token is taken last in the filing's own transaction (every check passed;
// RATE_LIMITED rolls the filing back) and given back when the chain refuses the filing at
// preflight, so only an accepted filing spends one.
//
// Decision timing: the AppealResult carries all three votes (SCHEMAS §7 `votes.length(3)`), so
// it is decided when every seat has answered or timed out. Two agreeing votes already fix the
// majority, so this only waits for the third vote's drama, never changes the outcome.
import { and, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import {
  createNoopSigner,
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  signBytes,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
  appeals,
  appealVotes,
  attemptFrames,
  auditLog,
  betEvents,
  bets,
  chainEvents,
  chainTxs,
  rulings,
  users,
} from '@youre-on/db';
import type { AppealSubmitted, PartySignature, SignRequest } from '@youre-on/shared/api';
import {
  AppealResult,
  AppealVote,
  appellantsOf,
  decideAppeal,
  PANEL_SEATS,
  type Appealable,
} from '@youre-on/shared/appeal';
import { BetState } from '@youre-on/shared/bet-state';
import {
  BetStatus,
  ESCROW_ERROR__APPEAL_RESOLVE_DEADLINE_PASSED,
  ESCROW_ERROR__APPEAL_WINDOW_CLOSED,
  ESCROW_ERROR__INVALID_STATUS,
  ESCROW_ERROR__NOT_LOSER,
  ESCROW_ERROR__NOT_PARTY,
  findBetPda,
  findVaultPda,
  getAppealInstructionAsync,
  getBetDecoder,
  getCloseBetInstructionAsync,
  getResolveAppealInstructionAsync,
  Outcome,
  type Bet,
} from '@youre-on/shared/escrow-client';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import { betIdToBytes, type Party } from '@youre-on/shared/primitives';
import { payout, toOnchainOutcome, type OnchainOutcome } from '@youre-on/shared/ruling';
import { renderSignCard } from '@youre-on/shared/sign-card';
import type { TermsEnvelope } from '@youre-on/shared/terms';
import { asciiFold, judgeCue, type JudgeCue } from '../bets/cues';
import { partyOf, type BetRow } from '../bets/snapshot';
import {
  ataOf,
  buildBlockhashTx,
  confirmSent,
  cosignTx,
  customErrorCode,
  heightOnce,
  isBlockhashNotFound,
  messageB64,
  PreflightError,
  SimulationError,
  TOKEN_PROGRAM,
  TxFailedError,
  txFate,
  wireOf,
  type ChainRuntime,
  type Landed,
  type SendOptions,
} from '../chain/tx';
import { sha256Hex, verifyEd25519 } from '../crypto';
import { HttpError } from '../errors';
import { isCalledOffBet, isDanceOffBet } from '../judge/dance-bet';
import {
  fanout,
  hexBytes,
  iso,
  lockBet,
  readBet,
  readBetAccount,
  statePayload,
  type Inflight,
  type LifecycleDeps,
  type Tx,
} from '../lock/common';
import { txFromStored } from '../lock/service';
import { loadEnvelope } from '../lock/terms';
import {
  payoutCue,
  SIGN_REQUEST_TTL_MS,
  STRANDED_GRACE_MS,
  type PayoutService,
} from '../payout/service';
import type { Providers } from '../providers/types';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { runPanel, type CastVote, type PanelInput } from './panel';

/** ESCROW §8.3 / API-CONTRACT §1.5: the UI (and the server) stop taking appeals 1 s early. */
export const APPEAL_UI_MARGIN_MS = 1_000;
/** API-CONTRACT §2.12 (as §2.10): rebuild an unsigned appeal message older than this. */
export const APPEAL_REBUILD_MS = 20_000;
/** API-CONTRACT §1.7: 3 appeals per hour per user (ESCROW TM-L9). */
export const APPEAL_BUCKET = { limit: 3, windowMs: 3_600_000 } as const;
/** The appellant's 3/h bucket (the route binds it to deps.rateLimit and the caller). */
export interface AppealBucket {
  /** Takes one token, or throws RATE_LIMITED. */
  take(): void;
  /** Gives the token back (the chain refused the filing). */
  refund(): void;
}
/** A failed resolve_appeal is sent again by the sweep no sooner than this. */
export const RESOLVE_APPEAL_RETRY_MS = 3_000;
/** rulings.model of the stage='appeal' row (DATA-MODEL §5.13). */
export const PANEL_MODEL = 'panel/majority-of-3';

const b58enc = getBase58Encoder();
const b58dec = getBase58Decoder();
const sigString = (b: Uint8Array) => b58dec.decode(b);

const ORDER = BetState.options;
const isAfter = (s: BetState, t: BetState) => ORDER.indexOf(s) > ORDER.indexOf(t);

/** bets.outcome (resolve) -> the offchain outcome of the ruling being appealed. */
const PG_TO_RULING = {
  party_a: 'A_WINS',
  party_b: 'B_WINS',
  refund: 'VOID',
  split: 'VOID',
} as const satisfies Record<NonNullable<BetRow['outcome']>, Appealable>;
const ONCHAIN_ENUM: Record<OnchainOutcome, Outcome> = {
  PartyA: Outcome.PartyA,
  PartyB: Outcome.PartyB,
  Split: Outcome.Split,
  Refund: Outcome.Refund,
};

type AppealRow = typeof appeals.$inferSelect;
type ChainTxRow = typeof chainTxs.$inferSelect;

export type AppealDeps = LifecycleDeps & { providers?: Pick<Providers, 'llm'> };

export interface AppealServiceOptions {
  deps: AppealDeps;
  runtime: () => Promise<ChainRuntime | null>;
  inflight: Inflight;
  signer: 'phones' | 'server';
  /** Re-arms finalize when an appeal never lands (the ruling is paid out as usual). */
  payout: Pick<PayoutService, 'armFinalize'>;
  send?: SendOptions;
  /** Per-vote budget (default PANEL_VOTE_TIMEOUT_MS, 8 s); tests shorten it. */
  voteTimeoutMs?: number;
}

/** Program error -> API error for a refused appeal (simulation or preflight). */
function appealRefusal(err: unknown): HttpError | null {
  const code = customErrorCode(err);
  if (code === ESCROW_ERROR__APPEAL_WINDOW_CLOSED)
    return new HttpError('APPEAL_WINDOW_CLOSED', 'Too late. The ruling stands.', {
      program_error: { code, name: 'AppealWindowClosed' },
    });
  if (code === ESCROW_ERROR__NOT_LOSER)
    return new HttpError('NOT_LOSER', "Winners don't appeal.", {
      program_error: { code, name: 'NotLoser' },
    });
  if (code === ESCROW_ERROR__NOT_PARTY)
    return new HttpError('NOT_A_PARTY', "You're not in this bet.", {
      program_error: { code, name: 'NotParty' },
    });
  if (code === ESCROW_ERROR__INVALID_STATUS)
    return new HttpError('STATE_MOVED_ON', undefined, {
      program_error: { code, name: 'InvalidStatus' },
    });
  return null;
}

/** `[EVENT] APPEAL_FILED by=Logan :: Announce the three-judge panel in one line, then wait.` */
export function appealFiledCue(name: string): JudgeCue {
  return judgeCue(
    'APPEAL_FILED',
    { by: name },
    'Announce the three-judge panel in one line, then wait.',
  );
}

/** `[EVENT] APPEAL_VOTE seat=2 judge=openai vote=A_WINS :: Do not speak; …` (speak=false). */
export function appealVoteCue(v: AppealVote): JudgeCue {
  return judgeCue(
    'APPEAL_VOTE',
    { seat: v.seat, judge: v.provider, vote: v.counted_as },
    'Do not speak; the stage reads the votes.',
    false,
  );
}

/** `[EVENT] APPEAL_RESULT final=B_WINS tally=1-1-1 decided_by=upheld_no_majority :: …` */
export function appealResultCue(r: AppealResult, names: Record<Party, string>): JudgeCue {
  const t = r.tally;
  const winner =
    r.final_outcome === 'A_WINS' ? names.A : r.final_outcome === 'B_WINS' ? names.B : null;
  const instruction =
    r.decided_by === 'upheld_no_majority'
      ? 'Say the ruling stands: no majority.'
      : r.flipped
        ? `Say the panel overturned the ruling: ${asciiFold(winner ?? 'nobody')} wins.`
        : winner
          ? `Say the panel upheld the ruling: ${asciiFold(winner)} wins.`
          : 'Say the panel upheld the ruling: it stays void.';
  return judgeCue(
    'APPEAL_RESULT',
    {
      final: r.final_outcome,
      tally: `${t.A_WINS}-${t.B_WINS}-${t.ABSTAIN}`,
      decided_by: r.decided_by,
    },
    instruction,
  );
}

/** A stored appeal_votes row -> SCHEMAS AppealVote. */
function voteOf(r: typeof appealVotes.$inferSelect, betId: string): AppealVote {
  return AppealVote.parse({
    schema_version: 1,
    appeal_id: r.appeal_id,
    bet_id: betId,
    seat: r.seat,
    provider: r.provider,
    model: r.model,
    status: r.status,
    outcome: r.outcome,
    confidence: Number(r.confidence),
    reason: r.reason,
    counted_as: r.counted_as,
    latency_ms: r.latency_ms ?? 0,
    created_at: r.created_at.toISOString(),
  });
}

export class AppealService {
  /** chain_txs ids (appeal / resolve_appeal) whose confirm loop runs in this process. */
  private readonly confirming = new Set<string>();
  /** Running panels by appeal id (one per appeal per process). */
  private readonly panels = new Map<string, Promise<CastVote[]>>();
  /** Running decide-and-resolve jobs by appeal id. */
  private readonly deciding = new Set<string>();
  /** bet_id -> no resolve_appeal retry before this (ms). */
  private readonly retryAt = new Map<string, number>();

  constructor(private readonly o: AppealServiceOptions) {}

  private get deps() {
    return this.o.deps;
  }

  private async rt(): Promise<ChainRuntime> {
    const rt = await this.o.runtime();
    if (!rt) throw new HttpError('RPC_UNAVAILABLE', 'The chain is not configured.');
    return rt;
  }

  // ---- GET: the appellant's SignRequest ---------------------------------------------------

  async appealRequest(betId: string, userId: string): Promise<SignRequest> {
    const rt = await this.rt();
    const bet = await this.bet(betId);
    await this.danceOffOrThrow(bet);
    const party = this.appellantOrThrow(bet, userId, this.deps.now());
    return this.buildRequest(rt, bet, party);
  }

  /**
   * The appeal request pushed next to the concede one at RULED (payout/service.ts, phones only,
   * decisive camera rulings): the loser signs on the first tap, no GET round trip inside the
   * 10 s window. null when it cannot be built (the phone GETs it on the tap).
   */
  async pushRequest(rt: ChainRuntime, bet: BetRow, loser: Party): Promise<SignRequest | null> {
    try {
      if (bet.evidence_source === 'gemini') return null; // SCHEMAS §7: no "I appeal!" on a market
      if (await isDanceOffBet(this.deps.db, bet.id)) return null; // DANCE-OFF §5: the score decides
      if (await isCalledOffBet(this.deps.db, bet.id)) return null; // both agreed: nothing to appeal
      this.windowOrThrow(bet, this.deps.now());
      return await this.buildRequest(rt, bet, loser);
    } catch (err) {
      this.deps.log.warn('appeal.push_request_failed', { bet_id: bet.id, err: String(err) });
      return null;
    }
  }

  /**
   * DANCE-OFF §5: a dance off is decided by the deterministic score, so it has no appeal (no
   * "check it again"), as a Gemini market has none.
   */
  private async danceOffOrThrow(bet: Pick<BetRow, 'id' | 'state'>): Promise<void> {
    if (await isDanceOffBet(this.deps.db, bet.id))
      throw new HttpError('INVALID_STATE', 'The score decides a dance off. No appeals.', {
        state: bet.state,
        reason: 'dance_off',
      });
    // A call-off (judge/call-off.ts): both players agreed to the refund, so there is no appeal.
    if (await isCalledOffBet(this.deps.db, bet.id))
      throw new HttpError('INVALID_STATE', 'Called off. No appeals.', {
        state: bet.state,
        reason: 'called_off',
      });
  }

  /** The caller's party if they may appeal now (SCHEMAS §5.3 loser; the window; RULED). */
  private appellantOrThrow(bet: BetRow, userId: string, now: number): Party {
    const party = partyOf(bet, userId);
    if (!party) throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
    this.rulingOpenOrThrow(bet);
    const may = appellantsOf(bet.outcome ?? '');
    if (may === null) throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
    if (may !== 'either' && may !== party)
      throw new HttpError('NOT_LOSER', "Winners don't appeal.");
    this.windowOrThrow(bet, now);
    return party;
  }

  private rulingOpenOrThrow(bet: Pick<BetRow, 'state'>): void {
    if (bet.state === 'RULED') return;
    throw new HttpError(
      isAfter(bet.state, 'RULED') ? 'STATE_MOVED_ON' : 'INVALID_STATE',
      undefined,
      {
        state: bet.state,
      },
    );
  }

  private windowOrThrow(bet: Pick<BetRow, 'appeal_deadline' | 'state'>, now: number): void {
    if (!bet.appeal_deadline) throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
    if (now >= bet.appeal_deadline.getTime() - APPEAL_UI_MARGIN_MS)
      throw new HttpError('APPEAL_WINDOW_CLOSED', 'Too late. The ruling stands.', {
        appeal_deadline: Math.floor(bet.appeal_deadline.getTime() / 1000),
      });
  }

  private async buildRequest(rt: ChainRuntime, bet: BetRow, party: Party): Promise<SignRequest> {
    const now = this.deps.now();
    const envelope = (await loadEnvelope(this.deps.db, bet.id, { finalOnly: true }))?.envelope;
    if (!envelope) throw new HttpError('TERMS_NOT_FINAL');
    const role = party === 'A' ? 'party_a' : 'party_b';
    let row = await this.latestTx(bet.id, 'appeal');
    // An appeal already on its way (another tap, the other party of a VOID): never retire it.
    if (row && (row.status === 'signed' || row.status === 'sent'))
      throw new HttpError('STATE_MOVED_ON', 'An appeal is already on its way.');
    if (
      !row ||
      row.status !== 'built' ||
      row.signer_role !== role ||
      now - row.built_at.getTime() > APPEAL_REBUILD_MS
    ) {
      const [betPda] = await findBetPda({ betId: betIdToBytes(bet.id) });
      const onchain = await this.fetchBet(rt, betPda);
      if (!onchain || onchain.status !== BetStatus.Resolved) throw new HttpError('STATE_MOVED_ON');
      const appellant = party === 'A' ? onchain.partyA : onchain.partyB;
      const fp = rt.keys.feePayer;
      const ix = await getAppealInstructionAsync({
        payer: fp,
        appellant: createNoopSigner(appellant),
        bet: betPda,
      });
      let built;
      try {
        // No SetComputeUnitPrice: a phone signs this message (CU_PRICE is server-only txs).
        built = await buildBlockhashTx(rt.client, fp.address, [ix], { label: 'appeal' });
      } catch (err) {
        if (err instanceof SimulationError) throw appealRefusal(err.err) ?? err;
        throw err;
      }
      row = await this.deps.db.transaction(async (tx) => {
        await expireInflight(tx, bet.id, 'appeal');
        const [r] = await tx
          .insert(chainTxs)
          .values({
            bet_id: bet.id,
            kind: 'appeal',
            signer_role: role,
            message_b64: messageB64(built.tx),
            message_sha256: sha256Hex(new Uint8Array(built.tx.messageBytes)),
            simulated_cu: Number(built.simulatedUnits),
            cu_limit: built.cuLimit,
            expected_status: 'appealed',
            status: 'built',
            last_valid_block_height: built.lastValidBlockHeight,
            built_at: new Date(now),
          })
          .returning();
        return r!;
      });
    }
    return this.signRequestOf(rt, bet, row, party, envelope);
  }

  private signRequestOf(
    rt: ChainRuntime,
    bet: BetRow,
    row: ChainTxRow,
    party: Party,
    envelope: TermsEnvelope,
  ): SignRequest {
    const msg = new Uint8Array(Buffer.from(row.message_b64!, 'base64'));
    const compiled = getCompiledTransactionMessageDecoder().decode(msg) as unknown as {
      header: { numSignerAccounts: number };
      staticAccounts: Address[];
      lifetimeToken: string;
    };
    // Device policy G2: the card equals the phone's own renderSignCard() over the same final
    // Terms, appellant and BetSnapshot.deadlines.appeal_deadline (whole unix seconds).
    const appealEndSecs = Math.floor(
      (bet.appeal_deadline?.getTime() ?? row.built_at.getTime() + SIGN_REQUEST_TTL_MS) / 1000,
    );
    const validUntil = Math.min(
      row.built_at.getTime() + SIGN_REQUEST_TTL_MS,
      appealEndSecs * 1000 - APPEAL_UI_MARGIN_MS,
    );
    return {
      bet_id: bet.id,
      kind: 'appeal',
      for_parties: [party],
      message_b64: row.message_b64!,
      message_sha256: row.message_sha256,
      fee_payer: rt.keys.feePayer.address,
      signers: compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts),
      lifetime: {
        type: 'blockhash',
        blockhash: compiled.lifetimeToken,
        last_valid_block_height: Number(row.last_valid_block_height ?? 0n),
        valid_until: iso(validUntil),
      },
      envelope,
      card: renderSignCard({
        kind: 'appeal',
        terms: envelope.terms,
        terms_hash: envelope.terms_hash,
        me: party,
        appeal_deadline: appealEndSecs,
      }),
      // T2: the offchain outcome of the ruling.issued the phone verified (VOID for a Refund).
      ruling_ref: { ruling_hash: bet.ruling_hash!, outcome: PG_TO_RULING[bet.outcome!] },
      issued_at: iso(this.deps.now()),
    };
  }

  // ---- POST: file the appeal ----------------------------------------------------------------

  /**
   * POST /v1/bets/:id/appeal. Phones: the appellant's PartySignature over the stored bytes.
   * LOCK_SIGNER=server (custodial): `body` may carry no signature; the server signs as the
   * appellant's demo key (which must equal the bet's wallet snapshot).
   */
  async appeal(
    betId: string,
    userId: string,
    body: Partial<PartySignature>,
    o: { bucket?: AppealBucket; requestId?: string; actor?: 'user' | 'system' } = {},
  ): Promise<AppealSubmitted> {
    if (body.kind !== undefined && body.kind !== 'appeal')
      throw new HttpError('VALIDATION_FAILED', undefined, {
        issues: [{ path: 'kind', message: "must be 'appeal'" }],
      });
    const rt = await this.rt();
    const bet = await this.bet(betId);
    const party = partyOf(bet, userId);
    if (!party) throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
    // Idem (bet_id, 'appeal'): the same appellant again (a lost 202) gets the filed appeal back.
    const filed = await this.replayOf(betId, party);
    if (filed) return filed;
    await this.danceOffOrThrow(bet);
    this.appellantOrThrow(bet, userId, this.deps.now());
    if (body.party && body.party !== party) throw new HttpError('NOT_LOSER');
    const wallet = party === 'A' ? bet.party_a_wallet! : bet.party_b_wallet!;

    let signature = body.party_signature;
    let messageSha = body.message_sha256;
    if (!signature) {
      if (this.o.signer !== 'server') throw new HttpError('SIGNATURE_INVALID');
      const kp: KeyPairSigner | null = party === 'A' ? rt.keys.demoA : rt.keys.demoB;
      if (!kp || kp.address !== wallet)
        throw new HttpError('SIGNATURE_INVALID', 'No custodial key for that party.');
      const req = await this.buildRequest(rt, bet, party);
      const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
      signature = sigString(await signBytes(kp.keyPair.privateKey, msg));
      messageSha = req.message_sha256;
    }

    const now = this.deps.now();
    const role = party === 'A' ? 'party_a' : 'party_b';
    const prepared = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b) throw new HttpError('STATE_MOVED_ON');
      // A second tap that raced the first one here (another Idempotency-Key): the same filing.
      const [already] = await tx
        .select({ status: appeals.status, party: appeals.appellant_party })
        .from(appeals)
        .where(eq(appeals.bet_id, betId));
      if (already && already.status !== 'failed') {
        if (already.party === party) return null;
        throw new HttpError('STATE_MOVED_ON', 'An appeal was already filed.');
      }
      if (b.state !== 'RULED') throw new HttpError('STATE_MOVED_ON', undefined, { state: b.state });
      this.windowOrThrow(b, now);
      const [row] = await tx
        .select()
        .from(chainTxs)
        .where(
          and(
            eq(chainTxs.bet_id, betId),
            eq(chainTxs.kind, 'appeal'),
            eq(chainTxs.status, 'built'),
            eq(chainTxs.signer_role, role),
          ),
        )
        .orderBy(desc(chainTxs.built_at))
        .limit(1)
        .for('update');
      if (!row) throw new HttpError('SIGN_REQUEST_EXPIRED');
      if (row.message_sha256 !== messageSha) throw new HttpError('MESSAGE_MISMATCH');
      if (now - row.built_at.getTime() > SIGN_REQUEST_TTL_MS)
        throw new HttpError('SIGN_REQUEST_EXPIRED');
      const msg = new Uint8Array(Buffer.from(row.message_b64!, 'base64'));
      let sig: SignatureBytes;
      try {
        sig = new Uint8Array(b58enc.encode(signature!)) as SignatureBytes;
      } catch {
        throw new HttpError('SIGNATURE_INVALID');
      }
      if (sig.length !== 64 || !verifyEd25519(wallet, msg, sig))
        throw new HttpError('SIGNATURE_INVALID');
      const full = await cosignTx(txFromStored(row.message_b64!, new Map([[wallet, sig]])), [
        rt.keys.feePayer,
      ]);
      const txSig = sigString(full.signatures[rt.keys.feePayer.address]!);
      const [ruled] = await tx
        .select({ id: rulings.id, outcome: rulings.outcome })
        .from(rulings)
        .where(and(eq(rulings.bet_id, betId), eq(rulings.ruling_hash, b.ruling_hash ?? '')))
        .limit(1);
      if (!ruled) throw new HttpError('INVALID_STATE', 'No ruling on record to appeal.');
      const original = PG_TO_RULING[b.outcome!];
      // DB first: a crash after the send still finds the appeal ('sent', the keeper's sweep).
      await tx
        .update(chainTxs)
        .set({
          ...(party === 'A'
            ? { a_signature: signature!, a_signed_at: new Date(now) }
            : { b_signature: signature!, b_signed_at: new Date(now) }),
          first_signer: party,
          signature: txSig,
          status: 'sent',
          sent_at: new Date(now),
        })
        .where(eq(chainTxs.id, row.id));
      const filing = {
        appellant_user_id: userId,
        appellant_party: party,
        appealed_ruling_id: ruled.id,
        original_outcome: original,
        status: 'filing' as const,
        filed_at: new Date(now),
        decided_at: null,
        final_outcome: null,
        decided_by: null,
        flipped: null,
        result_ruling_id: null,
      };
      // appeals.bet_id is UNIQUE: a failed appeal (its tx never landed) is re-filed in place.
      const [ap] = await tx
        .insert(appeals)
        .values({ bet_id: betId, ...filing })
        .onConflictDoUpdate({
          target: appeals.bet_id,
          set: filing,
          setWhere: sql`${appeals.status} = 'failed'`,
        })
        .returning();
      if (!ap) throw new HttpError('STATE_MOVED_ON', 'An appeal was already filed.');
      await tx.delete(appealVotes).where(eq(appealVotes.appeal_id, ap.id));
      await tx.insert(auditLog).values({
        actor_kind: o.actor ?? 'user',
        actor_user_id: userId,
        action: 'appeal.filed',
        bet_id: betId,
        subject_user_id: userId,
        request_id: o.requestId ?? null,
        details: { appeal_id: ap.id, party, signature: txSig, original_outcome: original },
      });
      // The 3/h bucket, last: every check passed (a refused tap, or a double tap that lost the
      // race above, spends nothing), and RATE_LIMITED rolls this filing back.
      o.bucket?.take();
      return { full, rowId: row.id, lvbh: row.last_valid_block_height, appealId: ap.id, txSig };
    });
    if (!prepared) {
      const replay = await this.replayOf(betId, party);
      if (!replay) throw new HttpError('STATE_MOVED_ON', 'An appeal was already filed.');
      return replay;
    }

    try {
      await rt.client.send(wireOf(prepared.full), false);
    } catch (err) {
      if (err instanceof PreflightError) {
        o.bucket?.refund(); // the chain refused it: never filed, so it costs nothing
        await this.failAppeal(betId, prepared.appealId, prepared.rowId, 'failed', err, false);
        if (isBlockhashNotFound(err)) throw new HttpError('SIGN_REQUEST_EXPIRED');
        throw (
          appealRefusal(err.err) ?? new HttpError('STATE_MOVED_ON', "Couldn't file the appeal.")
        );
      }
      // Transport trouble: the confirm re-broadcasts the same bytes.
      this.deps.log.warn('appeal.send_retry', { bet_id: betId, err });
    }

    // Out: tx.submitted + the judge announces the panel (API-CONTRACT §2.12 effects).
    const names = await this.names(bet);
    const envs = await this.deps.db.transaction(async (tx) => [
      await appendBetEvent(tx, {
        bet_id: betId,
        type: 'tx.submitted',
        payload: { kind: 'appeal', signature: prepared.txSig },
        now,
      }),
      await appendBetEvent(tx, {
        bet_id: betId,
        type: 'judge.cue',
        payload: appealFiledCue(names[party]),
        now,
      }),
    ]);
    fanout(this.deps, bet, envs);
    this.deps.log.info('appeal.filed', {
      bet_id: betId,
      appeal_id: prepared.appealId,
      party,
      signature: prepared.txSig,
    });

    // The panel starts now, beside the confirm (§7.2: votes stored, streamed after Appealed).
    void this.ensurePanel(prepared.appealId);
    this.o.inflight.run('appeal.confirm', () =>
      this.confirmAppeal(
        betId,
        prepared.appealId,
        prepared.rowId,
        prepared.full,
        prepared.lvbh,
        now,
      ),
    );
    return { status: 'submitted', signature: prepared.txSig, appeal_id: prepared.appealId };
  }

  /**
   * POST /v1/demo/bets/:id/appeal (LOCK_SIGNER=server): the appeal of the losing demo party,
   * signed custodially (the same path as a signature-less phone tap). `party` only for a VOID.
   */
  async appealAsDemo(
    betId: string,
    party: Party | undefined,
    o: { requestId?: string } = {},
  ): Promise<AppealSubmitted> {
    if (this.o.signer !== 'server')
      throw new HttpError('INVALID_STATE', 'Custodial appeals need LOCK_SIGNER=server.', {
        reason: 'lock_signer_phones',
      });
    const bet = await this.bet(betId);
    const may = appellantsOf(bet.outcome ?? '');
    if (may === null) {
      this.rulingOpenOrThrow(bet);
      throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
    }
    if (may !== 'either' && party && party !== may)
      throw new HttpError('NOT_LOSER', "Winners don't appeal.");
    const who: Party = may === 'either' ? (party ?? 'A') : may;
    const userId = who === 'A' ? bet.party_a_id : bet.party_b_id;
    return this.appeal(betId, userId, {}, { ...o, actor: 'system' });
  }

  /** The filed appeal of `party` (not failed), as the 202 it got: an idempotent replay. */
  private async replayOf(betId: string, party: Party): Promise<AppealSubmitted | null> {
    const [ap] = await this.deps.db.select().from(appeals).where(eq(appeals.bet_id, betId));
    if (!ap || ap.status === 'failed' || ap.appellant_party !== party) return null;
    const [tx] = await this.deps.db
      .select({ signature: chainTxs.signature })
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.bet_id, betId),
          eq(chainTxs.kind, 'appeal'),
          inArray(chainTxs.status, ['sent', 'confirmed']),
        ),
      )
      .orderBy(desc(chainTxs.sent_at))
      .limit(1);
    if (!tx?.signature) return null;
    return {
      status: 'submitted',
      signature: tx.signature as AppealSubmitted['signature'],
      appeal_id: ap.id,
    };
  }

  // ---- the appeal tx: confirm / fail ----------------------------------------------------------

  private async confirmAppeal(
    betId: string,
    appealId: string,
    rowId: string,
    full: Transaction,
    lvbh: bigint | null,
    sentAt: number,
  ): Promise<void> {
    const rt = await this.rt();
    const signature = sigString(full.signatures[rt.keys.feePayer.address]!);
    let landed: Landed;
    this.confirming.add(rowId);
    try {
      landed = await confirmSent(rt.client, full, { ...this.o.send, lastValidBlockHeight: lvbh });
    } catch (err) {
      if (err instanceof TxFailedError && err.kind === 'timeout') {
        // The blockhash may still be valid: the row stays 'sent' and the sweep settles it.
        this.deps.log.warn('appeal.confirm_pending', { bet_id: betId, signature });
        return;
      }
      if (err instanceof TxFailedError) {
        await this.failAppeal(
          betId,
          appealId,
          rowId,
          err.kind === 'expired' ? 'expired' : 'failed',
          err,
        );
        return;
      }
      throw err;
    } finally {
      this.confirming.delete(rowId);
    }
    await this.markAppealed(rt, betId, appealId, rowId, signature, sentAt, landed);
    this.ensureDecision(appealId);
  }

  /**
   * Appealed confirmed: RULED (or a FINALIZED whose finalize must now fail) -> APPEALED with the
   * Bet account's appealed_at / appeal_resolve_deadline, appeals -> panel_voting, tx.confirmed
   * once, and the votes stored so far are streamed. The projector may have moved the bet first
   * (BetAppealed): then only what this confirm owes is emitted.
   */
  private async markAppealed(
    rt: ChainRuntime,
    betId: string,
    appealId: string,
    rowId: string | null,
    signature: string,
    sentAt: number,
    landed: Landed,
  ): Promise<void> {
    const onchain = await readBetAccount(rt, betId).catch(() => null);
    const appealed = onchain?.status === BetStatus.Appealed ? onchain : null;
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b) return null;
      const first = rowId
        ? (
            await tx
              .update(chainTxs)
              .set({
                status: 'confirmed',
                rpc_processed_at: new Date(landed.processedAt),
                rpc_confirmed_at: new Date(landed.confirmedAt),
              })
              .where(and(eq(chainTxs.id, rowId), ne(chainTxs.status, 'confirmed')))
              .returning({ id: chainTxs.id })
          ).length > 0
        : false;
      await tx
        .update(appeals)
        .set({ status: 'panel_voting' })
        .where(and(eq(appeals.id, appealId), eq(appeals.status, 'filing')));
      const envs: BetEventEnvelope[] = [];
      let state = b.state;
      if (b.state === 'RULED' || b.state === 'FINALIZED') {
        const [row] = await tx
          .update(bets)
          .set({
            state: 'APPEALED',
            ...(appealed
              ? {
                  appealed_at: new Date(Number(appealed.appealedAt) * 1000),
                  appeal_resolve_deadline: new Date(Number(appealed.appealResolveDeadline) * 1000),
                }
              : {}),
          })
          .where(eq(bets.id, betId))
          .returning();
        state = 'APPEALED';
        envs.push(
          await appendBetEvent(tx, {
            bet_id: betId,
            type: 'bet.state',
            payload: statePayload(row!, b.state, 'appealed', {
              kind: 'appeal',
              signature,
              submitted_at: iso(sentAt),
              rpc_processed_at: iso(landed.processedAt),
              rpc_confirmed_at: iso(landed.confirmedAt),
            }),
            now: this.deps.now(),
          }),
        );
      }
      if (first)
        envs.push(
          await appendBetEvent(tx, {
            bet_id: betId,
            type: 'tx.confirmed',
            payload: { kind: 'appeal', signature, slot: Number(landed.slot ?? 0n) },
            now: this.deps.now(),
          }),
        );
      if (state === 'APPEALED') envs.push(...(await this.pendingVotes(tx, appealId, betId)));
      return { b, envs };
    });
    if (out) fanout(this.deps, out.b, out.envs);
    this.deps.log.info('appeal.appealed', { bet_id: betId, appeal_id: appealId, signature });
  }

  /**
   * The appeal tx never landed (preflight, onchain failure, expiry): row failed / expired,
   * appeals 'failed', its votes discarded (§7.2), tx.failed pushed, and finalize re-armed so
   * the ruling is paid out as usual.
   */
  private async failAppeal(
    betId: string,
    appealId: string,
    rowId: string,
    status: 'failed' | 'expired',
    err: unknown,
    push = true,
  ): Promise<void> {
    const message = String((err as Error)?.message ?? err).slice(0, 200);
    const out = await this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(chainTxs)
        .set({ status, err: message })
        .where(eq(chainTxs.id, rowId))
        .returning({ signature: chainTxs.signature });
      const b = await lockBet(tx, betId);
      await tx
        .update(appeals)
        .set({ status: 'failed' })
        .where(and(eq(appeals.id, appealId), inArray(appeals.status, ['filing', 'panel_voting'])));
      await tx.delete(appealVotes).where(eq(appealVotes.appeal_id, appealId));
      if (!b || !push) return null;
      const e = await appendBetEvent(tx, {
        bet_id: betId,
        type: 'tx.failed',
        payload: {
          kind: 'appeal',
          signature: row?.signature ?? null,
          error: message.slice(0, 200),
        },
        now: this.deps.now(),
      });
      return { b, e };
    });
    if (out) fanout(this.deps, out.b, [out.e]);
    this.deps.log.warn('appeal.failed', {
      bet_id: betId,
      appeal_id: appealId,
      status,
      err: message,
    });
    this.o.payout.armFinalize(betId, this.deps.now());
  }

  // ---- the panel -----------------------------------------------------------------------------

  /** Runs the seats this appeal has no stored vote for (at most once per appeal per process). */
  private ensurePanel(appealId: string): Promise<CastVote[]> {
    const running = this.panels.get(appealId);
    if (running) return running;
    const p = (async () => {
      const ctx = await this.panelContext(appealId);
      if (!ctx) return [];
      const stored = await this.deps.db
        .select({ seat: appealVotes.seat })
        .from(appealVotes)
        .where(eq(appealVotes.appeal_id, appealId));
      const have = new Set(stored.map((s) => s.seat));
      const seats = PANEL_SEATS.map((_, i) => i).filter((i) => !have.has(i));
      if (!seats.length) return [];
      const llm = this.deps.providers?.llm ?? null;
      return runPanel(llm, ctx.input, {
        now: this.deps.now,
        seats,
        ...(this.o.voteTimeoutMs !== undefined ? { timeoutMs: this.o.voteTimeoutMs } : {}),
        onVote: (cv) =>
          this.recordVote(appealId, ctx.bet.id, cv).catch((err: unknown) =>
            this.deps.log.warn('appeal.vote_store_failed', { appeal_id: appealId, err }),
          ),
      });
    })();
    const tracked = p.catch((err: unknown) => {
      this.deps.log.error('appeal.panel_failed', { appeal_id: appealId, err });
      return [] as CastVote[];
    });
    this.panels.set(appealId, tracked);
    void tracked.finally(() => this.panels.delete(appealId));
    this.o.inflight.run('appeal.panel', () => tracked);
    return tracked;
  }

  /** What every seat is sent: terms + the appealed ruling's frames (or settlement record). */
  private async panelContext(appealId: string): Promise<{
    ap: AppealRow;
    bet: BetRow;
    original: typeof rulings.$inferSelect;
    input: PanelInput;
    frame_hashes: string[];
  } | null> {
    const [ap] = await this.deps.db.select().from(appeals).where(eq(appeals.id, appealId));
    if (!ap || ap.status === 'failed') return null;
    const bet = await readBet(this.deps.db, ap.bet_id);
    const [original] = await this.deps.db
      .select()
      .from(rulings)
      .where(eq(rulings.id, ap.appealed_ruling_id));
    const envelope = (await loadEnvelope(this.deps.db, ap.bet_id, { finalOnly: true }))?.envelope;
    if (!bet || !original || !envelope) return null;
    const terms = envelope.terms;
    const performer = terms.performer
      ? (terms.performer === 'A' ? terms.party_a : terms.party_b).display_name
      : null;
    let input: PanelInput;
    let frame_hashes: string[] = [];
    if (original.stage === 'settlement') {
      input = {
        appeal_id: ap.id,
        bet_id: ap.bet_id,
        terms,
        performer_name: performer,
        evidence: { kind: 'gemini', record_canonical: original.evidence_canonical ?? '{}' },
      };
    } else {
      const frames = original.attempt_id
        ? await this.deps.db
            .select({
              t_ms: attemptFrames.t_ms,
              sha256: attemptFrames.sha256,
              bytes: attemptFrames.bytes,
            })
            .from(attemptFrames)
            .where(eq(attemptFrames.attempt_id, original.attempt_id))
            .orderBy(attemptFrames.idx)
        : [];
      frame_hashes = frames.map((f) => f.sha256);
      input = {
        appeal_id: ap.id,
        bet_id: ap.bet_id,
        terms,
        performer_name: performer,
        evidence: {
          kind: 'camera',
          frames: frames.map((f) => ({ t_ms: f.t_ms, bytes: new Uint8Array(f.bytes) })),
        },
      };
    }
    return { ap, bet, original, input, frame_hashes };
  }

  /** Stores one vote (ON CONFLICT DO NOTHING) and streams it when the bet is APPEALED. */
  private async recordVote(appealId: string, betId: string, cv: CastVote): Promise<void> {
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b) return null;
      const [ap] = await tx.select().from(appeals).where(eq(appeals.id, appealId));
      if (!ap || (ap.status !== 'filing' && ap.status !== 'panel_voting')) return null;
      await insertVotes(tx, [cv]);
      if (b.state !== 'APPEALED') return { b, envs: [] as BetEventEnvelope[] };
      return { b, envs: await this.pendingVotes(tx, appealId, betId) };
    });
    if (out?.envs.length) fanout(this.deps, out.b, out.envs);
  }

  /** appeal.vote + APPEAL_VOTE for every stored vote not on the bet's log yet (under the bet lock). */
  private async pendingVotes(tx: Tx, appealId: string, betId: string): Promise<BetEventEnvelope[]> {
    const stored = await tx
      .select()
      .from(appealVotes)
      .where(eq(appealVotes.appeal_id, appealId))
      .orderBy(appealVotes.seat);
    if (!stored.length) return [];
    const emitted = await tx
      .select({ seat: sql<number>`(${betEvents.envelope} -> 'payload' -> 'vote' ->> 'seat')::int` })
      .from(betEvents)
      .where(and(eq(betEvents.bet_id, betId), eq(betEvents.type, 'appeal.vote')));
    const done = new Set(emitted.map((e) => Number(e.seat)));
    const envs: BetEventEnvelope[] = [];
    for (const r of stored) {
      if (done.has(r.seat)) continue;
      const vote = voteOf(r, betId);
      envs.push(
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'appeal.vote',
          payload: { vote },
          now: this.deps.now(),
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: appealVoteCue(vote),
          now: this.deps.now(),
        }),
      );
    }
    return envs;
  }

  // ---- the decision and resolve_appeal ------------------------------------------------------

  /** Panel -> AppealResult -> resolve_appeal, at most once per appeal per process. */
  private ensureDecision(appealId: string): void {
    if (this.deciding.has(appealId)) return;
    this.deciding.add(appealId);
    this.o.inflight.run('appeal.decide', async () => {
      try {
        const casts = await this.ensurePanel(appealId);
        const betId = await this.decide(appealId, casts);
        if (betId) await this.submitResolve(betId);
      } finally {
        this.deciding.delete(appealId);
      }
    });
  }

  /**
   * All three votes in and the bet APPEALED: decideAppeal -> the hashed AppealResult (the
   * stage='appeal' ruling, onchain_ix resolve_appeal), appeals 'decided', appeal.result +
   * APPEAL_RESULT. Idempotent: a decided appeal returns its bet id. null = not decidable now.
   */
  private async decide(appealId: string, casts: readonly CastVote[]): Promise<string | null> {
    const ctx = await this.panelContext(appealId);
    if (!ctx) return null;
    const names = await this.names(ctx.bet);
    const now = this.deps.now();
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, ctx.bet.id);
      const [ap] = await tx.select().from(appeals).where(eq(appeals.id, appealId)).for('update');
      if (!b || !ap) return null;
      if (ap.status === 'decided') return { b, envs: [] as BetEventEnvelope[], result: null };
      if (ap.status === 'failed' || b.state !== 'APPEALED') return null;
      await insertVotes(tx, casts);
      const rows = await tx
        .select()
        .from(appealVotes)
        .where(eq(appealVotes.appeal_id, appealId))
        .orderBy(appealVotes.seat);
      if (rows.length !== PANEL_SEATS.length) return null;
      const votes = rows.map((r) => voteOf(r, b.id));
      const original = ap.original_outcome as Appealable;
      const d = decideAppeal(original, votes);
      const result = AppealResult.parse({
        schema_version: 1,
        appeal_id: ap.id,
        bet_id: b.id,
        appellant: ap.appellant_party,
        original_outcome: original,
        original_ruling_hash: ctx.original.ruling_hash,
        votes,
        tally: d.tally,
        final_outcome: d.final_outcome,
        decided_by: d.decided_by,
        flipped: d.flipped,
        evidence_hash: ctx.original.evidence_hash,
        frame_hashes: ctx.frame_hashes,
        terms_hash: b.terms_hash,
        created_at: iso(now),
      });
      const hash = hashJcs(result);
      const [r] = await tx
        .insert(rulings)
        .values({
          bet_id: b.id,
          stage: 'appeal',
          appeal_id: ap.id,
          model: PANEL_MODEL,
          outcome: result.final_outcome,
          void_reason:
            result.final_outcome === 'VOID' ? (ctx.original.void_reason ?? 'undecidable') : null,
          frame_hashes: result.frame_hashes,
          evidence_kind: ctx.original.evidence_kind,
          evidence_hash: result.evidence_hash,
          record_canonical: jcs(result),
          ruling_hash: hash,
          onchain_ix: 'resolve_appeal',
          latency_ms: Math.max(0, now - ap.filed_at.getTime()),
          created_at: new Date(result.created_at),
        })
        .returning({ id: rulings.id });
      await tx
        .update(appeals)
        .set({
          status: 'decided',
          decided_at: new Date(now),
          final_outcome: result.final_outcome,
          decided_by: result.decided_by,
          flipped: result.flipped,
          result_ruling_id: r!.id,
        })
        .where(eq(appeals.id, ap.id));
      await tx.insert(auditLog).values({
        actor_kind: 'panel',
        action: 'appeal.decided',
        bet_id: b.id,
        details: {
          appeal_id: ap.id,
          appeal_ruling_hash: hash,
          final_outcome: result.final_outcome,
          decided_by: result.decided_by,
          tally: result.tally,
          votes: votes.map((v) => ({
            seat: v.seat,
            model: v.model,
            status: v.status,
            counted_as: v.counted_as,
          })),
        },
      });
      const envs = [
        // Every vote is on the log before the result, even ones stored while the bet was still
        // RULED (the Stream's BetAppealed moved it before our own confirm could stream them).
        ...(await this.pendingVotes(tx, ap.id, b.id)),
        await appendBetEvent(tx, {
          bet_id: b.id,
          type: 'appeal.result',
          payload: { result, ruling_hash: hash },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: b.id,
          type: 'judge.cue',
          payload: appealResultCue(result, names),
          now,
        }),
      ];
      return { b, envs, result };
    });
    if (!out) return null;
    if (out.envs.length) fanout(this.deps, out.b, out.envs);
    if (out.result)
      this.deps.log.info('appeal.decided', {
        bet_id: out.b.id,
        appeal_id: appealId,
        final_outcome: out.result.final_outcome,
        decided_by: out.result.decided_by,
        tally: out.result.tally,
      });
    return out.b.id;
  }

  /**
   * [ComputeBudget, (ATA creates), resolve_appeal(final, appeal_ruling_hash), close_bet], fee
   * payer + appeal authority: APPEALED -> APPEAL_RESOLVED (pending_tx) -> processed -> PAID /
   * VOIDED. A refused or failed send returns the bet to APPEALED for the sweep's retry.
   */
  private async submitResolve(betId: string): Promise<void> {
    const rt = await this.o.runtime();
    if (!rt) return;
    const appealKey = rt.keys.appeal;
    if (!appealKey) {
      this.deps.log.error('appeal.no_appeal_key', {
        bet_id: betId,
        hint: 'APPEAL_AUTHORITY_SECRET_KEY is not set: the stakes come back by timeout_refund',
      });
      return;
    }
    const bet = await readBet(this.deps.db, betId);
    if (!bet || bet.state !== 'APPEALED') return;
    const [ap] = await this.deps.db.select().from(appeals).where(eq(appeals.bet_id, betId));
    if (!ap || ap.status !== 'decided' || !ap.result_ruling_id || !ap.final_outcome) return;
    const [res] = await this.deps.db
      .select({ ruling_hash: rulings.ruling_hash })
      .from(rulings)
      .where(eq(rulings.id, ap.result_ruling_id));
    if (!res) return;
    const inFlight = await this.latestTx(betId, 'resolve_appeal');
    if (inFlight && ['built', 'signed', 'sent'].includes(inFlight.status)) return;

    const idBytes = betIdToBytes(betId);
    const [betPda] = await findBetPda({ betId: idBytes });
    const onchain = await this.fetchBet(rt, betPda);
    if (!onchain) {
      // Closed: a resolve_appeal of ours landed after its confirm was lost.
      await this.recoverResolve(rt, betId);
      return;
    }
    if (onchain.status !== BetStatus.Appealed) {
      this.deps.log.warn('appeal.resolve_not_appealed', {
        bet_id: betId,
        onchain: BetStatus[onchain.status],
      });
      return;
    }
    if (onchain.appealAuthority !== appealKey.address) {
      this.deps.log.error('appeal.appeal_key_mismatch', {
        bet_id: betId,
        key: appealKey.address,
        bet_appeal_authority: onchain.appealAuthority,
      });
      return;
    }
    const outcome = toOnchainOutcome(ap.final_outcome as Appealable);
    const fp = rt.keys.feePayer;
    const [vault] = await findVaultPda({ betId: idBytes });
    const pays = payout(outcome, onchain.stakeA, onchain.stakeA + onchain.stakeB);
    const aTok = await ataOf(onchain.partyA, onchain.mint);
    const bTok = await ataOf(onchain.partyB, onchain.mint);
    const ixs: Instruction[] = [];
    for (const [owner, tok, amount] of [
      [onchain.partyA, aTok, pays.to_a],
      [onchain.partyB, bTok, pays.to_b],
    ] as const) {
      if (amount === 0n || (await rt.client.getAccount(tok))) continue;
      ixs.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: fp,
          owner,
          mint: onchain.mint,
          tokenProgram: TOKEN_PROGRAM,
        }),
      );
    }
    ixs.push(
      await getResolveAppealInstructionAsync({
        payer: fp,
        appealAuthority: appealKey,
        bet: betPda,
        vault,
        mint: onchain.mint,
        ...(pays.to_a > 0n ? { partyAToken: aTok } : {}),
        ...(pays.to_b > 0n ? { partyBToken: bTok } : {}),
        tokenProgram: TOKEN_PROGRAM,
        finalOutcome: ONCHAIN_ENUM[outcome],
        appealRulingHash: hexBytes(res.ruling_hash),
      }),
      await getCloseBetInstructionAsync({
        payer: fp,
        bet: betPda,
        vault,
        mint: onchain.mint,
        rentPayer: onchain.rentPayer,
        tokenProgram: TOKEN_PROGRAM,
      }),
    );
    let built;
    try {
      built = await buildBlockhashTx(rt.client, fp.address, ixs, {
        signers: [fp, appealKey],
        label: 'resolve_appeal+close_bet',
        cuPrice: rt.cuPrice,
      });
    } catch (err) {
      if (err instanceof SimulationError) {
        const code = customErrorCode(err.err);
        this.deps.log.warn('appeal.resolve_refused', { bet_id: betId, code, err: err.message });
        // Past appeal_resolve_deadline (or no longer Appealed): the timeout-refund keeper (or the
        // chain) owns it, so the sweep looks again only after a long pause, not every tick.
        const final =
          code === ESCROW_ERROR__APPEAL_RESOLVE_DEADLINE_PASSED ||
          code === ESCROW_ERROR__INVALID_STATUS;
        this.retryAt.set(betId, this.deps.now() + (final ? 60_000 : RESOLVE_APPEAL_RETRY_MS));
        return;
      }
      throw err;
    }
    const signature = sigString(built.tx.signatures[fp.address]!);
    const now = this.deps.now();
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b || b.state !== 'APPEALED') return null;
      await expireInflight(tx, betId, 'resolve_appeal');
      const [r] = await tx
        .insert(chainTxs)
        .values({
          bet_id: betId,
          kind: 'resolve_appeal',
          bundled_close: true,
          signer_role: 'appeal',
          message_b64: messageB64(built.tx),
          message_sha256: sha256Hex(new Uint8Array(built.tx.messageBytes)),
          signature,
          simulated_cu: Number(built.simulatedUnits),
          cu_limit: built.cuLimit,
          expected_status: 'settled',
          status: 'sent',
          last_valid_block_height: built.lastValidBlockHeight,
          sent_at: new Date(now),
        })
        .returning({ id: chainTxs.id });
      const [row] = await tx
        .update(bets)
        .set({ state: 'APPEAL_RESOLVED' })
        .where(eq(bets.id, betId))
        .returning();
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(row!, b.state, null, {
            kind: 'resolve_appeal',
            signature,
            submitted_at: iso(now),
            rpc_processed_at: null,
            rpc_confirmed_at: null,
          }),
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'tx.submitted',
          payload: { kind: 'resolve_appeal', signature },
          now,
        }),
      ];
      return { b, envs, rowId: r!.id };
    });
    if (!out) return;
    fanout(this.deps, out.b, out.envs);

    try {
      await rt.client.send(wireOf(built.tx), false);
    } catch (err) {
      if (err instanceof PreflightError) {
        await this.revertResolve(betId, out.rowId, 'failed', err);
        return;
      }
      this.deps.log.warn('appeal.resolve_send_retry', { bet_id: betId, err });
    }
    this.confirming.add(out.rowId);
    try {
      const landed = await confirmSent(rt.client, built.tx, {
        ...this.o.send,
        lastValidBlockHeight: built.lastValidBlockHeight,
        onProcessed: (at) =>
          this.o.inflight.run('appeal.processed', () =>
            this.markResolveProcessed(betId, out.rowId, signature, now, at),
          ),
      });
      await this.settleResolve(betId, out.rowId, signature, now, landed);
    } catch (err) {
      if (err instanceof TxFailedError && err.kind === 'timeout') {
        this.deps.log.warn('appeal.resolve_confirm_pending', { bet_id: betId, signature });
        return;
      }
      if (err instanceof TxFailedError) {
        await this.revertResolve(
          betId,
          out.rowId,
          err.kind === 'expired' ? 'expired' : 'failed',
          err,
        );
        return;
      }
      throw err;
    } finally {
      this.confirming.delete(out.rowId);
    }
  }

  /** Processed: the winner's phone plays the payout animation on this bet.state frame. */
  private async markResolveProcessed(
    betId: string,
    rowId: string,
    signature: string,
    sentAt: number,
    at: number,
  ): Promise<void> {
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      await tx
        .update(chainTxs)
        .set({ rpc_processed_at: new Date(at) })
        .where(eq(chainTxs.id, rowId));
      if (!b || b.state !== 'APPEAL_RESOLVED') return null;
      const e = await appendBetEvent(tx, {
        bet_id: betId,
        type: 'bet.state',
        payload: statePayload(b, b.state, 'processed', {
          kind: 'resolve_appeal',
          signature,
          submitted_at: iso(sentAt),
          rpc_processed_at: iso(at),
          rpc_confirmed_at: null,
        }),
        now: this.deps.now(),
      });
      return { b, e };
    });
    if (out) fanout(this.deps, out.b, [out.e]);
  }

  /** resolve_appeal confirmed: PAID / VOIDED by the panel's final outcome, with the PAID cue. */
  private async settleResolve(
    betId: string,
    rowId: string,
    signature: string,
    sentAt: number,
    landed: Landed,
  ): Promise<void> {
    const now = this.deps.now();
    const [ap] = await this.deps.db.select().from(appeals).where(eq(appeals.bet_id, betId));
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b) return null;
      await tx
        .update(chainTxs)
        .set({
          status: 'confirmed',
          rpc_processed_at: new Date(landed.processedAt),
          rpc_confirmed_at: new Date(landed.confirmedAt),
        })
        .where(eq(chainTxs.id, rowId));
      if ((b.state !== 'APPEAL_RESOLVED' && b.state !== 'APPEALED') || !ap?.final_outcome)
        return { b, envs: [] as BetEventEnvelope[] };
      const outcome = toOnchainOutcome(ap.final_outcome as Appealable);
      const stakeA = b.stake_a ?? 0n;
      const amounts = payout(outcome, stakeA, stakeA + (b.stake_b ?? 0n));
      const voided = outcome === 'Refund';
      // bets.outcome stays the projector's (AppealResolved carries the final one): writing it
      // here would flap against a late BetAppealed delivery (fold.ts outcomeEvolves).
      const [row] = await tx
        .update(bets)
        .set({ state: voided ? 'VOIDED' : 'PAID', payout_via: 'resolve_appeal' })
        .where(eq(bets.id, betId))
        .returning();
      const names = await this.names(b, tx);
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(row!, b.state, 'resolve_appeal', {
            kind: 'resolve_appeal',
            signature,
            submitted_at: iso(sentAt),
            rpc_processed_at: iso(landed.processedAt),
            rpc_confirmed_at: iso(landed.confirmedAt),
          }),
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'tx.confirmed',
          payload: { kind: 'resolve_appeal', signature, slot: Number(landed.slot ?? 0n) },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: payoutCue(outcome, amounts, names),
          now,
        }),
      ];
      return { b, envs };
    });
    if (out) fanout(this.deps, out.b, out.envs);
    this.deps.log.info('appeal.settled', { bet_id: betId, signature });
  }

  /** The resolve_appeal did not land (and never will): row failed / expired, back to APPEALED. */
  private async revertResolve(
    betId: string,
    rowId: string,
    status: 'failed' | 'expired',
    err: unknown,
  ): Promise<void> {
    this.retryAt.set(betId, this.deps.now() + RESOLVE_APPEAL_RETRY_MS);
    const out = await this.deps.db.transaction(async (tx) => {
      await tx
        .update(chainTxs)
        .set({ status, err: String((err as Error)?.message ?? err).slice(0, 200) })
        .where(eq(chainTxs.id, rowId));
      const b = await lockBet(tx, betId);
      if (b?.state !== 'APPEAL_RESOLVED') return null;
      const [row] = await tx
        .update(bets)
        .set({ state: 'APPEALED' })
        .where(eq(bets.id, betId))
        .returning();
      const e = await appendBetEvent(tx, {
        bet_id: betId,
        type: 'bet.state',
        payload: statePayload(row!, 'APPEAL_RESOLVED', 'resolve_appeal_failed'),
        now: this.deps.now(),
      });
      return { b, e };
    });
    if (out) fanout(this.deps, out.b, [out.e]);
    this.deps.log.warn('appeal.resolve_failed', { bet_id: betId, status, err: String(err) });
  }

  /** The PDA is closed: settle from the resolve_appeal row that landed. */
  private async recoverResolve(rt: ChainRuntime, betId: string): Promise<boolean> {
    const rows = await this.deps.db
      .select()
      .from(chainTxs)
      .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, 'resolve_appeal')))
      .orderBy(desc(chainTxs.sent_at))
      .limit(5);
    for (const row of rows) {
      if (!row.signature) continue;
      const st = await rt.client.signatureStatus(row.signature, { searchHistory: true });
      if (!st || st.err || st.confirmationStatus === 'processed') continue;
      await this.settleResolve(
        betId,
        row.id,
        row.signature,
        row.sent_at?.getTime() ?? this.deps.now(),
        {
          signature: row.signature,
          processedAt: row.rpc_processed_at?.getTime() ?? this.deps.now(),
          confirmedAt: this.deps.now(),
          slot: st.slot,
        },
      );
      return true;
    }
    this.deps.log.warn('appeal.pda_closed_unexplained', { bet_id: betId });
    return false;
  }

  // ---- keeper sweep -------------------------------------------------------------------------

  /**
   * The durable backstop of the in-process jobs (a confirm timeout, a restart, an appeal the
   * projector saw first). Idempotent; safe beside the in-process jobs (they are skipped).
   */
  async sweep(
    nowMs: number,
  ): Promise<{ appealed: string[]; failed: string[]; resolving: string[] }> {
    const out = { appealed: [] as string[], failed: [] as string[], resolving: [] as string[] };
    const rt = await this.o.runtime();
    if (!rt) return out;
    const height = heightOnce(rt.client);

    // 1. 'sent' appeal / resolve_appeal rows whose confirm loop is gone.
    const sent = await this.deps.db
      .select()
      .from(chainTxs)
      .where(and(inArray(chainTxs.kind, ['appeal', 'resolve_appeal']), eq(chainTxs.status, 'sent')))
      .orderBy(chainTxs.sent_at)
      .limit(20);
    for (const row of sent) {
      if (this.confirming.has(row.id) || !row.signature) continue;
      try {
        const { fate, status: st } = await txFate(
          rt.client,
          row.signature,
          row.last_valid_block_height,
          {
            sentAtMs: row.sent_at?.getTime() ?? 0,
            nowMs,
            height,
          },
        );
        if (fate === 'pending') continue;
        const landed: Landed = {
          signature: row.signature,
          processedAt: row.rpc_processed_at?.getTime() ?? nowMs,
          confirmedAt: nowMs,
          slot: st?.slot ?? null,
        };
        const dead = fate === 'failed' ? 'failed' : 'expired';
        if (row.kind === 'appeal') {
          const [ap] = await this.deps.db
            .select()
            .from(appeals)
            .where(eq(appeals.bet_id, row.bet_id));
          if (!ap) continue;
          if (fate === 'landed') {
            await this.markAppealed(
              rt,
              row.bet_id,
              ap.id,
              row.id,
              row.signature,
              row.sent_at?.getTime() ?? nowMs,
              landed,
            );
            this.ensureDecision(ap.id);
            out.appealed.push(row.bet_id);
          } else {
            await this.failAppeal(
              row.bet_id,
              ap.id,
              row.id,
              dead,
              st?.err ? JSON.stringify(st.err) : 'expired unconfirmed',
            );
            out.failed.push(row.bet_id);
          }
        } else if (fate === 'landed') {
          await this.settleResolve(
            row.bet_id,
            row.id,
            row.signature,
            row.sent_at?.getTime() ?? nowMs,
            landed,
          );
        } else {
          await this.revertResolve(
            row.bet_id,
            row.id,
            dead,
            st?.err ? JSON.stringify(st.err) : 'expired unconfirmed',
          );
        }
      } catch (err) {
        this.deps.log.warn('appeal.sweep_tx_failed', { bet_id: row.bet_id, kind: row.kind, err });
      }
    }

    // 2. APPEALED bets: the panel, the decision, resolve_appeal (whatever is missing).
    const live = await this.deps.db
      .select()
      .from(bets)
      .where(
        and(
          eq(bets.state, 'APPEALED'),
          sql`(${bets.appeal_resolve_deadline} IS NULL OR ${bets.appeal_resolve_deadline} > ${iso(nowMs)}::timestamptz)`,
        ),
      )
      .limit(10);
    for (const b of live) {
      try {
        let [ap] = await this.deps.db.select().from(appeals).where(eq(appeals.bet_id, b.id));
        if (!ap) ap = (await this.adoptForeignAppeal(b)) ?? undefined;
        if (!ap || ap.status === 'failed') continue;
        if (ap.status !== 'decided') {
          if (!this.deciding.has(ap.id)) {
            this.ensureDecision(ap.id);
            out.resolving.push(b.id);
          }
          continue;
        }
        if (this.deciding.has(ap.id) || (this.retryAt.get(b.id) ?? 0) > nowMs) continue;
        const last = await this.latestTx(b.id, 'resolve_appeal');
        if (last && ['built', 'signed', 'sent'].includes(last.status)) continue;
        this.deciding.add(ap.id);
        const id = ap.id;
        this.o.inflight.run('appeal.resolve', async () => {
          try {
            await this.submitResolve(b.id);
          } finally {
            this.deciding.delete(id);
          }
        });
        out.resolving.push(b.id);
      } catch (err) {
        this.deps.log.warn('appeal.sweep_bet_failed', { bet_id: b.id, err });
      }
    }

    // 3. APPEAL_RESOLVED with no resolve_appeal in flight (a crash between two writes).
    const stranded = await this.deps.db
      .select({ id: bets.id })
      .from(bets)
      .where(
        and(
          eq(bets.state, 'APPEAL_RESOLVED'),
          lte(bets.updated_at, new Date(nowMs - STRANDED_GRACE_MS)),
          sql`NOT EXISTS (SELECT 1 FROM ${chainTxs} t WHERE t.bet_id = ${bets.id}
                AND t.kind = 'resolve_appeal' AND t.status IN ('built','signed','sent'))`,
        ),
      )
      .limit(10);
    for (const s of stranded) {
      try {
        const onchain = await readBetAccount(rt, s.id);
        if (!onchain) {
          await this.recoverResolve(rt, s.id);
          continue;
        }
        if (onchain.status !== BetStatus.Appealed) continue;
        const last = await this.latestTx(s.id, 'resolve_appeal');
        if (last)
          await this.revertResolve(
            s.id,
            last.id,
            last.status === 'expired' ? 'expired' : 'failed',
            'payout_lost',
          );
      } catch (err) {
        this.deps.log.warn('appeal.sweep_stranded_failed', { bet_id: s.id, err });
      }
    }
    return out;
  }

  /**
   * An APPEALED bet with no appeals row: the appeal reached the chain some other way (signed
   * outside this server, or a row lost). The appellant is the loser of a decisive ruling, else
   * the BetAppealed event's signer; the panel then rules on it like any other.
   */
  private async adoptForeignAppeal(b: BetRow): Promise<AppealRow | null> {
    const [ruled] = await this.deps.db
      .select({ id: rulings.id })
      .from(rulings)
      .where(and(eq(rulings.bet_id, b.id), eq(rulings.ruling_hash, b.ruling_hash ?? '')))
      .limit(1);
    if (!ruled || !b.outcome) return null;
    const may = appellantsOf(b.outcome);
    let party: Party | null = may === 'A' || may === 'B' ? may : null;
    if (!party) {
      const [ev] = await this.deps.db
        .select({ payload: chainEvents.payload })
        .from(chainEvents)
        .where(and(eq(chainEvents.bet_id, b.id), eq(chainEvents.event_name, 'BetAppealed')))
        .limit(1);
      const appellant = (ev?.payload as { appellant?: string } | undefined)?.appellant;
      party = appellant === b.party_a_wallet ? 'A' : appellant === b.party_b_wallet ? 'B' : null;
    }
    if (!party) return null;
    const [ap] = await this.deps.db
      .insert(appeals)
      .values({
        bet_id: b.id,
        appellant_user_id: party === 'A' ? b.party_a_id : b.party_b_id,
        appellant_party: party,
        appealed_ruling_id: ruled.id,
        original_outcome: PG_TO_RULING[b.outcome],
        status: 'panel_voting',
      })
      .onConflictDoNothing({ target: appeals.bet_id })
      .returning();
    if (ap) this.deps.log.warn('appeal.adopted', { bet_id: b.id, appeal_id: ap.id, party });
    return ap ?? null;
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async bet(betId: string): Promise<BetRow> {
    const b = await readBet(this.deps.db, betId);
    if (!b) throw new HttpError('NOT_FOUND', 'No such bet.');
    return b;
  }

  private async latestTx(betId: string, kind: 'appeal' | 'resolve_appeal') {
    const [row] = await this.deps.db
      .select()
      .from(chainTxs)
      .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, kind)))
      .orderBy(desc(chainTxs.built_at))
      .limit(1);
    return row ?? null;
  }

  private async fetchBet(rt: ChainRuntime, betPda: Address): Promise<Bet | null> {
    const acc = await rt.client.getAccount(betPda);
    if (!acc || acc.owner !== rt.programId) return null;
    return getBetDecoder().decode(acc.data);
  }

  private async names(
    bet: Pick<BetRow, 'party_a_id' | 'party_b_id'>,
    db: Pick<Tx, 'select'> = this.deps.db,
  ): Promise<Record<Party, string>> {
    const rows = await db
      .select({ id: users.id, name: users.display_name })
      .from(users)
      .where(inArray(users.id, [bet.party_a_id, bet.party_b_id]));
    const by = new Map(rows.map((r) => [r.id, r.name]));
    return { A: by.get(bet.party_a_id) ?? 'A', B: by.get(bet.party_b_id) ?? 'B' };
  }
}

/** Stores cast votes (one per seat / provider; a repeat is a no-op). */
async function insertVotes(tx: Tx, casts: readonly CastVote[]): Promise<void> {
  if (!casts.length) return;
  await tx
    .insert(appealVotes)
    .values(
      casts.map(({ vote: v, output_sha256 }) => ({
        appeal_id: v.appeal_id,
        seat: v.seat,
        provider: v.provider,
        model: v.model,
        status: v.status,
        outcome: v.outcome,
        counted_as: v.counted_as,
        confidence: v.confidence.toFixed(2),
        reason: v.reason,
        output_sha256,
        latency_ms: v.latency_ms,
        created_at: new Date(v.created_at),
      })),
    )
    .onConflictDoNothing();
}

/** One in-flight tx per (bet, kind) (chain_txs_inflight_uq): retire a stale one before a new build. */
async function expireInflight(tx: Tx, betId: string, kind: 'appeal' | 'resolve_appeal') {
  await tx
    .update(chainTxs)
    .set({ status: 'expired' })
    .where(
      and(
        eq(chainTxs.bet_id, betId),
        eq(chainTxs.kind, kind),
        inArray(chainTxs.status, ['built', 'signed', 'sent']),
      ),
    );
}
