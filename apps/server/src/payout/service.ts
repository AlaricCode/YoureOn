// Payout service (beats 3-4 money out): resolve -> RULED, then GG (concede) or finalize after the
// appeal window, each bundled with close_bet -> PAID / VOIDED (ESCROW §5.2, SCHEMAS §9.2,
// API-CONTRACT §2.10, scripts/smoke-devnet.ts + scripts/lib/crank.ts ported).
//
//   onRuling(betId, ruling)  the judge slice calls exactly this with a decisive or VOID shared
//                            `Ruling` (attempt/settlement) or `HearingRuling`. Builds
//                            [ComputeBudget, resolve] signed by judge_authority + fee payer with
//                            evidence_hash = ruling.evidence_hash and ruling_hash = sha256(JCS(ruling)),
//                            waits for `confirmed`, sets RULED, pushes bet.state (reason carries
//                            appeal_deadline) and the loser's concede tx.sign_request, and arms the
//                            finalize fast path (setTimeout at appeal_deadline + 1 s). REDO throws.
//   finalizeDue(now)         keeper sweep (DB-first): reconcile() first (settles 'sent' resolve /
//                            concede / finalize rows whose confirm timed out or died with a
//                            restart), then every RULED bet past appeal_deadline + 1 s.
//   concedeRequest / concede GET / POST /v1/bets/:id/concede (the loser signs on the phone;
//                            LOCK_SIGNER=server signs as the demo key). GG and the appeal are
//                            mutually exclusive: once the loser's appeal is signed / out, GET and
//                            POST answer STATE_MOVED_ON {reason:'appeal_in_flight'} (checked under
//                            the bet lock, as the appeal checks RULED under it).
//
// The program emits no BetPaid: money moves in BetFinalized / BetConceded (then BetClosed). Our own
// RPC `confirmed` of the payout tx moves the bet to PAID / VOIDED and pushes judge.cue PAID with
// the amounts (computed with the shared `payout()` rule over the deposited stakes).
//
// Columns written here that DATA-MODEL §8.1 lists as projector-owned: outcome, evidence_hash,
// ruling_hash, resolve_deadline, appeal_deadline (read back from the Bet account at our own
// `confirmed`; the same values BetResolved carries). The stub projector writes none of them, and
// the finalize sweep needs appeal_deadline in Postgres. onchain_pending / pending_sig keep the
// lock's values (see lock/service.ts header).
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
import { z } from 'zod/v4';
import { bets, chainTxs, users } from '@youre-on/db';
import type { PartySignature, SignRequest } from '@youre-on/shared/api';
import {
  BetStatus,
  ESCROW_ERROR__APPEAL_WINDOW_OPEN,
  findBetPda,
  findVaultPda,
  getBetDecoder,
  getCloseBetInstructionAsync,
  getConcedeInstructionAsync,
  getFinalizeInstructionAsync,
  getResolveInstructionAsync,
  Outcome,
  type Bet,
} from '@youre-on/shared/escrow-client';
import { HearingRuling } from '@youre-on/shared/hearing';
import { hashJcs } from '@youre-on/shared/jcs';
import { formatUsd } from '@youre-on/shared/money';
import { renderSignCard } from '@youre-on/shared/sign-card';
import { betIdToBytes, type Party } from '@youre-on/shared/primitives';
import { payout, Ruling, toOnchainOutcome, type OnchainOutcome } from '@youre-on/shared/ruling';
import type { TermsEnvelope } from '@youre-on/shared/terms';
import { BetState } from '@youre-on/shared/bet-state';
import { recordLine, type PairRecord, type PayoutVia } from '@youre-on/shared/gg';
import { judgeCue } from '../bets/cues';
import { partyOf, type BetRow } from '../bets/snapshot';
import { HttpError } from '../errors';
import { sha256Hex, verifyEd25519 } from '../crypto';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import {
  ataOf,
  buildBlockhashTx,
  chainNow,
  confirmSent,
  cosignTx,
  customErrorCode,
  isBlockhashNotFound,
  messageB64,
  PreflightError,
  SimulationError,
  TOKEN_PROGRAM,
  heightOnce,
  TxFailedError,
  txFate,
  wireOf,
  type ChainRuntime,
  type Landed,
  type SendOptions,
} from '../chain/tx';
import {
  fanout,
  hexBytes,
  hexOf,
  iso,
  Inflight,
  casBetState,
  lockBet,
  readBetAccount,
  statePayload,
  type LifecycleDeps,
  type Tx,
} from '../lock/common';
import { loadEnvelope } from '../lock/terms';
import { txFromStored } from '../lock/service';

/** A ruling the judge slice hands over: SCHEMAS Ruling (attempt / settlement) or HearingRuling. */
export const PayoutRuling = z.union([Ruling, HearingRuling]);
export type PayoutRuling = z.infer<typeof PayoutRuling>;

/** States from which `resolve` may be sent (the bet is Locked onchain). */
export const RESOLVABLE_STATES: readonly BetState[] = [
  'LOCKED',
  'ATTEMPT',
  'JUDGING',
  'HEARING',
  'AWAITING_MARKET',
];
/** SCHEMAS §9.2: the server finalizes at appeal_deadline + 1 s. */
export const FINALIZE_DELAY_MS = 1_000;
/** API-CONTRACT §2.10: rebuild a concede message older than this (unsigned). */
export const CONCEDE_REBUILD_MS = 20_000;
/** A recent blockhash lives ~60 s on devnet; the sign request stops a bit earlier. */
export const SIGN_REQUEST_TTL_MS = 50_000;
/** CONCEDED / FINALIZED this long with no payout in flight counts as stranded. */
export const STRANDED_GRACE_MS = 30_000;

const b58enc = getBase58Encoder();
const b58dec = getBase58Decoder();
const sigString = (b: Uint8Array) => b58dec.decode(b);

const ONCHAIN: Record<
  OnchainOutcome,
  { enum: Outcome; pg: 'party_a' | 'party_b' | 'split' | 'refund' }
> = {
  PartyA: { enum: Outcome.PartyA, pg: 'party_a' },
  PartyB: { enum: Outcome.PartyB, pg: 'party_b' },
  Split: { enum: Outcome.Split, pg: 'split' },
  Refund: { enum: Outcome.Refund, pg: 'refund' },
};
const FROM_PG = { party_a: 'PartyA', party_b: 'PartyB', split: 'Split', refund: 'Refund' } as const;

export interface PayoutServiceOptions {
  deps: LifecycleDeps;
  runtime: () => Promise<ChainRuntime | null>;
  inflight: Inflight;
  signer: 'phones' | 'server';
  send?: SendOptions;
  /** Arm the setTimeout fast path (default true). */
  timers?: boolean;
  /**
   * The loser's appeal SignRequest, pushed beside the concede one at RULED (src/appeal
   * AppealService.pushRequest); null / absent = only the concede request is pushed.
   */
  appealRequest?: (rt: ChainRuntime, bet: BetRow, loser: Party) => Promise<SignRequest | null>;
  /**
   * The GG moment (src/gg/service.ts): extra events in the commit that moves the bet to CONCEDED
   * (bet.gg). Must never throw for a missing extra (it would fail the loser's GG).
   */
  onConcedeSubmitted?: (tx: Tx, bet: BetRow, now: number) => Promise<BetEventEnvelope[]>;
  /** How the payout came about (GG / the clock / a lapsed review) for the PAID cue's wording. */
  cueContext?: (
    tx: Tx,
    bet: BetRow,
    kind: 'finalize' | 'concede',
  ) => Promise<PayoutCueContext | undefined>;
}

