// RefundService: the permissionless exits the server sends itself, so escrowed money can never sit
// past its onchain deadline (ESCROW I12, TM-L1 / TM-L2; DATA-MODEL §3.5 BetRefunded).
//
//   sweep(now)         keeper 'timeout-refund' (DB-first). Bets Locked onchain past
//                      resolve_deadline (judge never ruled: a crash, a lost ruling, a dead LLM) or
//                      Appealed past appeal_resolve_deadline get [ATA creates, timeout_refund,
//                      close_bet] from the fee payer. Each side gets its own stake back; the bet
//                      -> EXPIRED (end_reason resolve_timeout / appeal_timeout, payout_via
//                      'timeout_refund'), with bet.state + tx.confirmed + judge.cue EXPIRED pushed.
//                      'sent' refund rows whose in-process confirm is gone are settled first.
//   sweepOrphans(now)  keeper 'orphan-escrow' (chain-first). Every Bet our fee payer created whose
//                      bets row is gone (POST /v1/demo/reset deletes rows) or terminal, gets its
//                      exit once due (timeout_refund / finalize), an Open one is cancelled at once
//                      by the judge key (cancel_open_bet refunds A), and a terminal one left
//                      unclosed gets close_bet. Bets owned by a live row are left to the DB paths.
//   voidForReset(...)  POST /v1/demo/reset: a Locked rehearsal bet gets resolve(Refund) by the judge
//                      key, so the orphan sweep can finalize it (both stakes back) right after the
//                      10 s appeal window instead of an hour later at resolve_deadline.
//
// Retry safety ("never build a new tx while the old one may land"): a bet with any 'sent'
// resolve / concede / finalize / timeout_refund row is skipped until that row is settled; a 'sent'
// refund row is rebuilt only once it is known dead (failed onchain, or the chain is past its
// lastValidBlockHeight and the signature is still unseen). Orphan exits keep the same rule in
// memory per Bet PDA. The program itself makes every exit exclusive (I10 half-open windows,
// InvalidStatus), so a race can cost a fee, never money.
//
// Not reachable today: an Open Bet tracked by a live row (the atomic lock never leaves one; the
// sequential fallback is not implemented). The orphan path covers any Open Bet anyway.
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { getBase58Decoder, type Address, type Transaction } from '@solana/kit';
import { auditLog, bets, chainTxs } from '@youre-on/db';
import { isTerminalBetState, type BetState } from '@youre-on/shared/bet-state';
import { exitActionFor, exitDeadline, refundEndReason } from '@youre-on/shared/chain/exits';
import {
  BetStatus,
  ESCROW_ERROR__DEADLINE_NOT_REACHED,
  ESCROW_ERROR__INVALID_STATUS,
  findBetPda,
  getResolveInstructionAsync,
  Outcome,
  type Bet,
} from '@youre-on/shared/escrow-client';
import { hashJcs } from '@youre-on/shared/jcs';
import { formatUsd } from '@youre-on/shared/money';
import { betIdToBytes } from '@youre-on/shared/primitives';
import { judgeCue } from '../bets/cues';
import type { BetRow } from '../bets/snapshot';
import { sha256Hex } from '../crypto';
import {
  listOurBets,
  planExit,
  type ExitPlan,
  type LiveBet,
  type ServerExit,
} from '../chain/exits';
import {
  buildBlockhashTx,
  chainNow,
  confirmSent,
  customErrorCode,
  messageB64,
  PreflightError,
  SimulationError,
  TxFailedError,
  wireOf,
  type ChainRuntime,
  type Landed,
  type SendOptions,
} from '../chain/tx';
import {
  fanout,
  iso,
  lockBet,
  readBetAccount,
  statePayload,
  type Inflight,
  type LifecycleDeps,
} from '../lock/common';
import { appendBetEvent } from '../realtime/events';

