/**
 * World Mode bets (§11.4) and their resolution oracle (§12.6 steps 1, 3, 4
 * for markets, plus 5/7/8 so a market bet never depends on another module's
 * mirror):
 *   POST /world/bets: compileMarket → create_bet (proposer signs, oracle
 *     co-signs; acceptance_audio_hash = 0, flags = market) → {bet, sign}
 *   counterparty `fund` = acceptance (D-32) — the bets module's fund route
 *   Funded       → start (oracle, beacon_slot 0, no witnesses)
 *   Live         → end (oracle, heads []) once every event resolved
 *   Perceiving   → post_tracks(program_bin ‖ ∅ ‖ market_bin) chunks → run_rules
 *   PreRuled     → consent (oracle) after consent_deadline + 5 s
 *   timeouts     → refund (§9.4 #15)
 */
import { randomBytes } from 'node:crypto';
import {
  BET_FLAG_MARKET,
  BET_STATE,
  LIVE_GRACE_S,
  LangError,
  PANEL_TIMEOUT_S,
  PERCEPTION_TIMEOUT_S,
  POST_TRACKS_CHUNK,
  START_WINDOW_S,
  ZERO_HASH_HEX,
  buildPayload,
  compileMarket,
  encodeMarketBin,
  encodeProgram,
  marketHash,
  marketTitle,
  programHash,
  readback,
  toYaml,
  type BetAccount,
  type MarketBinEntry,
  type MarketResultCode,
} from '@verdict/engine';
import type { AppContext } from '../context.js';
import { consentIx, createBetIx, endIx, postTracksIx, refundIx, runRulesIx, startIx, type IxEnv } from '../chain/ixs.js';
import { createAtaIdempotentIx, setComputeUnitLimitIx } from '../chain/programs.js';
import type { ChainIx, SendResult } from '../chain/types.js';
import { ApiError } from '../errors.js';
import { WORLD_BETS_COLLECTION, betSources, userById } from '../integration/sources.js';
import { COLLECTIONS, type UserRecord } from '../persistence/records.js';
import type { Collection } from '../persistence/store.js';
import type { WorldEvent } from '../providers/types.js';
import type { SignPayload } from '../tx/service.js';
import { PriceRelay } from './prices.js';
import { quotePicks, type QuoteRecord } from './quotes.js';
import { marketBetView, type SettlementInfo, type WorldBetRecord } from './view.js';

export const CREATE_TX_KIND = 'world.create_bet';
/** Keeper task of the bet-lifecycle service (drives market bets when present). */
export const LIFECYCLE_KEEPER_TASK = 'bet-lifecycle';
/** §12.6 step 5: oracle consent this long after the deadline. */
export const CONSENT_GRACE_S = 5;
const RUN_RULES_CU = 1_400_000;

