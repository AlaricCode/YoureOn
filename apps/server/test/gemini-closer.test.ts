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
import { evaluateProposeTerms, proposeTermsReply } from '@youre-on/shared/judge/reply';
import { termsConfirmPath } from '@youre-on/shared/judge/typed-terms';
import { sha256Hex } from '@youre-on/shared/primitives';
import { Ruling, GEMINI_SETTLEMENT_MODEL } from '@youre-on/shared/ruling';
import { SettlementEvidence } from '@youre-on/shared/settlement';
import { Terms } from '@youre-on/shared/terms';
import type { Ruling as RulingT } from '@youre-on/shared/ruling';
import { createGeminiClient } from '../src/markets/gemini';
import { createReplayClient, createRoutedClient } from '../src/markets/replay';
import { MarketService } from '../src/markets/service';
import {
  installSettlement,
  RESOLVE_DEADLINE_MARGIN_MS,
  SettlementService,
  SETTLE_RESOLVE_GRACE_MS,
  SETTLE_SWEEP_EVERY_MS,
  terminalResolveError,
  type BetChainView,
} from '../src/markets/settlement';
import { SimulationError } from '../src/chain/tx';
import { HttpError } from '../src/errors';
import type { Logger } from '../src/log';
import { confirmTerms } from '../src/lock/terms';
import { confirmAndLock } from '../src/voice/tools';
import { realWorldReply } from '../src/markets/voice-tool';
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

/**
 * Every test quotes the recorded contract, and a contract settles once (the settlement keeper
 * rules every later bet on the body the first one stored): retire the contract's row so the
 * next quote starts a fresh one, as a new 5-minute round would. Bets already quoted keep
 * pointing at the retired row.
 */
async function forgetSettlement(db: Ctx['deps']['db']) {
  await db
    .update(geminiMarkets)
    .set({ instrument_symbol: sql`instrument_symbol || ':retired:' || gen_random_uuid()` })
    .where(sql`instrument_symbol NOT LIKE '%:retired:%'`);
}