/** Keeper cadence of the DB-first refund sweep. */
export const REFUND_SWEEP_MS = 15_000;
/** Keeper cadence of the chain-first orphan sweep (one getProgramAccounts per run). */
export const ORPHAN_SWEEP_MS = 60_000;
/** At most this many refunds per sweep (one tx each). */
export const REFUND_BATCH = 10;
/** A bet whose Bet PDA is unreadable / unexpected is re-read at most this often. */
export const REFUND_ANOMALY_BACKOFF_MS = 5 * 60_000;

/** Offchain states whose Bet is Locked onchain (no resolve has landed). */
export const LOCKED_FAMILY: readonly BetState[] = [
  'LOCKED',
  'ATTEMPT',
  'JUDGING',
  'HEARING',
  'AWAITING_MARKET',
];
/** Offchain states whose Bet may be Appealed onchain. */
export const APPEAL_FAMILY: readonly BetState[] = ['RULED', 'APPEALED', 'APPEAL_RESOLVED'];
/** Any of these 'sent' means a tx of the bet may still land: no refund is built meanwhile. */
const BLOCKING_KINDS = ['resolve', 'concede', 'finalize', 'timeout_refund'] as const;

const b58 = getBase58Decoder();
/** The tx id (the fee payer's signature) of a built tx. */
const sigOf = (built: { tx: Transaction }, fp: Address) => b58.decode(built.tx.signatures[fp]!);

export interface RefundServiceOptions {
  deps: LifecycleDeps;
  runtime: () => Promise<ChainRuntime | null>;
  inflight: Inflight;
  send?: SendOptions;
}

export interface RefundSweepResult {
  refunded: string[];
  /** Sent but not confirmed yet (reconciled on a later pass). */
  pending: string[];
  /** Candidates whose deadline has not passed on the chain clock yet. */
  notDue: string[];
}

export interface OrphanSummary {
  at: string;
  /** Live Bets our fee payer created (null: the client cannot list program accounts). */
  live: number | null;
  /** Live Bets with no live bets row: the ones this sweep is responsible for. */
  orphans: Array<{
    bet_id: string;
    status: string;
    action: ServerExit | null;
    /** unix seconds when its exit becomes due (null: due now / no timed exit). */
    due_at: number | null;
    vault_hint: string;
  }>;
  sent: Array<{ bet_id: string; action: ServerExit; signature: string }>;
  errors: string[];
}

export class RefundService {
  private readonly confirming = new Set<string>();
  private readonly anomalies = new Map<string, number>();
  private readonly orphanTx = new Map<string, { signature: string; lvbh: bigint | null }>();
  /** The last orphan scan, for GET /v1/demo/health. */
  lastOrphanScan: OrphanSummary | null = null;

  constructor(private readonly o: RefundServiceOptions) {}

  private get deps() {
    return this.o.deps;
  }

  // ---- DB-first: timeout_refund of bets we track ----------------------------------------------

  async sweep(nowMs: number): Promise<RefundSweepResult> {
    const out: RefundSweepResult = { refunded: [], pending: [], notDue: [] };
    const rt = await this.o.runtime();
    if (!rt) return out;
    try {
      out.refunded.push(...(await this.reconcile(rt, nowMs)));
    } catch (err) {
      this.deps.log.warn('refund.reconcile_failed', { err });
    }
    const due = new Date(nowMs);
    const rows = await this.deps.db
      .select({ id: bets.id })
      .from(bets)
      .where(
        or(
          and(
            inArray(bets.state, [...LOCKED_FAMILY]),
            or(isNull(bets.resolve_deadline), lte(bets.resolve_deadline, due)),
          ),
          and(
            inArray(bets.state, [...APPEAL_FAMILY]),
            isNotNull(bets.appeal_resolve_deadline),
            lte(bets.appeal_resolve_deadline, due),
          ),
        ),
      )
      .orderBy(sql`${bets.resolve_deadline} ASC NULLS FIRST`)
      .limit(REFUND_BATCH * 3);
    let clock: bigint | null = null;
    let sent = 0;
    for (const { id } of rows) {
      if (sent >= REFUND_BATCH) break;
      const backoffUntil = this.anomalies.get(id);
      if (backoffUntil !== undefined && nowMs < backoffUntil) continue;
      try {
        clock ??= await chainNow(rt.client);
        const r = await this.refundOne(rt, id, clock, nowMs);
        if (r === 'refunded') out.refunded.push(id);
        if (r === 'pending') out.pending.push(id);
        if (r === 'not_due') out.notDue.push(id);
        if (r === 'refunded' || r === 'pending') sent++;
      } catch (err) {
        this.deps.log.warn('refund.failed', { bet_id: id, err });
      }
    }
    return out;
  }

