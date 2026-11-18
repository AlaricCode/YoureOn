// Beat 6 settlement: a locked Gemini bet waits for Gemini to settle its BTC 5-minute contract,
// then a deterministic settlement Ruling goes to deps.onRuling (resolve -> RULED -> finalize), as
// an attempt ruling does (SCHEMAS §4, §5.2, §8.3, §9.2; API-CONTRACT §7.3; ARCHITECTURE "Gemini").
//
//   enterAwaitingMarket()  inside LockService.onLanded's transaction: LOCKED -> AWAITING_MARKET,
//                          bet.state + judge.cue MARKET_WAITING (speak=false). The phones and
//                          the stage never see a gemini bet sit in LOCKED.
//   SettlementService
//     arm()        fast path: a timer at expiry + 5 s (Gemini settles p50 5.7 s, max 8.8 s after
//                  expiry), then every 2 s for 2 minutes.
//     check()      GET /v1/prediction-markets/events/{eventTicker} for THIS bet's contract (never
//                  the relay's current one: the relay has rolled over by then), classify it:
//                    pending  -> nothing (retry later; Gemini 5xx / timeouts count as pending)
//                    settled  -> GeminiSettlementRecord (response_sha256 = sha256 of the exact
//                                body) -> settlement Ruling (yes -> MET, no -> NOT_MET, mapped
//                                through yes_party)
//                    voided / settled on another line -> VOID market_invalid (refund)
//                  One transaction: the settlement `rulings` row (evidence_canonical = the record,
//                  rulings_settlement_uq keeps it one per bet), the gemini_markets settlement
//                  columns (the raw body byte for byte), market.settled + ruling.issued +
//                  judge.cue MARKET_SETTLED / VOIDED, an audit row. After COMMIT: fan-out, then
//                  deps.onRuling(bet_id, ruling).
//     sweep()      keeper task 'market-settlement' (the durable backstop): LOCKED gemini bets ->
//                  AWAITING_MARKET; AWAITING_MARKET bets past expiry are checked (each at most
//                  every 10 s), and a settlement ruling that never reached RULED (an RPC failure,
//                  a restart) is handed to deps.onRuling again after 15 s (it is idempotent).
//                  A contract Gemini never settles keeps the bet waiting: the program's
//                  timeout_refund (anyone, after resolve_deadline = lock + 3600 s) is the backstop.
//     onSnapshot() the relay's 2 s snapshots -> market.tick (persisted, <= 1 Hz per bet) for each
//                  AWAITING_MARKET bet on that contract, until its expiry: the phones' and the
//                  stage's live price.
//
// Every step is idempotent and safe across two machines (row lock + state re-check + the unique
// settlement ruling).
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { auditLog, bets, geminiMarkets, rulings, users } from '@youre-on/db';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import { expiryLabel } from '@youre-on/shared/judge/market-terms';
import { sha256Hex } from '@youre-on/shared/primitives';
import { Ruling } from '@youre-on/shared/ruling';
import {
  classifyContract,
  formatPrice,
  settlementRecord,
  settlementRuling,
} from '@youre-on/shared/settlement';
import type { Terms } from '@youre-on/shared/terms';
import type { AppDeps } from '../context';
import { asciiFold, judgeCue } from '../bets/cues';
import type { BetRow } from '../bets/snapshot';
import type { KeeperTask } from '../keeper/keeper';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { fanout, iso, lockBet, statePayload, type Tx } from '../lock/common';
import { loadEnvelope } from '../lock/terms';
import { cleanDecimal, isoOrNull, toStrike } from './gemini';

/** First settlement check after expiry (spike 05: settled p50 5.66 s, max 8.78 s). */
export const SETTLE_FIRST_CHECK_MS = 5_000;
/** Fast-path poll interval (API-CONTRACT §7.3 "poll that endpoint every 2 s from expiry"). */
export const SETTLE_POLL_MS = 2_000;
/** The fast path stops after this past expiry; the keeper sweep carries on. */
export const SETTLE_FAST_WINDOW_MS = 120_000;
/** The sweep checks one bet at most this often. */
export const SETTLE_SWEEP_EVERY_MS = 10_000;
/** A settlement ruling still not RULED after this is handed to onRuling again. */
export const SETTLE_RESOLVE_GRACE_MS = 15_000;
/** market.tick at most this often per bet (API-CONTRACT §3.4: 1 Hz). */
export const MARKET_TICK_MIN_MS = 1_000;
/** At most this many bets per sweep. */
export const SETTLE_BATCH = 10;
/** The GG window the cue announces when APPEAL_WINDOW_S is unset (= Config.appeal_window_secs). */
const DEFAULT_GG_SECS = 10;