export interface RuledResult {
  signature: string;
  appeal_deadline: number;
  already: boolean;
}

export class PayoutService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly finalizing = new Set<string>();
  /** chain_txs ids whose in-process confirm loop is running (reconcile() skips them). */
  private readonly confirming = new Set<string>();
  constructor(private readonly o: PayoutServiceOptions) {}

  private get deps() {
    return this.o.deps;
  }

  private async rt(): Promise<ChainRuntime> {
    const rt = await this.o.runtime();
    if (!rt) throw new HttpError('RPC_UNAVAILABLE', 'The chain is not configured.');
    return rt;
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Drops the finalize timers of bets that no longer exist (POST /v1/demo/reset). */
  forget(betIds: readonly string[]): void {
    for (const id of betIds) {
      const t = this.timers.get(id);
      if (t) clearTimeout(t);
      this.timers.delete(id);
    }
  }

  // ---- resolve ----------------------------------------------------------------------------

  async onRuling(betId: string, input: Ruling | HearingRuling): Promise<RuledResult> {
    try {
      return await this.resolveOnce(betId, input);
    } catch (err) {
      // A lagging RPC node rejected the fresh blockhash at preflight: nothing landed (send()
      // checked), the row is retired, so one immediate rebuild beats waiting for resolve-due.
      if (!isBlockhashNotFound(err)) throw err;
      this.deps.log.warn('payout.resolve_blockhash_retry', { bet_id: betId });
      // Never the rejected blockhash again: the same one would rebuild the very same bytes
      // (unknown -> wait a slot, so getLatestBlockhash moves on).
      const rejected = (err as PreflightError).blockhash;
      if (!rejected) await new Promise((r) => setTimeout(r, 500));
      return this.resolveOnce(betId, input, rejected);
    }
  }

  private async resolveOnce(
    betId: string,
    input: Ruling | HearingRuling,
    avoidBlockhash?: string,
  ): Promise<RuledResult> {
    const ruling = PayoutRuling.parse(input);
    if (ruling.bet_id !== betId)
      throw new Error(`ruling is for bet ${ruling.bet_id}, not ${betId}`);
    if (ruling.outcome === 'REDO') throw new Error('REDO never goes onchain');
    const outcome = toOnchainOutcome(ruling.outcome);
    const rulingHash = hashJcs(ruling);
    const rt = await this.rt();
    const judge = rt.keys.judge;
    if (!judge) throw new Error('JUDGE_AUTHORITY_SECRET_KEY is not set');

    const bet = await this.bet(betId);
    if (bet.terms_hash !== ruling.terms_hash)
      throw new Error('ruling.terms_hash != the bet terms_hash');
    const prior = await this.latestTx(betId, 'resolve');
    if (prior?.status === 'confirmed' && bet.appeal_deadline)
      return {
        signature: prior.signature!,
        appeal_deadline: Math.floor(bet.appeal_deadline.getTime() / 1000),
        already: true,
      };

    // An earlier resolve may have landed after its confirm timed out (or across a restart):
    // when the Bet is already Resolved with THIS ruling, adopt it instead of rebuilding (a
    // rebuild would fail simulation: the bet is no longer Locked).
    const idBytes = betIdToBytes(betId);
    const [betPda] = await findBetPda({ betId: idBytes });
    const before = await this.fetchBet(rt, betPda);
    if (before && before.status !== BetStatus.Locked) {
      if (before.status === BetStatus.Resolved && hexOf(before.rulingHash) === rulingHash)
        return this.adoptResolved(rt, betId, before, prior);
      throw new HttpError('INVALID_STATE', 'The bet is no longer Locked onchain.', {
        state: bet.state,
        onchain: BetStatus[before.status],
      });
    }
    if (!RESOLVABLE_STATES.includes(bet.state))
      throw new HttpError('INVALID_STATE', undefined, { state: bet.state });

    // Never build a second resolve while an earlier one may still land (a confirm timeout, a
    // restart, the resolve-due retry): re-broadcast its exact bytes and wait for it, unless it is
    // known dead (then the rebuild below is safe).
    if (prior?.status === 'sent') {
      const resumed = await this.resumeResolve(rt, betId, prior, rulingHash, judge);
      if (resumed !== 'dead') return resumed;
    }

    const ix = await getResolveInstructionAsync({
      payer: rt.keys.feePayer,
      judgeAuthority: judge,
      bet: betPda,
      outcome: ONCHAIN[outcome].enum,
      evidenceHash: hexBytes(ruling.evidence_hash),
      rulingHash: hexBytes(rulingHash),
    });
    const built = await buildBlockhashTx(rt.client, rt.keys.feePayer.address, [ix], {
      signers: [rt.keys.feePayer, judge],
      label: 'resolve',
      cuPrice: rt.cuPrice,
      ...(avoidBlockhash ? { avoidBlockhash } : {}),
    });
    const signature = sigString(built.tx.signatures[rt.keys.feePayer.address]!);
    const now = this.deps.now();
    const rowId = await this.deps.db.transaction(async (tx) => {
      await expireInflight(tx, betId, 'resolve');
      const [row] = await tx
        .insert(chainTxs)
        .values({
          bet_id: betId,
          kind: 'resolve',
          signer_role: 'judge',
          message_b64: messageB64(built.tx),
          message_sha256: sha256Hex(new Uint8Array(built.tx.messageBytes)),
          signature,
          simulated_cu: Number(built.simulatedUnits),
          cu_limit: built.cuLimit,
          expected_status: 'resolved',
          status: 'sent',
          last_valid_block_height: built.lastValidBlockHeight,
          sent_at: new Date(now),
        })
        .returning({ id: chainTxs.id });
      return row!.id;
    });
    let landed: Landed;
    this.confirming.add(rowId);
    try {
      try {
        await rt.client.send(wireOf(built.tx), false);
      } catch (err) {
        if (err instanceof PreflightError) {
          err.blockhash = built.blockhash ?? undefined;
          throw err;
        }
        // Transport trouble: confirmSent re-broadcasts the same bytes.
        this.deps.log.warn('payout.resolve_send_retry', { bet_id: betId, err });
      }
      landed = await confirmSent(rt.client, built.tx, {
        ...this.o.send,
        lastValidBlockHeight: built.lastValidBlockHeight,
      });
    } catch (err) {
      if (err instanceof TxFailedError && err.kind === 'timeout') {
        // The blockhash is still valid, so it may yet land: the row stays 'sent' and reconcile()
        // settles it; if it already landed, adopt it now.
        const after = await this.fetchBet(rt, betPda);
        if (after?.status === BetStatus.Resolved && hexOf(after.rulingHash) === rulingHash)
          return this.adoptResolved(rt, betId, after, { id: rowId, signature, status: 'sent' });
        throw err;
      }
      await this.deps.db
        .update(chainTxs)
        .set({
          status: err instanceof TxFailedError && err.kind === 'expired' ? 'expired' : 'failed',
          err: String((err as Error).message ?? err).slice(0, 200),
        })
        .where(eq(chainTxs.id, rowId));
      throw err;
    } finally {
      this.confirming.delete(rowId);
    }

    const onchain = await this.fetchBet(rt, betPda);
    return this.markRuled(
      rt,
      betId,
      rowId,
      {
        outcome,
        evidenceHash: ruling.evidence_hash,
        rulingHash,
        appealDeadline: Number(onchain?.appealDeadline ?? 0n),
        resolveDeadline: onchain ? Number(onchain.resolveDeadline) : null,
      },
      signature,
      now,
      landed,
    );
  }

  /**
   * A 'sent' resolve row of this bet, its in-process confirm gone. Known dead (failed onchain,
   * or past its lastValidBlockHeight and still unseen on a second read) -> the row is retired and
   * 'dead' returned, so the caller may build a new one. Otherwise its stored message is re-signed
   * (ed25519 is deterministic: the same signatures, the same tx id), re-broadcast with preflight
   * off and confirmed -> RULED. A row for a different ruling, or one whose confirm is running in
   * this process, is never doubled: INVALID_STATE (retryable) until it settles.
   */
  private async resumeResolve(
    rt: ChainRuntime,
    betId: string,
    prior: typeof chainTxs.$inferSelect,
    rulingHash: string,
    judge: KeyPairSigner,
  ): Promise<RuledResult | 'dead'> {
    const inFlight = () =>
      new HttpError('INVALID_STATE', 'A resolve for this bet is still in flight.', {
        reason: 'resolve_in_flight',
        signature: prior.signature,
      });
    if (this.confirming.has(prior.id)) throw inFlight();
    if (!prior.signature || !prior.message_b64) return 'dead';
    const retire = async (status: 'failed' | 'expired', err: string) => {
      await this.deps.db
        .update(chainTxs)
        .set({ status, err: err.slice(0, 200) })
        .where(and(eq(chainTxs.id, prior.id), eq(chainTxs.status, 'sent')));
      return 'dead' as const;
    };
    const { fate, status } = await txFate(
      rt.client,
      prior.signature,
      prior.last_valid_block_height,
      { sentAtMs: prior.sent_at?.getTime() ?? 0, nowMs: this.deps.now() },
    );
    if (fate === 'failed') return retire('failed', JSON.stringify(status?.err));
    if (fate === 'dead') return retire('expired', 'expired unconfirmed');
    const msg = Buffer.from(prior.message_b64, 'base64');
    if (!msg.includes(Buffer.from(rulingHash, 'hex'))) throw inFlight(); // another ruling's resolve
    const full = await cosignTx(txFromStored(prior.message_b64, new Map()), [
      rt.keys.feePayer,
      judge,
    ]);
    if (sigString(full.signatures[rt.keys.feePayer.address]!) !== prior.signature)
      throw new Error(`stored resolve of bet ${betId} does not re-sign to its signature`);
    this.deps.log.warn('payout.resolve_resumed', { bet_id: betId, signature: prior.signature });
    let landed: Landed;
    this.confirming.add(prior.id);
    try {
      await rt.client.send(wireOf(full), true).catch(() => {}); // the status poll decides
      landed = await confirmSent(rt.client, full, {
        ...this.o.send,
        lastValidBlockHeight: prior.last_valid_block_height,
      });
    } catch (err) {
      if (err instanceof TxFailedError && err.kind !== 'timeout')
        return retire(err.kind === 'expired' ? 'expired' : 'failed', err.message);
      throw err; // timeout: still 'sent', reconcile() or the next retry settles it
    } finally {
      this.confirming.delete(prior.id);
    }
    const [betPda] = await findBetPda({ betId: betIdToBytes(betId) });
    const onchain = await this.fetchBet(rt, betPda);
    if (!onchain || onchain.status !== BetStatus.Resolved)
      throw new Error(`resolve ${prior.signature} confirmed but bet ${betId} is not Resolved`);
    const opt = onchain.outcome as { __option: 'Some'; value: Outcome } | { __option: 'None' };
    if (opt.__option !== 'Some') throw new Error(`bet ${betId} is Resolved without an outcome`);
    return this.markRuled(
      rt,
      betId,
      prior.id,
      {
        outcome: Outcome[opt.value] as OnchainOutcome,
        evidenceHash: hexOf(onchain.evidenceHash),
        rulingHash: hexOf(onchain.rulingHash),
        appealDeadline: Number(onchain.appealDeadline),
        resolveDeadline: Number(onchain.resolveDeadline),
      },
      prior.signature,
      prior.sent_at?.getTime() ?? this.deps.now(),
      landed,
    );
  }

  /** Adopts a resolve found onchain (values from the Bet account): -> RULED as if we confirmed it. */
  private async adoptResolved(
    rt: ChainRuntime,
    betId: string,
    onchain: Bet,
    row: Pick<typeof chainTxs.$inferSelect, 'id' | 'signature' | 'status'> | null,
  ): Promise<RuledResult> {
    const now = this.deps.now();
    let rowId: string | null = null;
    let slot: bigint | null = null;
    if (row?.signature && row.status !== 'confirmed') {
      const st = await rt.client.signatureStatus(row.signature, { searchHistory: true });
      if (st && !st.err && st.confirmationStatus !== 'processed') {
        rowId = row.id;
        slot = st.slot;
      }
    }
    const opt = onchain.outcome as { __option: 'Some'; value: Outcome } | { __option: 'None' };
    if (opt.__option !== 'Some') throw new Error(`bet ${betId} is Resolved without an outcome`);
    this.deps.log.warn('payout.resolve_adopted', { bet_id: betId, signature: row?.signature });
    return this.markRuled(
      rt,
      betId,
      rowId,
      {
        outcome: Outcome[opt.value] as OnchainOutcome,
        evidenceHash: hexOf(onchain.evidenceHash),
        rulingHash: hexOf(onchain.rulingHash),
        appealDeadline: Number(onchain.appealDeadline),
        resolveDeadline: Number(onchain.resolveDeadline),
      },
      row?.signature ?? '',
      now,
      { signature: row?.signature ?? '', processedAt: now, confirmedAt: now, slot },
      true,
    );
  }

  /**
   * The confirmed resolve -> RULED (reason carries appeal_deadline), then the loser's GG prompt
   * and the finalize fast path. No state change when the bet is no longer resolvable (e.g. a
   * concurrent adopt already ruled it).
   *
   * The chain may get there first: the projector's chain-wins rule (the Stream, or rpc_poll a few
   * seconds after the send) moves the bet to RULED with this ruling before our own confirm
   * returns (a slow confirm, a confirm timeout + adopt, RPC 429 retries). Then the state write and
   * bet.state are skipped (the projector pushed them), but the side effects still belong to this
   * confirm: tx.confirmed, the GG prompt and the finalize timer. They run once: only the call that
   * moves this resolve's chain_txs row to 'confirmed' does them.
   */
  private async markRuled(
    rt: ChainRuntime,
    betId: string,
    rowId: string | null,
    r: {
      outcome: OnchainOutcome;
      evidenceHash: string;
      rulingHash: string;
      appealDeadline: number;
      resolveDeadline: number | null;
    },
    signature: string,
    submittedAt: number,
    landed: Landed,
    already = false,
  ): Promise<RuledResult> {
    const { outcome, appealDeadline } = r;
    const txConfirmed = (tx: Tx) =>
      appendBetEvent(tx, {
        bet_id: betId,
        type: 'tx.confirmed',
        payload: { kind: 'resolve', signature, slot: Number(landed.slot ?? 0n) },
        now: this.deps.now(),
      });
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b) return null;
      // under the bet lock: true for exactly one confirm of this row
      const firstConfirm = rowId
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
      if (!RESOLVABLE_STATES.includes(b.state)) {
        const chainRuled = b.state === 'RULED' && b.ruling_hash === r.rulingHash;
        if (!chainRuled || !firstConfirm) return { b, envs: [], moved: false };
        this.deps.log.info('payout.ruled_by_chain_first', { bet_id: betId, signature });
        return { b, envs: signature ? [await txConfirmed(tx)] : [], moved: true };
      }
      const row = await casBetState(tx, betId, RESOLVABLE_STATES, {
        state: 'RULED',
        outcome: ONCHAIN[outcome].pg,
        evidence_hash: r.evidenceHash,
        ruling_hash: r.rulingHash,
        appeal_deadline: new Date(appealDeadline * 1000),
        ...(r.resolveDeadline !== null
          ? { resolve_deadline: new Date(r.resolveDeadline * 1000) }
          : {}),
      });
      if (!row) return { b, envs: [], moved: false };
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(
            row,
            b.state,
            `appeal_deadline=${appealDeadline}`,
            signature
              ? {
                  kind: 'resolve',
                  signature,
                  submitted_at: iso(submittedAt),
                  rpc_processed_at: iso(landed.processedAt),
                  rpc_confirmed_at: iso(landed.confirmedAt),
                }
              : null,
          ),
          now: this.deps.now(),
        }),
        ...(signature ? [await txConfirmed(tx)] : []),
      ];
      return { b, envs, moved: true };
    });
    if (out) fanout(this.deps, out.b, out.envs);
    if (!out?.moved) return { signature, appeal_deadline: appealDeadline, already: true };
    this.deps.log.info('payout.ruled', {
      bet_id: betId,
      signature,
      outcome,
      appeal_deadline: appealDeadline,
    });

    // The loser's GG prompt (decisive outcomes only), off the ruling's path, with the appeal
    // request beside it (API-CONTRACT §3.4: "concede + appeal, loser"; camera bets only).
    if (this.o.signer === 'phones' && (outcome === 'PartyA' || outcome === 'PartyB')) {
      const loser: Party = outcome === 'PartyA' ? 'B' : 'A';
      this.o.inflight.run('payout.sign_request', async () => {
        const fresh = await this.bet(betId);
        const push = async (request: SignRequest) => {
          const env = await this.deps.db.transaction((tx) =>
            appendBetEvent(tx, {
              bet_id: betId,
              type: 'tx.sign_request',
              payload: { request },
              now: this.deps.now(),
            }),
          );
          fanout(this.deps, fresh, [env]);
        };
        // The GG prompt first, never held up by the appeal build (one more simulate).
        await push(await this.buildConcede(rt, fresh, loser));
        const appeal = await this.o.appealRequest?.(rt, fresh, loser);
        if (appeal) await push(appeal);
      });
    }
    this.armFinalize(betId, appealDeadline * 1000 + FINALIZE_DELAY_MS);
    return { signature, appeal_deadline: appealDeadline, already };
  }

  // ---- finalize ---------------------------------------------------------------------------

  /** setTimeout fast path at appeal_deadline + 1 s (the keeper sweep is the durable backstop). */
  armFinalize(betId: string, atMs: number): void {
    if (this.o.timers === false) return;
    const prev = this.timers.get(betId);
    if (prev) clearTimeout(prev);
    const delay = Math.max(0, atMs - this.deps.now());
    const t = setTimeout(() => {
      this.timers.delete(betId);
      this.o.inflight.run('payout.finalize', () => this.finalize(betId));
    }, delay);
    t.unref?.();
    this.timers.set(betId, t);
  }

  /** Keeper: every RULED bet past appeal_deadline + 1 s. */
  async finalizeDue(nowMs: number): Promise<string[]> {
    const rt = await this.o.runtime();
    if (!rt) return [];
    const out: string[] = [];
    try {
      out.push(...(await this.reconcile(rt, nowMs)));
    } catch (err) {
      this.deps.log.warn('payout.reconcile_failed', { err });
    }
    try {
      await this.reconcileStranded(rt, nowMs);
    } catch (err) {
      this.deps.log.warn('payout.reconcile_stranded_failed', { err });
    }
    // Only RULED: an APPEALED bet is the appeal panel's (resolve_appeal pays it), and a RULED
    // one whose appeal is on its way waits for that tx's fate.
    const due = await this.deps.db
      .select({ id: bets.id })
      .from(bets)
      .where(
        and(
          eq(bets.state, 'RULED'),
          lte(bets.appeal_deadline, new Date(nowMs - FINALIZE_DELAY_MS)),
          sql`NOT ${appealInFlight}`,
        ),
      )
      .limit(25);
    for (const d of due) {
      const r = await this.finalize(d.id).catch((err: unknown) => {
        this.deps.log.warn('payout.finalize_failed', { bet_id: d.id, err });
        return 'failed' as const;
      });
      if (r === 'paid') out.push(d.id);
    }
    return out;
  }

  /** [ComputeBudget, (ATA creates), finalize, close_bet], fee payer only. Retries on AppealWindowOpen. */
  async finalize(betId: string): Promise<'paid' | 'not_due' | 'skipped' | 'failed' | 'pending'> {
    if (this.finalizing.has(betId)) return 'skipped';
    this.finalizing.add(betId);
    try {
      const rt = await this.rt();
      const bet = await this.bet(betId);
      if (bet.state !== 'RULED') return 'skipped'; // APPEALED: the panel's resolve_appeal pays
      // The appeal service re-arms finalize if the appeal never lands.
      if (await appealOut(this.deps.db, betId)) return 'skipped';
      const idBytes = betIdToBytes(betId);
      const [betPda] = await findBetPda({ betId: idBytes });
      const onchain = await this.fetchBet(rt, betPda);
      if (!onchain || onchain.status === BetStatus.Settled)
        // Paid out already (our bundled close_bet closes the PDA), e.g. a payout whose confirm
        // timed out and was reverted to RULED, then landed: settle from its chain_txs row.
        return (await this.recoverPayout(rt, betId)) ? 'paid' : 'skipped';
      if (onchain.status !== BetStatus.Resolved) return 'skipped';
      if ((await chainNow(rt.client)) < onchain.appealDeadline) {
        this.armFinalize(betId, this.deps.now() + 1_000);
        return 'not_due';
      }
      const fp = rt.keys.feePayer;
      const [vault] = await findVaultPda({ betId: idBytes });
      const aTok = await ataOf(onchain.partyA, onchain.mint);
      const bTok = await ataOf(onchain.partyB, onchain.mint);
      const ixs: Instruction[] = [
        ...(await this.ataCreates(
          rt,
          [
            [onchain.partyA, aTok],
            [onchain.partyB, bTok],
          ],
          onchain.mint,
        )),
        await getFinalizeInstructionAsync({
          payer: fp,
          bet: betPda,
          vault,
          mint: onchain.mint,
          partyAToken: aTok,
          partyBToken: bTok,
          tokenProgram: TOKEN_PROGRAM,
        }),
        await getCloseBetInstructionAsync({
          payer: fp,
          bet: betPda,
          vault,
          mint: onchain.mint,
          rentPayer: onchain.rentPayer,
          tokenProgram: TOKEN_PROGRAM,
        }),
      ];
      let built;
      try {
        built = await buildBlockhashTx(rt.client, fp.address, ixs, {
          signers: [fp],
          label: 'finalize+close_bet',
          cuPrice: rt.cuPrice,
        });
      } catch (err) {
        if (
          err instanceof SimulationError &&
          customErrorCode(err.err) === ESCROW_ERROR__APPEAL_WINDOW_OPEN
        ) {
          this.armFinalize(betId, this.deps.now() + 1_000);
          return 'not_due';
        }
        throw err;
      }
      return await this.submitPayout(
        rt,
        betId,
        'finalize',
        built.tx,
        built.lastValidBlockHeight,
        null,
      );
    } finally {
      this.finalizing.delete(betId);
    }
  }

  // ---- concede (GG) -----------------------------------------------------------------------

  /** GET /v1/bets/:id/concede: the loser's SignRequest (rebuilt when > 20 s old and unsigned). */
  async concedeRequest(betId: string, userId: string): Promise<SignRequest> {
    const rt = await this.rt();
    const bet = await this.bet(betId);
    const loser = this.loserOrThrow(bet, userId);
    await noAppealOutOrThrow(this.deps.db, betId);
    return this.buildConcede(rt, bet, loser);
  }

  private loserOrThrow(bet: BetRow, userId: string): Party {
    const party = partyOf(bet, userId);
    if (!party) throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
    if (bet.state !== 'RULED') {
      // Enum order, not string order: 'APPEALED' / 'PAID' sort before 'RULED' as strings.
      const after = BetState.options.indexOf(bet.state) > BetState.options.indexOf('RULED');
      throw new HttpError(after ? 'STATE_MOVED_ON' : 'INVALID_STATE', undefined, {
        state: bet.state,
      });
    }
    if (bet.outcome !== 'party_a' && bet.outcome !== 'party_b')
      throw new HttpError('CONCEDE_NOT_ALLOWED', 'There is no winner to pay.');
    const loser: Party = bet.outcome === 'party_a' ? 'B' : 'A';
    if (party !== loser) throw new HttpError('NOT_LOSER', 'Only the loser can tap GG.');
    return loser;
  }

  private async buildConcede(rt: ChainRuntime, bet: BetRow, loser: Party): Promise<SignRequest> {
    const now = this.deps.now();
    const envelope = (await loadEnvelope(this.deps.db, bet.id, { finalOnly: true }))?.envelope;
    if (!envelope) throw new HttpError('TERMS_NOT_FINAL');
    const prior = await this.latestTx(bet.id, 'concede');
    let row = prior;
    if (!row || row.status !== 'built' || now - row.built_at.getTime() > CONCEDE_REBUILD_MS) {
      const idBytes = betIdToBytes(bet.id);
      const [betPda] = await findBetPda({ betId: idBytes });
      const onchain = await this.fetchBet(rt, betPda);
      if (!onchain || onchain.status !== BetStatus.Resolved) throw new HttpError('STATE_MOVED_ON');
      const [vault] = await findVaultPda({ betId: idBytes });
      const loserKey = loser === 'A' ? onchain.partyA : onchain.partyB;
      const winnerKey = loser === 'A' ? onchain.partyB : onchain.partyA;
      const winnerTok = await ataOf(winnerKey, onchain.mint);
      const fp = rt.keys.feePayer;
      const ixs: Instruction[] = [
        ...(await this.ataCreates(rt, [[winnerKey, winnerTok]], onchain.mint)),
        await getConcedeInstructionAsync({
          payer: fp,
          party: createNoopSigner(loserKey),
          bet: betPda,
          vault,
          mint: onchain.mint,
          ...(loser === 'A' ? { partyBToken: winnerTok } : { partyAToken: winnerTok }),
          tokenProgram: TOKEN_PROGRAM,
        }),
        await getCloseBetInstructionAsync({
          payer: fp,
          bet: betPda,
          vault,
          mint: onchain.mint,
          rentPayer: onchain.rentPayer,
          tokenProgram: TOKEN_PROGRAM,
        }),
      ];
      const built = await buildBlockhashTx(rt.client, fp.address, ixs, {
        label: 'concede+close_bet',
      });
      row = await this.deps.db.transaction(async (tx) => {
        await expireInflight(tx, bet.id, 'concede');
        const [r] = await tx
          .insert(chainTxs)
          .values({
            bet_id: bet.id,
            kind: 'concede',
            bundled_close: true,
            signer_role: loser === 'A' ? 'party_a' : 'party_b',
            message_b64: messageB64(built.tx),
            message_sha256: sha256Hex(new Uint8Array(built.tx.messageBytes)),
            simulated_cu: Number(built.simulatedUnits),
            cu_limit: built.cuLimit,
            expected_status: 'settled',
            status: 'built',
            last_valid_block_height: built.lastValidBlockHeight,
            built_at: new Date(now),
          })
          .returning();
        return r!;
      });
    }
    return this.signRequestOf(rt, bet, row, loser, envelope);
  }

  private async signRequestOf(
    rt: ChainRuntime,
    bet: BetRow,
    row: typeof chainTxs.$inferSelect,
    loser: Party,
    envelope: TermsEnvelope,
  ): Promise<SignRequest> {
    const msg = new Uint8Array(Buffer.from(row.message_b64!, 'base64'));
    const compiled = getCompiledTransactionMessageDecoder().decode(msg) as unknown as {
      header: { numSignerAccounts: number };
      staticAccounts: Address[];
      lifetimeToken: string;
    };
    // The phone (device policy G2) refuses unless every card string equals its own
    // renderSignCard() over the same final Terms, loser and BetSnapshot.deadlines.appeal_deadline
    // (whole unix seconds), so the server renders it with that one shared function.
    const appealEndSecs = Math.floor(
      (bet.appeal_deadline?.getTime() ?? row.built_at.getTime() + SIGN_REQUEST_TTL_MS) / 1000,
    );
    const validUntil = Math.min(
      row.built_at.getTime() + SIGN_REQUEST_TTL_MS,
      appealEndSecs * 1000 + FINALIZE_DELAY_MS,
    );
    return {
      bet_id: bet.id,
      kind: 'concede',
      for_parties: [loser],
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
        kind: 'concede',
        terms: envelope.terms,
        terms_hash: envelope.terms_hash,
        me: loser,
        appeal_deadline: appealEndSecs,
      }),
      // T2: the phone compares this with the outcome of the ruling.issued it verified, so it is
      // the offchain RulingOutcome (A_WINS / B_WINS), not the onchain enum name.
      ruling_ref: {
        ruling_hash: bet.ruling_hash!,
        outcome: bet.outcome === 'party_a' ? 'A_WINS' : 'B_WINS',
      },
      issued_at: iso(this.deps.now()),
    };
  }

  /**
   * POST /v1/bets/:id/concede. Phones: the loser's PartySignature over the stored bytes.
   * LOCK_SIGNER=server (custodial): `body` may carry no signature; the server signs as the
   * loser's demo key (which must equal the bet's wallet snapshot).
   */
  async concede(
    betId: string,
    userId: string,
    body: Partial<PartySignature> & { party?: Party },
  ): Promise<{ status: 'submitted'; signature: string }> {
    const rt = await this.rt();
    const bet = await this.bet(betId);
    const loser = this.loserOrThrow(bet, userId);
    if (body.party && body.party !== loser) throw new HttpError('NOT_LOSER');
    await noAppealOutOrThrow(this.deps.db, betId);
    const wallet = loser === 'A' ? bet.party_a_wallet! : bet.party_b_wallet!;

    let signature = body.party_signature;
    let messageSha = body.message_sha256;
    if (!signature) {
      if (this.o.signer !== 'server') throw new HttpError('SIGNATURE_INVALID');
      const kp: KeyPairSigner | null = loser === 'A' ? rt.keys.demoA : rt.keys.demoB;
      if (!kp || kp.address !== wallet)
        throw new HttpError('SIGNATURE_INVALID', 'No custodial key for that party.');
      const req = await this.buildConcede(rt, bet, loser);
      const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
      signature = sigString(await signBytes(kp.keyPair.privateKey, msg));
      messageSha = req.message_sha256;
    }

    const now = this.deps.now();
    const prepared = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b || b.state !== 'RULED')
        throw new HttpError('STATE_MOVED_ON', undefined, { state: b?.state });
      await noAppealOutOrThrow(tx, betId); // the appeal's filing checks RULED under this lock
      const [row] = await tx
        .select()
        .from(chainTxs)
        .where(
          and(
            eq(chainTxs.bet_id, betId),
            eq(chainTxs.kind, 'concede'),
            eq(chainTxs.status, 'built'),
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
      if (!verifyEd25519(wallet, msg, sig)) throw new HttpError('SIGNATURE_INVALID');
      const full = await cosignTx(txFromStored(row.message_b64!, new Map([[wallet, sig]])), [
        rt.keys.feePayer,
      ]);
      const txSig = sigString(full.signatures[rt.keys.feePayer.address]!);
      await tx
        .update(chainTxs)
        .set({
          ...(loser === 'A'
            ? { a_signature: signature!, a_signed_at: new Date(now) }
            : { b_signature: signature!, b_signed_at: new Date(now) }),
          first_signer: loser,
          signature: txSig,
          status: 'signed',
        })
        .where(eq(chainTxs.id, row.id));
      return { full, rowId: row.id, lvbh: row.last_valid_block_height };
    });
    await this.submitPayout(
      rt,
      betId,
      'concede',
      prepared.full,
      prepared.lvbh,
      prepared.rowId,
      true,
    );
    return {
      status: 'submitted',
      signature: sigString(prepared.full.signatures[rt.keys.feePayer.address]!),
    };
  }

  // ---- shared submit + settle -------------------------------------------------------------

  /**
   * state -> CONCEDED / FINALIZED (pending_tx), send once with preflight, then (async for concede)
   * confirm -> PAID / VOIDED. A preflight rejection, an onchain failure or a blockhash expiry
   * returns the bet to RULED; a confirm timeout (blockhash still valid) leaves it CONCEDED /
   * FINALIZED with the row 'sent' for reconcile().
   */
  private async submitPayout(
    rt: ChainRuntime,
    betId: string,
    kind: 'finalize' | 'concede',
    full: Transaction,
    lastValidBlockHeight: bigint | null,
    existingRowId: string | null,
    background = false,
  ): Promise<'paid' | 'failed' | 'pending'> {
    const signature = sigString(full.signatures[rt.keys.feePayer.address]!);
    const now = this.deps.now();
    const target: BetState = kind === 'concede' ? 'CONCEDED' : 'FINALIZED';
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b || b.state !== 'RULED')
        throw new HttpError('STATE_MOVED_ON', undefined, { state: b?.state });
      // An appeal filed since concede() signed (it raced in between the two transactions).
      if (kind === 'concede') await noAppealOutOrThrow(tx, betId);
      let rowId = existingRowId;
      if (rowId) {
        await tx
          .update(chainTxs)
          .set({ status: 'sent', sent_at: new Date(now) })
          .where(eq(chainTxs.id, rowId));
      } else {
        await expireInflight(tx, betId, kind);
        const [r] = await tx
          .insert(chainTxs)
          .values({
            bet_id: betId,
            kind,
            bundled_close: true,
            signer_role: 'fee_payer',
            message_b64: messageB64(full),
            message_sha256: sha256Hex(new Uint8Array(full.messageBytes)),
            signature,
            expected_status: 'settled',
            status: 'sent',
            last_valid_block_height: lastValidBlockHeight,
            sent_at: new Date(now),
          })
          .returning({ id: chainTxs.id });
        rowId = r!.id;
      }
      // Compare-and-set (checked RULED above, under the row lock): never over a settled bet.
      const row = await casBetState(tx, betId, ['RULED'], { state: target });
      if (!row) throw new HttpError('STATE_MOVED_ON', undefined, { state: b.state });
      const pending = {
        kind,
        signature,
        submitted_at: iso(now),
        rpc_processed_at: null,
        rpc_confirmed_at: null,
      };
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(row, b.state, null, pending),
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'tx.submitted',
          payload: { kind, signature },
          now,
        }),
        // The GG moment: bet.gg in the same commit as CONCEDED (src/gg/service.ts).
        ...(kind === 'concede' && this.o.onConcedeSubmitted
          ? await this.o.onConcedeSubmitted(tx, row, now)
          : []),
      ];
      return { b, envs, rowId: rowId! };
    });
    fanout(this.deps, out.b, out.envs);

    try {
      await rt.client.send(wireOf(full), false);
    } catch (err) {
      if (err instanceof PreflightError) {
        await this.revertPayout(betId, out.rowId, kind, 'failed', err);
        if (kind === 'concede')
          throw new HttpError('STATE_MOVED_ON', "Couldn't pay out. Try again.");
        return 'failed';
      }
      this.deps.log.warn('payout.send_retry', { bet_id: betId, err });
    }
    const confirm = async (): Promise<'paid' | 'failed' | 'pending'> => {
      this.confirming.add(out.rowId);
      try {
        const landed = await confirmSent(rt.client, full, {
          ...this.o.send,
          lastValidBlockHeight,
          onProcessed: (at) =>
            this.o.inflight.run('payout.processed', () =>
              this.markProcessed(betId, out.rowId, kind, signature, now, at),
            ),
        });
        await this.settle(betId, out.rowId, kind, signature, now, landed);
        return 'paid';
      } catch (err) {
        if (err instanceof TxFailedError && err.kind === 'timeout') {
          // Not seen yet but the blockhash is still valid: it may land. Leave the bet
          // CONCEDED / FINALIZED and the row 'sent'; reconcile() settles or reverts it.
          this.deps.log.warn('payout.confirm_pending', { bet_id: betId, kind, signature });
          return 'pending';
        }
        if (err instanceof TxFailedError) {
          // 'onchain' (it failed) or 'expired' (block height past lastValidBlockHeight).
          await this.revertPayout(
            betId,
            out.rowId,
            kind,
            err.kind === 'expired' ? 'expired' : 'failed',
            err,
          );
          if (kind === 'finalize') this.armFinalize(betId, this.deps.now() + 1_000);
          return 'failed';
        }
        throw err;
      } finally {
        this.confirming.delete(out.rowId);
      }
    };
    if (background) {
      this.o.inflight.run('payout.confirm', confirm);
      return 'paid';
    }
    return confirm();
  }

  /** The payout tx did not land (and never will): row failed / expired, bet back to RULED. */
  private async revertPayout(
    betId: string,
    rowId: string,
    kind: 'finalize' | 'concede',
    status: 'failed' | 'expired',
    err: unknown,
  ) {
    const target: BetState = kind === 'concede' ? 'CONCEDED' : 'FINALIZED';
    const out = await this.deps.db.transaction(async (tx) => {
      await tx
        .update(chainTxs)
        .set({ status, err: String((err as Error)?.message ?? err).slice(0, 200) })
        .where(eq(chainTxs.id, rowId));
      const b = await lockBet(tx, betId);
      if (b?.state !== target) return null;
      const row = await casBetState(tx, betId, [target], { state: 'RULED' });
      if (!row) return null;
      const e = await appendBetEvent(tx, {
        bet_id: betId,
        type: 'bet.state',
        payload: statePayload(row, target, `${kind}_failed`),
        now: this.deps.now(),
      });
      return { b, e };
    });
    if (out) fanout(this.deps, out.b, [out.e]);
  }

  /**
   * Keeper (runs first in finalizeDue): settles every 'sent' resolve / concede / finalize row
   * whose in-process confirm loop is gone (a timeout, a restart). searchTransactionHistory, so an
   * older landed tx is still found. Landed -> RULED / PAID; failed or past lastValidBlockHeight ->
   * failed / expired (a payout goes back to RULED, unless its close_bet already closed the PDA).
   */
  async reconcile(rt: ChainRuntime, nowMs: number): Promise<string[]> {
    const rows = await this.deps.db
      .select()
      .from(chainTxs)
      .where(
        and(
          inArray(chainTxs.kind, ['resolve', 'concede', 'finalize']),
          eq(chainTxs.status, 'sent'),
        ),
      )
      .orderBy(chainTxs.sent_at)
      .limit(25);
    const paid: string[] = [];
    const height = heightOnce(rt.client);
    for (const row of rows) {
      if (this.confirming.has(row.id) || !row.signature) continue;
      const kind = row.kind as 'resolve' | 'concede' | 'finalize';
      // Known dead needs a second empty status read after the past-height read (txFate): a tx
      // that landed in the last valid block would otherwise be reverted and paid out again
      // (the program refuses the second payout, but the DB would flap).
      const { fate, status: st } = await txFate(
        rt.client,
        row.signature,
        row.last_valid_block_height,
        { sentAtMs: row.sent_at?.getTime() ?? 0, nowMs, height },
      );
      const landed = fate === 'landed';
      const dead: 'failed' | 'expired' | null =
        fate === 'failed' ? 'failed' : fate === 'dead' ? 'expired' : null;
      if (!landed && !dead) continue; // still in flight
      const onchain = await readBetAccount(rt, row.bet_id);
      if (kind === 'resolve') {
        // Only judge_authority can resolve: a Resolved Bet is our ruling (this row or an earlier one).
        if (onchain?.status === BetStatus.Resolved)
          await this.adoptResolved(rt, row.bet_id, onchain, row);
        await this.deps.db
          .update(chainTxs)
          .set(
            landed
              ? { status: 'confirmed', rpc_confirmed_at: new Date(nowMs) }
              : { status: dead!, err: st?.err ? JSON.stringify(st.err).slice(0, 200) : 'expired' },
          )
          .where(and(eq(chainTxs.id, row.id), eq(chainTxs.status, 'sent')));
        continue;
      }
      if (landed) {
        await this.settle(
          row.bet_id,
          row.id,
          kind,
          row.signature,
          row.sent_at?.getTime() ?? nowMs,
          {
            signature: row.signature,
            processedAt: row.rpc_processed_at?.getTime() ?? nowMs,
            confirmedAt: nowMs,
            slot: st?.slot ?? null,
          },
        );
        paid.push(row.bet_id);
        continue;
      }
      await this.revertPayout(
        row.bet_id,
        row.id,
        kind,
        dead!,
        st?.err ? JSON.stringify(st.err) : 'expired unconfirmed',
      );
      // concede / finalize bundle close_bet: a closed PDA means some payout of this bet landed.
      if (!onchain && (await this.recoverPayout(rt, row.bet_id))) paid.push(row.bet_id);
    }
    return paid;
  }

  /**
   * CONCEDED / FINALIZED with no payout row in flight (a crash between two writes, a row retired
   * by hand): nothing would ever move the bet again. The chain decides: the PDA closed -> settle
   * from the payout row that landed (PAID / VOIDED); still Resolved -> back to RULED, so
   * finalize-due (or the loser's GG) pays it out.
   */
  async reconcileStranded(rt: ChainRuntime, nowMs: number): Promise<string[]> {
    const rows = await this.deps.db
      .select({ id: bets.id, state: bets.state, at: bets.updated_at })
      .from(bets)
      .where(
        and(
          inArray(bets.state, ['CONCEDED', 'FINALIZED']),
          lte(bets.updated_at, new Date(nowMs - STRANDED_GRACE_MS)),
          sql`NOT EXISTS (SELECT 1 FROM ${chainTxs} t WHERE t.bet_id = ${bets.id}
                AND t.kind IN ('concede','finalize') AND t.status IN ('built','signed','sent'))`,
        ),
      )
      .limit(10);
    const fixed: string[] = [];
    for (const b of rows) {
      const onchain = await readBetAccount(rt, b.id);
      if (!onchain) {
        if (await this.recoverPayout(rt, b.id)) fixed.push(b.id);
        continue;
      }
      if (onchain.status !== BetStatus.Resolved) continue;
      const out = await this.deps.db.transaction(async (tx) => {
        const cur = await lockBet(tx, b.id);
        if (!cur || (cur.state !== 'CONCEDED' && cur.state !== 'FINALIZED')) return null;
        const row = await casBetState(tx, b.id, ['CONCEDED', 'FINALIZED'], { state: 'RULED' });
        if (!row) return null;
        const e = await appendBetEvent(tx, {
          bet_id: b.id,
          type: 'bet.state',
          payload: statePayload(row, cur.state, 'payout_lost'),
          now: this.deps.now(),
        });
        return { cur, e };
      });
      if (!out) continue;
      fanout(this.deps, out.cur, [out.e]);
      this.deps.log.warn('payout.stranded_reverted', { bet_id: b.id, from: out.cur.state });
      if (onchain.appealDeadline) this.armFinalize(b.id, Number(onchain.appealDeadline) * 1000);
      fixed.push(b.id);
    }
    return fixed;
  }

  /** RULED but the PDA is closed: find the payout row that landed and settle from it. */
  private async recoverPayout(rt: ChainRuntime, betId: string): Promise<boolean> {
    const rows = await this.deps.db
      .select()
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.bet_id, betId),
          inArray(chainTxs.kind, ['concede', 'finalize']),
          inArray(chainTxs.status, ['sent', 'failed', 'expired', 'confirmed']),
        ),
      )
      .orderBy(desc(chainTxs.sent_at))
      .limit(5);
    for (const row of rows) {
      if (!row.signature) continue;
      const st = await rt.client.signatureStatus(row.signature, { searchHistory: true });
      if (!st || st.err || st.confirmationStatus === 'processed') continue;
      this.deps.log.warn('payout.recovered', {
        bet_id: betId,
        kind: row.kind,
        signature: row.signature,
      });
      await this.settle(
        betId,
        row.id,
        row.kind as 'concede' | 'finalize',
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
    this.deps.log.warn('payout.pda_closed_unexplained', { bet_id: betId });
    return false;
  }

  /** Processed: the winner's phone plays the payout animation on this bet.state frame. */
  private async markProcessed(
    betId: string,
    rowId: string,
    kind: 'finalize' | 'concede',
    signature: string,
    sentAt: number,
    at: number,
  ) {
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      await tx
        .update(chainTxs)
        .set({ rpc_processed_at: new Date(at) })
        .where(eq(chainTxs.id, rowId));
      if (!b || (b.state !== 'CONCEDED' && b.state !== 'FINALIZED')) return null;
      const e = await appendBetEvent(tx, {
        bet_id: betId,
        type: 'bet.state',
        payload: statePayload(b, b.state, 'processed', {
          kind,
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

  private async settle(
    betId: string,
    rowId: string,
    kind: 'finalize' | 'concede',
    signature: string,
    sentAt: number,
    landed: Landed,
  ) {
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b) return null;
      // Stamped once the row lock is held: a `now` from before the wait would date these events
      // earlier than ones another path committed (with lower seqs) while this one waited.
      const now = this.deps.now();
      await tx
        .update(chainTxs)
        .set({
          status: 'confirmed',
          rpc_processed_at: new Date(landed.processedAt),
          rpc_confirmed_at: new Date(landed.confirmedAt),
        })
        .where(eq(chainTxs.id, rowId));
      // RULED too: a payout found landed after it was reverted (recoverPayout).
      if (b.state !== 'CONCEDED' && b.state !== 'FINALIZED' && b.state !== 'RULED')
        return { b, envs: [] as BetEventEnvelope[] };
      const outcome = FROM_PG[(b.outcome ?? 'refund') as keyof typeof FROM_PG];
      const stakeA = b.stake_a ?? 0n;
      const amounts = payout(outcome, stakeA, stakeA + (b.stake_b ?? 0n));
      const voided = outcome === 'Refund';
      const row = await casBetState(tx, betId, ['CONCEDED', 'FINALIZED', 'RULED'], {
        state: voided ? 'VOIDED' : 'PAID',
        payout_via: kind,
      });
      if (!row) return { b, envs: [] as BetEventEnvelope[] };
      const names = await this.names(b, tx);
      const cue = payoutCue(outcome, amounts, names, await this.o.cueContext?.(tx, b, kind));
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(row, b.state, kind, {
            kind,
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
          payload: { kind, signature, slot: Number(landed.slot ?? 0n) },
          now,
        }),
        await appendBetEvent(tx, { bet_id: betId, type: 'judge.cue', payload: cue, now }),
      ];
      return { b, envs };
    });
    if (out) fanout(this.deps, out.b, out.envs);
    this.deps.log.info('payout.settled', { bet_id: betId, kind, signature });
  }

  // ---- helpers ----------------------------------------------------------------------------

  private async bet(betId: string): Promise<BetRow> {
    const [b] = await this.deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
    if (!b) throw new HttpError('NOT_FOUND', 'No such bet.');
    return b;
  }

  private async latestTx(betId: string, kind: 'resolve' | 'concede' | 'finalize') {
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

  private async ataCreates(
    rt: ChainRuntime,
    pairs: ReadonlyArray<readonly [Address, Address]>,
    mint: Address,
  ) {
    const ixs: Instruction[] = [];
    for (const [owner, tok] of pairs) {
      if (await rt.client.getAccount(tok)) continue;
      ixs.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: rt.keys.feePayer,
          owner,
          mint,
          tokenProgram: TOKEN_PROGRAM,
        }),
      );
    }
    return ixs;
  }

  private async names(
    bet: Pick<BetRow, 'party_a_id' | 'party_b_id'>,
    db: Pick<Tx, 'select'> = this.deps.db,
  ) {
    const rows = await db
      .select({ id: users.id, name: users.display_name })
      .from(users)
      .where(inArray(users.id, [bet.party_a_id, bet.party_b_id]));
    const by = new Map(rows.map((r) => [r.id, r.name]));
    return { A: by.get(bet.party_a_id) ?? 'A', B: by.get(bet.party_b_id) ?? 'B' } as Record<
      Party,
      string
    >;
  }
}