/** A logger that keeps every line: [level, event, fields]. */
function recordingLog(): Logger & { lines: Array<[string, string, Record<string, unknown>]> } {
  const lines: Array<[string, string, Record<string, unknown>]> = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
    void lines.push([level, msg, fields ?? {}]);
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
const linesOf = (log: ReturnType<typeof recordingLog>, event: string, level?: string) =>
  log.lines.filter(([l, m]) => m === event && (level === undefined || l === level));
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
      await forgetSettlement(ctx.deps.db);
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

    it('confirm when Gemini can no longer price the round: 409 with Gemini’s own reason (not QUOTE_STALE)', async () => {
      const { A, betId } = await newBet();
      const first = MarketTermsResponse.parse(
        (await post(A, marketTermsPath(betId), { side: 'UP', amount_usd: '5' })).json,
      );
      // 02:38:30: inside T-120 s of the 02:40 contract, the next one not listed yet
      clock.t = Date.parse('2026-11-18T02:38:30.000Z');
      await markets.refresh();
      const c = await confirmTerms(ctx.deps, betId);
      expect(c).toMatchObject({ ok: false, fix: 'QUOTE_STALE', refusal: 'TOO_CLOSE_TO_EXPIRY' });
      const r = await post(A, termsConfirmPath(betId), { terms_hash: first.terms_hash });
      expect(r.status).toBe(409);
      expect(r.json!.error).toMatchObject({
        code: 'MARKET_UNAVAILABLE',
        message: 'Too late for this round. The next one opens soon.',
        details: { reason: 'TOO_CLOSE_TO_EXPIRY' },
      });
      // the old card stays the bet's terms: nothing was frozen
      expect(await betRow(betId)).toMatchObject({
        state: 'TERMS_PROPOSED',
        terms_hash: first.terms_hash,
      });
      // the voice judge hears the same reason
      expect(await confirmAndLock(ctx.deps, betId)).toMatchObject({
        ok: false,
        fix: 'QUOTE_STALE',
        reason: 'TOO_CLOSE_TO_EXPIRY',
      });
    });

    it('a re-quote after the rollover moves the bet to the next round, and says so (new line, new end)', async () => {
      const { A, betId } = await newBet();
      const first = MarketTermsResponse.parse(
        (await post(A, marketTermsPath(betId), { side: 'DOWN', amount_usd: '2' })).json,
      );
      expect(first.quote.market.eventTicker).toBe(TICKER);
      // 02:41:57: the relay rolled over to the 02:45 contract (line 64367.38)
      g.routes.set(EVENTS_PATH, F.events_0241);
      g.routes.set(eventPath('BTC05M2611180245'), F.event_0245_active);
      clock.t = T0241;
      await markets.refresh();
      const voice = await confirmAndLock(ctx.deps, betId);
      expect(voice).toMatchObject({ ok: false, fix: 'REQUOTED', new_round: true });
      expect(voice.say).toMatch(
        /^That round closed\. New round: line \$64,367\.38, ends 02:45 UTC\. \$[\d.]+ against \$[\d.]+\. Say yes to lock it\.$/,
      );
      const row = await betRow(betId);
      const terms = Terms.parse(
        JSON.parse(
          (
            await ctx.deps.db
              .select()
              .from(betTermsVersions)
              .where(eq(betTermsVersions.terms_hash, row.terms_hash!))
          )[0]!.canonical_json,
        ),
      );
      expect(terms.market).toMatchObject({
        eventTicker: 'BTC05M2611180245',
        expiry: '2026-11-18T02:45:00.000Z',
      });
      // the typed route: same re-quote path, the message names the new round
      clock.t += MARKET_CONFIRM_MAX_AGE_MS + 1_000;
      await markets.refresh();
      const r = await post(A, termsConfirmPath(betId), { terms_hash: row.terms_hash });
      expect(r.status).toBe(409);
      expect(r.json!.error).toMatchObject({
        code: 'TERMS_HASH_MISMATCH',
        message: "Gemini's odds moved. Review the new split.", // same round as the last re-quote
        details: { reason: 'requoted', new_round: false },
      });
    });

    it('the typed confirm names the new round when a re-quote crosses the rollover', async () => {
      const { A, betId } = await newBet();
      const first = MarketTermsResponse.parse(
        (await post(A, marketTermsPath(betId), { side: 'UP', amount_usd: '1' })).json,
      );
      g.routes.set(EVENTS_PATH, F.events_0241);
      g.routes.set(eventPath('BTC05M2611180245'), F.event_0245_active);
      clock.t = T0241;
      await markets.refresh();
      const r = await post(A, termsConfirmPath(betId), { terms_hash: first.terms_hash });
      expect(r.status).toBe(409);
      expect(r.json!.error).toMatchObject({
        code: 'TERMS_HASH_MISMATCH',
        message: 'New round: line $64,367.38, ends 02:45 UTC. Review the new split.',
        details: { reason: 'requoted', new_round: true },
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

      // SYNTHETIC: the same contract settled the other way (forget the NO body stored above)
      await forgetSettlement(ctx.deps.db);
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
        await forgetSettlement(ctx.deps.db);
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

    it('the fast path (timers): armed at expiry + 5 s, re-polls every 1 s in the band, settles', async () => {
      const { betId } = await lockedBet('UP');
      const timed = installSettlement(ctx.deps, new SettlementService(ctx.deps)); // timers on
      try {
        clock.t = T0240 + 5_000; // the first check is due now
        g.routes.set(eventPath(TICKER), closedNoSide()); // not settled at +5 s
        const calls0 = g.calls.length;
        const terms = Terms.parse(
          JSON.parse(
            (
              await ctx.deps.db
                .select()
                .from(betTermsVersions)
                .where(and(eq(betTermsVersions.bet_id, betId), eq(betTermsVersions.is_final, true)))
            )[0]!.canonical_json,
          ),
        );
        timed.follow(betId, terms);
        await expect.poll(() => g.calls.length - calls0, { timeout: 2_000 }).toBeGreaterThan(0);
        expect(ruled).toHaveLength(0);
        g.routes.set(eventPath(TICKER), F.event_0240_settled); // Gemini settles; 1 s later we see it
        await expect.poll(() => ruled.length, { timeout: 3_000 }).toBe(1);
        expect(ruled[0]).toMatchObject({ betId, ruling: { outcome: 'B_WINS' } });
        await timed.idle();
      } finally {
        timed.stop();
        svc = installSettlement(ctx.deps, new SettlementService(ctx.deps, { timers: false }));
      }
    });

    it('GET /v1/bets/:id/settlement: the evidence chain, for the parties only, once settled', async () => {
      const { A, betId } = await lockedBet('DOWN');
      const read = (u: SignedUp) =>
        fetch(`${ctx.base}/v1/bets/${betId}/settlement`, {
          headers: { Authorization: `Bearer ${u.session.token}` },
        }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
      expect((await read(A)).json.error.code).toBe('NOT_FOUND'); // not settled yet
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      expect(await svc.check(betId)).toBe('settled');
      const ok = await read(A);
      expect(ok.status).toBe(200);
      const ev = SettlementEvidence.parse(ok.json);
      expect(ev.ruling.outcome).toBe('A_WINS');
      expect(ev.raw_body).toBe(JSON.stringify(F.event_0240_settled));
      expect(ev.onchain).toBeNull(); // no chain here (the stub payout seam)
      expect(ev.verification).toEqual({
        ok: true,
        checks: {
          body_matches_record: true,
          record_hash: true,
          ruling_commits_record: true,
          ruling_hash: true,
          outcome_follows_gemini: true,
        },
      });
      const stranger = await signUpAt('Carol');
      expect((await read(stranger)).status).toBe(404);
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

    it('voice propose_terms for a real_world bet speaks Gemini’s split (or its refusal) at once', async () => {
      const args = {
        type: 'real_world',
        claim: 'Bitcoin finishes the current five-minute round at or above the line.',
        performer: 'none',
        yes_party: 'A',
        attempts: { count: 1, rule: 'single' },
        success_criteria: ['Gemini settles the five-minute Bitcoin contract at or above its line.'],
        failure_criteria: [],
        edge_cases: [],
        amount_usd: '5',
        market_side: 'YES',
        deadline_minutes: 0,
      };
      const ev = evaluateProposeTerms(args, { realWorldEnabled: true });
      const template = proposeTermsReply(ev, { rev: 1 });
      expect(template.say).toContain('Gemini sets the odds');
      expect(realWorldReply(ctx.deps, ev, template)).toEqual({
        ...template,
        say: 'Bitcoin finishes the current five-minute round at or above the line. Gemini prices it 61/39: $6.10 against $3.90.',
      });
      // skill bets, refusals and invalid calls pass through untouched
      const skill = evaluateProposeTerms({ ...args, type: 'skill', performer: 'B' }, {});
      expect(realWorldReply(ctx.deps, skill, { ok: true, say: 'x' })).toEqual({
        ok: true,
        say: 'x',
      });
      // a stale snapshot keeps the template (the sink refetches for the binding quote)
      clock.t += 10_000;
      expect(realWorldReply(ctx.deps, ev, template)).toBe(template);
      // too late for this round: refused now, with the next window
      clock.t = Date.parse('2026-11-18T02:38:30.000Z');
      await markets.refresh();
      expect(realWorldReply(ctx.deps, ev, template)).toEqual({
        ok: false,
        fix: 'TOO_CLOSE_TO_EXPIRY',
        say: 'Too late for this round. The next one opens at 02:40 UTC.',
      });
    });

    // ---- one settlement body per contract ------------------------------------------------

    /** SYNTHETIC: the recorded settled body as other bytes (the same JSON, keys reordered). */
    const reorderedSettled = () => {
      const { ticker, ...rest } = clone(F.event_0240_settled) as any;
      return { ...rest, ticker };
    };
    const evidenceOf = async (u: SignedUp, betId: string) => {
      const r = await fetch(`${ctx.base}/v1/bets/${betId}/settlement`, {
        headers: { Authorization: `Bearer ${u.session.token}` },
      });
      expect(r.status).toBe(200);
      return SettlementEvidence.parse(await r.json());
    };

    it('a second bet on the same contract rules on the stored body: both evidence chains keep it', async () => {
      const one = await lockedBet('UP');
      const two = await lockedBet('DOWN');
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      expect(await svc.check(one.betId)).toBe('settled');
      // later, Gemini would answer with other bytes; the second bet does not fetch at all
      g.routes.set(eventPath(TICKER), reorderedSettled());
      clock.t = T0240 + 30_000;
      const calls = g.calls.length;
      expect(await svc.check(two.betId)).toBe('settled');
      expect(g.calls.length).toBe(calls);

      const body = JSON.stringify(F.event_0240_settled);
      const [r1] = await settlementRows(one.betId);
      const [r2] = await settlementRows(two.betId);
      const rec1 = GeminiSettlementRecord.parse(JSON.parse(r1!.evidence_canonical!));
      const rec2 = GeminiSettlementRecord.parse(JSON.parse(r2!.evidence_canonical!));
      // the same fetch: bytes, URL and time; each bet's own record and ruling
      expect(rec2.response_sha256).toBe(sha256Hex(body));
      expect(rec2.response_sha256).toBe(rec1.response_sha256);
      expect(rec2.fetched_at).toBe(rec1.fetched_at);
      expect(rec2.source_url).toBe(rec1.source_url);
      expect(rec2).toMatchObject({ bet_id: two.betId, terms_hash: two.res.terms_hash });
      expect(r2).toMatchObject({ latency_ms: 30_000, created_at: new Date(T0240 + 30_000) });
      expect(ruled.map((r) => [r.betId, r.ruling.outcome])).toEqual([
        [one.betId, 'B_WINS'],
        [two.betId, 'A_WINS'],
      ]);
      for (const [u, id] of [
        [one.A, one.betId],
        [two.A, two.betId],
      ] as const) {
        const ev = await evidenceOf(u, id);
        expect(ev.raw_body).toBe(body);
        expect(ev.verification).toMatchObject({ ok: true, checks: { body_matches_record: true } });
      }
      const [m] = await ctx.deps.db
        .select()
        .from(geminiMarkets)
        .where(eq(geminiMarkets.instrument_symbol, SYMBOL));
      expect(m!.settlement_raw).toBe(body);
    });

    it('two bets settling at once on different bytes: one stores its body, the other retries on it', async () => {
      const one = await lockedBet('UP');
      const two = await lockedBet('DOWN');
      // every fetch of the event gets the next body: the same JSON, different bytes
      const bodies = [JSON.stringify(F.event_0240_settled), JSON.stringify(reorderedSettled())];
      let n = 0;
      const split = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === eventPath(TICKER))
          return new Response(bodies[n++ % 2], { status: 200 });
        return g.fetch(input, init);
      }) as typeof fetch;
      ctx.deps.markets = new MarketService({
        client: createGeminiClient({ fetch: split }),
        now,
        log: silentLogger,
      });
      clock.t = T0240 + 6_000;
      const first = await Promise.all([svc.check(one.betId), svc.check(two.betId)]);
      expect(n).toBe(2);
      expect([...first].sort()).toEqual(['pending', 'settled']);
      const loser = first[0] === 'pending' ? one.betId : two.betId;
      expect(await settlementRows(loser)).toHaveLength(0);
      expect(await svc.check(loser)).toBe('settled'); // on the stored body, no third fetch
      expect(n).toBe(2);
      const shas = await Promise.all(
        [one.betId, two.betId].map(async (id) => {
          const [row] = await settlementRows(id);
          return GeminiSettlementRecord.parse(JSON.parse(row!.evidence_canonical!)).response_sha256;
        }),
      );
      expect(shas[0]).toBe(shas[1]);
      const [m] = await ctx.deps.db
        .select()
        .from(geminiMarkets)
        .where(eq(geminiMarkets.instrument_symbol, SYMBOL));
      expect(sha256Hex(m!.settlement_raw!)).toBe(shas[0]);
      for (const b of [one, two])
        expect((await evidenceOf(b.A, b.betId)).verification.checks.body_matches_record).toBe(true);
    });

    // ---- the resolve deadline, re-sends --------------------------------------------------

    /** A settlement service of its own: its logger, and `view` as the Bet account. */
    function serviceWith(view: () => BetChainView, over: Partial<typeof ctx.deps> = {}) {
      const log = recordingLog();
      const reads = { n: 0 };
      const s = new SettlementService(
        { ...ctx.deps, log, ...over },
        { timers: false, chain: async () => (reads.n++, view()) },
      );
      return { s, log, reads };
    }

    it('Gemini settles inside the resolve-deadline margin: no ruling, left for timeout_refund, one error', async () => {
      const { betId } = await lockedBet('UP');
      // the Bet's resolve_deadline is 20 s after Gemini's answer: inside the 30 s margin
      const { s, log, reads } = serviceWith(() => ({
        kind: 'locked',
        resolveDeadlineMs: T0240 + 26_000,
      }));
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      expect(await s.check(betId)).toBe('skipped');
      expect(await settlementRows(betId)).toHaveLength(0);
      expect((await betRow(betId)).state).toBe('AWAITING_MARKET');
      expect(ruled).toHaveLength(0);
      // nobody was told someone won
      expect(await types(betId)).not.toContain('market.settled');
      expect(await types(betId)).not.toContain('ruling.issued');
      const err = linesOf(log, 'market.settlement_after_deadline', 'error');
      expect(err).toHaveLength(1);
      expect(err[0]![2]).toMatchObject({
        bet_id: betId,
        reason: 'resolve_deadline',
        resolve_deadline: new Date(T0240 + 26_000).toISOString(),
      });
      expect(s.abandonedBets).toEqual([betId]);
      // the sweep and later checks leave it alone: no Gemini call, no chain read, no new line
      const calls = g.calls.length;
      for (let i = 1; i <= 3; i++) {
        clock.t += SETTLE_SWEEP_EVERY_MS;
        expect((await s.sweep(clock.t)).checked).not.toContain(betId);
      }
      expect(await s.check(betId)).toBe('skipped');
      expect(g.calls.length).toBe(calls);
      expect(reads.n).toBe(1);
      expect(log.lines.filter(([l]) => l === 'error')).toHaveLength(1);
    });

    it('a Bet with time left settles as usual; a Bet no longer Locked is never ruled', async () => {
      const far = await lockedBet('UP');
      const gone = await lockedBet('DOWN');
      const ok = serviceWith(() => ({ kind: 'locked', resolveDeadlineMs: T0240 + 3_600_000 }));
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      expect(await ok.s.check(far.betId)).toBe('settled');
      expect(ruled.map((r) => r.betId)).toEqual([far.betId]);
      // the margin is the boundary: 30 s before the deadline is too late
      expect(RESOLVE_DEADLINE_MARGIN_MS).toBe(30_000);

      const refunded = serviceWith(() => ({ kind: 'not_locked', status: 'Refunded' }));
      expect(await refunded.s.check(gone.betId)).toBe('skipped');
      expect(await settlementRows(gone.betId)).toHaveLength(0);
      expect(linesOf(refunded.log, 'market.settlement_after_deadline')[0]![2]).toMatchObject({
        reason: 'bet Refunded onchain',
      });
    });

    it('a resend never overlaps a send still in flight (slow devnet confirm): one resolve', async () => {
      const { betId } = await lockedBet('UP');
      let release!: () => void;
      const confirming = new Promise<void>((r) => (release = r));
      let sends = 0;
      const { s } = serviceWith(() => ({ kind: 'unknown' }), {
        onRuling: async (id, r) => {
          sends++;
          await confirming;
          await ctx.deps.onRuling!(id, r);
        },
      });
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      const first = s.check(betId); // commits, then the resolve takes > 15 s to confirm
      await expect.poll(() => sends).toBe(1);
      clock.t += SETTLE_RESOLVE_GRACE_MS + 1;
      expect((await s.sweep(clock.t)).resent).toEqual([]);
      clock.t += SETTLE_RESOLVE_GRACE_MS;
      expect((await s.sweep(clock.t)).resent).toEqual([]);
      expect(sends).toBe(1);
      release();
      expect(await first).toBe('settled');
      expect(ruled).toHaveLength(1);
    });

    it('a failing resolve is re-sent with backoff (15 s, 30 s, 60 s ...), one error line, then recovers', async () => {
      const { betId } = await lockedBet('UP');
      let sends = 0;
      const { s, log } = serviceWith(() => ({ kind: 'unknown' }), {
        onRuling: async (id, r) => {
          sends++;
          await ctx.deps.onRuling!(id, r);
        },
      });
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      const t0 = T0240 + 6_000;
      clock.t = t0;
      failRuling = true;
      expect(await s.check(betId)).toBe('settled'); // send 1 fails: next try at +15 s
      const resentAt = async (ms: number) => {
        clock.t = t0 + ms;
        return (await s.sweep(clock.t)).resent.includes(betId);
      };
      expect(await resentAt(10_000)).toBe(false);
      expect(await resentAt(15_000)).toBe(true); // send 2 fails: next at +30 s
      expect(await resentAt(25_000)).toBe(false);
      expect(await resentAt(40_000)).toBe(false);
      expect(await resentAt(45_000)).toBe(true); // send 3 fails: next at +60 s
      expect(await resentAt(100_000)).toBe(false);
      expect(await resentAt(105_000)).toBe(true); // send 4 fails: next at +120 s
      expect(sends).toBe(4);
      expect(linesOf(log, 'market.on_ruling_failed', 'error')).toHaveLength(1);
      expect(linesOf(log, 'market.on_ruling_failed', 'error')[0]![2]).toMatchObject({
        retry_in_ms: SETTLE_RESOLVE_GRACE_MS,
      });
      failRuling = false;
      expect(await resentAt(225_000)).toBe(true);
      expect(sends).toBe(5);
      expect(ruled.map((r) => r.betId)).toEqual([betId]);
      expect(linesOf(log, 'market.resolve_recovered')[0]![2]).toMatchObject({ failures: 4 });
    });

    it('re-sends stop at the resolve deadline (committed in time, the RPC down until then)', async () => {
      const a = await lockedBet('UP');
      const deadline = T0240 + 6_000 + 120_000;
      const late = serviceWith(() => ({ kind: 'locked', resolveDeadlineMs: deadline }));
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      clock.t = T0240 + 6_000;
      failRuling = true;
      expect(await late.s.check(a.betId)).toBe('settled');
      expect(await settlementRows(a.betId)).toHaveLength(1);
      clock.t += SETTLE_RESOLVE_GRACE_MS;
      expect((await late.s.sweep(clock.t)).resent).toEqual([a.betId]);
      clock.t = deadline - RESOLVE_DEADLINE_MARGIN_MS;
      expect((await late.s.sweep(clock.t)).resent).toEqual([]);
      expect(late.s.abandonedBets).toEqual([a.betId]);
      expect(linesOf(late.log, 'market.resolve_abandoned', 'error')[0]![2]).toMatchObject({
        bet_id: a.betId,
        reason: 'resolve_deadline',
      });
      clock.t += 600_000;
      failRuling = false;
      expect((await late.s.sweep(clock.t)).resent).toEqual([]);
      expect(ruled).toHaveLength(0);
    });

    it('re-sends stop at once when the payout seam says the Bet is no longer Locked onchain', async () => {
      const b = await lockedBet('DOWN');
      g.routes.set(eventPath(TICKER), F.event_0240_settled);
      let sends = 0;
      const gone = serviceWith(() => ({ kind: 'unknown' }), {
        onRuling: async () => {
          sends++;
          throw new HttpError('INVALID_STATE', 'The bet is no longer Locked onchain.', {
            onchain: 'Refunded',
          });
        },
      });
      clock.t = T0240 + 6_000;
      expect(await gone.s.check(b.betId)).toBe('settled');
      clock.t += 10 * SETTLE_RESOLVE_GRACE_MS;
      expect((await gone.s.sweep(clock.t)).resent).toEqual([]);
      expect(sends).toBe(1);
      expect(linesOf(gone.log, 'market.resolve_abandoned')[0]![2]).toMatchObject({
        reason: 'not_resolvable',
      });
    });

    it('terminalResolveError: ResolveDeadlinePassed (6023) and INVALID_STATE are final; an RPC 429 is not', () => {
      const sim = new SimulationError('resolve', { InstructionError: [1, { Custom: 6023 }] }, []);
      expect(terminalResolveError(sim)).toBe('resolve_deadline_passed');
      expect(terminalResolveError(new HttpError('INVALID_STATE'))).toBe('not_resolvable');
      expect(
        terminalResolveError(
          new SimulationError('resolve', { InstructionError: [1, { Custom: 6000 }] }, []),
        ),
      ).toBeNull();
      expect(terminalResolveError(new Error('rpc 429'))).toBeNull();
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