export type SettlementDeps = Pick<AppDeps, 'db' | 'hub' | 'log' | 'now' | 'env'> &
  Partial<Pick<AppDeps, 'markets' | 'onRuling'>>;

export type CheckResult = 'settled' | 'pending' | 'skipped';

async function partyNames(db: Pick<Tx, 'select'>, bet: Pick<BetRow, 'party_a_id' | 'party_b_id'>) {
  const rows = await db
    .select({ id: users.id, name: users.display_name })
    .from(users)
    .where(inArray(users.id, [bet.party_a_id, bet.party_b_id]));
  const by = new Map(rows.map((r) => [r.id, r.name]));
  return { A: by.get(bet.party_a_id) ?? 'A', B: by.get(bet.party_b_id) ?? 'B' };
}

/**
 * LOCKED -> AWAITING_MARKET for a gemini bet, inside the caller's transaction (after the LOCKED
 * write). Returns the events to fan out after COMMIT; [] when the bet is not LOCKED.
 */
export async function enterAwaitingMarket(
  tx: Tx,
  betId: string,
  terms: Terms,
  now: number,
): Promise<BetEventEnvelope[]> {
  const [cur] = await tx.select().from(bets).where(eq(bets.id, betId)).limit(1);
  if (!cur || cur.state !== 'LOCKED' || !terms.market) return [];
  const [row] = await tx
    .update(bets)
    .set({ state: 'AWAITING_MARKET' })
    .where(and(eq(bets.id, betId), eq(bets.state, 'LOCKED')))
    .returning();
  if (!row) return [];
  const m = terms.market;
  return [
    await appendBetEvent(tx, {
      bet_id: betId,
      type: 'bet.state',
      payload: statePayload(row, 'LOCKED', null),
      now,
    }),
    await appendBetEvent(tx, {
      bet_id: betId,
      type: 'judge.cue',
      payload: judgeCue(
        'MARKET_WAITING',
        { expiry: expiryLabel(m.expiry), line: m.strike.value ?? '-', odds: m.priceAtLock },
        'Do not speak; the clock is running until Gemini settles.',
        false,
      ),
      now,
    }),
  ];
}

interface Watched {
  eventTicker: string;
  expiryMs: number;
  lastTickAt: number;
}

export interface SettlementOptions {
  /** Arm the setTimeout fast path (default true). Tests drive check() / sweep() themselves. */
  timers?: boolean;
}