  /** One candidate: re-read the chain, backfill the deadlines, refund when due. */
  async refundOne(
    rt: ChainRuntime,
    betId: string,
    clock: bigint,
    nowMs: number,
  ): Promise<'refunded' | 'pending' | 'not_due' | 'skipped' | 'failed'> {
    if (await this.blocked(betId)) return 'skipped';
    const onchain = await readBetAccount(rt, betId);
    if (
      !onchain ||
      (onchain.status !== BetStatus.Locked && onchain.status !== BetStatus.Appealed)
    ) {
      // Closed, Resolved (a resolve the DB has not caught up with), terminal: not ours to refund.
      this.anomalies.set(betId, nowMs + REFUND_ANOMALY_BACKOFF_MS);
      this.deps.log.warn('refund.unexpected_onchain', {
        bet_id: betId,
        onchain: onchain ? BetStatus[onchain.status] : 'missing',
      });
      return 'skipped';
    }
    this.anomalies.delete(betId);
    await this.backfillDeadlines(betId, onchain);
    if (exitActionFor(onchain, clock) !== 'timeout_refund') return 'not_due';

    const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
    const plan = await planExit(rt, pda, onchain, 'timeout_refund');
    const fp = rt.keys.feePayer;
    let built;
    try {
      built = await buildBlockhashTx(rt.client, fp.address, plan.ixs, {
        signers: [fp],
        label: 'timeout_refund+close_bet',
      });
    } catch (err) {
      if (err instanceof SimulationError) {
        const code = customErrorCode(err.err);
        // The chain clock can trail ours (devnet): try again next pass.
        if (code === ESCROW_ERROR__DEADLINE_NOT_REACHED) return 'not_due';
        if (code === ESCROW_ERROR__INVALID_STATUS) return 'skipped'; // a resolve won the race
      }
      throw err;
    }
    const signature = sigOf(built, fp.address);
    const now = this.deps.now();
    const rowId = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b || !refundableState(b)) return null;
      const [busy] = await tx
        .select({ id: chainTxs.id })
        .from(chainTxs)
        .where(
          and(
            eq(chainTxs.bet_id, betId),
            inArray(chainTxs.kind, [...BLOCKING_KINDS]),
            eq(chainTxs.status, 'sent'),
          ),
        )
        .limit(1);
      if (busy) return null;
      const [row] = await tx
        .insert(chainTxs)
        .values({
          bet_id: betId,
          kind: 'timeout_refund',
          bundled_close: true,
          signer_role: 'fee_payer',
          message_b64: messageB64(built.tx),
          message_sha256: sha256Hex(new Uint8Array(built.tx.messageBytes)),
          signature,
          simulated_cu: Number(built.simulatedUnits),
          cu_limit: built.cuLimit,
          expected_status: 'refunded',
          status: 'sent',
          last_valid_block_height: built.lastValidBlockHeight,
          sent_at: new Date(now),
        })
        .returning({ id: chainTxs.id });
      const env = await appendBetEvent(tx, {
        bet_id: betId,
        type: 'tx.submitted',
        payload: { kind: 'timeout_refund', signature },
        now,
      });
      return { id: row!.id, b, env };
    });
    if (!rowId) return 'skipped';
    fanout(this.deps, rowId.b, [rowId.env]);
    this.deps.log.warn('refund.sending', {
      bet_id: betId,
      from: BetStatus[onchain.status],
      signature,
      to_a: plan.payout?.to_a,
      to_b: plan.payout?.to_b,
    });
    return this.submit(rt, betId, rowId.id, built.tx, built.lastValidBlockHeight, plan, now);
  }

  private async submit(
    rt: ChainRuntime,
    betId: string,
    rowId: string,
    full: Transaction,
    lvbh: bigint | null,
    plan: ExitPlan,
    sentAt: number,
  ): Promise<'refunded' | 'pending' | 'failed'> {
    this.confirming.add(rowId);
    try {
      try {
        await rt.client.send(wireOf(full), false);
      } catch (err) {
        if (err instanceof PreflightError) {
          await this.markRow(rowId, 'failed', err.message);
          return 'failed';
        }
        this.deps.log.warn('refund.send_retry', { bet_id: betId, err }); // confirm re-broadcasts
      }
      const landed = await confirmSent(rt.client, full, {
        ...this.o.send,
        lastValidBlockHeight: lvbh,
      });
      await this.settle(betId, rowId, plan.bet.status, plan.payout, landed, sentAt);
      return 'refunded';
    } catch (err) {
      if (err instanceof TxFailedError && err.kind === 'timeout') return 'pending';
      if (err instanceof TxFailedError) {
        await this.markRow(rowId, err.kind === 'expired' ? 'expired' : 'failed', err.message);
        return 'failed';
      }
      throw err;
    } finally {
      this.confirming.delete(rowId);
    }
  }

  /** 'sent' refund rows whose confirm loop is gone (a timeout, a restart). */
  async reconcile(rt: ChainRuntime, nowMs: number): Promise<string[]> {
    const rows = await this.deps.db
      .select()
      .from(chainTxs)
      .where(and(eq(chainTxs.kind, 'timeout_refund'), eq(chainTxs.status, 'sent')))
      .orderBy(chainTxs.sent_at)
      .limit(25);
    const done: string[] = [];
    let height: bigint | null = null;
    for (const row of rows) {
      if (this.confirming.has(row.id) || !row.signature) continue;
      const st = await rt.client.signatureStatus(row.signature, { searchHistory: true });
      if (st?.err) {
        await this.markRow(row.id, 'failed', JSON.stringify(st.err));
        continue;
      }
      if (st && st.confirmationStatus !== 'processed') {
        const b = await this.betRow(row.bet_id);
        // From the DB alone: each side's own stake (ESCROW §6 refund; a donation would add to B).
        const from = b && APPEAL_FAMILY.includes(b.state) ? BetStatus.Appealed : BetStatus.Locked;
        const payout = b ? { to_a: b.stake_a ?? 0n, to_b: b.stake_b ?? 0n } : null;
        await this.settle(
          row.bet_id,
          row.id,
          from,
          payout,
          {
            signature: row.signature,
            processedAt: row.rpc_processed_at?.getTime() ?? nowMs,
            confirmedAt: nowMs,
            slot: st.slot,
          },
          row.sent_at?.getTime() ?? nowMs,
        );
        done.push(row.bet_id);
        continue;
      }
      if (!st) {
        height ??= await rt.client.blockHeight();
        const lvbh = row.last_valid_block_height;
        const old = row.sent_at ? nowMs - row.sent_at.getTime() > 10 * 60_000 : true;
        const past = lvbh != null ? height > lvbh : old;
        // Known dead only if a second read (after the height) still has no status.
        if (
          past &&
          (await rt.client.signatureStatus(row.signature, { searchHistory: true })) === null
        )
          await this.markRow(row.id, 'expired', 'expired unconfirmed');
      }
    }
    return done;
  }

  private async settle(
    betId: string,
    rowId: string,
    from: BetStatus,
    payout: { to_a: bigint; to_b: bigint } | null,
    landed: Landed,
    sentAt: number,
  ) {
    const now = this.deps.now();
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      await tx
        .update(chainTxs)
        .set({
          status: 'confirmed',
          rpc_processed_at: new Date(landed.processedAt),
          rpc_confirmed_at: new Date(landed.confirmedAt),
        })
        .where(eq(chainTxs.id, rowId));
      if (!b || isTerminalBetState(b.state)) return null;
      const endReason = refundEndReason(from) ?? 'resolve_timeout';
      const [row] = await tx
        .update(bets)
        .set({
          state: 'EXPIRED',
          end_reason: endReason,
          outcome: 'refund',
          payout_via: 'timeout_refund',
          ...(payout ? { payout_a: payout.to_a, payout_b: payout.to_b } : {}),
          payout_sig: landed.signature,
          close_sig: landed.signature,
          settled_at: new Date(landed.confirmedAt),
          closed_at: new Date(landed.confirmedAt),
        })
        .where(eq(bets.id, betId))
        .returning();
      const kv: Record<string, string> = { reason: endReason };
      if (payout) {
        kv.a = formatUsd(payout.to_a.toString());
        kv.b = formatUsd(payout.to_b.toString());
      }
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(row!, b.state, endReason, {
            kind: 'timeout_refund',
            signature: landed.signature,
            submitted_at: iso(sentAt),
            rpc_processed_at: iso(landed.processedAt),
            rpc_confirmed_at: iso(landed.confirmedAt),
          }),
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'tx.confirmed',
          payload: {
            kind: 'timeout_refund',
            signature: landed.signature,
            slot: Number(landed.slot ?? 0n),
          },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: judgeCue(
            'EXPIRED',
            kv,
            endReason === 'appeal_timeout'
              ? 'Say the appeal ran out of time, so both got their own stake back.'
              : 'Say the judging ran out of time, so both got their own stake back. Nothing was lost.',
          ),
          now,
        }),
      ];
      return { b, envs };
    });
    if (out) fanout(this.deps, out.b, out.envs);
    this.deps.log.warn('refund.settled', { bet_id: betId, signature: landed.signature });
  }

  private async markRow(rowId: string, status: 'failed' | 'expired', err: string) {
    await this.deps.db
      .update(chainTxs)
      .set({ status, err: err.slice(0, 200) })
      .where(and(eq(chainTxs.id, rowId), eq(chainTxs.status, 'sent')));
  }

  /** Writes resolve_deadline / appeal_resolve_deadline from the Bet when the DB lacks them. */
  private async backfillDeadlines(betId: string, onchain: Bet) {
    const set =
      onchain.status === BetStatus.Locked
        ? { resolve_deadline: new Date(Number(onchain.resolveDeadline) * 1000) }
        : {
            appeal_resolve_deadline: new Date(Number(onchain.appealResolveDeadline) * 1000),
            appealed_at: new Date(Number(onchain.appealedAt) * 1000),
          };
    const col =
      onchain.status === BetStatus.Locked ? bets.resolve_deadline : bets.appeal_resolve_deadline;
    const want = Object.values(set)[0]!;
    await this.deps.db
      .update(bets)
      .set(set)
      .where(
        and(eq(bets.id, betId), or(isNull(col), sql`${col} <> ${want.toISOString()}::timestamptz`)),
      );
  }

  private async blocked(betId: string): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ id: chainTxs.id })
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.bet_id, betId),
          inArray(chainTxs.kind, [...BLOCKING_KINDS]),
          eq(chainTxs.status, 'sent'),
        ),
      )
      .limit(1);
    return !!row;
  }

  private async betRow(betId: string): Promise<BetRow | null> {
    const [b] = await this.deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
    return b ?? null;
  }

  // ---- chain-first: Bets no live row owns ---------------------------------------------------

  /** Keeper 'orphan-escrow': exits for our Bets that no live bets row owns (see the header). */
  async sweepOrphans(nowMs: number): Promise<OrphanSummary> {
    const summary: OrphanSummary = {
      at: iso(nowMs),
      live: null,
      orphans: [],
      sent: [],
      errors: [],
    };
    const rt = await this.o.runtime();
    if (!rt) return summary;
    const live = await listOurBets(rt);
    if (!live) {
      this.lastOrphanScan = summary;
      return summary;
    }
    summary.live = live.length;
    const rows = live.length
      ? await this.deps.db
          .select({ id: bets.id, state: bets.state })
          .from(bets)
          .where(
            inArray(
              bets.id,
              live.map((l) => l.betId),
            ),
          )
      : [];
    const stateOf = new Map(rows.map((r) => [r.id, r.state]));
    const clock = live.length ? await chainNow(rt.client) : 0n;
    for (const l of live) {
      const st = stateOf.get(l.betId);
      const terminalOnchain =
        l.bet.status === BetStatus.Settled ||
        l.bet.status === BetStatus.Refunded ||
        l.bet.status === BetStatus.Cancelled;
      // A live row owns it (DB-first paths), unless only the close is left (always safe).
      if (st !== undefined && !isTerminalBetState(st) && !terminalOnchain) continue;
      const action = this.orphanAction(rt, l.bet, clock);
      const deadline = exitDeadline(l.bet);
      summary.orphans.push({
        bet_id: l.betId,
        status: BetStatus[l.bet.status],
        action,
        due_at: action || deadline === null ? null : Number(deadline),
        vault_hint: formatUsd((l.bet.stakeA + l.bet.stakeB).toString()),
      });
      if (!action) continue;
      try {
        const sig = await this.sendOrphanExit(rt, l, action);
        if (sig) summary.sent.push({ bet_id: l.betId, action, signature: sig });
      } catch (err) {
        summary.errors.push(`${l.betId}: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
        this.deps.log.warn('refund.orphan_failed', { bet_id: l.betId, action, err });
      }
    }
    if (summary.orphans.length)
      this.deps.log.warn('refund.orphans', {
        live: summary.live,
        orphans: summary.orphans.length,
        sent: summary.sent.length,
      });
    this.lastOrphanScan = summary;
    return summary;
  }

  private orphanAction(rt: ChainRuntime, bet: Bet, clock: bigint): ServerExit | null {
    const due = exitActionFor(bet, clock);
    if (due) return due;
    // An Open Bet need not wait for accept_deadline: our judge key may cancel it (refund to A).
    if (bet.status === BetStatus.Open && rt.keys.judge?.address === bet.judgeAuthority)
      return 'cancel_open_bet';
    return null;
  }

  /** Sends one orphan exit (fee payer) and waits for it; null when one is still in flight. */
  async sendOrphanExit(rt: ChainRuntime, l: LiveBet, action: ServerExit): Promise<string | null> {
    const prev = this.orphanTx.get(l.address);
    if (prev) {
      const st = await rt.client.signatureStatus(prev.signature, { searchHistory: true });
      if (st && !st.err && st.confirmationStatus !== 'processed') {
        // It landed: the next scan sees the Bet closed (or the next status).
        this.orphanTx.delete(l.address);
        return null;
      }
      if (!st?.err) {
        const height = await rt.client.blockHeight();
        if (prev.lvbh === null || height <= prev.lvbh) return null; // may still land
        if ((await rt.client.signatureStatus(prev.signature, { searchHistory: true })) !== null)
          return null;
      }
      this.orphanTx.delete(l.address); // known dead: rebuilding is safe
    }
    const plan = await planExit(rt, l.address, l.bet, action);
    const fp = rt.keys.feePayer;
    const built = await buildBlockhashTx(rt.client, fp.address, plan.ixs, {
      signers: [fp, ...plan.signers],
      label: `${action}${action === 'close_bet' ? '' : '+close_bet'} (orphan)`,
    });
    const signature = sigOf(built, fp.address);
    this.orphanTx.set(l.address, { signature, lvbh: built.lastValidBlockHeight });
    await this.deps.db.insert(auditLog).values({
      actor_kind: 'server',
      action: 'chain.orphan_exit',
      bet_id: l.betId,
      details: {
        bet_pda: l.address,
        exit: action,
        signature,
        status: BetStatus[l.bet.status],
        to_a: plan.payout?.to_a.toString() ?? null,
        to_b: plan.payout?.to_b.toString() ?? null,
      },
    });
    await rt.client.send(wireOf(built.tx), false).catch((err: unknown) => {
      if (err instanceof PreflightError) {
        this.orphanTx.delete(l.address);
        throw err;
      }
      this.deps.log.warn('refund.orphan_send_retry', { bet_id: l.betId, err });
    });
    await confirmSent(rt.client, built.tx, {
      ...this.o.send,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });
    this.orphanTx.delete(l.address);
    this.deps.log.warn('refund.orphan_exit', { bet_id: l.betId, exit: action, signature });
    return signature;
  }

  // ---- demo reset ---------------------------------------------------------------------------

  /**
   * POST /v1/demo/reset, per non-seed bet with a live Bet: make sure its money comes back.
   * Locked before resolve_deadline -> resolve(Refund) signed by the judge key (the orphan sweep
   * finalizes it after the appeal window: each side gets its own stake); anything already due ->
   * that exit now; Open -> cancel_open_bet. Returns what it did (null: nothing to do yet, e.g.
   * Resolved or Appealed inside its window: the orphan sweep finishes it).
   */
  async voidForReset(
    rt: ChainRuntime,
    l: LiveBet,
    nowMs: number,
  ): Promise<{
    action: ServerExit | 'resolve_refund';
    signature: string;
    finalize_at: number | null;
  } | null> {
    const clock = await chainNow(rt.client);
    const exit = this.orphanAction(rt, l.bet, clock);
    if (exit) {
      const signature = await this.sendOrphanExit(rt, l, exit);
      return signature ? { action: exit, signature, finalize_at: null } : null;
    }
    if (l.bet.status !== BetStatus.Locked) return null;
    const judge = rt.keys.judge;
    if (!judge || judge.address !== l.bet.judgeAuthority) return null;
    const record = { kind: 'demo_reset', bet_id: l.betId, at: iso(nowMs) };
    const ix = await getResolveInstructionAsync({
      payer: rt.keys.feePayer,
      judgeAuthority: judge,
      bet: l.address,
      outcome: Outcome.Refund,
      evidenceHash: Uint8Array.from(Buffer.from(sha256Hex('yo-demo-reset-v1'), 'hex')),
      rulingHash: Uint8Array.from(Buffer.from(hashJcs(record), 'hex')),
    });
    const fp = rt.keys.feePayer;
    const built = await buildBlockhashTx(rt.client, fp.address, [ix], {
      signers: [fp, judge],
      label: 'resolve(Refund) (demo reset)',
    });
    const signature = sigOf(built, fp.address);
    await this.deps.db.insert(auditLog).values({
      actor_kind: 'system',
      action: 'demo.reset_void',
      bet_id: l.betId,
      details: { bet_pda: l.address, signature, ruling: record },
    });
    await rt.client.send(wireOf(built.tx), false).catch((err: unknown) => {
      if (err instanceof PreflightError) throw err;
      this.deps.log.warn('refund.reset_send_retry', { bet_id: l.betId, err });
    });
    await confirmSent(rt.client, built.tx, {
      ...this.o.send,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });
    const after = await readBetAccount(rt, l.betId);
    return {
      action: 'resolve_refund',
      signature,
      finalize_at: after ? Number(after.appealDeadline) : null,
    };
  }
}

function refundableState(b: BetRow): boolean {
  return LOCKED_FAMILY.includes(b.state) || APPEAL_FAMILY.includes(b.state);
}
