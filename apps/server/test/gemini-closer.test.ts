/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and event payloads are loosely typed in tests */
// Beat 6, the Gemini closer, against a real Postgres and a fake Gemini that answers with REAL
// recorded responses (fixtures/gemini-btc5m.json: BTC05M2611180240, settled "no" at
// 64367.38366666667 vs the 64389.6 line, then the 02:40 -> 02:45 rollover). No chain: the lock
// is stood in for (confirmTerms + LOCKED in SQL); the full chain path (custodial and phones
// locks, resolve, finalize, payouts at unequal stakes) is gemini-e2e.test.ts over LiteSVM.
//
//   POST /v1/bets/:id/terms/market -> binding quote -> Terms.market + stakes + bet columns
//   confirm with a stale quote -> re-quoted (409 TERMS_HASH_MISMATCH reason requoted)
//   LOCKED -> AWAITING_MARKET (the sweep) -> market.tick -> expiry -> settlement keeper:
//     UP / DOWN wins on Gemini's side, voided -> VOID market_invalid, another line -> VOID,
//     not settled yet / Gemini 5xx / contract missing -> retried, rollover while awaiting,
//     onRuling failing -> re-sent by the sweep, two concurrent checks -> one ruling.
// Synthetic variants of the recorded settled body (a "yes" side, a voided contract) are built by
// editing a clone of the real one; they are labelled where they are made.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  betEvents,
  bets,
  betTermsVersions,
  geminiMarkets,
  marketSnapshots,
  rulings,
} from '@youre-on/db';
import { GeminiSettlementRecord } from '@youre-on/shared/evidence';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import {
  marketTermsPath,
  MarketTermsResponse,
  MARKET_CONFIRM_MAX_AGE_MS,
} from '@youre-on/shared/judge/market-terms';
import { termsConfirmPath } from '@youre-on/shared/judge/typed-terms';
import { sha256Hex } from '@youre-on/shared/primitives';
import { Ruling, GEMINI_SETTLEMENT_MODEL } from '@youre-on/shared/ruling';
import { Terms } from '@youre-on/shared/terms';
import type { Ruling as RulingT } from '@youre-on/shared/ruling';
import { createGeminiClient } from '../src/markets/gemini';
import { createReplayClient, createRoutedClient } from '../src/markets/replay';
import { MarketService } from '../src/markets/service';
import {
  installSettlement,
  SettlementService,
  SETTLE_RESOLVE_GRACE_MS,
  SETTLE_SWEEP_EVERY_MS,
} from '../src/markets/settlement';
import { confirmTerms } from '../src/lock/terms';
import { silentLogger } from '../src/log';
import {
  clone,
  EVENTS_PATH,
  eventPath,
  fakeGemini,
  GEMINI_FIXTURE as F,
  T0237,
  strikePath,
  T0241,
  TICKER_PATH,
  type FakeGemini,
} from './gemini-fake';
import {
  DB_URL,
  describeDb,
  getChallenge,
  newKey,
  ownDatabase,
  postJson,
  signedHeaders,
  signupBody,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

const T0240 = Date.parse('2026-11-18T02:40:00.000Z');
const TICKER = 'BTC05M2611180240';
const SYMBOL = 'GEMI-BTC05M2611180240-UP';

/** SYNTHETIC: the real settled body with the other side ("yes", settled above the line). */
function settledYes() {
  const e = clone(F.event_0240_settled) as any;
  e.contracts[0].resolutionSide = 'yes';
  e.contracts[0].settlementValue = '64401.25';
  e.settlement = { value: '64401.25' };
  return e;
}
/** SYNTHETIC: the real settled body, voided (Gemini's `invalid`; never seen live: 0 of 173). */
function voided(status = 'invalid') {
  const e = clone(F.event_0240_settled) as any;
  e.status = status;
  e.contracts[0].status = status;
  delete e.contracts[0].resolutionSide;
  delete e.contracts[0].settlementValue;
  delete e.settlement;
  return e;
}
/** The real body before settlement (closed, no side yet). */
function closedNoSide() {
  const e = clone(F.event_0240_settled) as any;
  e.status = 'closed';
  e.contracts[0].status = 'closed';
  delete e.contracts[0].resolutionSide;
  delete e.contracts[0].settlementValue;
  return e;
}

describeDb(
  'Beat 6: the Gemini closer (terms, AWAITING_MARKET, settlement; DB, fake Gemini)',
  () => {
    let ctx: Ctx;
    const clock = { t: T0237 };
    const now = () => clock.t;
    let g: FakeGemini;
    let markets: MarketService;
    let svc: SettlementService;
    let ruled: Array<{ betId: string; ruling: RulingT }> = [];
    let failRuling = false;

    /** Gemini bets this file left waiting (an earlier run, a failed test) would be swept too. */
    const retireLeftovers = () =>
      ctx.deps.db
        .update(bets)
        .set({ state: 'CANCELLED', end_reason: 'cancelled' })
        .where(
          and(
            eq(bets.evidence_source, 'gemini'),
            inArray(bets.state, ['LOCKED', 'AWAITING_MARKET', 'AWAITING_AUTHORIZATIONS']),
          ),
        );

    beforeAll(async () => {
      g = fakeGemini({});
      // Its own database: gemini_markets rows (one per contract) are global, and this suite
      // re-uses the recorded contract every test.
      const url = await ownDatabase(DB_URL!, 'gemini');
      ctx = await startTestServer({
        now,
        env: {
          DEMO_MODE: 'true',
          DATABASE_URL: url,
          DEMO_ADMIN_TOKEN: 'demo-admin-closer',
          ELEVENLABS_TOOL_SECRET: 'tool-secret-closer',
        },
      });
      await ctx.deps.db.execute(sql`TRUNCATE gemini_markets, market_snapshots CASCADE`);
      // The payout seam: record the ruling and move the bet on, as resolve -> RULED would.
      ctx.deps.onRuling = async (betId, ruling) => {
        if (failRuling) throw new Error('rpc 429');
        ruled.push({ betId, ruling });
        await ctx.deps.db.update(bets).set({ state: 'RULED' }).where(eq(bets.id, betId));
      };
    });
    afterAll(async () => {
      svc?.stop();
      if (ctx) await retireLeftovers();
      await ctx?.server.close();
    });
    beforeEach(async () => {
      clock.t = T0237;
      ruled = [];
      failRuling = false;
      await retireLeftovers();
      g.routes.clear();
      g.routes.set(EVENTS_PATH, F.events_0237);
      g.routes.set(eventPath(TICKER), F.event_0240_active);
      g.routes.set(TICKER_PATH, F.btcusd);
      g.calls.length = 0;
      // A fresh relay per test (the clock goes back to 02:37:10 each time), wired as the
      // market-bets route module wires the real one: snapshots -> the settlement service's ticks.
      markets = new MarketService({
        client: createGeminiClient({ fetch: g.fetch }),
        now,
        log: silentLogger,
      });
      ctx.deps.markets = markets;
      svc?.stop();
      svc = installSettlement(ctx.deps, new SettlementService(ctx.deps, { timers: false }));
      markets.onSnapshot((s) => svc.onSnapshot(s));
      await markets.refresh();
    });

    // ---- HTTP helpers (signed at the server's clock) --------------------------------------

    async function signUpAt(name: string): Promise<SignedUp> {
      const device = newKey();
      const wallet = newKey();
      const ch = await getChallenge(ctx.base, device);
      const r = await postJson(
        ctx.base,
        '/v1/auth/signup',
        signupBody(ch, device, wallet, { display_name: name }),
      );
      if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.json)}`);
      return { device, wallet, session: r.json as any };
    }
    const post = (u: SignedUp, path: string, body: unknown = {}) => {
      const raw = JSON.stringify(body);
      return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw, { ts: now() }));
    };
    const betRow = async (id: string) =>
      (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
    const events = async (id: string) =>
      ctx.deps.db
        .select({ type: betEvents.type, envelope: betEvents.envelope })
        .from(betEvents)
        .where(eq(betEvents.bet_id, id))
        .orderBy(asc(betEvents.seq));
    const types = async (id: string) => (await events(id)).map((e) => e.type);
    const settlementRows = (id: string) =>
      ctx.deps.db
        .select()
        .from(rulings)
        .where(and(eq(rulings.bet_id, id), eq(rulings.stage, 'settlement')));

    /** Logan challenges Jake from the list; Jake accepts. */
    async function newBet() {
      const A = await signUpAt('Logan');
      const B = await signUpAt('Jake');
      const room = await post(A, '/v1/rooms', { name: 'Closer', kind: 'session' });
      expect(room.status).toBe(201);
      expect((await post(B, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
      const bet = await post(A, '/v1/bets', {
        room_id: room.json!.room_id,
        opponent_user_id: B.session.user.user_id,
        challenge_method: 'list',
      });
      expect(bet.status).toBe(201);
      const betId = bet.json!.bet.bet_id as string;
      expect((await post(B, `/v1/bets/${betId}/invite/accept`)).status).toBe(200);
      return { A, B, betId };
    }

    /** POST /terms/market, freeze, then stand in for the lock (no chain here): LOCKED. */
    async function lockedBet(side: 'UP' | 'DOWN', amount = '5') {
      const b = await newBet();
      const r = await post(b.A, marketTermsPath(b.betId), { side, amount_usd: amount });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const res = MarketTermsResponse.parse(r.json);
      const c = await confirmTerms(ctx.deps, b.betId);
      expect(c.ok).toBe(true);
      await ctx.deps.db.update(bets).set({ state: 'LOCKED' }).where(eq(bets.id, b.betId));
      const swept = await svc.sweep(now());
      expect(swept.entered).toContain(b.betId);
      expect((await betRow(b.betId)).state).toBe('AWAITING_MARKET');
      return { ...b, res };
    }

    // ---- terms ----------------------------------------------------------------------------

    it('POST /terms/market: the binding quote becomes Terms.market, the stakes and the bet columns', async () => {
      const { A, betId } = await newBet();
      const r = await post(A, marketTermsPath(betId), { side: 'UP', amount_usd: '5' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const res = MarketTermsResponse.parse(r.json);
      // discovery list at 02:37:10: bid .54 / ask .67 -> mid 0.605 -> 61 %: UP takes 61 % of $10
      expect(res.quote.market).toEqual({
        venue: 'gemini',
        eventTicker: TICKER,
        instrumentSymbol: SYMBOL,
        side: 'YES',
        priceAtLock: '0.61',
        priceSource: 'mid',
        quotedAt: new Date(T0237).toISOString(),
        strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' },
        expiry: '2026-11-18T02:40:00.000Z',
      });
      expect(res.quote.stakes).toEqual({ a: '6100000', b: '3900000', currency: 'USDC' });
      expect(res).toMatchObject({ ok: true, kind: 'proposed', state: 'TERMS_PROPOSED' });
      expect(res.say).toBe(
        "Gemini's BTC 5-minute contract expiring 02:40 UTC resolves UP. Logan has Up, Jake has Down. Gemini's odds: $6.10 against $3.90.",
      );

      const [v] = await ctx.deps.db
        .select()
        .from(betTermsVersions)
        .where(eq(betTermsVersions.bet_id, betId));
      expect(v).toMatchObject({ drafted_by: 'party_a', source_tool: 'market' });
      const terms = Terms.parse(JSON.parse(v!.canonical_json));
      expect(sha256Hex(v!.canonical_json)).toBe(res.terms_hash);
      expect(terms).toMatchObject({
        type: 'real_world',
        claim: "Gemini's BTC 5-minute contract expiring 02:40 UTC resolves UP.",
        performer: null,
        yes_party: 'A',
        evidence_source: 'gemini',
        success_criteria: ['Gemini settles this contract YES.'],
        failure_criteria: ['Gemini settles this contract NO.'],
        market: res.quote.market,
        stakes: res.quote.stakes,
        deadline: '2026-11-18T02:50:00.000Z', // expiry + 10 min
      });

      const row = await betRow(betId);
      expect(row).toMatchObject({
        state: 'TERMS_PROPOSED',
        evidence_source: 'gemini',
        stake_a: 6_100_000n,
        stake_b: 3_900_000n,
        a_position: 'yes',
        odds_p: '0.61',
        odds_source: 'mid',
        quoted_at: new Date(T0237),
        title: 'Bitcoin Up in 5 minutes',
      });
      const [m] = await ctx.deps.db
        .select()
        .from(geminiMarkets)
        .where(eq(geminiMarkets.id, row.gemini_market_id!));
      expect(m).toMatchObject({
        event_ticker: TICKER,
        instrument_symbol: SYMBOL,
        contract_ticker: 'UP',
        series: 'BTC05M',
        strike: '64389.60000000',
        status: 'active',
        expires_at: new Date(T0240),
      });
      const [s] = await ctx.deps.db
        .select()
        .from(marketSnapshots)
        .where(eq(marketSnapshots.id, row.pricing_snapshot_id!));
      expect(s).toMatchObject({ best_bid: '0.5400', best_ask: '0.6700', source: 'rest_event' });
      expect(s!.snapshot_sha256).toBe(res.quote.snapshot_sha256);
      expect(sha256Hex(s!.snapshot_canonical!)).toBe(res.quote.snapshot_sha256);
      expect(JSON.parse(s!.snapshot_canonical!)).toMatchObject({ eventTicker: TICKER });
      expect(res.quote.snapshot_id).toBe(String(row.pricing_snapshot_id));

      const env = (await events(betId)).find((e) => e.type === 'terms.proposed')!.envelope as any;
      expect(env.payload.envelope.presentation).toMatchObject({
        stakes_display: '$6.10 vs $3.90',
        odds_display: '61/39',
      });

      // DOWN on the same contract: A holds NO (39 %), B is the yes party; re-proposing replaces it.
      const down = MarketTermsResponse.parse(
        (await post(A, marketTermsPath(betId), { side: 'DOWN', amount_usd: '5' })).json,
      );
      expect(down.quote.stakes).toEqual({ a: '3900000', b: '6100000', currency: 'USDC' });
      expect(down.quote.market.side).toBe('NO');
      expect(await betRow(betId)).toMatchObject({ a_position: 'no', stake_a: 3_900_000n });
    });

    it('refusals: too close to expiry, strike pending, lopsided stakes, the feed off, B, bad input', async () => {
      const { A, B, betId } = await newBet();
      const market = (u: SignedUp, body: unknown) => post(u, marketTermsPath(betId), body);

      expect((await market(B, { side: 'UP', amount_usd: '5' })).json!.error.code).toBe(
        'NOT_A_PARTY',
      );
      expect((await market(A, { side: 'UP', amount_usd: 'five' })).json!.error.code).toBe(
        'VALIDATION_FAILED',
      );
      expect((await market(A, { side: 'SIDEWAYS', amount_usd: '5' })).status).toBe(422);
      // $20 a side: UP's 61 % of $40 = $24.40 > max_stake ($20)
      const big = await market(A, { side: 'UP', amount_usd: '20' });
      expect(big.status).toBe(409);
      expect(big.json!.error).toMatchObject({
        code: 'MARKET_UNAVAILABLE',
        details: { reason: 'STAKE_ABOVE_MAX' },
      });

      // inside T-120 s
      clock.t = Date.parse('2026-11-18T02:38:30.000Z');
      await markets.refresh();
      const late = await market(A, { side: 'UP', amount_usd: '5' });
      expect(late.json!.error).toMatchObject({
        code: 'MARKET_UNAVAILABLE',
        details: { reason: 'TOO_CLOSE_TO_EXPIRY' },
      });

      // the next window, before its strike is known (listed without a value; /strike pending)
      const noValue = clone(F.event_0245_active) as any;
      noValue.contracts[0].strike = { type: 'reference', availableAt: '2026-11-18T02:40:00.000Z' };
      g.routes.set(eventPath('BTC05M2611180245'), noValue);
      g.routes.set(strikePath('BTC05M2611180245'), F.strike_0245_pending);
      clock.t = Date.parse('2026-11-18T02:40:01.000Z');
      await markets.refresh();
      expect(markets.snapshot?.eventTicker).toBe('BTC05M2611180245');
      const pending = await market(A, { side: 'UP', amount_usd: '5' });
      expect(pending.json!.error).toMatchObject({
        code: 'MARKET_UNAVAILABLE',
        details: { reason: 'STRIKE_PENDING' },
      });
      expect((await betRow(betId)).state).toBe('DRAFTING');

      // the relay off -> MARKET_NOT_OPEN (and the voice judge would get NO_MARKET)
      const saved = ctx.deps.markets;
      ctx.deps.markets = undefined;
      try {
        const off = await market(A, { side: 'UP', amount_usd: '5' });
        expect(off.json!.error).toMatchObject({
          code: 'MARKET_UNAVAILABLE',
          details: { reason: 'MARKET_NOT_OPEN' },
        });
      } finally {
        ctx.deps.markets = saved;
      }
    });

    it('confirm with a quote older than 30 s re-quotes (409 TERMS_HASH_MISMATCH requoted), then locks', async () => {
      const { A, betId } = await newBet();
      const first = MarketTermsResponse.parse(
        (await post(A, marketTermsPath(betId), { side: 'UP', amount_usd: '5' })).json,
      );
      clock.t += MARKET_CONFIRM_MAX_AGE_MS + 1_000;
      await markets.refresh(); // the event detail now: bid .56 / ask .69 -> 63 %
      // confirmTerms only (the typed route would also start the lock, which needs a chain)
      const c = await confirmTerms(ctx.deps, betId);
      expect(c).toMatchObject({ ok: false, fix: 'REQUOTED' });
      const re = c.ok === false && c.fix === 'REQUOTED' ? c.envelope : null;
      expect(re!.terms_hash).not.toBe(first.terms_hash);
      expect(re!.terms.market).toMatchObject({
        priceAtLock: '0.63',
        quotedAt: new Date(clock.t).toISOString(),
      });
      expect(re!.terms.stakes).toEqual({ a: '6300000', b: '3700000', currency: 'USDC' });
      const row = await betRow(betId);
      expect(row).toMatchObject({ state: 'TERMS_PROPOSED', terms_hash: re!.terms_hash });
      const versions = await ctx.deps.db
        .select({ source: betTermsVersions.source_tool })
        .from(betTermsVersions)
        .where(eq(betTermsVersions.bet_id, betId));
      expect(versions.map((v) => v.source)).toEqual(['market', 'requote']);
      // fresh now: the freeze goes through
      expect(await confirmTerms(ctx.deps, betId)).toMatchObject({ ok: true });
      expect((await betRow(betId)).state).toBe('AWAITING_AUTHORIZATIONS');
    });

    it('the typed confirm route answers a re-quote with 409 TERMS_HASH_MISMATCH {reason: requoted}', async () => {
      const { A, betId } = await newBet();
      const first = MarketTermsResponse.parse(
        (await post(A, marketTermsPath(betId), { side: 'DOWN', amount_usd: '2' })).json,
      );
      clock.t += MARKET_CONFIRM_MAX_AGE_MS + 1_000;
      await markets.refresh();
      const r = await post(A, termsConfirmPath(betId), { terms_hash: first.terms_hash });
      expect(r.status).toBe(409);
      expect(r.json!.error).toMatchObject({
        code: 'TERMS_HASH_MISMATCH',
        details: { reason: 'requoted' },
      });
      expect(r.json!.error.details.terms_hash).toBe((await betRow(betId)).terms_hash);
    });

    // ---- AWAITING_MARKET, ticks, settlement --------------------------------------------------

    it('UP call, Gemini settles NO (the real recorded result): B wins; record, ruling, events, audit', async () => {
      const { betId, res } = await lockedBet('UP');
      const t = await types(betId);
      expect(t.slice(-2)).toEqual(['bet.state', 'judge.cue']);
      const cue = (await events(betId)).at(-1)!.envelope as any;
      expect(cue.payload).toMatchObject({ cue: 'MARKET_WAITING', speak: false });

      // live ticks for this contract until expiry (<= 1 Hz)
      clock.t += 2_000;
      await markets.refresh();
      await svc.idle();
      clock.t += 500;
      markets.refresh(); // same contract, too soon for another tick
      await markets.refresh();
      await svc.idle();
      const ticks = (await events(betId)).filter((e) => e.type === 'market.tick');
      expect(ticks).toHaveLength(1);
      expect((ticks[0]!.envelope as any).payload.snapshot).toMatchObject({ eventTicker: TICKER });

      // before expiry the keeper does nothing
      expect(await svc.check(betId)).toBe('pending');
      expect(g.calls.filter((c) => c === eventPath(TICKER)).length).toBeGreaterThan(0);

      // 02:40:06: Gemini settled it "no" (5.5 s after expiry, as recorded)
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      expect(await svc.check(betId)).toBe('settled');

      const [row] = await settlementRows(betId);
      const ruling = Ruling.parse(JSON.parse(row!.record_canonical));
      expect(ruling).toMatchObject({
        bet_id: betId,
        stage: 'settlement',
        attempt_no: 1,
        outcome: 'B_WINS',
        claim_result: 'NOT_MET',
        confidence: 1,
        cited_frames: [],
        frame_hashes: [],
        model: GEMINI_SETTLEMENT_MODEL,
        terms_hash: res.terms_hash,
        void_reason: null,
        reason: 'Gemini settled DOWN: Bitcoin finished at $64,367.38, below the $64,389.60 line.',
      });
      expect(row!.ruling_hash).toBe(hashJcs(ruling));
      expect(row).toMatchObject({ evidence_kind: 'gemini', latency_ms: 6_000 });
      const record = GeminiSettlementRecord.parse(JSON.parse(row!.evidence_canonical!));
      expect(record).toEqual({
        schema_version: 1,
        kind: 'gemini_settlement',
        bet_id: betId,
        terms_hash: res.terms_hash,
        contract: {
          eventTicker: TICKER,
          instrumentSymbol: SYMBOL,
          status: 'settled',
          resolutionSide: 'no',
          settlementValue: '64367.38366666667',
          strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' },
          resolvedAt: '2026-11-18T02:40:05.521Z',
        },
        source_url: `https://api.gemini.com${eventPath(TICKER)}`,
        // the fake serves JSON.stringify(fixture): the record pins those exact bytes
        response_sha256: sha256Hex(JSON.stringify(F.event_0240_settled)),
        fetched_at: new Date(T0240 + 6_000).toISOString(),
      });
      expect(ruling.evidence_hash).toBe(hashJcs(record));
      expect(row!.evidence_hash).toBe(sha256Hex(jcs(record)));

      const [m] = await ctx.deps.db
        .select()
        .from(geminiMarkets)
        .where(eq(geminiMarkets.instrument_symbol, SYMBOL));
      expect(m).toMatchObject({
        status: 'settled',
        resolution_side: 'no',
        settlement_value: '64367.38366666667',
        resolved_at: new Date('2026-11-18T02:40:05.521Z'),
        settlement_raw: JSON.stringify(F.event_0240_settled),
        settlement_response_sha256: record.response_sha256,
      });

      const all = await events(betId);
      const tail = all.slice(-3).map((e) => e.envelope as any);
      expect(tail.map((e) => e.type)).toEqual(['market.settled', 'ruling.issued', 'judge.cue']);
      expect(tail[0].payload).toEqual({ record, evidence_hash: ruling.evidence_hash });
      expect(tail[1].payload).toEqual({ ruling, ruling_hash: row!.ruling_hash });
      expect(tail[2].payload.cue).toBe('MARKET_SETTLED');
      expect(tail[2].payload.text).toBe(
        '[EVENT] MARKET_SETTLED side=no line=64389.6 settle=64367.38 winner=Jake gg_secs=10 :: Announce Gemini settled DOWN and Jake wins.',
      );
      const [audit] = await ctx.deps.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.bet_id, betId), eq(auditLog.action, 'ruling.issued')));
      expect(audit!.details).toMatchObject({ stage: 'settlement', outcome: 'B_WINS' });

      // handed to the payout seam exactly once (which moved it to RULED); a second check is a no-op
      expect(ruled).toEqual([{ betId, ruling }]);
      expect(await svc.check(betId)).toBe('skipped');
      expect(ruled).toHaveLength(1);
      expect(await settlementRows(betId)).toHaveLength(1);
    });

    it('DOWN call wins on the real NO; UP call wins on a (synthetic) YES', async () => {
      const down = await lockedBet('DOWN', '2');
      const up = await lockedBet('UP', '1');
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 7_000;
      expect(await svc.check(down.betId)).toBe('settled');
      expect(ruled.at(-1)!.ruling).toMatchObject({ outcome: 'A_WINS', claim_result: 'NOT_MET' });

      g.routes.set(eventPath(TICKER), settledYes());
      expect(await svc.check(up.betId)).toBe('settled');
      expect(ruled.at(-1)!.ruling).toMatchObject({
        outcome: 'A_WINS',
        claim_result: 'MET',
        reason:
          'Gemini settled UP: Bitcoin finished at $64,401.25, at or above the $64,389.60 line.',
      });
    });

    it('voided by Gemini (invalid / cancelled) -> VOID market_invalid; the cue says refund', async () => {
      for (const status of ['invalid', 'cancelled']) {
        const { betId } = await lockedBet('UP');
        g.routes.set(eventPath(TICKER), voided(status));
        clock.t = T0240 + 9_000;
        expect(await svc.check(betId)).toBe('settled');
        const r = ruled.at(-1)!.ruling;
        expect(r).toMatchObject({
          bet_id: betId,
          outcome: 'VOID',
          void_reason: 'market_invalid',
          claim_result: 'UNCLEAR',
        });
        const [row] = await settlementRows(betId);
        const record = GeminiSettlementRecord.parse(JSON.parse(row!.evidence_canonical!));
        expect(record.contract).toMatchObject({
          status: 'invalid',
          resolutionSide: null,
          settlementValue: null,
        });
        const cue = (await events(betId)).at(-1)!.envelope as any;
        expect(cue.payload.cue).toBe('VOIDED');
        ruled = [];
        clock.t = T0237;
        g.routes.set(eventPath(TICKER), F.event_0240_active);
        await markets.refresh();
      }
    });

    it('settled against a different line than the locked one is ambiguous: VOID', async () => {
      const { betId } = await lockedBet('UP');
      const e = settledYes();
      e.contracts[0].strike.value = '64390.1'; // SYNTHETIC: not the line bound into the terms
      g.routes.set(eventPath(TICKER), e);
      clock.t = T0240 + 6_000;
      expect(await svc.check(betId)).toBe('settled');
      expect(ruled.at(-1)!.ruling).toMatchObject({
        outcome: 'VOID',
        void_reason: 'market_invalid',
      });
    });

    it('late / missing settlement: closed, a 500, a timeout-ish network error, no contract -> retried; then settles', async () => {
      const { betId } = await lockedBet('UP');
      clock.t = T0240 + 5_000;
      g.routes.set(eventPath(TICKER), closedNoSide());
      expect(await svc.check(betId)).toBe('pending');
      g.routes.set(eventPath(TICKER), 500);
      clock.t += 2_000;
      expect(await svc.check(betId)).toBe('pending');
      g.routes.set(eventPath(TICKER), 'throw');
      clock.t += 2_000;
      expect(await svc.check(betId)).toBe('pending');
      const noContract = clone(F.event_0240_settled) as any;
      noContract.contracts = [];
      g.routes.set(eventPath(TICKER), noContract);
      clock.t += 2_000;
      expect(await svc.check(betId)).toBe('pending');
      // settled but the side not filled in yet: still pending
      const noSide = clone(F.event_0240_settled) as any;
      delete noSide.contracts[0].resolutionSide;
      g.routes.set(eventPath(TICKER), noSide);
      clock.t += 2_000;
      expect(await svc.check(betId)).toBe('pending');
      expect(await settlementRows(betId)).toHaveLength(0);
      expect((await betRow(betId)).state).toBe('AWAITING_MARKET');

      // the keeper sweep: throttled per bet, then it picks the settlement up
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      const calls = g.calls.length;
      expect((await svc.sweep(clock.t)).checked).not.toContain(betId); // checked < 10 s ago
      expect(g.calls.length).toBe(calls);
      clock.t += SETTLE_SWEEP_EVERY_MS;
      expect((await svc.sweep(clock.t)).checked).toContain(betId);
      expect(ruled.map((r) => r.betId)).toEqual([betId]);
      expect(ruled[0]!.ruling.outcome).toBe('B_WINS');
    });

    it('rollover while awaiting: ticks stop, settlement reads the bet’s own contract, a new bet quotes 02:45', async () => {
      const { betId } = await lockedBet('DOWN');
      // the relay rolls over to 02:45 at expiry
      g.routes.set(EVENTS_PATH, F.events_0241);
      g.routes.set(eventPath('BTC05M2611180245'), F.event_0245_active);
      g.routes.set(eventPath(TICKER), closedNoSide());
      clock.t = T0241;
      await markets.refresh();
      await svc.idle();
      expect(markets.snapshot?.eventTicker).toBe('BTC05M2611180245');
      const before = (await events(betId)).filter((e) => e.type === 'market.tick').length;
      clock.t += 2_000;
      await markets.refresh();
      await svc.idle();
      expect((await events(betId)).filter((e) => e.type === 'market.tick').length).toBe(before);

      // Gemini settles the 02:40 contract: the keeper reads ITS event, not the relay's 02:45
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      g.calls.length = 0;
      expect(await svc.check(betId)).toBe('settled');
      expect(g.calls).toEqual([eventPath(TICKER)]);
      expect(ruled.at(-1)!.ruling.outcome).toBe('A_WINS'); // A took DOWN, Gemini said no

      // meanwhile a new bet prices the 02:45 contract (event detail bid .10 / ask .19 -> 15 %)
      const fresh = await newBet();
      const r = MarketTermsResponse.parse(
        (await post(fresh.A, marketTermsPath(fresh.betId), { side: 'UP', amount_usd: '5' })).json,
      );
      expect(r.quote.market).toMatchObject({
        eventTicker: 'BTC05M2611180245',
        strike: { value: '64367.38' },
        expiry: '2026-11-18T02:45:00.000Z',
      });
      expect(r.quote.market.priceAtLock).toBe('0.15');
    });

    it('onRuling failing (RPC down) leaves the ruling committed; the sweep re-sends it after 15 s', async () => {
      const { betId } = await lockedBet('UP');
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      failRuling = true;
      expect(await svc.check(betId)).toBe('settled');
      expect(ruled).toHaveLength(0);
      expect(await settlementRows(betId)).toHaveLength(1);
      failRuling = false;
      expect((await svc.sweep(clock.t)).resent).not.toContain(betId); // inside the grace
      clock.t += SETTLE_RESOLVE_GRACE_MS + 1;
      expect((await svc.sweep(clock.t)).resent).toContain(betId);
      expect(ruled).toHaveLength(1);
      expect(ruled[0]!.ruling.outcome).toBe('B_WINS');
    });

    it('two keepers checking at once commit one ruling and call onRuling once', async () => {
      const { betId } = await lockedBet('UP');
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      const other = new SettlementService(ctx.deps, { timers: false }); // a second machine
      const [a, b] = await Promise.all([svc.check(betId), other.check(betId)]);
      expect([a, b]).toEqual(['settled', 'settled']);
      expect(await settlementRows(betId)).toHaveLength(1);
      expect(ruled).toHaveLength(1);
    });

    it('GET /v1/demo/health reports the Gemini relay, the live contract and the waiting bets', async () => {
      await lockedBet('UP');
      const res = await fetch(`${ctx.base}/v1/demo/health`, {
        headers: { 'X-YO-Demo-Key': 'demo-admin-closer' },
      });
      expect(res.status).toBe(200);
      const h = (await res.json()) as any;
      expect(h.gemini).toEqual({
        feed: true,
        real_world_enabled: true,
        last_ok_at: new Date(T0237).toISOString(),
        last_error: null,
        failures: 0,
        feed_mode: null,
        rollovers: 0,
        current: {
          event_ticker: TICKER,
          expiry: '2026-11-18T02:40:00.000Z',
          strike: '64389.6',
          lockable: true,
          lockable_until: '2026-11-18T02:38:00.000Z',
          refusal: null,
        },
        next_window_start: '2026-11-18T02:40:00.000Z',
        awaiting_market: 1,
      });
    });

    it('the voice judge’s get_market_odds: a preview at Gemini’s odds, refusals spoken, secret required', async () => {
      const tool = (body: unknown, secret = 'tool-secret-closer') =>
        postJson(ctx.base, '/el/tools/get_market_odds', body, { 'X-YO-Tool-Secret': secret });
      const ids = { conversation_id: 'conv_1', bet_id: 'b' };
      const ok = await tool({
        ...ids,
        asset: 'BTC',
        horizon: '5m',
        a_side: 'YES',
        amount_usd: '5',
      });
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({
        ok: true,
        odds: '61/39',
        a: '$6.10',
        b: '$3.90',
        line: '$64,389.60',
        ends: '02:40 UTC',
        ends_in_s: 170,
        lock_within_s: 50,
        say: 'Gemini prices it 61/39: $6.10 against $3.90.',
      });
      expect(new TextEncoder().encode(JSON.stringify(ok.json)).length).toBeLessThan(300);
      // A on NO: A puts up 39 %
      const no = await tool({ ...ids, a_side: 'NO', amount_usd: '5' });
      expect(no.json).toMatchObject({ ok: true, odds: '39/61', a: '$3.90', b: '$6.10' });
      // over the cap at these odds; not dollars; too late; bad secret
      expect((await tool({ ...ids, a_side: 'YES', amount_usd: '20' })).json).toMatchObject({
        ok: false,
        fix: 'STAKE_ABOVE_MAX',
      });
      expect((await tool({ ...ids, a_side: 'YES', amount_usd: 'lots' })).json).toMatchObject({
        ok: false,
        fix: 'AMBIGUOUS',
      });
      clock.t = Date.parse('2026-11-18T02:38:30.000Z');
      await markets.refresh();
      const late = await tool({ ...ids, a_side: 'YES', amount_usd: '5' });
      expect(late.json).toEqual({
        ok: false,
        fix: 'TOO_CLOSE_TO_EXPIRY',
        say: 'Too late for this round. The next one opens at 02:40 UTC.',
      });
      expect((await tool({ ...ids, a_side: 'YES', amount_usd: '5' }, 'wrong')).status).toBe(401);
      const saved = ctx.deps.markets;
      ctx.deps.markets = undefined;
      try {
        expect((await tool({ ...ids, a_side: 'YES', amount_usd: '5' })).json).toMatchObject({
          ok: false,
          fix: 'MARKET_NOT_OPEN',
        });
      } finally {
        ctx.deps.markets = saved;
      }
    });

    it('REPLAY feed (Gemini down): POST /v1/demo/gemini replay -> a labelled bet settles from the recording', async () => {
      // the relay as server.ts builds it: live Gemini (here: down) routed with the replay
      g.routes.set(EVENTS_PATH, 500);
      markets = new MarketService({
        client: createRoutedClient({
          live: createGeminiClient({ fetch: g.fetch }),
          replay: createReplayClient({ now }),
        }),
        now,
        log: silentLogger,
      });
      ctx.deps.markets = markets;
      markets.onSnapshot((snap) => svc.onSnapshot(snap));
      expect(await markets.refresh()).toBeNull();
      expect(markets.lastError).toMatch(/HTTP 500/);

      const admin = { 'X-YO-Demo-Key': 'demo-admin-closer' };
      const sw = await postJson(ctx.base, '/v1/demo/gemini', { feed: 'replay' }, admin);
      expect(sw.status).toBe(200);
      expect(sw.json).toMatchObject({
        feed: 'replay',
        current: { lockable: true, market: { eventTicker: 'REPLAY-BTC05M2611180240' } },
      });
      expect((await postJson(ctx.base, '/v1/demo/gemini', { feed: 'replay' })).status).toBe(404);

      const { betId, res } = await lockedBet('DOWN');
      expect(res.quote.market).toMatchObject({
        eventTicker: 'REPLAY-BTC05M2611180240',
        instrumentSymbol: 'REPLAY-GEMI-BTC05M2611180240-UP',
        side: 'NO',
      });
      const terms = Terms.parse(
        JSON.parse(
          (
            await ctx.deps.db
              .select()
              .from(betTermsVersions)
              .where(eq(betTermsVersions.terms_hash, res.terms_hash))
          )[0]!.canonical_json,
        ),
      );
      expect(terms.claim).toBe(
        'REPLAY: a recorded Gemini BTC 5-minute round, ending 02:40 UTC, resolves UP.',
      );

      clock.t = T0240 + 6_000;
      expect(await svc.check(betId)).toBe('settled');
      const r = ruled.at(-1)!.ruling;
      expect(r).toMatchObject({ bet_id: betId, outcome: 'A_WINS' }); // DOWN, as recorded
      expect(r.reason).toMatch(/^Replay of a recorded round\. Gemini settled DOWN/);
      const [row] = await settlementRows(betId);
      const record = GeminiSettlementRecord.parse(JSON.parse(row!.evidence_canonical!));
      expect(record.source_url).toBe(
        'replay://gemini/v1/prediction-markets/events/REPLAY-BTC05M2611180240',
      );
      // back to live
      expect(
        (await postJson(ctx.base, '/v1/demo/gemini', { feed: 'live' }, admin)).json,
      ).toMatchObject({ feed: 'live' });
    });

    it('a bet that left AWAITING_MARKET (e.g. RULED) is skipped and forgotten', async () => {
      const { betId } = await lockedBet('UP');
      expect(svc.followed).toContain(betId);
      await ctx.deps.db.update(bets).set({ state: 'RULED' }).where(eq(bets.id, betId));
      expect(await svc.check(betId)).toBe('skipped');
      expect(svc.followed).not.toContain(betId);
    });
  },
);