/**
 * How a decisive payout came about (the GG moment): the loser's GG (`gg`, with the pair's record
 * after this bet), or the clock (`timeout`, with how a spoken review ended, if one was asked).
 * resolve_appeal passes none: its wording is unchanged.
 */
export interface PayoutCueContext {
  via: PayoutVia;
  record?: PairRecord | null;
  review?: 'declined' | 'lapsed' | null;
}

/**
 * judge.cue PAID / VOIDED for a payout of `outcome` (concede, finalize, resolve_appeal):
 * `[EVENT] PAID winner=Jake amount=$10 … :: Congratulate Jake in one line.` With `ctx` (concede /
 * finalize of a decisive ruling) the line says how: `… via=gg loser=Logan record="Logan 4-6 Jake"
 * :: Logan said GG. Praise the sportsmanship in one short line, then congratulate Jake.`, or
 * `… via=timeout loser=Logan :: No GG from Logan; the clock ran out. …`. Without `ctx` the line
 * is byte-identical to the original one.
 */
export function payoutCue(
  outcome: OnchainOutcome,
  amounts: { to_a: bigint; to_b: bigint },
  names: Record<Party, string>,
  ctx?: PayoutCueContext,
) {
  if (outcome === 'Refund')
    return judgeCue(
      'VOIDED',
      { a: formatUsd(amounts.to_a.toString()), b: formatUsd(amounts.to_b.toString()) },
      "Say it's void: both got their stake back.",
    );
  const winner: Party | null = outcome === 'PartyA' ? 'A' : outcome === 'PartyB' ? 'B' : null;
  const kv: Record<string, string> = {
    winner: winner ? names[winner] : 'split',
    amount: formatUsd(
      (winner === 'A' ? amounts.to_a : winner === 'B' ? amounts.to_b : amounts.to_a).toString(),
    ),
    to_a: formatUsd(amounts.to_a.toString()),
    to_b: formatUsd(amounts.to_b.toString()),
  };
  if (!winner) return judgeCue('PAID', kv, 'Say it is a split.');
  const w = names[winner];
  if (!ctx || ctx.via === 'appeal') return judgeCue('PAID', kv, `Congratulate ${w} in one line.`);
  const l = names[winner === 'A' ? 'B' : 'A'];
  kv.via = ctx.via;
  kv.loser = l;
  if (ctx.via === 'gg') {
    if (ctx.record) kv.record = recordLine(ctx.record, names);
    return judgeCue(
      'PAID',
      kv,
      `${l} said GG. Praise the sportsmanship in one short line, then congratulate ${w}.`,
    );
  }
  if (ctx.review) kv.review = ctx.review;
  const why =
    ctx.review === 'declined'
      ? `${l} kept the ruling.`
      : ctx.review === 'lapsed'
        ? `${l} did not confirm the review, so the ruling stands.`
        : `No GG from ${l}; the clock ran out.`;
  return judgeCue('PAID', kv, `${why} Congratulate ${w} in one line.`);
}

