/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and event payloads are loose here */
// The GG moment + the spoken review request, over HTTP + Postgres (no chain: the review service
// only reads the bet row and its log). The money races (GG / appeal / finalize over the real
// escrow.so) are in gg-review-litesvm.test.ts.
//
//   ReviewService.request   every ReviewFix, once per ruling, "already" for a retry, the
//                           confirm_by cutoff (appeal_deadline − 1 s) and its 1.5 s lead
//   lapse / decline         review.closed + REVIEW_CLOSED (speak:false); only the loser declines
//   POST /el/tools/request_review   401, WRONG_BET (+ audit), SLOW_DOWN, a replayed success
//   gg/record + gg/service  the pair's record before / after (seed history, role swaps, streak)
//   payoutCue               the GG / timeout / review wordings; without ctx, byte-identical
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { auditLog, betEvents, bets, chainTxs, voiceSessions } from '@youre-on/db';
import {
  BetGgPayload,
  recordAfter,
  recordLine,
  REVIEW_MIN_LEAD_MS,
  reviewOpen,
  ReviewRequestedPayload,
  type PairRecord,
} from '@youre-on/shared/gg';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { stageLineFor } from '@youre-on/shared/stage-voice';
import { RateLimiter } from '../src/http/rate-limit';
import { createLifecycle, installLifecycle, type Lifecycle } from '../src/lock/runtime';
import { ggEvents, payoutCueContext } from '../src/gg/service';
import { pairRecord } from '../src/gg/record';
import { payoutCue } from '../src/payout/service';
import { reviewClosedCue } from '../src/review/service';
import { betFacts, randomSig } from './chain-fixtures';
import { mkBetRow, mkUser } from './chain-db';
import {
  DB_URL,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

const ADMIN = 'demo-admin-token-review';
const SECRET = 'tool-secret-review';
const names = { A: 'Logan', B: 'Jake' };
const AAAA_SHA = createHash('sha256').update(Buffer.from('AAAA', 'base64')).digest('hex');

describe('payoutCue: the GG moment wordings (API-CONTRACT §4.5)', () => {
  const amounts = { to_a: 10_000_000n, to_b: 0n };
  const rec: PairRecord = {
    a_wins: 5,
    b_wins: 7,
    pushes: 0,
    total: 12,
    streak: { party: 'A', length: 1 },
    rival: true,
    includes_seed: true,
  };

  it('without a context: byte-identical to the original line (resolve_appeal keeps it)', () => {
    expect(payoutCue('PartyA', amounts, names).text).toBe(
      '[EVENT] PAID winner=Logan amount=$10 to_a=$10 to_b=$0 :: Congratulate Logan in one line.',
    );
    expect(payoutCue('PartyA', amounts, names, { via: 'appeal' }).text).toBe(
      payoutCue('PartyA', amounts, names).text,
    );
    expect(payoutCue('Split', { to_a: 5n, to_b: 5n }, names, { via: 'gg' }).text).toMatch(
      /winner=split .* :: Say it is a split\.$/,
    );
    expect(payoutCue('Refund', { to_a: 5n, to_b: 5n }, names, { via: 'timeout' }).cue).toBe(
      'VOIDED',
    );
  });

  it('GG: via=gg, the loser, the record after; praise the sportsmanship', () => {
    const c = payoutCue('PartyA', amounts, names, { via: 'gg', record: rec });
    expect(c).toMatchObject({ cue: 'PAID', speak: true });
    expect(c.text).toBe(
      '[EVENT] PAID winner=Logan amount=$10 to_a=$10 to_b=$0 via=gg loser=Jake record="Logan 5-7 Jake" :: Jake said GG. Praise the sportsmanship in one short line, then congratulate Logan.',
    );
    // no record (it could not be read): no record value, same instruction
    expect(payoutCue('PartyA', amounts, names, { via: 'gg', record: null }).text).not.toContain(
      'record=',
    );
  });

  it('timeout: no GG; a lapsed or declined review says so', () => {
    const t = (review?: 'lapsed' | 'declined' | null) =>
      payoutCue('PartyB', { to_a: 0n, to_b: 4_000_000n }, names, { via: 'timeout', review }).text;
    expect(t()).toBe(
      '[EVENT] PAID winner=Jake amount=$4 to_a=$0 to_b=$4 via=timeout loser=Logan :: No GG from Logan; the clock ran out. Congratulate Jake in one line.',
    );
    expect(t('lapsed')).toBe(
      '[EVENT] PAID winner=Jake amount=$4 to_a=$0 to_b=$4 via=timeout loser=Logan review=lapsed :: Logan did not confirm the review, so the ruling stands. Congratulate Jake in one line.',
    );
    expect(t('declined')).toMatch(/review=declined :: Logan kept the ruling\. Congratulate Jake/);
  });

  it('ASCII, at most 300 chars, the stage reads the GG line', () => {
    const long = { A: 'Zoë Alexandra Montgomery-Smith', B: 'Bartholomew Fitzgerald III' };
    for (const ctx of [
      { via: 'gg' as const, record: rec },
      { via: 'timeout' as const, review: 'lapsed' as const },
    ]) {
      const c = payoutCue('PartyA', amounts, long, ctx);
      expect(c.text.length).toBeLessThanOrEqual(300);
      expect(c.text).toMatch(/^[\x20-\x7e]+$/);
    }
    const gg = payoutCue('PartyA', amounts, names, { via: 'gg', record: rec });
    expect(stageLineFor({ type: 'judge.cue', payload: gg }, { A: 'Logan', B: 'Jake' })).toEqual({
      voice: 'judge',
      text: 'Jake says GG. Logan takes $10.',
    });
    const plain = payoutCue('PartyA', amounts, names, { via: 'timeout' });
    expect(stageLineFor({ type: 'judge.cue', payload: plain }, { A: null, B: null })!.text).toBe(
      'Paid. Logan takes $10.',
    );
  });

  it('REVIEW_CLOSED is a context update, never spoken', () => {
    expect(reviewClosedCue('Jake', 'declined')).toEqual({
      cue: 'REVIEW_CLOSED',
      text: '[EVENT] REVIEW_CLOSED by=Jake reason=declined :: Do not speak. Jake kept the ruling.',
      speak: false,
    });
    expect(reviewClosedCue('Jake', 'lapsed').text).toBe(
      '[EVENT] REVIEW_CLOSED by=Jake reason=lapsed :: Do not speak. The review was not confirmed; the ruling stands.',
    );
  });
});

describe('RateLimiter.remaining (read-only)', () => {
  it('counts whole tokens without taking one', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const spec = { limit: 3, windowMs: 3_600_000 };
    expect(rl.remaining('appeal', 'u', spec)).toBe(3);
    rl.take('appeal', 'u', spec);
    rl.take('appeal', 'u', spec);
    expect(rl.remaining('appeal', 'u', spec)).toBe(1);
    expect(rl.remaining('appeal', 'u', spec)).toBe(1); // reading spends nothing
    rl.take('appeal', 'u', spec);
    expect(rl.remaining('appeal', 'u', spec)).toBe(0);
    t += 1_200_000; // one token refills per 20 min
    expect(rl.remaining('appeal', 'u', spec)).toBe(1);
  });
});

