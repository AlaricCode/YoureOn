// POST /v1/bets/:id/terms/typed and /terms/confirm (src/terms/routes.ts) against a real Postgres,
// no chain runtime: the typed path runs the same evaluateProposeTerms + persistEvaluation as the
// propose_terms webhook (terms.proposed, guardrail refusal -> CANCELLED) and the same confirm
// step (freeze -> AWAITING_AUTHORIZATIONS). LOCKED with LOCK_SIGNER=server is covered over
// LiteSVM in lifecycle.test.ts ("typed path").
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { auditLog, betEvents, bets, betTermsVersions, createDb } from '@youre-on/db';
import { REFUSAL_QUIPS } from '@youre-on/shared/judge/guardrails';
import type { SpokenBetFixture } from '@youre-on/shared/judge/fixture-schema';
import {
  bottleFlipClaim,
  termsConfirmPath,
  TermsConfirmResponse,
  typedTermsPath,
  typedTermsRequest,
  TypedTermsResponse,
} from '@youre-on/shared/judge/typed-terms';
import { createDeps, startServer } from '../src/server';
import {
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  testEnv,
  type Ctx,
  type SignedUp,
} from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const CHUG = (
  JSON.parse(
    readFileSync(join(here, '../../../packages/shared/src/judge/fixtures/10-chug.json'), 'utf8'),
  ) as SpokenBetFixture
).sample_args as Record<string, unknown>;