export class SettlementService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly checking = new Map<string, Promise<CheckResult>>();
  private readonly lastChecked = new Map<string, number>();
  private readonly watching = new Map<string, Watched>();
  private readonly ticking = new Set<string>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly lateLogged = new Set<string>();

  constructor(
    private readonly deps: SettlementDeps,
    private readonly o: SettlementOptions = {},
  ) {}

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Resolves once every timer-started check and tick so far has settled (tests). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const q = p.finally(() => this.running.delete(q));
    this.running.add(q);
    return q;
  }

  /** Starts following a bet that just entered AWAITING_MARKET (ticks + the fast path). */
  follow(betId: string, terms: Terms): void {
    if (!terms.market) return;
    const expiryMs = Date.parse(terms.market.expiry);
    this.watching.set(betId, {
      eventTicker: terms.market.eventTicker,
      expiryMs,
      lastTickAt: this.watching.get(betId)?.lastTickAt ?? 0,
    });
    this.arm(betId, expiryMs + SETTLE_FIRST_CHECK_MS);
  }

  /** The fast path: check() at `atMs`, then every SETTLE_POLL_MS inside the fast window. */
  arm(betId: string, atMs: number): void {
    if (this.o.timers === false) return;
    const prev = this.timers.get(betId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(
      () => {
        this.timers.delete(betId);
        void this.track(
          this.check(betId).then((r) => {
            const w = this.watching.get(betId);
            if (r === 'pending' && w && this.deps.now() < w.expiryMs + SETTLE_FAST_WINDOW_MS)
              this.arm(betId, this.deps.now() + SETTLE_POLL_MS);
            return r;
          }),
        );
      },
      Math.max(0, atMs - this.deps.now()),
    );
    t.unref?.();
    this.timers.set(betId, t);
  }

  /** One settlement check of one bet; concurrent callers share it. Never throws. */
  check(betId: string): Promise<CheckResult> {
    let p = this.checking.get(betId);
    if (!p) {
      p = this.doCheck(betId)
        .catch((err: unknown) => {
          this.deps.log.warn('market.settle_failed', { bet_id: betId, err });
          return 'pending' as const;
        })
        .finally(() => this.checking.delete(betId));
      this.checking.set(betId, p);
    }
    return p;
  }

  private async doCheck(betId: string): Promise<CheckResult> {
    const deps = this.deps;
    const [bet] = await deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
    if (!bet || bet.state !== 'AWAITING_MARKET') {
      this.forget(betId);
      return 'skipped';
    }
    const final = await loadEnvelope(deps.db, betId, { finalOnly: true });
    const terms = final?.envelope.terms;
    const market = terms?.market;
    if (!final || !terms || !market || final.envelope.terms_hash !== bet.terms_hash) {
      deps.log.error('market.settle_no_terms', { bet_id: betId });
      return 'skipped';
    }
    const now = deps.now();
    this.lastChecked.set(betId, now);
    const expiryMs = Date.parse(market.expiry);
    if (now < expiryMs) {
      this.follow(betId, terms);
      return 'pending';
    }
    const [existing] = await deps.db
      .select({ id: rulings.id })
      .from(rulings)
      .where(and(eq(rulings.bet_id, betId), eq(rulings.stage, 'settlement')))
      .limit(1);
    if (existing) return 'settled'; // the sweep re-sends it if it never reached RULED

    const client = deps.markets?.client;
    if (!client) {
      deps.log.warn('market.settle_no_feed', { bet_id: betId });
      return 'pending';
    }
    let resp: Awaited<ReturnType<typeof client.getEventRaw>>;
    try {
      resp = await client.getEventRaw(market.eventTicker);
    } catch (err) {
      deps.log.warn('market.settle_fetch_failed', { bet_id: betId, err });
      return 'pending';
    }
    const fetchedAt = deps.now();
    const contract = resp.event.contracts.find(
      (c) => c.instrumentSymbol === market.instrumentSymbol,
    );
    if (!contract) {
      deps.log.warn('market.settle_contract_missing', {
        bet_id: betId,
        instrument: market.instrumentSymbol,
      });
      return 'pending';
    }
    const state = classifyContract(contract);
    if (state.kind === 'pending') {
      if (fetchedAt > Date.parse(terms.deadline) && !this.lateLogged.has(betId)) {
        this.lateLogged.add(betId);
        deps.log.warn('market.settlement_late', {
          bet_id: betId,
          status: state.status,
          deadline: terms.deadline,
        });
      }
      return 'pending';
    }

    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(resp.bytes);
    const responseSha = sha256Hex(resp.bytes);
    // Keep the raw body only when it round-trips (the CHECK hashes its UTF-8 encoding).
    const lossless = sha256Hex(bodyText) === responseSha;
    const record = settlementRecord({
      bet_id: betId,
      terms_hash: final.envelope.terms_hash,
      eventTicker: resp.event.ticker,
      instrumentSymbol: contract.instrumentSymbol,
      state,
      settlementValue: cleanDecimal(contract.settlementValue),
      strike: toStrike(contract.strike),
      resolvedAt: isoOrNull(contract.resolvedAt),
      source_url: resp.url,
      response_sha256: responseSha,
      fetched_at: iso(fetchedAt),
    });
    const ruling = settlementRuling({
      ruling_id: randomUUID(),
      created_at: iso(fetchedAt),
      terms: { bet_id: betId, yes_party: terms.yes_party, market },
      terms_hash: final.envelope.terms_hash,
      record,
    });
    const evidenceCanonical = jcs(record);
    const rulingCanonical = jcs(ruling);
    const rulingHash = hashJcs(ruling);

    const out = await deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b || b.state !== 'AWAITING_MARKET' || b.terms_hash !== final.envelope.terms_hash)
        return null;
      const [dup] = await tx
        .select({ id: rulings.id })
        .from(rulings)
        .where(and(eq(rulings.bet_id, betId), eq(rulings.stage, 'settlement')))
        .limit(1);
      if (dup) return null;
      await tx.insert(rulings).values({
        id: ruling.ruling_id,
        bet_id: betId,
        stage: 'settlement',
        model: ruling.model,
        outcome: ruling.outcome,
        claim_result: ruling.claim_result,
        redo_reason: null,
        void_reason: ruling.void_reason,
        confidence: ruling.confidence.toFixed(2),
        reason: ruling.reason,
        cited_frames: [],
        frame_hashes: [],
        evidence_kind: 'gemini',
        evidence_hash: ruling.evidence_hash,
        evidence_canonical: evidenceCanonical,
        record_canonical: rulingCanonical,
        ruling_hash: rulingHash,
        latency_ms: Math.max(0, fetchedAt - expiryMs),
        created_at: new Date(ruling.created_at),
      });
      const c = record.contract;
      await tx
        .update(geminiMarkets)
        .set({
          status: c.status,
          resolution_side: c.resolutionSide,
          settlement_value: c.settlementValue,
          resolved_at: c.resolvedAt ? new Date(c.resolvedAt) : null,
          settlement_raw: lossless ? bodyText : null,
          settlement_response_sha256: lossless ? responseSha : null,
          event_raw: lossless ? (JSON.parse(bodyText) as unknown) : null,
          updated_at: new Date(fetchedAt),
        })
        .where(eq(geminiMarkets.instrument_symbol, c.instrumentSymbol));
      const names = await partyNames(tx, b);
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'market.settled',
          payload: { record, evidence_hash: ruling.evidence_hash },
          now: fetchedAt,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'ruling.issued',
          payload: { ruling, ruling_hash: rulingHash },
          now: fetchedAt,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: settlementCue(
            ruling,
            record,
            names,
            deps.env.APPEAL_WINDOW_S ?? DEFAULT_GG_SECS,
          ),
          now: fetchedAt,
        }),
      ];
      await tx.insert(auditLog).values({
        actor_kind: 'server',
        action: 'ruling.issued',
        bet_id: betId,
        details: {
          ruling_id: ruling.ruling_id,
          ruling_hash: rulingHash,
          outcome: ruling.outcome,
          stage: 'settlement',
          model: ruling.model,
          gemini_status: c.status,
          resolution_side: c.resolutionSide,
          response_sha256: responseSha,
        },
      });
      return { b, envs };
    });
    if (!out) return 'settled';
    fanout(deps, out.b, out.envs);
    deps.log.info('market.settled', {
      bet_id: betId,
      event_ticker: record.contract.eventTicker,
      side: record.contract.resolutionSide,
      outcome: ruling.outcome,
      ruling_hash: rulingHash,
      after_expiry_ms: fetchedAt - expiryMs,
    });
    this.forget(betId);
    await this.sendRuling(betId, ruling);
    return 'settled';
  }

  private async sendRuling(betId: string, ruling: Ruling): Promise<void> {
    if (!this.deps.onRuling) return;
    try {
      await this.deps.onRuling(betId, ruling);
    } catch (err) {
      // The sweep retries after SETTLE_RESOLVE_GRACE_MS (onRuling is idempotent).
      this.deps.log.error('market.on_ruling_failed', { bet_id: betId, err: String(err) });
    }
  }

  private forget(betId: string): void {
    this.watching.delete(betId);
    const t = this.timers.get(betId);
    if (t) clearTimeout(t);
    this.timers.delete(betId);
  }

  /** Keeper: the durable backstop of the fast path (see the header). */
  async sweep(nowMs: number): Promise<{ entered: string[]; checked: string[]; resent: string[] }> {
    const deps = this.deps;
    const out = { entered: [] as string[], checked: [] as string[], resent: [] as string[] };

    // 1. A gemini bet left in LOCKED (its landing transaction is the normal path).
    const locked = await deps.db
      .select({ id: bets.id })
      .from(bets)
      .where(and(eq(bets.state, 'LOCKED'), eq(bets.evidence_source, 'gemini')))
      .limit(SETTLE_BATCH);
    for (const { id } of locked) {
      const terms = (await loadEnvelope(deps.db, id, { finalOnly: true }))?.envelope.terms;
      if (!terms?.market) continue;
      const r = await deps.db.transaction(async (tx) => {
        const b = await lockBet(tx, id);
        if (!b) return null;
        const envs = await enterAwaitingMarket(tx, id, terms, nowMs);
        return envs.length ? { b, envs } : null;
      });
      if (!r) continue;
      fanout(deps, r.b, r.envs);
      this.follow(id, terms);
      out.entered.push(id);
    }

    // 2. Bets waiting for Gemini.
    const waiting = await deps.db
      .select({ id: bets.id, ruling_hash: bets.ruling_hash })
      .from(bets)
      .where(eq(bets.state, 'AWAITING_MARKET'))
      .limit(SETTLE_BATCH * 5);
    for (const w of waiting) {
      const [ruled] = await deps.db
        .select({ record: rulings.record_canonical, created_at: rulings.created_at })
        .from(rulings)
        .where(
          and(
            eq(rulings.bet_id, w.id),
            eq(rulings.stage, 'settlement'),
            lte(rulings.created_at, new Date(nowMs - SETTLE_RESOLVE_GRACE_MS)),
          ),
        )
        .limit(1);
      if (ruled) {
        if (out.resent.length >= SETTLE_BATCH) continue;
        try {
          await this.sendRuling(w.id, Ruling.parse(JSON.parse(ruled.record)));
          out.resent.push(w.id);
          deps.log.info('market.resolve_retried', { bet_id: w.id });
        } catch (err) {
          deps.log.warn('market.resolve_retry_failed', { bet_id: w.id, err: String(err) });
        }
        continue;
      }
      if (!this.watching.has(w.id)) {
        // e.g. after a restart: follow it again (ticks + the fast path)
        const terms = (await loadEnvelope(deps.db, w.id, { finalOnly: true }))?.envelope.terms;
        if (terms?.market) this.follow(w.id, terms);
      }
      const watched = this.watching.get(w.id);
      if (watched && nowMs < watched.expiryMs + SETTLE_FIRST_CHECK_MS) continue;
      const last = this.lastChecked.get(w.id);
      if (last !== undefined && nowMs - last < SETTLE_SWEEP_EVERY_MS) continue;
      if (out.checked.length >= SETTLE_BATCH) continue;
      await this.check(w.id);
      out.checked.push(w.id);
    }
    return out;
  }

  /** Relay snapshot -> market.tick for each waiting bet on that contract (until its expiry). */
  onSnapshot(snap: GeminiMarketSnapshot): void {
    const now = this.deps.now();
    for (const [betId, w] of this.watching) {
      if (w.eventTicker !== snap.eventTicker || now >= w.expiryMs) continue;
      if (now - w.lastTickAt < MARKET_TICK_MIN_MS || this.ticking.has(betId)) continue;
      w.lastTickAt = now;
      this.ticking.add(betId);
      void this.track(
        this.tick(betId, snap)
          .catch((err: unknown) => this.deps.log.warn('market.tick_failed', { bet_id: betId, err }))
          .finally(() => this.ticking.delete(betId)),
      );
    }
  }

  private async tick(betId: string, snap: GeminiMarketSnapshot): Promise<void> {
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b || b.state !== 'AWAITING_MARKET') return null;
      const env = await appendBetEvent(tx, {
        bet_id: betId,
        type: 'market.tick',
        payload: { snapshot: snap },
        now: this.deps.now(),
      });
      return { b, env };
    });
    if (!out) {
      this.watching.delete(betId);
      return;
    }
    fanout(this.deps, out.b, [out.env]);
  }

  /** Bets followed for ticks / the fast path (diagnostics, tests). */
  get followed(): string[] {
    return [...this.watching.keys()];
  }
}

