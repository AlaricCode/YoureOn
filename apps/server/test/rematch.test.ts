/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and event payloads are loose here */
// Double or nothing (docs/planning/DANCE-OFF.md §7): POST /v1/bets/:bet_id/rematch, for every bet
// type. Either party of a finished bet (PAID, VOIDED, FINALIZED, EXPIRED) challenges the other
// again in the same room as A; the new DRAFTING bet supersedes the old one, and bet.invited
// carries rematch_of + suggested_stake_usd (2 × the old per-side stake, capped at max_stake).
// Same pair_busy / open-bet rules as POST /v1/bets (the shared createChallenge).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { betEvents, bets, outbox } from '@youre-on/db';
import { rematchPath, RematchResponse, suggestedRematchStakeUsd } from '@youre-on/shared/api';
import { sha256Hex } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { REMATCH_FROM } from '../src/bets/routes';
import {
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

describe('suggestedRematchStakeUsd (§7)', () => {
  it('doubles the per-side stake (the larger side), capped at max_stake, whole cents', () => {
    expect(suggestedRematchStakeUsd({ a: '5000000', b: '5000000' })).toBe(10);
    expect(suggestedRematchStakeUsd({ a: '15000000', b: '15000000' })).toBe(20);
    expect(suggestedRematchStakeUsd({ a: '1000000', b: '3000000' })).toBe(6);
    expect(suggestedRematchStakeUsd({ a: '1255000', b: '1255000' })).toBe(2.51);
    expect(REMATCH_FROM).toEqual(['PAID', 'VOIDED', 'FINALIZED', 'EXPIRED']);
  });
});

describeDb('rematch: POST /v1/bets/:id/rematch (DB)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startTestServer({ env: { MAX_STAKE_MICRO: '20000000' } });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  const post = (u: SignedUp, path: string, body: unknown = {}) => {
    const raw = JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const uid = (u: SignedUp) => u.session.user.user_id;
  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;

  async function pair() {
    const A = await signUp(ctx.base, 'Logan');
    const B = await signUp(ctx.base, 'Jake');
    const C = await signUp(ctx.base, 'Carol');
    const room = await post(A, '/v1/rooms', { name: 'Rematch', kind: 'session' });
    expect(room.status).toBe(201);
    for (const u of [B, C])
      expect((await post(u, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    return { A, B, C, roomId: room.json!.room_id as string };
  }

  /** A bet A→B, moved straight to `state` with `stakeMicro` a side (no chain). */
  async function finished(
    A: SignedUp,
    B: SignedUp,
    roomId: string,
    state: 'PAID' | 'VOIDED' | 'FINALIZED' | 'DRAFTING',
    stakeMicro = 5_000_000n,
  ) {
    const created = await post(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(B),
      challenge_method: 'list',
    });
    expect(created.status).toBe(201);
    const betId: string = created.json!.bet.bet_id;
    if (state !== 'DRAFTING')
      await ctx.deps.db
        .update(bets)
        .set({
          state,
          terms_hash: sha256Hex(`terms ${betId}`),
          stake_a: stakeMicro,
          stake_b: stakeMicro,
          evidence_source: 'camera',
        })
        .where(eq(bets.id, betId));
    return betId;
  }

  it('only a finished bet, only its parties', async () => {
    const { A, B, C, roomId } = await pair();
    const open = await finished(A, B, roomId, 'DRAFTING');
    const r = await post(B, rematchPath(open));
    expect(r.status).toBe(409);
    expect(r.json!.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'not_finished', state: 'DRAFTING' },
    });
    await ctx.deps.db
      .update(bets)
      .set({
        state: 'PAID',
        terms_hash: sha256Hex(open),
        stake_a: 1n,
        stake_b: 1n,
        evidence_source: 'camera',
      })
      .where(eq(bets.id, open));
    expect((await post(C, rematchPath(open))).json!.error.code).toBe('NOT_A_PARTY');
    expect((await post(B, rematchPath('not-a-uuid'))).status).toBe(404);
  });

  it('the loser asks: a new DRAFTING bet, caller = A, supersedes the old one, 2x the stake', async () => {
    const { A, B, roomId } = await pair();
    const old = await finished(A, B, roomId, 'PAID', 5_000_000n);
    const r = await post(B, rematchPath(old));
    expect(r.status).toBe(201);
    const body = RematchResponse.parse(r.json);
    expect(body.suggested_stake_usd).toBe(10);
    expect(r.json!.bet).toMatchObject({ bet_id: body.bet_id, state: 'DRAFTING' });
    expect(r.json!.voice.dynamic_variables).toMatchObject({
      bet_id: body.bet_id,
      party_a_name: 'Jake',
      party_b_name: 'Logan',
    });
    const row = await betRow(body.bet_id);
    expect(row).toMatchObject({
      state: 'DRAFTING',
      party_a_id: uid(B),
      party_b_id: uid(A),
      room_id: roomId,
      supersedes_bet_id: old,
      challenge_method: 'list',
    });
    expect((await betRow(old)).state).toBe('PAID'); // the old bet is untouched

    const evs = (
      await ctx.deps.db
        .select()
        .from(betEvents)
        .where(eq(betEvents.bet_id, body.bet_id))
        .orderBy(asc(betEvents.seq))
    ).map((e) => e.envelope as any);
    expect(evs.map((e) => e.type)).toEqual(['bet.invited', 'bet.state']);
    expect(parseRealtimeEvent(evs[0]).ok).toBe(true);
    expect(evs[0].payload).toMatchObject({
      challenger: { user_id: uid(B) },
      room_id: roomId,
      rematch_of: old,
      suggested_stake_usd: 10,
    });
    const [push] = await ctx.deps.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.bet_id, body.bet_id), eq(outbox.recipient_user_id, uid(A))));
    expect(push!.payload).toMatchObject({ title: 'Jake wants a rematch' });

    // a repeat by the same caller answers the same rematch; the other side is pair_busy
    const again = await post(B, rematchPath(old));
    expect(again.status).toBe(201);
    expect(again.json!.bet_id).toBe(body.bet_id);
    const theirs = await post(A, rematchPath(old));
    expect(theirs.status).toBe(409);
    expect(theirs.json!.error.details).toMatchObject({ reason: 'pair_busy', bet_id: body.bet_id });
  });

  it('the stake doubles up to max_stake; a VOIDED or FINALIZED bet can be run back too', async () => {
    const { A, B, roomId } = await pair();
    const big = await finished(A, B, roomId, 'VOIDED', 15_000_000n);
    const r = await post(A, rematchPath(big));
    expect(r.status).toBe(201);
    expect(r.json!.suggested_stake_usd).toBe(20);
    expect((await betRow(r.json!.bet_id)).supersedes_bet_id).toBe(big);
    // finish that one too, then rematch a FINALIZED bet
    await ctx.deps.db
      .update(bets)
      .set({
        state: 'FINALIZED',
        terms_hash: sha256Hex('t2'),
        stake_a: 2_000_000n,
        stake_b: 2_000_000n,
        evidence_source: 'camera',
      })
      .where(eq(bets.id, r.json!.bet_id));
    const r2 = await post(B, rematchPath(r.json!.bet_id));
    expect(r2.status).toBe(201);
    expect(r2.json!.suggested_stake_usd).toBe(4);
  });
});