/**
 * A RULED bet whose loser's `appeal` is signed / out (src/appeal): finalize waits for its fate
 * (it lands -> APPEALED; it never does -> the appeal service re-arms finalize).
 */
const appealInFlight = sql`EXISTS (SELECT 1 FROM ${chainTxs} t WHERE t.bet_id = ${bets.id}
  AND t.kind = 'appeal' AND t.status IN ('signed','sent'))`;

/** Is the loser's `appeal` signed / out (src/appeal)? finalize waits for its fate; GG is refused. */
async function appealOut(db: Pick<Tx, 'select'>, betId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chainTxs.id })
    .from(chainTxs)
    .where(
      and(
        eq(chainTxs.bet_id, betId),
        eq(chainTxs.kind, 'appeal'),
        inArray(chainTxs.status, ['signed', 'sent']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * GG once the appeal is out: refused. The bet stays RULED until the appeal confirms, and a GG
 * then would show CONCEDED (the winner's payout screen, the projector) for a concede the chain
 * refuses, or, landing first, leave the filed appeal stranded.
 */
async function noAppealOutOrThrow(db: Pick<Tx, 'select'>, betId: string): Promise<void> {
  if (await appealOut(db, betId))
    throw new HttpError('STATE_MOVED_ON', 'An appeal is on its way.', {
      reason: 'appeal_in_flight',
    });
}

/** One in-flight tx per (bet, kind) (chain_txs_inflight_uq): retire a stale one before a new build. */
async function expireInflight(tx: Tx, betId: string, kind: 'resolve' | 'concede' | 'finalize') {
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