const run = DB_URL ? describe : describe.skip;

run('review requests + the GG record (Postgres)', () => {
  let ctx: Ctx;
  let lc: Lifecycle;
  let offset = 0;
  const now = () => Date.now() + offset;
  let A: SignedUp;
  let B: SignedUp;
  const uid = (u: SignedUp) => u.session.user.user_id;

  beforeAll(async () => {
    ctx = await startTestServer({
      now,
      env: { DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: ADMIN, ELEVENLABS_TOOL_SECRET: SECRET },
    });
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, { runtime: async () => null, timers: false }),
    );
    A = await signUp(ctx.base, 'Logan');
    B = await signUp(ctx.base, 'Jake');
  });
  afterAll(async () => {
    lc?.stop();
    await ctx?.server.close();
  });

  /** A bet row in `state` (no chain): RULED with an appeal window `windowMs` from now. */
  async function bet(
    o: {
      state?: (typeof bets.$inferInsert)['state'];
      outcome?: 'party_a' | 'party_b' | 'refund' | 'split' | null;
      windowMs?: number;
      extra?: Partial<typeof bets.$inferInsert>;
    } = {},
  ) {
    const f = betFacts();
    return mkBetRow(ctx.deps.db, f, {
      partyA: uid(A),
      partyB: uid(B),
      state: o.state ?? 'RULED',
      extra: {
        outcome: o.outcome === undefined ? 'party_a' : o.outcome,
        appeal_deadline: new Date(now() + (o.windowMs ?? 10_000)),
        ruling_hash: 'ab'.repeat(32),
        ...o.extra,
      },
    });
  }
  const events = async (betId: string) =>
    (
      await ctx.deps.db
        .select()
        .from(betEvents)
        .where(eq(betEvents.bet_id, betId))
        .orderBy(asc(betEvents.seq))
    ).map((e) => e.envelope as any);
  const request = (betId: string, o: Partial<Parameters<Lifecycle['review']['request']>[1]> = {}) =>
    lc.review.request(betId, { source: 'demo', ...o });
  const admin = (path: string, body: unknown = {}) =>
    postJson(ctx.base, path, body, { 'X-YO-Demo-Key': ADMIN });
  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, method, path, raw, { ts: now() }));
  };

  it('accepts a request: review.requested to the loser, confirm_by = appeal_deadline − 1 s, heard only in the audit', async () => {
    const id = await bet({ outcome: 'party_a' });
    const row = (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)))[0]!;
    const r = await request(id, { source: 'voice', heard: `check that again ${'x'.repeat(200)}` });
    expect(r).toMatchObject({ ok: true, already: false, loser_name: 'Jake' });
    if (!r.ok) throw new Error('refused');
    expect(r.review).toMatchObject({ for_party: 'B', source: 'voice' });
    expect(Date.parse(r.review.confirm_by)).toBe(row.appeal_deadline!.getTime() - 1_000);
    const ev = await events(id);
    expect(ev.map((e) => e.type)).toEqual(['review.requested']);
    expect(parseRealtimeEvent(ev[0]).ok).toBe(true); // the shared wire contract
    expect(JSON.stringify(ev[0])).not.toContain('check that again'); // never broadcast
    const [audit] = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.bet_id, id), eq(auditLog.action, 'review.requested')));
    expect(audit!.actor_kind).toBe('judge');
    expect((audit!.details as any).heard).toHaveLength(80);
    expect((audit!.details as any).heard).toMatch(/^check that again/);

    // A retry / a second phrase while it is open: "already", the same review, no new event.
    const again = await request(id, { source: 'voice', heard: "that's wrong" });
    expect(again).toMatchObject({ ok: true, already: true, review: r.review });
    expect((await events(id)).map((e) => e.type)).toEqual(['review.requested']);
    // the client rule
    expect(reviewOpen({ ...r.review, closed: null, confirmed: false }, 'RULED', now())).toBe(true);
    expect(
      reviewOpen({ ...r.review, closed: null, confirmed: false }, 'RULED', now() + 10_000),
    ).toBe(false);
    expect(reviewOpen({ ...r.review, closed: null, confirmed: true }, 'RULED', now())).toBe(false);
    expect(reviewOpen({ ...r.review, closed: null, confirmed: false }, 'CONCEDED', now())).toBe(
      false,
    );
  });

  it('every refusal (ReviewFix) by state, outcome and evidence; none writes an event', async () => {
    const cases: Array<[string, Parameters<typeof bet>[0], string]> = [
      ['before the ruling', { state: 'LOCKED', outcome: null }, 'NO_RULING'],
      ['the camera is judging', { state: 'JUDGING', outcome: null }, 'NO_RULING'],
      ['GG sent', { state: 'CONCEDED' }, 'GG_CALLED'],
      ['GG paid', { state: 'PAID', extra: { payout_via: 'concede' } }, 'GG_CALLED'],
      ['finalized', { state: 'FINALIZED' }, 'FINAL'],
      ['paid by the clock', { state: 'PAID', extra: { payout_via: 'finalize' } }, 'FINAL'],
      ['void paid', { state: 'VOIDED', outcome: 'refund' }, 'FINAL'],
      ['with the panel', { state: 'APPEALED' }, 'WITH_PANEL'],
      ['panel decided', { state: 'APPEAL_RESOLVED' }, 'WITH_PANEL'],
      ['a void ruling', { outcome: 'refund' }, 'NO_LOSER'],
      ['a split', { outcome: 'split' }, 'NO_LOSER'],
    ];
    for (const [why, o, fix] of cases) {
      const id = await bet(o);
      expect([why, await request(id)]).toEqual([why, expect.objectContaining({ ok: false, fix })]);
      expect([why, (await events(id)).length]).toEqual([why, 0]);
    }
    expect(await request(randomUUID())).toMatchObject({ ok: false, fix: 'WRONG_BET' });
  });

  it('a market bet: MARKET (no reviews on Gemini settlements)', async () => {
    const [m] = await ctx.deps.db.execute<{ id: string }>(
      // a minimal gemini_markets row for the bets_gemini_market CHECK
      (await import('drizzle-orm'))
        .sql`INSERT INTO gemini_markets (event_ticker, instrument_symbol, expires_at)
        VALUES ('BTC05MTEST', ${`GEMI-BTC05M-${randomUUID()}`}, now()) RETURNING id`,
    );
    const id = await bet({
      extra: { evidence_source: 'gemini', gemini_market_id: m!.id, a_position: 'yes' },
    });
    expect(await request(id)).toMatchObject({ ok: false, fix: 'MARKET' });
  });

  it('an appeal already signed / sent: WITH_PANEL (the ruling is with the panel)', async () => {
    const id = await bet();
    await ctx.deps.db.insert(chainTxs).values({
      bet_id: id,
      kind: 'appeal',
      signer_role: 'party_b',
      message_b64: 'AAAA',
      message_sha256: AAAA_SHA,
      signature: randomSig(),
      expected_status: 'appealed',
      status: 'sent',
      sent_at: new Date(),
    });
    expect(await request(id)).toMatchObject({ ok: false, fix: 'WITH_PANEL' });
  });

  it('the cutoff: accepted until confirm_by − 1.5 s, WINDOW_CLOSED from there (never extended)', async () => {
    // confirm_by = deadline − 1 s; the last accepted instant is confirm_by − 1501 ms.
    const late = await bet({ windowMs: 1_000 + REVIEW_MIN_LEAD_MS });
    expect(await request(late)).toMatchObject({ ok: false, fix: 'WINDOW_CLOSED' });
    const atEdge = await bet({ windowMs: 1_000 + REVIEW_MIN_LEAD_MS - 100 });
    expect(await request(atEdge)).toMatchObject({ ok: false, fix: 'WINDOW_CLOSED' });
    const inTime = await bet({ windowMs: 1_000 + REVIEW_MIN_LEAD_MS + 200 });
    const r = await request(inTime);
    expect(r).toMatchObject({ ok: true, already: false });
    // confirm_by is the appeal cutoff, fixed at the ruling: a second ask never moves it.
    const row = (await ctx.deps.db.select().from(bets).where(eq(bets.id, inTime)))[0]!;
    expect(r.ok && Date.parse(r.review.confirm_by)).toBe(row.appeal_deadline!.getTime() - 1_000);
    expect((await request(inTime)).ok && true).toBe(true);
    // Past confirm_by an open review is not "already" any more: the window is shut.
    offset += 2_000;
    expect(await request(inTime)).toMatchObject({ ok: false, fix: 'ONE_REVIEW' });
    offset -= 2_000;
  });

  it('no appeals left this hour (read-only bucket): NO_APPEALS_LEFT; the bucket is untouched', async () => {
    const id = await bet();
    const seen: string[] = [];
    expect(
      await request(id, {
        appealsLeft: (u) => {
          seen.push(u);
          return 0;
        },
      }),
    ).toMatchObject({ ok: false, fix: 'NO_APPEALS_LEFT' });
    expect(seen).toEqual([uid(B)]); // the loser's bucket, not the caller's
    expect(await request(id, { appealsLeft: () => 1 })).toMatchObject({ ok: true });
  });

  it('lapse at confirm_by: review.closed lapsed + REVIEW_CLOSED (speak:false); once; ONE_REVIEW after', async () => {
    const id = await bet();
    const r = await request(id);
    if (!r.ok) throw new Error('refused');
    expect(await lc.review.lapse(id, r.review.review_id)).toBe(true);
    expect(await lc.review.lapse(id, r.review.review_id)).toBe(false); // once
    const ev = await events(id);
    expect(ev.map((e) => e.type)).toEqual(['review.requested', 'review.closed', 'judge.cue']);
    expect(ev[1].payload).toEqual({ review_id: r.review.review_id, reason: 'lapsed' });
    expect(ev[2].payload).toMatchObject({ cue: 'REVIEW_CLOSED', speak: false });
    for (const e of ev) expect(parseRealtimeEvent(e).ok).toBe(true);
    expect(await request(id)).toMatchObject({ ok: false, fix: 'ONE_REVIEW' });
    // The PAID line after it says the review lapsed.
    const c = await ctx.deps.db.transaction((tx) =>
      payoutCueContext(tx, { id, outcome: 'party_a' }, 'finalize'),
    );
    expect(c).toEqual({ via: 'timeout', review: 'lapsed' });
  });

  it('lapse is a no-op once the ruling moved on (GG / appeal / finalize)', async () => {
    for (const state of ['CONCEDED', 'APPEALED', 'FINALIZED'] as const) {
      const id = await bet();
      const r = await request(id);
      if (!r.ok) throw new Error('refused');
      await ctx.deps.db.execute(
        (await import('drizzle-orm')).sql`UPDATE bets SET state = ${state} WHERE id = ${id}`,
      );
      expect([state, await lc.review.lapse(id, r.review.review_id)]).toEqual([state, false]);
    }
    // ...and while the loser's appeal is out (signed / sent), even though the bet is still RULED.
    const id = await bet();
    const r = await request(id);
    if (!r.ok) throw new Error('refused');
    await ctx.deps.db.insert(chainTxs).values({
      bet_id: id,
      kind: 'appeal',
      signer_role: 'party_b',
      message_b64: 'AAAA',
      message_sha256: AAAA_SHA,
      signature: randomSig(),
      expected_status: 'appealed',
      status: 'signed',
    });
    expect(await lc.review.lapse(id, r.review.review_id)).toBe(false);
  });

  it('decline (POST /review/decline): only the loser; idempotent; the PAID line says they kept it', async () => {
    const id = await bet({ outcome: 'party_a' }); // B lost
    const path = `/v1/bets/${id}/review/decline`;
    expect((await signed(B, 'POST', path)).json!.error.code).toBe('INVALID_STATE'); // no review
    const r = await request(id);
    if (!r.ok) throw new Error('refused');
    const winner = await signed(A, 'POST', path);
    expect(winner.status).toBe(403);
    expect(winner.json!.error.code).toBe('NOT_LOSER');
    const ok = await signed(B, 'POST', path);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ status: 'closed' });
    expect((await signed(B, 'POST', path)).json).toEqual({ status: 'closed' }); // idempotent
    const ev = await events(id);
    expect(ev.filter((e) => e.type === 'review.closed').map((e) => e.payload.reason)).toEqual([
      'declined',
    ]);
    expect(ev.at(-1).payload.text).toBe(
      '[EVENT] REVIEW_CLOSED by=Jake reason=declined :: Do not speak. Jake kept the ruling.',
    );
    expect(await request(id)).toMatchObject({ ok: false, fix: 'ONE_REVIEW' });
    const c = await ctx.deps.db.transaction((tx) =>
      payoutCueContext(tx, { id, outcome: 'party_a' }, 'finalize'),
    );
    expect(c).toEqual({ via: 'timeout', review: 'declined' });
    // a stranger
    const C = await signUp(ctx.base, 'Mo');
    expect((await signed(C, 'POST', path)).json!.error.code).toBe('NOT_A_PARTY');
  });

  it('a request nobody closed (its timer lost to a restart) still reads as lapsed at PAID', async () => {
    const id = await bet();
    expect((await request(id)).ok).toBe(true);
    const c = await ctx.deps.db.transaction((tx) =>
      payoutCueContext(tx, { id, outcome: 'party_a' }, 'finalize'),
    );
    expect(c).toEqual({ via: 'timeout', review: 'lapsed' });
    const none = await bet();
    expect(
      await ctx.deps.db.transaction((tx) =>
        payoutCueContext(tx, { id: none, outcome: 'party_a' }, 'finalize'),
      ),
    ).toEqual({ via: 'timeout', review: null });
    expect(
      await ctx.deps.db.transaction((tx) =>
        payoutCueContext(tx, { id: none, outcome: 'refund' }, 'finalize'),
      ),
    ).toBeUndefined();
  });

  it('the lapse timer fires at confirm_by by itself (timers on)', async () => {
    const own = createLifecycle(ctx.deps, { runtime: async () => null });
    try {
      const id = await bet({ windowMs: 1_000 + REVIEW_MIN_LEAD_MS + 300 });
      const r = await own.review.request(id, { source: 'demo' });
      expect(r.ok).toBe(true);
      await new Promise((res) => setTimeout(res, 2_100)); // confirm_by is ~1.8 s away
      const ev = await events(id);
      expect(ev.map((e) => e.type)).toEqual(['review.requested', 'review.closed', 'judge.cue']);
    } finally {
      own.stop();
    }
  });

  it('POST /v1/demo/bets/:id/review (the laptop fallback): 200 + say, 409 + fix', async () => {
    const id = await bet({ outcome: 'party_b' }); // A lost
    const ok = await admin(`/v1/demo/bets/${id}/review`);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      ok: true,
      say: 'Review requested. Logan, confirm on your phone.',
      review: { for_party: 'A', source: 'demo' },
    });
    const again = await admin(`/v1/demo/bets/${id}/review`);
    expect(again.json).toMatchObject({
      ok: true,
      already: true,
      say: "Already asked. Logan, it's on your phone.",
    });
    const no = await admin(`/v1/demo/bets/${await bet({ state: 'CONCEDED' })}/review`);
    expect(no.status).toBe(409);
    expect(no.json).toEqual({
      ok: false,
      fix: 'GG_CALLED',
      say: 'GG was called. The ruling stands.',
    });
    expect((await postJson(ctx.base, `/v1/demo/bets/${id}/review`, {})).status).toBe(404);
  });

  describe('POST /el/tools/request_review (the voice tool)', () => {
    const tool = (body: unknown, secret: string | null = SECRET) =>
      postJson(
        ctx.base,
        '/el/tools/request_review',
        body,
        secret === null ? {} : { 'X-YO-Tool-Secret': secret },
      );
    async function bound(betId: string) {
      const conv = `conv_${randomUUID()}`;
      await ctx.deps.db.insert(voiceSessions).values({
        bet_id: betId,
        user_id: uid(A),
        purpose: 'terms',
        el_agent_id: 'agent_test',
        el_conversation_id: conv,
      });
      return conv;
    }

    it('401 without the secret; WRONG_BET (+ audit) for a conversation of another bet', async () => {
      const id = await bet();
      const conv = await bound(id);
      const body = { conversation_id: conv, bet_id: id, heard: 'check that again' };
      expect((await tool(body, null)).status).toBe(401);
      expect((await tool(body, 'nope')).status).toBe(401);
      const other = await bet();
      const wrong = await tool({ ...body, bet_id: other });
      expect(wrong.status).toBe(200);
      expect(wrong.json).toEqual({
        ok: false,
        fix: 'WRONG_BET',
        say: "That's not this bet's docket.",
      });
      const missing = await tool({ heard: 'x' });
      expect(missing.json).toMatchObject({ fix: 'WRONG_BET' });
      await new Promise((r) => setTimeout(r, 50)); // the audit insert is off the reply path
      const audits = await ctx.deps.db
        .select()
        .from(auditLog)
        // audited under the conversation's own bet, with the bet it claimed
        .where(and(eq(auditLog.bet_id, id), eq(auditLog.action, 'el_tool.wrong_bet')));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details as any).toMatchObject({
        tool: 'request_review',
        reason: 'bet_mismatch',
        claimed_bet_id: other,
      });
      expect((await events(id)).length).toBe(0);
    });

    it('a bound call asks the loser; the reply is under 300 B; a retry is replayed, a new phrase is "already"', async () => {
      const id = await bet({ outcome: 'party_a' });
      const conv = await bound(id);
      const body = { conversation_id: conv, bet_id: id, heard: 'No way. Check that again.' };
      const r = await tool(body);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true, say: 'Review requested. Jake, confirm on your phone.' });
      expect(Buffer.byteLength(JSON.stringify(r.json))).toBeLessThan(300);
      expect((await tool(body)).json).toEqual(r.json); // dedupe replay (10 s)
      expect((await tool({ ...body, heard: 'review it' })).json).toEqual({
        ok: true,
        already: true,
        say: "Already asked. Jake, it's on your phone.",
      });
      expect((await events(id)).filter((e) => e.type === 'review.requested')).toHaveLength(1);
    });

    it('after GG / with the panel / after PAID the judge is told to decline politely', async () => {
      for (const [o, fix, say] of [
        [{ state: 'CONCEDED' }, 'GG_CALLED', 'GG was called. The ruling stands.'],
        [{ state: 'APPEALED' }, 'WITH_PANEL', "It's already with the panel."],
        [{ state: 'PAID', extra: { payout_via: 'finalize' } }, 'FINAL', 'The ruling is final.'],
        [{ windowMs: 2_000 }, 'WINDOW_CLOSED', 'Too late. The ruling stands.'],
      ] as const) {
        const id = await bet(o as any);
        const conv = await bound(id);
        const r = await tool({ conversation_id: conv, bet_id: id, heard: 'check it' });
        expect(r.json).toEqual({ ok: false, fix, say });
      }
    });

    it('30/min per conversation: SLOW_DOWN (and no 429)', async () => {
      const saved = ctx.deps.rateLimit;
      ctx.deps.rateLimit = new RateLimiter(now);
      try {
        const id = await bet();
        const conv = await bound(id);
        let last: any;
        for (let i = 0; i < 31; i++)
          last = await tool({ conversation_id: conv, bet_id: id, heard: `again ${i}` });
        expect(last.status).toBe(200);
        expect(last.json).toEqual({
          ok: false,
          fix: 'SLOW_DOWN',
          say: 'One at a time. Say that again.',
        });
      } finally {
        ctx.deps.rateLimit = saved;
      }
    });
  });

  describe('the GG record (gg/record.ts, gg/service.ts)', () => {
    /** A settled history row between the pair (as seed-h2h writes them). */
    async function settled(
      pa: string,
      pb: string,
      outcome: 'party_a' | 'party_b' | 'refund',
      dayAgo: number,
    ) {
      const at = new Date(now() - dayAgo * 86_400_000);
      await ctx.deps.db.insert(bets).values({
        id: randomUUID(),
        party_a_id: pa,
        party_b_id: pb,
        party_a_wallet: betFacts().party_a,
        party_b_wallet: betFacts().party_b,
        challenge_method: 'face',
        title: 'History',
        evidence_source: 'camera',
        state: 'PAID',
        onchain_status: 'settled',
        mint: betFacts().mint,
        stake_a: 1_000_000n,
        stake_b: 1_000_000n,
        terms_hash: betFacts().terms_hash,
        outcome,
        payout_a: outcome === 'party_a' ? 2_000_000n : outcome === 'refund' ? 1_000_000n : 0n,
        payout_b: outcome === 'party_b' ? 2_000_000n : outcome === 'refund' ? 1_000_000n : 0n,
        payout_via: 'concede',
        settled_at: at,
        created_at: at,
        is_seed: true,
      });
    }

    it("before = the pair in this bet's parties (roles swapped in history), streak, rival; after ticks over", async () => {
      const X = await mkUser(ctx.deps.db, 'Logan');
      const Y = await mkUser(ctx.deps.db, 'Jake');
      expect(await pairRecord(ctx.deps.db, X, Y)).toEqual({
        a_wins: 0,
        b_wins: 0,
        pushes: 0,
        total: 0,
        streak: null,
        rival: false,
        includes_seed: false,
      });
      // oldest first: X wins, push, Y wins (Y was challenger), Y wins, Y wins (X challenger)
      await settled(X, Y, 'party_a', 5);
      await settled(X, Y, 'refund', 4);
      await settled(Y, X, 'party_a', 3);
      await settled(Y, X, 'party_a', 2);
      await settled(X, Y, 'party_b', 1);
      const before = await pairRecord(ctx.deps.db, X, Y);
      expect(before).toEqual({
        a_wins: 1,
        b_wins: 3,
        pushes: 1,
        total: 5,
        streak: { party: 'B', length: 3 },
        rival: true,
        includes_seed: true,
      });
      // the same pair from Y's side as challenger: parties swap, nothing else
      expect(await pairRecord(ctx.deps.db, Y, X)).toMatchObject({
        a_wins: 3,
        b_wins: 1,
        streak: { party: 'A', length: 3 },
      });
      const afterX = recordAfter(before, 'A');
      expect(afterX).toMatchObject({
        a_wins: 2,
        b_wins: 3,
        total: 6,
        streak: { party: 'A', length: 1 },
      });
      expect(recordAfter(before, 'B').streak).toEqual({ party: 'B', length: 4 });
      expect(recordLine(afterX, names)).toBe('Logan 2-3 Jake');
      expect(recordAfter({ ...before, total: 1, rival: false }, 'A').rival).toBe(false);
    });

    it('bet.gg: who said GG, what it pays, the record before / after (4-7 -> 5-7)', async () => {
      const X = await mkUser(ctx.deps.db, 'Logan');
      const Y = await mkUser(ctx.deps.db, 'Jake');
      for (let i = 0; i < 4; i++) await settled(X, Y, 'party_a', 20 - i);
      for (let i = 0; i < 7; i++) await settled(Y, X, 'party_a', 10 - i);
      const f = betFacts({ stake_a: '5000000', stake_b: '5000000' });
      const id = await mkBetRow(ctx.deps.db, f, {
        partyA: X,
        partyB: Y,
        state: 'CONCEDED',
        extra: { outcome: 'party_a', appeal_deadline: new Date(now() + 5_000) },
      });
      const row = (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)))[0]!;
      const envs = await ctx.deps.db.transaction((tx) => ggEvents(ctx.deps, tx, row, now()));
      expect(envs).toHaveLength(1);
      expect(parseRealtimeEvent(envs[0]).ok).toBe(true);
      const p = BetGgPayload.parse(envs[0]!.payload);
      expect(p).toMatchObject({ by: 'B', winner: 'A', to_a: '10000000', to_b: '0' });
      expect(p.record!.before).toMatchObject({ a_wins: 4, b_wins: 7, total: 11, rival: true });
      expect(p.record!.after).toMatchObject({ a_wins: 5, b_wins: 7, total: 12 });
      expect(p.record!.before.streak).toEqual({ party: 'B', length: 7 });
      expect(p.record!.after.streak).toEqual({ party: 'A', length: 1 });
      // The PAID cue reads it back from the log.
      const c = await ctx.deps.db.transaction((tx) =>
        payoutCueContext(tx, { id, outcome: 'party_a' }, 'concede'),
      );
      expect(c).toEqual({ via: 'gg', record: p.record!.after });
      expect(payoutCue('PartyA', { to_a: 10_000_000n, to_b: 0n }, names, c).text).toContain(
        'record="Logan 5-7 Jake" :: Jake said GG.',
      );
      // No loser (refund): no bet.gg.
      const v = { ...row, outcome: 'refund' as const };
      expect(await ctx.deps.db.transaction((tx) => ggEvents(ctx.deps, tx, v, now()))).toEqual([]);
    });

    it('a record read that fails gives record null, never a failed GG (savepoint)', async () => {
      const id = await bet({ state: 'CONCEDED' });
      const row = (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)))[0]!;
      const broken = { ...row, party_b_id: 'not-a-uuid' };
      const envs = await ctx.deps.db.transaction(async (tx) => {
        const out = await ggEvents(ctx.deps, tx, broken, now());
        // the transaction is still usable after the failed read
        await tx.select().from(bets).where(eq(bets.id, id));
        return out;
      });
      expect(envs).toHaveLength(1);
      expect(BetGgPayload.parse(envs[0]!.payload).record).toBeNull();
      expect(ReviewRequestedPayload.safeParse({}).success).toBe(false);
    });
  });
});