/** MARKET_SETTLED (decisive) or VOIDED (refund) for the voice judge (API-CONTRACT §4.5). */
export function settlementCue(
  r: Ruling,
  record: {
    contract: {
      resolutionSide: 'yes' | 'no' | null;
      settlementValue: string | null;
      strike: { value: string | null };
    };
  },
  names: { A: string; B: string },
  ggSecs: number,
) {
  const c = record.contract;
  if (r.outcome === 'VOID')
    return judgeCue(
      'VOIDED',
      { reason: r.void_reason ?? 'market_invalid' },
      'Say Gemini voided the contract, so nobody wins and both stakes go back.',
    );
  const winner = r.outcome === 'A_WINS' ? names.A : names.B;
  const up = c.resolutionSide === 'yes';
  return judgeCue(
    'MARKET_SETTLED',
    {
      side: c.resolutionSide ?? '-',
      line: c.strike.value ?? '-',
      settle: c.settlementValue ? formatPrice(c.settlementValue).slice(1).replace(/,/g, '') : '-',
      winner,
      gg_secs: ggSecs,
    },
    `Announce Gemini settled ${up ? 'UP' : 'DOWN'} and ${asciiFold(winner)} wins.`,
  );
}

const registry = new WeakMap<object, SettlementService>();

/** The settlement service of this deps bag (built on first use). */
export function settlementOf(deps: SettlementDeps): SettlementService {
  let s = registry.get(deps);
  if (!s) registry.set(deps, (s = new SettlementService(deps)));
  return s;
}

/** Replaces the settlement service of `deps` (tests). */
export function installSettlement(deps: SettlementDeps, s: SettlementService): SettlementService {
  registry.get(deps)?.stop();
  registry.set(deps, s);
  return s;
}

export function settlementTask(deps: SettlementDeps): KeeperTask {
  return { name: 'market-settlement', run: (now) => settlementOf(deps).sweep(now) };
}
