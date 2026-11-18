/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and event payloads are loosely typed in tests */
// Odds (API-CONTRACT §2.19, src/odds): the offer / counter protocol over real Postgres (typed
// 15 vs 5 auto-offers, counters, accepts that recompose the card, the confirm gate, withdraw,
// stale taps, the frozen 409s, the balance soft check), the judge's history-grounded suggestion
// (spend off: template / default with no model call; a scripted "live" model: valid, out of band,
// hallucinated, timeout, refusal; stakes always stakesFor(the chosen rung); the cache), the voice
// tools (propose_terms stake_b_usd, confirm_terms ODDS_PENDING -> ODDS_AGREED, suggest_odds),
// the seed-h2h category records and the stats fold. No chain: LOCKED 15/5 and the payouts are
// in lifecycle.test.ts over LiteSVM.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { betEvents, bets, betTermsVersions } from '@youre-on/db';
import { MICRO_PER_USD } from '@youre-on/shared/constants';
import { stakesFor } from '@youre-on/shared/odds-math';
import {
  oddsAcceptPath,
  oddsOfferPath,
  oddsSuggestPath,
  oddsWithdrawPath,
} from '@youre-on/shared/odds';
import {
  bottleFlipClaim,
  termsConfirmPath,
  typedTermsPath,
  typedTermsRequest,
} from '@youre-on/shared/judge/typed-terms';
import type { ElevenLabsClient } from '../src/voice/elevenlabs';
import { createVoiceRoutes } from '../src/voice/routes';
import { createOddsRoutes } from '../src/odds/routes';
import { SuggestCache, suggestOdds } from '../src/odds/suggest';
import { computeStats, type StatsRow } from '../src/odds/stats';
import { assertOddsState } from '../src/odds/service';
import { seedHeadToHead, seedPlan } from '../src/demo/seed-h2h';
import { createLifecycle, installLifecycle } from '../src/lock/runtime';
import { MockLlm, type MockReply } from '../src/providers/mock/llm';
import { routeModules } from '../src/routes';
import { HttpError } from '../src/errors';
import {
  describeDb,
  newKey,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

const SECRET = `tool-secret-${randomUUID()}`;
const AGENT = 'agent_odds_test';
const RUN = randomUUID().slice(0, 8);
const USD = (n: number) => (BigInt(Math.round(n * 100)) * (MICRO_PER_USD / 100n)).toString();
let convN = 0;
const mockEl: ElevenLabsClient = {
  async conversationToken() {
    convN += 1;
    return { token: `tok_${RUN}_${convN}`, conversation_id: `conv_odds_${RUN}_${convN}` };
  },
};

// ---- pure ----------------------------------------------------------------------------------------

describe('computeStats (pure)', () => {
  const me = '11111111-1111-4111-8111-111111111111';
  const them = '22222222-2222-4222-8222-222222222222';
  const row = (o: Partial<StatsRow> & { outcome: StatsRow['outcome'] }): StatsRow => ({
    id: randomUUID(),
    is_seed: false,
    settled_at: new Date(),
    party_a_id: them,
    party_b_id: me,
    title: null,
    t: {
      type: 'skill',
      claim: 'Jake lands a water bottle flip upright on the table.',
      performer: 'B',
      yes_party: 'B',
      success_criteria: [],
    },
    ...o,
  });
  it('categories, performer as A and B, yes_party != performer, voids, legacy seeds, streak', () => {
    const rows: StatsRow[] = [
      row({ outcome: 'party_b' }), // made (B performs, B yes)
      row({ outcome: 'party_b' }), // made
      row({ outcome: 'party_a' }), // missed
      // performer as A, a throw
      row({
        outcome: 'party_a',
        party_a_id: me,
        party_b_id: them,
        t: {
          type: 'skill',
          claim: 'Jake throws a paper ball into the bin.',
          performer: 'A',
          yes_party: 'A',
        },
      }),
      // yes_party != performer: A bet Jake CAN flip it; Jake (B) performs, A is the yes party.
      row({
        outcome: 'party_a',
        t: { type: 'skill', claim: 'Jake lands a bottle flip.', performer: 'B', yes_party: 'A' },
      }), // claim true -> made, though Jake (B) lost the bet
      row({ outcome: 'refund' }), // a void: a push, not a try
      row({ outcome: 'party_b', is_seed: true, t: null, title: 'Demo history: Bottle flip' }), // legacy seed: overall only
      // someone else performs: not mine
      row({
        outcome: 'party_a',
        t: { type: 'skill', claim: 'Logan lands a bottle flip.', performer: 'A', yes_party: 'A' },
      }),
    ];
    const s = computeStats(rows, me, 'bottle_flip');
    expect(s.overall).toEqual({ wins: 4, losses: 3, pushes: 1 });
    expect(s.in_category).toEqual({ made: 3, tries: 4 });
    expect(s.as_performer).toEqual({ made: 4, tries: 5 });
    expect(s.recent).toEqual(['W', 'W', 'L', 'W', 'W']);
    expect(s.streak).toEqual({ kind: 'W', n: 2 });
    expect(s.includes_seed).toBe(true);
    expect(s.category_label).toBe('Bottle flip');
    expect(computeStats(rows, me, 'throw').in_category).toEqual({ made: 1, tries: 1 });
    expect(computeStats([], me, 'other')).toMatchObject({ streak: null, includes_seed: false });
  });
});

describe('seedPlan (pure)', () => {
  it('records must fit the head-to-head; the rest are filler of other categories', () => {
    expect(
      seedPlan(4, 12, [{ player: 'b', category: 'bottle_flip', made: 10, missed: 2 }]),
    ).toMatchObject({
      ok: true,
    });
    expect(
      seedPlan(1, 12, [{ player: 'b', category: 'bottle_flip', made: 10, missed: 2 }]),
    ).toMatchObject({
      ok: false,
    });
    const p = seedPlan(4, 12, [{ player: 'b', category: 'bottle_flip', made: 10, missed: 2 }]);
    if (!p.ok) throw new Error('plan');
    expect(p.bets).toHaveLength(16);
    const flips = p.bets.filter((b) => b.title === 'Bottle flip');
    expect(flips).toHaveLength(12);
    expect(flips.every((b) => b.challenger === 'a')).toBe(true); // Jake is party B, the performer
    expect(flips.filter((b) => b.made)).toHaveLength(10);
  });
});

describe('assertOddsState (pure)', () => {
  const base = {
    state: 'TERMS_PROPOSED',
    evidence_source: 'camera',
    gemini_market_id: null,
  } as any;
  it('locked / no_terms / market_bet', () => {
    const reason = (row: any, o?: any) => {
      try {
        assertOddsState(row, o);
        return null;
      } catch (e) {
        return (e as HttpError).details?.reason;
      }
    };
    expect(reason(base)).toBeNull();
    expect(reason({ ...base, state: 'AWAITING_AUTHORIZATIONS' })).toBe('locked');
    expect(reason({ ...base, state: 'DRAFTING' })).toBe('no_terms');
    expect(reason({ ...base, state: 'DRAFTING' }, { allowDrafting: true })).toBeNull();
    expect(reason({ ...base, evidence_source: 'gemini', gemini_market_id: 1n })).toBe('market_bet');
  });
});

// ---- over Postgres -------------------------------------------------------------------------------

describeDb(
  'odds over Postgres: offers, counters, the gate, the judge suggestion, voice, seed',
  () => {
    let ctx: Ctx;
    const cache = new SuggestCache();
    const keyA = newKey();
    const keyB = newKey();
    const json = (k: typeof keyA) => JSON.stringify([...k.secret]);

    beforeAll(async () => {
      ctx = await startTestServer({
        modules: [
          ...routeModules.filter((r) => r.name !== 'voice' && r.name !== 'odds'),
          createVoiceRoutes({ elevenlabs: mockEl }),
          createOddsRoutes({ cache }),
        ],
        env: {
          ELEVENLABS_AGENT_ID: AGENT,
          ELEVENLABS_TOOL_SECRET: SECRET,
          MAX_STAKE_MICRO: '20000000',
          DEMO_A_SECRET_KEY: json(keyA),
          DEMO_B_SECRET_KEY: json(keyB),
        },
      });
      installLifecycle(ctx.deps, createLifecycle(ctx.deps, { runtime: async () => null }));
    });
    afterAll(async () => {
      await ctx?.server.close();
    });

    const post = (u: SignedUp, path: string, body: unknown = {}) => {
      const raw = JSON.stringify(body);
      return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
    };
    const tool = (name: string, body: unknown, secret: string | null = SECRET) =>
      postJson(
        ctx.base,
        `/el/tools/${name}`,
        body,
        secret === null ? {} : { 'X-YO-Tool-Secret': secret },
      );
    const betRow = async (id: string) =>
      (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
    const events = async (id: string, type?: string) =>
      (
        await ctx.deps.db
          .select({ type: betEvents.type, envelope: betEvents.envelope })
          .from(betEvents)
          .where(
            type
              ? and(eq(betEvents.bet_id, id), eq(betEvents.type, type))
              : eq(betEvents.bet_id, id),
          )
          .orderBy(asc(betEvents.seq))
      ).map((r) => ({ type: r.type, payload: (r.envelope as any).payload }));
    const offers = async (id: string) =>
      (await events(id, 'odds.offered')).map((e) => e.payload.offer);
    const until = async (fn: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('timed out waiting');
    };

    async function pair(o: { A?: SignedUp; B?: SignedUp } = {}) {
      const A = o.A ?? (await signUp(ctx.base, 'Logan'));
      const B = o.B ?? (await signUp(ctx.base, 'Jake'));
      return { A, B };
    }
    async function newBet(o: { A?: SignedUp; B?: SignedUp; voice?: boolean } = {}) {
      const { A, B } = await pair(o);
      const room = await post(A, '/v1/rooms', { name: 'Odds', kind: 'session' });
      expect((await post(B, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
      let conversation_id: string | undefined;
      if (o.voice) {
        const tok = await post(A, '/v1/voice/tokens', { purpose: 'terms' });
        conversation_id = tok.json!.conversation_id;
      }
      const bet = await post(A, '/v1/bets', {
        room_id: room.json!.room_id,
        opponent_user_id: B.session.user.user_id,
        challenge_method: 'list',
        ...(conversation_id ? { voice_conversation_id: conversation_id } : {}),
      });
      expect(bet.status).toBe(201);
      const betId = bet.json!.bet.bet_id as string;
      expect((await post(B, `/v1/bets/${betId}/invite/accept`)).status).toBe(200);
      return { A, B, betId, conversation_id };
    }
    const typed = (u: SignedUp, betId: string, a: number, b?: number) =>
      post(
        u,
        typedTermsPath(betId),
        typedTermsRequest({
          claim: bottleFlipClaim('Jake'),
          stakeUsd: a,
          stakeBUsd: b,
          bName: 'Jake',
        }),
      );

    it('typed 15 vs 5 auto-offers from A; confirm 409 odds_pending; B counters 2:1; A accepts -> new card; confirm', async () => {
      const { A, B, betId } = await newBet();
      const p = await typed(A, betId, 15, 5);
      expect(p.json).toMatchObject({ ok: true, kind: 'proposed' });
      const card1 = p.json!.terms_hash as string;
      const [o1] = await offers(betId);
      expect(o1).toMatchObject({
        n: 1,
        from: 'A',
        stakes: { a: USD(15), b: USD(5) },
        ratio_label: '3 to 1',
        favored: 'A',
        terms_hash: card1,
        parent_id: null,
      });
      const cues = (await events(betId, 'judge.cue')).map((e) => e.payload);
      expect(cues.at(-1)).toMatchObject({ cue: 'ODDS_OFFERED', speak: true });
      expect(cues.at(-1).text).toMatch(/Logan offers 3 to 1/);
      expect((await betRow(betId)).stake_b).toBe(5_000_000n);
      // presentation: "$15 vs $5", "3 to 1"
      const [tp] = (await events(betId, 'terms.proposed')).map(
        (e) => e.payload.envelope.presentation,
      );
      expect(tp).toMatchObject({ stakes_display: '$15 vs $5', odds_display: '3 to 1' });
      expect(tp.readback).toContain(
        'Logan puts in fifteen, Jake puts in five; winner takes twenty.',
      );

      const early = await post(A, termsConfirmPath(betId), { terms_hash: card1 });
      expect(early.status).toBe(409);
      expect(early.json!.error).toMatchObject({
        code: 'INVALID_STATE',
        details: { reason: 'odds_pending' },
      });

      // A can't accept A's own offer; a stale n is refused.
      expect(
        (await post(A, oddsAcceptPath(betId, o1.offer_id), { n: 1 })).json!.error.details.reason,
      ).toBe('own_offer');
      expect(
        (await post(B, oddsAcceptPath(betId, o1.offer_id), { n: 2 })).json!.error.details.reason,
      ).toBe('stale');

      // B counters: 2 to 1, A the favourite, base $5 -> A $10, B $5.
      const c = await post(B, oddsOfferPath(betId), { ratio: '2:1', favored: 'A', base_usd: '5' });
      expect(c.status).toBe(200);
      expect(c.json!.offer).toMatchObject({
        n: 2,
        from: 'B',
        parent_id: o1.offer_id,
        stakes: { a: USD(10), b: USD(5) },
        ratio_label: '2 to 1',
      });
      const answered = (await events(betId, 'odds.answered')).map((e) => e.payload);
      expect(answered).toContainEqual(
        expect.objectContaining({ offer_id: o1.offer_id, answer: 'countered', party: 'B' }),
      );
      expect((await events(betId, 'judge.cue')).at(-1)!.payload.cue).toBe('ODDS_COUNTERED');
      // the old offer is closed
      expect(
        (await post(B, oddsAcceptPath(betId, o1.offer_id), { n: 1 })).json!.error.details.reason,
      ).toBe('not_open');

      const acc = await post(A, oddsAcceptPath(betId, c.json!.offer.offer_id), { n: 2 });
      expect(acc.status).toBe(200);
      expect(acc.json!.agreed).toBe(true);
      const card2 = acc.json!.terms_hash as string;
      expect(card2).not.toBe(card1);
      const row = await betRow(betId);
      expect(row).toMatchObject({ terms_hash: card2, stake_a: 10_000_000n, stake_b: 5_000_000n });
      const types = (await events(betId)).map((e) => e.type);
      expect(types.slice(-4)).toEqual([
        'odds.answered',
        'terms.proposed',
        'odds.agreed',
        'judge.cue',
      ]);
      const versions = await ctx.deps.db
        .select()
        .from(betTermsVersions)
        .where(eq(betTermsVersions.bet_id, betId))
        .orderBy(asc(betTermsVersions.version));
      expect(versions.at(-1)).toMatchObject({
        source_tool: 'odds',
        drafted_by: 'party_a',
        terms_hash: card2,
      });
      // The recomposed card keeps the claim, the edge case and the deadline length.
      const t1 = JSON.parse(versions[0]!.canonical_json);
      const t2 = JSON.parse(versions.at(-1)!.canonical_json);
      expect(t2).toMatchObject({
        claim: t1.claim,
        edge_cases: t1.edge_cases,
        stakes: { a: USD(10), b: USD(5) },
      });
      const mins = (t: any) =>
        Math.round((Date.parse(t.deadline) - Date.parse(t.created_at)) / 60_000);
      expect(mins(t2)).toBe(mins(t1));
      expect((await events(betId, 'judge.cue')).at(-1)!.payload).toMatchObject({
        cue: 'ODDS_AGREED',
        speak: false,
      });

      // The stale card is refused; the agreed card confirms.
      expect((await post(A, termsConfirmPath(betId), { terms_hash: card1 })).status).toBe(409);
      const ok = await post(A, termsConfirmPath(betId), { terms_hash: card2 });
      expect(ok.status).toBe(200);
      expect((await betRow(betId)).state).not.toBe('TERMS_PROPOSED');
      // After the freeze: 409 locked.
      const late = await post(B, oddsOfferPath(betId), { stakes_usd: { a: '5', b: '5' } });
      expect(late.status).toBe(409);
      expect(late.json!.error).toMatchObject({
        message: 'Terms are locked in.',
        details: { reason: 'locked' },
      });
    });

    it('a re-proposal with the agreed stakes needs no re-consent; withdraw; even counter', async () => {
      const { A, B, betId } = await newBet();
      await typed(A, betId, 15, 5);
      const [o1] = await offers(betId);
      // Only the author withdraws.
      expect((await post(B, oddsWithdrawPath(betId, o1.offer_id))).status).toBe(403);
      expect((await post(A, oddsWithdrawPath(betId, o1.offer_id))).status).toBe(200);
      // Withdrawn, but the card is still 15/5 and not agreed: still blocked.
      const card = (await betRow(betId)).terms_hash!;
      expect(
        (await post(A, termsConfirmPath(betId), { terms_hash: card })).json!.error.details.reason,
      ).toBe('odds_pending');
      // A offers it again; B accepts; the same card, no recompose.
      const again = await post(A, oddsOfferPath(betId), { stakes_usd: { a: '15', b: '5' } });
      expect(again.json!.offer.n).toBe(2);
      const acc = await post(B, oddsAcceptPath(betId, again.json!.offer.offer_id), { n: 2 });
      expect(acc.json).toMatchObject({ agreed: true, terms_hash: card });
      // A re-proposes the same stakes (an edge-case edit): agreed already -> no new offer.
      const before = (await offers(betId)).length;
      const p2 = await typed(A, betId, 15, 5);
      expect(p2.json!.terms_hash).not.toBe(card);
      expect((await offers(betId)).length).toBe(before);
      expect(
        (await post(A, termsConfirmPath(betId), { terms_hash: p2.json!.terms_hash })).status,
      ).toBe(200);
    });

    it('validation: per-side max, 10:1, sub-cent, non-party, DRAFTING', async () => {
      const { A, betId } = await newBet();
      expect(
        (await post(A, oddsOfferPath(betId), { stakes_usd: { a: '5', b: '5' } })).json!.error
          .details.reason,
      ).toBe('no_terms');
      await typed(A, betId, 5);
      expect(await offers(betId)).toEqual([]); // even: nothing to agree
      const big = await post(A, oddsOfferPath(betId), { stakes_usd: { a: '21', b: '5' } });
      expect(big.status).toBe(422);
      expect(big.json!.error.details.issue.code).toBe('STAKE_ABOVE_MAX');
      const long = await post(A, oddsOfferPath(betId), { stakes_usd: { a: '11', b: '1' } });
      expect(long.json!.error.details.issue.code).toBe('ODDS_TOO_LONG');
      const cents = await post(A, oddsOfferPath(betId), { stakes_usd: { a: '5.555', b: '1' } });
      expect(cents.json!.error.details.issue.code).toBe('AMBIGUOUS');
      // ...and the typed path refuses 11:1 as a draft issue.
      const t = await typed(A, betId, 11, 1);
      expect(t.json).toMatchObject({ ok: false, kind: 'draft', fix: 'ODDS_TOO_LONG' });
      const stranger = await signUp(ctx.base, 'Mallory');
      expect(
        (await post(stranger, oddsOfferPath(betId), { stakes_usd: { a: '10', b: '5' } })).status,
      ).toBe(403);
    });

    it('balance soft check: the side that cannot cover is named; RPC down skips it', async () => {
      const { A, B, betId } = await newBet();
      await typed(A, betId, 5);
      const balances = new Map([
        [A.wallet.pubkey, 50_000_000n],
        [B.wallet.pubkey, 3_000_000n],
      ]);
      let down = false;
      installLifecycle(
        ctx.deps,
        createLifecycle(ctx.deps, {
          runtime: async () =>
            ({
              mint: 'So11111111111111111111111111111111111111112',
              client: {
                tokenBalanceByOwner: async (owner: string) => {
                  if (down) throw new Error('rpc down');
                  return balances.get(owner) ?? 0n;
                },
              },
            }) as any,
        }),
      );
      try {
        const r = await post(A, oddsOfferPath(betId), { stakes_usd: { a: '5', b: '10' } });
        expect(r.status).toBe(409);
        expect(r.json!.error).toMatchObject({
          code: 'INSUFFICIENT_FUNDS',
          message: "Jake can't cover $10.",
          details: { party: 'B' },
        });
        expect(
          (await post(A, oddsOfferPath(betId), { stakes_usd: { a: '10', b: '3' } })).status,
        ).toBe(200);
        down = true;
        expect(
          (await post(A, oddsOfferPath(betId), { stakes_usd: { a: '5', b: '10' } })).status,
        ).toBe(200);
      } finally {
        installLifecycle(ctx.deps, createLifecycle(ctx.deps, { runtime: async () => null }));
      }
    });

    it('Suggest odds (spend off, no history): the category default, a judge offer both must accept', async () => {
      const { A, B, betId } = await newBet();
      await typed(A, betId, 5);
      const llm = ctx.deps.providers.llm as MockLlm;
      const callsBefore = llm.calls?.length ?? 0;
      const r = await post(B, oddsSuggestPath(betId), {});
      expect(r.status).toBe(200);
      const offer = r.json!.offer;
      expect(offer).toMatchObject({
        from: 'judge',
        stakes: { a: USD(15), b: USD(5) }, // a bottle flip lands ~25%: Logan (betting against) gives 3 to 1
        ratio_label: '3 to 1',
        suggestion: {
          ratio: '3:1',
          favored: 'A',
          chance_pct: 25,
          base_rate_pct: 25,
          source: 'default',
          model: null,
          sample_meaningful: false,
          stats: {
            category: 'bottle_flip',
            in_category: { made: 0, tries: 0 },
            includes_seed: false,
          },
        },
      });
      expect(r.json!.say).toBe(
        "Bottle flips land about a quarter of the time. That's my default. I'd make it three to one: Logan puts in fifteen, Jake puts in five. Both agree?",
      );
      expect(llm.calls?.length ?? 0).toBe(callsBefore);
      expect((await events(betId, 'judge.cue')).at(-1)!.payload).toMatchObject({
        cue: 'ODDS_OFFERED',
        speak: true,
      });
      // Asking again while it's open: the same offer, no new event.
      const n0 = (await offers(betId)).length;
      const again = await post(A, oddsSuggestPath(betId), {});
      expect(again.json!.offer.offer_id).toBe(offer.offer_id);
      expect((await offers(betId)).length).toBe(n0);
      // Both taps.
      const a1 = await post(A, oddsAcceptPath(betId, offer.offer_id), { n: offer.n });
      expect(a1.json!.agreed).toBe(false);
      expect(
        (await post(A, oddsAcceptPath(betId, offer.offer_id), { n: offer.n })).json!.error.details
          .reason,
      ).toBe('already_accepted');
      const b1 = await post(B, oddsAcceptPath(betId, offer.offer_id), { n: offer.n });
      expect(b1.json!.agreed).toBe(true);
      expect(await betRow(betId)).toMatchObject({ stake_a: 15_000_000n, stake_b: 5_000_000n });
      const v = await ctx.deps.db
        .select()
        .from(betTermsVersions)
        .where(eq(betTermsVersions.bet_id, betId))
        .orderBy(asc(betTermsVersions.version));
      expect(v.at(-1)).toMatchObject({ drafted_by: 'judge', source_tool: 'odds' });
      expect(
        (await post(A, termsConfirmPath(betId), { terms_hash: b1.json!.terms_hash })).status,
      ).toBe(200);
    });

    // ---- the demo players, with a seeded record -------------------------------------------------

    let demoA: SignedUp;
    let demoB: SignedUp;
    let demoBet: string;
    it('seed-h2h records: fit check, real terms rows, performer_stats; re-seed replaces', async () => {
      demoA = await signUp(ctx.base, 'Logan', keyA);
      demoB = await signUp(ctx.base, 'Jake', keyB);
      await expect(
        seedHeadToHead(ctx.deps, {
          a_wins: 1,
          b_wins: 12,
          records: [{ player: 'b', category: 'bottle_flip', made: 10, missed: 2 }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const r = await seedHeadToHead(ctx.deps, {
        a_wins: 4,
        b_wins: 12,
        records: [{ player: 'b', category: 'bottle_flip', made: 10, missed: 2 }],
      });
      expect(r).toMatchObject({
        inserted: 16,
        head_to_head: { b_vs_a: { wins: 12, losses: 4, includes_seed: true } },
      });
      expect(r.performer_stats[0]).toMatchObject({
        category: 'bottle_flip',
        in_category: { made: 10, tries: 12 },
        includes_seed: true,
        h2h: { wins: 12, losses: 4 },
      });
      const seeds = await ctx.deps.db
        .select({ id: bets.id, terms_hash: bets.terms_hash, title: bets.title })
        .from(bets)
        .where(and(eq(bets.is_seed, true), eq(bets.party_b_id, demoB.session.user.user_id)));
      expect(seeds.length).toBeGreaterThanOrEqual(12);
      const tv = await ctx.deps.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM bet_terms_versions tv JOIN bets b ON b.id = tv.bet_id
      WHERE b.is_seed AND tv.is_final AND tv.terms_hash = b.terms_hash AND tv.source_tool = 'seed'
        AND (b.party_a_id = ${demoA.session.user.user_id} OR b.party_b_id = ${demoA.session.user.user_id})`);
      expect(tv[0]!.n).toBe(16);
      for (const s of seeds) expect(s.title).toMatch(/^Demo history: /);
      // Re-seeding replaces (the terms rows cascade).
      const again = await seedHeadToHead(ctx.deps, {
        a_wins: 4,
        b_wins: 12,
        records: [{ player: 'b', category: 'bottle_flip', made: 10, missed: 2 }],
      });
      expect(again).toMatchObject({ replaced: 16, inserted: 16 });
      // The history list keeps the labelled titles and carries the other side's stake.
      const hist = await fetch(`${ctx.base}/v1/me/bets?status=settled&limit=20`, {
        headers: { Authorization: `Bearer ${demoA.session.token}` },
      }).then((x) => x.json() as Promise<any>);
      const seeded = hist.items.filter((x: any) => x.is_seed);
      expect(seeded.length).toBe(16);
      for (const x of seeded) {
        expect(x.title).toMatch(/^Demo history: /);
        expect(x.their_stake).toBe(x.my_stake);
      }
    });

    it("the judge's odds quote Jake's real record: 10 for 12 on flips -> 2 to 1, Jake the favourite", async () => {
      const { A, B, betId } = await newBet({ A: demoA, B: demoB });
      demoBet = betId;
      await typed(A, betId, 5);
      const r = await post(A, oddsSuggestPath(betId), {});
      expect(r.json!.offer).toMatchObject({
        stakes: { a: USD(5), b: USD(10) },
        suggestion: {
          ratio: '2:1',
          favored: 'B',
          chance_pct: 69,
          allowed: ['2:1', '3:1'],
          sample_meaningful: true,
          source: 'template',
          stats: {
            in_category: { made: 10, tries: 12 },
            includes_seed: true,
            h2h: { wins: 12, losses: 4 },
          },
        },
      });
      expect(r.json!.say).toBe(
        "Jake is 10 for 12 on bottle flips, and 12-4 against Logan. I'd make it two to one: Logan puts in five, Jake puts in ten. Both agree?",
      );
      expect(B).toBeTruthy();
    });

    it('a scripted live model: valid, out of band, hallucinated, timeout, refusal; never sets stakes', async () => {
      const A = demoA;
      const betId = demoBet;
      const bet = await betRow(betId);
      let script: (() => MockReply | Promise<MockReply>) | null = null;
      const mock = new MockLlm(() => script!());
      const saved = ctx.deps.providers.llm;
      ctx.deps.providers.llm = { name: 'live', chat: (req) => mock.chat(req) };
      const ask = async (
        reply: () => MockReply | Promise<MockReply>,
        o: { timeoutMs?: number } = {},
      ) => {
        script = reply;
        const open = (await offers(betId)).at(-1);
        if (open) await post(A, oddsWithdrawPath(betId, open.offer_id)).catch(() => undefined);
        return suggestOdds(
          ctx.deps,
          await betRow(betId),
          { requestedBy: 'A', via: 'button' },
          {
            cache: new SuggestCache(),
            ...o,
          },
        );
      };
      const stakes = (ratio: '2:1' | '3:1') => {
        const s = stakesFor({
          ratio,
          favored: 'B',
          baseMicro: 5_000_000n,
          maxStake: 20_000_000n,
        }) as any;
        return { a: s.a.toString(), b: s.b.toString() };
      };
      try {
        // valid: the neighbour rung, a facts-only sentence
        let r = await ask(() => ({
          value: { ratio: '3:1', reason: 'Jake has landed 10 of 12 bottle flips.' },
        }));
        expect(r.offer.suggestion).toMatchObject({
          ratio: '3:1',
          source: 'model',
          reason: 'Jake has landed 10 of 12 bottle flips.',
        });
        expect(r.offer.stakes).toEqual(stakes('3:1'));
        const req = mock.calls.at(-1)!;
        expect(req).toMatchObject({
          vendor: 'anthropic',
          model: 'claude-opus-5-5',
          effort: 'low',
          timeoutMs: 3000,
        });
        expect((req.output.jsonSchema as any).properties.ratio.enum).toEqual(['2:1', '3:1']);
        expect((req.parts[0] as any).text).toContain('"made":10');
        // out of band -> the nearest rung (its stakes, not the model's)
        r = await ask(() => ({ value: { ratio: '10:1', reason: 'Jake is 10 for 12.' } }));
        expect(r.offer.suggestion!.ratio).toBe('2:1');
        expect(r.offer.stakes).toEqual(stakes('2:1'));
        // hallucinated numbers -> the template
        r = await ask(() => ({
          value: { ratio: '3:1', reason: 'Jake has landed 9 of his last 10 flips.' },
        }));
        expect(r.offer.suggestion).toMatchObject({ ratio: '2:1', source: 'template' });
        expect(r.offer.suggestion!.reason).toBe(
          'Jake is 10 for 12 on bottle flips, and 12-4 against Logan.',
        );
        // timeout (the model never answers) -> the template, within the deadline
        const t0 = Date.now();
        r = await ask(() => new Promise<MockReply>(() => undefined), { timeoutMs: 50 });
        expect(Date.now() - t0).toBeLessThan(2_000);
        expect(r.offer.suggestion!.source).toBe('template');
        // refusal -> the template
        r = await ask(() => ({ fail: 'refusal' }));
        expect(r.offer.suggestion!.source).toBe('template');
        // a cache hit on the same card: one model call, no duplicate event
        const c = new SuggestCache();
        script = () => ({ value: { ratio: '2:1', reason: 'Jake is 10 for 12 on bottle flips.' } });
        const open = (await offers(betId)).at(-1);
        await post(A, oddsWithdrawPath(betId, open.offer_id));
        const n0 = mock.calls.length;
        const e0 = (await offers(betId)).length;
        const s1 = await suggestOdds(
          ctx.deps,
          await betRow(betId),
          { requestedBy: 'A', via: 'button' },
          { cache: c },
        );
        const s2 = await suggestOdds(
          ctx.deps,
          await betRow(betId),
          { requestedBy: 'A', via: 'button' },
          { cache: c },
        );
        expect(s2.offer.offer_id).toBe(s1.offer.offer_id);
        expect(s2.cached).toBe(true);
        expect(mock.calls.length).toBe(n0 + 1);
        expect((await offers(betId)).length).toBe(e0 + 1);
        // a new card version -> recomputed
        await typed(A, betId, 6);
        await suggestOdds(
          ctx.deps,
          await betRow(betId),
          { requestedBy: 'A', via: 'button' },
          { cache: c },
        );
        expect(mock.calls.length).toBe(n0 + 2);
        expect(bet).toBeTruthy();
      } finally {
        ctx.deps.providers.llm = saved;
      }
    });

    // ---- voice -----------------------------------------------------------------------------------

    it('voice: propose_terms 15 vs 5 reads both stakes; confirm_terms ODDS_PENDING; the taps -> ODDS_AGREED spoken', async () => {
      const { A, B, betId, conversation_id } = await newBet({ voice: true });
      const body = {
        conversation_id,
        bet_id: betId,
        type: 'skill',
        claim: 'Jake lands a water bottle flip upright on the table.',
        performer: 'B',
        yes_party: 'B',
        attempts: { count: 1, rule: 'single' },
        success_criteria: ['The bottle lands upright on its base.'],
        failure_criteria: [],
        edge_cases: [
          { question: 'Does the cap count?', answer: 'No. Only upright on its base counts.' },
        ],
        amount_usd: '15',
        stake_b_usd: '5',
        market_side: 'none',
        deadline_minutes: 0,
      };
      const r = await tool('propose_terms', body);
      expect(r.json).toMatchObject({ ok: true, odds: 'tap_accept', next: 'readback' });
      expect(r.json!.say).toContain(
        'Logan puts in fifteen, Jake puts in five; winner takes twenty.',
      );
      await until(async () => (await betRow(betId)).state === 'TERMS_PROPOSED');
      await until(async () => (await offers(betId)).length === 1);
      const [o] = await offers(betId);
      expect(o).toMatchObject({ from: 'judge', stakes: { a: USD(15), b: USD(5) } });
      expect((await events(betId, 'judge.cue')).at(-1)!.payload).toMatchObject({
        cue: 'ODDS_OFFERED',
        speak: false,
      });

      const c = await tool('confirm_terms', { conversation_id, bet_id: betId, heard: 'both' });
      expect(c.json).toEqual({
        ok: false,
        fix: 'ODDS_PENDING',
        say: 'Odds first. Both of you tap Accept on your phones.',
      });
      expect((await post(A, oddsAcceptPath(betId, o.offer_id), { n: 1 })).json!.agreed).toBe(false);
      expect((await post(B, oddsAcceptPath(betId, o.offer_id), { n: 1 })).json!.agreed).toBe(true);
      const cue = (await events(betId, 'judge.cue')).at(-1)!.payload;
      expect(cue).toMatchObject({ cue: 'ODDS_AGREED', speak: true });
      expect(cue.text).toMatch(
        /^\[EVENT\] ODDS_AGREED a=fifteen b=five :: Say the odds are agreed: Logan fifteen, Jake five\. Then call confirm_terms again\.$/,
      );
      const again = await tool('confirm_terms', { conversation_id, bet_id: betId, heard: 'both' });
      expect(again.json).toMatchObject({ ok: true });
    });

    it('voice: suggest_odds (auth, binding, DRAFTING offer with no card, dedupe)', async () => {
      const { A, betId, conversation_id } = await newBet({ voice: true });
      const body = {
        conversation_id,
        bet_id: betId,
        claim: 'Jake lands a water bottle flip upright on the table.',
        performer: 'B',
        attempts: { count: 1, rule: 'single' },
        base_usd: '5',
      };
      expect((await tool('suggest_odds', body, 'wrong')).status).toBe(401);
      const wrong = await tool('suggest_odds', { ...body, bet_id: randomUUID() });
      expect(wrong.json).toMatchObject({ ok: false, fix: 'WRONG_BET' });
      const r = await tool('suggest_odds', body);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: true, ratio: '3:1', a: '$15', b: '$5', pct: 25 });
      expect(r.json!.say).toMatch(
        /That's my default\. I'd make it three to one: Logan puts in fifteen, Jake puts in five\. Both agree\?$/,
      );
      expect(new TextEncoder().encode(JSON.stringify(r.json)).length).toBeLessThan(300);
      const [o] = await offers(betId);
      expect(o).toMatchObject({ from: 'judge', terms_hash: null });
      expect((await events(betId, 'judge.cue')).at(-1)!.payload).toMatchObject({ speak: false });
      // dedupe within 10 s: the same reply, no new offer
      expect((await tool('suggest_odds', body)).json).toEqual(r.json);
      expect(await offers(betId)).toHaveLength(1);
      // accepting needs a card
      expect(
        (await post(A, oddsAcceptPath(betId, o.offer_id), { n: 1 })).json!.error.details.reason,
      ).toBe('no_terms');
      // no claim
      expect(
        (await tool('suggest_odds', { ...body, claim: '', base_usd: '6' })).json,
      ).toMatchObject({
        ok: false,
        fix: 'NO_CLAIM',
      });
      // the card arrives with the suggested stakes: the open judge offer stays, and now it can be accepted
      await typed(A, betId, 15, 5);
      expect(await offers(betId)).toHaveLength(1);
      expect((await post(A, oddsAcceptPath(betId, o.offer_id), { n: 1 })).json!.agreed).toBe(false);
    });
  },
);