describeDb('typed terms: POST /v1/bets/:id/terms/typed + /terms/confirm (DB)', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await startTestServer({ env: { MAX_STAKE_MICRO: '20000000' } });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  const post = (u: SignedUp, path: string, body: unknown, c: Ctx = ctx) => {
    const raw = JSON.stringify(body);
    return postJson(c.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
  const eventTypes = async (id: string) =>
    (
      await ctx.deps.db
        .select({ type: betEvents.type })
        .from(betEvents)
        .where(eq(betEvents.bet_id, id))
        .orderBy(asc(betEvents.seq))
    ).map((r) => r.type);

  async function newBet(c: Ctx = ctx) {
    const A = await signUp(c.base, 'Logan');
    const B = await signUp(c.base, 'Jake');
    const room = await post(A, '/v1/rooms', { name: 'Typed', kind: 'session' }, c);
    expect(room.status).toBe(201);
    expect((await post(B, '/v1/rooms/join', { code: room.json!.code }, c)).status).toBe(200);
    const bet = await post(
      A,
      '/v1/bets',
      {
        room_id: room.json!.room_id,
        opponent_user_id: B.session.user.user_id,
        challenge_method: 'list',
      },
      c,
    );
    expect(bet.status).toBe(201);
    return { A, B, betId: bet.json!.bet.bet_id as string };
  }

  const flip = (stakeUsd = 5) =>
    typedTermsRequest({ claim: bottleFlipClaim('Jake'), stakeUsd, bName: 'Jake' });

  it('A types the bottle flip -> TERMS_PROPOSED, terms.proposed, drafted_by party_a', async () => {
    const { A, betId } = await newBet();
    expect((await betRow(betId)).state).toBe('DRAFTING');
    const r = await post(A, typedTermsPath(betId), flip(5));
    expect(r.status).toBe(200);
    const body = TypedTermsResponse.parse(r.json);
    expect(body).toMatchObject({ ok: true, kind: 'proposed', state: 'TERMS_PROPOSED' });
    const row = await betRow(betId);
    expect(row.state).toBe('TERMS_PROPOSED');
    expect(row.stake_a).toBe(5_000_000n);
    expect(row.terms_hash).toBe(body.ok ? body.terms_hash : null);
    expect(await eventTypes(betId)).toEqual(
      expect.arrayContaining(['terms.proposed', 'bet.state']),
    );
    const [v] = await ctx.deps.db
      .select()
      .from(betTermsVersions)
      .where(eq(betTermsVersions.bet_id, betId));
    expect(v).toMatchObject({ drafted_by: 'party_a', source_tool: 'typed', version: 1 });
    const terms = JSON.parse(v!.canonical_json);
    expect(terms).toMatchObject({
      claim: 'Jake lands a water bottle flip upright on the table. One try.',
      performer: 'B',
      yes_party: 'B',
      attempts: { count: 1, rule: 'single' },
      stakes: { a: '5000000', b: '5000000' },
    });

    // Re-proposing in TERMS_PROPOSED replaces the draft (a new version, a new hash).
    const again = await post(A, typedTermsPath(betId), flip(10));
    expect(again.json).toMatchObject({ ok: true, kind: 'proposed' });
    expect((await betRow(betId)).stake_a).toBe(10_000_000n);
  });

  it('a minimal body (claim + dollars) gets the server defaults; no edge case -> draft', async () => {
    const { A, betId } = await newBet();
    const r = await post(A, typedTermsPath(betId), {
      claim: 'Jake sinks a paper ball in the cup.',
      amount_usd: '1',
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false, kind: 'draft', missing: ['edge_cases'] });
    expect((await betRow(betId)).state).toBe('DRAFTING');
    expect(await eventTypes(betId)).toContain('terms.draft');
    const ok = await post(A, typedTermsPath(betId), {
      claim: 'Jake sinks a paper ball in the cup.',
      amount_usd: '1',
      edge_cases: [{ question: 'Does a bounce count?', answer: 'Yes, if it ends in the cup.' }],
    });
    expect(ok.json).toMatchObject({ ok: true, kind: 'proposed' });
  });

  it('over the stake cap -> draft STAKE_ABOVE_MAX (a counter, not a refusal)', async () => {
    const { A, betId } = await newBet();
    const r = await post(A, typedTermsPath(betId), flip(50));
    expect(r.json).toMatchObject({ ok: false, kind: 'draft', fix: 'STAKE_ABOVE_MAX' });
    expect((await betRow(betId)).state).toBe('DRAFTING');
  });

  it('guardrail refusal: the bet is CANCELLED (refused), terms.refused + judge.cue; then 409', async () => {
    const { A, betId } = await newBet();
    const r = await post(A, typedTermsPath(betId), CHUG);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: false,
      kind: 'refused',
      category: 'alcohol_drugs',
      say: REFUSAL_QUIPS.alcohol_drugs,
    });
    const row = await betRow(betId);
    expect(row).toMatchObject({
      state: 'CANCELLED',
      end_reason: 'refused',
      refusal_category: 'alcohol_drugs',
    });
    expect(await eventTypes(betId)).toEqual(
      expect.arrayContaining(['terms.refused', 'bet.state', 'judge.cue']),
    );
    const audits = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.bet_id, betId), eq(auditLog.action, 'terms.refused_prefilter')));
    expect(audits).toHaveLength(1);
    // A re-worded try cannot talk its way past: the bet is over.
    const again = await post(A, typedTermsPath(betId), flip(1));
    expect(again.status).toBe(409);
    expect(again.json!.error.code).toBe('INVALID_STATE');
  });

  it('non-party and party B: 403 NOT_A_PARTY on both routes; unknown bet 404', async () => {
    const { B, betId } = await newBet();
    const stranger = await signUp(ctx.base, 'Mallory');
    for (const u of [B, stranger]) {
      const t = await post(u, typedTermsPath(betId), flip());
      expect(t.status).toBe(403);
      expect(t.json!.error.code).toBe('NOT_A_PARTY');
      const c = await post(u, termsConfirmPath(betId), { terms_hash: 'ab'.repeat(32) });
      expect(c.status).toBe(403);
      expect(c.json!.error.code).toBe('NOT_A_PARTY');
    }
    expect((await betRow(betId)).state).toBe('DRAFTING');
    const missing = await post(B, typedTermsPath('00000000-0000-4000-8000-000000000000'), flip());
    expect(missing.status).toBe(404);
  });

  it('bad bodies: 422 VALIDATION_FAILED (shape, then the mapping)', async () => {
    const { A, betId } = await newBet();
    const noClaim = await post(A, typedTermsPath(betId), { amount_usd: '5' });
    expect(noClaim.status).toBe(422);
    expect(noClaim.json!.error.code).toBe('VALIDATION_FAILED');
    const badAttempts = await post(A, typedTermsPath(betId), {
      ...flip(),
      attempts: { count: 9, rule: 'single' },
    });
    expect(badAttempts.status).toBe(422);
    expect((await betRow(betId)).state).toBe('DRAFTING');
  });

  it('confirm: wrong state 409, stale hash 409, then freeze -> AWAITING_AUTHORIZATIONS; typed after freeze 409', async () => {
    const { A, betId } = await newBet();
    // DRAFTING: nothing to confirm.
    const early = await post(A, termsConfirmPath(betId), { terms_hash: 'ab'.repeat(32) });
    expect(early.status).toBe(409);
    expect(early.json!.error.code).toBe('INVALID_STATE');

    const p = TypedTermsResponse.parse((await post(A, typedTermsPath(betId), flip(1))).json);
    if (!p.ok) throw new Error('not proposed');
    const stale = await post(A, termsConfirmPath(betId), { terms_hash: 'ab'.repeat(32) });
    expect(stale.status).toBe(409);
    expect(stale.json!.error.code).toBe('TERMS_HASH_MISMATCH');
    expect((await betRow(betId)).state).toBe('TERMS_PROPOSED');

    const c = await post(A, termsConfirmPath(betId), { terms_hash: p.terms_hash });
    expect(c.status).toBe(200);
    const body = TermsConfirmResponse.parse(c.json);
    expect(body.code).toBe(p.code);
    expect(body.say).toContain('Logan, Jake: hold the button');
    const row = await betRow(betId);
    expect(row.terms_final_at).not.toBeNull();
    // No chain runtime here: the lock start fails in the background, the freeze already happened.
    expect(['AWAITING_AUTHORIZATIONS', 'CANCELLED']).toContain(row.state);
    const [v] = await ctx.deps.db
      .select()
      .from(betTermsVersions)
      .where(eq(betTermsVersions.bet_id, betId));
    expect(v!.is_final).toBe(true);
    const [audit] = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.bet_id, betId), eq(auditLog.action, 'bet.state_changed')));
    expect(audit).toMatchObject({ actor_kind: 'user', actor_user_id: A.session.user.user_id });

    const late = await post(A, typedTermsPath(betId), flip(5));
    expect(late.status).toBe(409);
    expect(late.json!.error.code).toBe('INVALID_STATE');
  });

  it('rate limit: the per-(bet, user) bucket answers 429 RATE_LIMITED', async () => {
    const env = testEnv({ MAX_STAKE_MICRO: '20000000' });
    const dbHandle = createDb({ url: env.DATABASE_URL, max: 2 });
    const { deps } = createDeps({ env, dbHandle });
    const server = await startServer(deps, {
      port: 0,
      hostname: '127.0.0.1',
      onClose: () => dbHandle.close(),
    });
    const limited: Ctx = {
      deps,
      dbHandle,
      server,
      base: `http://127.0.0.1:${server.port}`,
      wsUrl: '',
    };
    try {
      const { A, betId } = await newBet(limited);
      const codes: number[] = [];
      for (let i = 0; i < 13; i++)
        codes.push((await post(A, typedTermsPath(betId), flip(1), limited)).status);
      expect(codes.slice(0, 12).every((s) => s === 200)).toBe(true);
      expect(codes[12]).toBe(429);
    } finally {
      await server.close();
    }
  });
});