function money(units: number): string {
  const cents = Math.floor(units / 10_000);
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export class WorldService {
  readonly bets: Collection<WorldBetRecord>;
  readonly quotes: Collection<QuoteRecord>;
  readonly prices: PriceRelay;
  /** settlement lookups for BetView (filled from the receipt event log when present) */
  settlementOf: (bet: string) => SettlementInfo | null = () => null;
  boothStatusOf: (bet: string) => string | null = () => null;

  constructor(private readonly ctx: AppContext) {
    this.bets = ctx.store.collection<WorldBetRecord>(WORLD_BETS_COLLECTION);
    this.quotes = ctx.store.collection<QuoteRecord>(COLLECTIONS.quotes);
    this.prices = new PriceRelay(ctx);
  }

  register(): void {
    this.ctx.txs.onConfirmed(CREATE_TX_KIND, (tx) => {
      const bet = tx.meta['bet'];
      if (typeof bet === 'string' && this.bets.has(bet)) {
        this.bets.update(bet, (r) => ({ ...r, created: true, updated_at_ms: this.ctx.clock.nowMs() }));
        for (const p of this.bets.get(bet)!.picks) this.prices.want(p.event_id, true);
      }
    });
    // A BetCreated seen on chain (e.g. via QuickNode) also marks it created.
    this.ctx.events.on('BetCreated', (ev) => {
      const bet = ev.data['bet'];
      if (typeof bet === 'string' && this.bets.get(bet)?.created === false) {
        this.bets.update(bet, (r) => ({ ...r, created: true, updated_at_ms: this.ctx.clock.nowMs() }));
      }
    });
    this.ctx.keeper.register({ name: 'world', run: () => this.tick() });
    this.ctx.hub.setSnapshotProvider('world', async (eventId) => {
      this.prices.want(eventId);
      const latest = this.prices.latest(eventId);
      if (latest.length > 0) return latest.map((p) => ({ type: 'world.price' as const, ...p }));
      const ev = await this.ctx.providers.gemini.getEvent(eventId);
      if (!ev) throw new ApiError('NOT_FOUND');
      const at = this.ctx.clock.nowMs();
      return ev.contracts.map((c) => ({ type: 'world.price' as const, event_id: ev.id, contract_id: c.id, prob_bps: c.prob_bps, at_ms: at }));
    });
  }

  env(): IxEnv {
    const ch = this.ctx.chain;
    return { programId: ch.programId, mint: ch.mint, feePayer: ch.feePayer, oracle: ch.oracle };
  }

  // ---- POST /world/bets ------------------------------------------------------------

  async createBet(user: UserRecord, quoteId: string, counterpartyUserId: string): Promise<{ bet: unknown; sign: SignPayload }> {
    const q = this.quotes.get(quoteId);
    if (!q || q.user_id !== user.id) throw new ApiError('NOT_FOUND', 'quote');
    const now = this.ctx.clock.nowMs();
    if (now > q.expires_at_ms || q.used_by_bet) throw new ApiError('QUOTE_EXPIRED');
    const counter = userById(this.ctx, counterpartyUserId);
    if (!counter || counter.id === user.id) throw new ApiError('NOT_FOUND', 'counterparty');
    if (!betSources(this.ctx).arePeers(user.id, counter.id)) {
      throw new ApiError('WRONG_STATE', 'the counterparty must be a confirmed member of a recent huddle with the proposer');
    }
    // Events must still be open at bet time (prices are those of the quote).
    for (const l of q.legs) {
      const ev = await this.ctx.providers.gemini.getEvent(l.event_id);
      if (!ev || ev.status !== 'open' || ev.close_time_ms <= now) throw new ApiError('QUOTE_EXPIRED', `event ${l.event_id} is no longer open`);
    }

    let program;
    try {
      program = compileMarket({ picks: quotePicks(q), total_units: q.total_units }, user.wallet, counter.wallet, now);
    } catch (e) {
      if (e instanceof LangError) {
        const bad = e.errors.some((x) => x.code === 'BAD_STAKE');
        throw new ApiError(bad ? 'BAD_STAKE' : 'DRAFT_INVALID', e.message);
      }
      throw e;
    }
    const ph = programHash(program);
    const labels: Record<string, string> = {};
    const markets: Record<string, string> = {};
    for (const l of q.legs) markets[marketHash(l.event_id, l.contract_id)] = `${l.event_title}: ${l.contract_label}`;
    const rb = readback(program, { names: { [user.wallet]: user.display_name, [counter.wallet]: counter.display_name }, markets });

    const nonce = new DataView(new Uint8Array(randomBytes(8)).buffer).getBigUint64(0, true) & 0x7fff_ffff_ffff_ffffn;
    const env = this.env();
    const ix = createBetIx(env, user.wallet, {
      nonce,
      participants: [user.wallet, counter.wallet],
      stakes: program.stakes!.map((s) => BigInt(s)),
      side_b_mask: 0b10,
      stake_each: 0n,
      time_limit_s: program.time_limit_s,
      flags: BET_FLAG_MARKET,
      program_hash: ph,
      acceptance_audio_hash: ZERO_HASH_HEX,
      judges: this.ctx.config.keys.judges.map((k) => k.publicKey) as [string, string, string],
    });
    const betId = ix.accounts.bet!;
    const { sign } = await this.ctx.txs.request({
      user,
      kind: CREATE_TX_KIND,
      ixs: [ix],
      summary: `Stake ${money(program.stakes![0]!)}`,
      meta: { bet: betId, quote_id: q.quote_id },
    });
    const rec: WorldBetRecord = {
      bet: betId,
      quote_id: q.quote_id,
      kind: 'market',
      title: marketTitle({ picks: quotePicks(q), total_units: q.total_units }),
      program,
      yaml: toYaml(program),
      readback: rb,
      labels,
      program_hash: ph,
      nonce: nonce.toString(),
      creator_user_id: user.id,
      participants: [
        { user_id: user.id, display_name: user.display_name, wallet: user.wallet, side: 0 },
        { user_id: counter.id, display_name: counter.display_name, wallet: counter.wallet, side: 1 },
      ],
      picks: quotePicks(q),
      create_tx_id: sign.tx_id,
      created: false,
      done: false,
      created_at_ms: now,
      updated_at_ms: now,
      last_error: null,
    };
    this.bets.set(betId, rec);
    this.quotes.update(q.quote_id, (x) => ({ ...x, used_by_bet: betId }));
    return { bet: await this.view(betId, user.id), sign };
  }

  async view(betId: string, userId: string): Promise<unknown> {
    const fromBets = await betSources(this.ctx).betView(betId, userId);
    if (fromBets) return fromBets;
    const r = this.bets.get(betId);
    if (!r) throw new ApiError('NOT_FOUND');
    const bet = await this.ctx.chain.getBet(betId);
    return marketBetView(r, bet, userId, this.boothStatusOf(betId), this.settlementOf(betId));
  }

  // ---- POST /world/bets/:id/hedge (§11.6) ----------------------------------------------

  async hedge(user: UserRecord, betId: string, body: Record<string, unknown>): Promise<{ order_id: string; status: string }> {
    const r = this.bets.get(betId);
    if (!r) throw new ApiError('NOT_FOUND');
    if (!r.participants.some((p) => p.user_id === user.id)) throw new ApiError('WRONG_STATE', 'only participants may hedge');
    const contract = body['contract_id'];
    const side = body['side'];
    const amount = body['amount_units'];
    if (typeof contract !== 'string' || !r.picks.some((p) => p.contract_id === contract)) throw new ApiError('NOT_FOUND', 'contract');
    if (side !== 'yes' && side !== 'no') throw new ApiError('WRONG_STATE', 'side must be "yes" or "no"', 400);
    if (!Number.isSafeInteger(amount) || (amount as number) <= 0) throw new ApiError('BAD_STAKE');
    return this.ctx.providers.hedge.placeOrder({ bet: betId, contract_id: contract, side, amount_units: amount as number });
  }

  // ---- keeper: resolution oracle ---------------------------------------------------------

  /**
   * The bet-lifecycle keeper (lifecycle/service.ts) already drives market bets
   * (start, end on resolution, market_bin, run_rules, consent, refund) from
   * `world_bets`; when it is registered this keeper only tracks state and
   * price relays, so oracle transactions are never sent twice.
   */
  oracleDelegated(): boolean {
    return this.ctx.keeper.taskNames.includes(LIFECYCLE_KEEPER_TASK);
  }

  async tick(): Promise<void> {
    const pinned = new Set<string>();
    const delegated = this.oracleDelegated();
    for (const r of this.bets.values()) {
      if (r.done) continue;
      try {
        const open = delegated ? await this.track(r) : await this.step(r);
        if (open) for (const p of r.picks) pinned.add(p.event_id);
      } catch (e) {
        this.ctx.log.error({ err: e, bet: r.bet }, 'world keeper step failed');
        this.bets.update(r.bet, (x) => ({ ...x, last_error: (e as Error).message ?? String(e) }));
      }
    }
    this.prices.gc(pinned);
  }

  private async send(betId: string, what: string, ixs: ChainIx[]): Promise<SendResult> {
    const r = await this.ctx.chain.sendAsBackend(ixs);
    if (r.status === 'failed') {
      this.ctx.log.warn({ bet: betId, what, error: r.error }, 'world oracle tx failed');
      this.bets.update(betId, (x) => ({ ...x, last_error: `${what}: ${r.error}`, updated_at_ms: this.ctx.clock.nowMs() }));
    }
    return r;
  }

  private async ensureAtas(participants: string[]): Promise<void> {
    const env = this.env();
    await this.ctx.chain.sendAsBackend(participants.map((p) => createAtaIdempotentIx(env.feePayer, p, env.mint)));
  }

  /** Market results for every pick, or null while any event is unresolved. */
  async results(r: WorldBetRecord): Promise<MarketBinEntry[] | null> {
    const cache = new Map<string, WorldEvent | null>();
    const out: MarketBinEntry[] = [];
    for (const p of r.picks) {
      if (!cache.has(p.event_id)) cache.set(p.event_id, await this.ctx.providers.gemini.getEvent(p.event_id));
      const ev = cache.get(p.event_id);
      if (!ev || ev.status !== 'resolved') return null;
      const res = ev.resolution?.find((x) => x.contract_id === p.contract_id)?.result ?? 'void';
      const code: MarketResultCode = res === 'yes' ? 1 : res === 'no' ? 0 : 2;
      out.push({ market_hash: marketHash(p.event_id, p.contract_id), result: code });
    }
    return out;
  }

  /** State tracking only (delegated mode); returns true while the bet is still open. */
  async track(r: WorldBetRecord): Promise<boolean> {
    const bet = await this.ctx.chain.getBet(r.bet);
    if (!bet) return !r.created && this.ctx.clock.nowMs() < r.created_at_ms + 3_600_000;
    const done = bet.state === BET_STATE.Settled || bet.state === BET_STATE.Refunded;
    if (done || !r.created) this.bets.update(r.bet, (x) => ({ ...x, created: true, done, updated_at_ms: this.ctx.clock.nowMs() }));
    return bet.state <= BET_STATE.Live;
  }

  /** One keeper step for one bet; returns true while the bet is still open (prices pinned). */
  async step(r: WorldBetRecord): Promise<boolean> {
    const bet = await this.ctx.chain.getBet(r.bet);
    if (!bet) return !r.created && this.ctx.clock.nowMs() < r.created_at_ms + 3_600_000;
    if (!r.created) this.bets.update(r.bet, (x) => ({ ...x, created: true }));
    const env = this.env();
    const now = await this.ctx.chain.nowSeconds();
    const participants = bet.participants.slice(0, bet.n_participants);

    if (bet.state === BET_STATE.Settled || bet.state === BET_STATE.Refunded) {
      this.bets.update(r.bet, (x) => ({ ...x, done: true, updated_at_ms: this.ctx.clock.nowMs() }));
      return false;
    }
    if (refundDue(bet, now)) {
      await this.ensureAtas(participants);
      await this.send(r.bet, 'refund', [refundIx(env, r.bet, participants)]);
      return false;
    }
    switch (bet.state) {
      case BET_STATE.Funded:
        await this.send(r.bet, 'start', [startIx(env, r.bet, env.oracle, { beacon_slot: 0n, witnesses: [] })]);
        return true;
      case BET_STATE.Live: {
        if (!(await this.results(r))) return true;
        await this.send(r.bet, 'end', [endIx(env, r.bet, env.oracle, { seq: 0, heads: [] })]);
        return false;
      }
      case BET_STATE.Perceiving:
        await this.postAndRun(r, bet);
        return false;
      case BET_STATE.PreRuled:
        if (now > bet.consent_deadline + BigInt(CONSENT_GRACE_S)) {
          await this.ensureAtas(participants);
          await this.send(r.bet, 'consent', [
            consentIx(env, r.bet, env.oracle, participants, { winner_mask: bet.winner_mask, evidence_root: bet.evidence_root }),
          ]);
        }
        return false;
      default:
        return bet.state <= BET_STATE.Live;
    }
  }

  /** post_tracks (resuming from `written`) then run_rules. */
  private async postAndRun(r: WorldBetRecord, bet: BetAccount): Promise<void> {
    const env = this.env();
    if (bet.tracks_finalized === 0) {
      const entries = await this.results(r);
      if (!entries) return;
      const programBin = encodeProgram(r.program);
      const payload = buildPayload(programBin, new Uint8Array(0), encodeMarketBin(entries));
      const tb = await this.ctx.chain.getTrackBuffer(r.bet);
      let offset = tb ? tb.header.written : 0;
      while (offset < payload.length) {
        const data = payload.subarray(offset, offset + POST_TRACKS_CHUNK);
        const finalize = offset + data.length === payload.length;
        const res = await this.send(r.bet, 'post_tracks', [
          postTracksIx(env, r.bet, {
            payload_len: payload.length,
            program_len: programBin.length,
            calibration_len: 0,
            offset,
            data,
            finalize,
            perception_root: ZERO_HASH_HEX,
          }),
        ]);
        if (res.status !== 'confirmed') return;
        offset += data.length;
      }
    }
    await this.send(r.bet, 'run_rules', [setComputeUnitLimitIx(RUN_RULES_CU), runRulesIx(env, r.bet)]);
  }
}

/** §9.4 #15 refund conditions (chain time, seconds). */
export function refundDue(b: BetAccount, now: bigint): boolean {
  switch (b.state) {
    case BET_STATE.Proposed:
      return now > b.fund_deadline;
    case BET_STATE.Funded:
      return now > b.funded_at + BigInt(START_WINDOW_S);
    case BET_STATE.Live:
      return now > b.started_at + BigInt(b.time_limit_s) + BigInt(LIVE_GRACE_S);
    case BET_STATE.Perceiving:
      return now > b.ended_at + BigInt(PERCEPTION_TIMEOUT_S);
    case BET_STATE.Disputed:
      return now > b.disputed_at + BigInt(PANEL_TIMEOUT_S);
    case BET_STATE.PreRuled:
      return now > b.consent_deadline + BigInt(PANEL_TIMEOUT_S);
    default:
      return false;
  }
}
