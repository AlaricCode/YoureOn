// Demo ops (API-CONTRACT §2.17), all behind DEMO_MODE=true + `X-YO-Demo-Key: <DEMO_ADMIN_TOKEN>`
// (404 otherwise, so the surface does not exist outside the demo). The stage-token requirement
// of §2.17 is not enforced yet (no stage session issuer); the admin key alone gates these.
//
//   GET  /v1/demo/health                 fee payer SOL, nonce pool counts, last server tx, rpc/db ms
//   POST /v1/demo/reset                  revoke leased nonces, delete non-seed bets (cascade), re-sync
//                                        the nonce pool from chain. Never touches face_enrollments.
//   POST /v1/demo/bets/:bet_id/terms     inject fixture terms through the SAME sink as propose_terms
//                                        (no voice_conversation_id needed). Body: optional
//                                        propose_terms args (the LLM projection) overriding the fixture.
//   POST /v1/demo/bets/:bet_id/confirm   the confirm_terms step (freeze + LockService.start).
//   GET  /v1/demo/bets/:bet_id           state + chain_txs summary (scripts/cp1-drive.ts polls it).
//   POST /v1/demo/claim-tokens           {party: 'a'|'b', display_name?} -> one-time QR for
//                                        POST /v1/auth/demo-claim (claim-tokens.ts; 10 min, single
//                                        use). scripts/demo-claim-qr.ts prints it.
//   POST /v1/demo/users/:user_id/devices {device_pubkey} registers a further device key of a user:
//                                        the judge-cam iPhone is a device of A (API-CONTRACT §2.9,
//                                        ARCHITECTURE C5) and there is no other way to add one yet
//                                        (the judge-cam phone can also use demo-claim for party a). The device then signs in with
//                                        POST /v1/auth/session and binds itself with PATCH
//                                        /v1/devices/current. 201 {device_id, user_id}; a repeat for
//                                        the same user answers 200 with the same device.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import type { MiddlewareHandler } from 'hono';
import { auditLog, bets, chainTxs, devices, noncePool, users } from '@youre-on/db';
import { DemoClaimTokenRequest, type DemoClaimTokenResponse } from '@youre-on/shared/api';
import { MAX_STAKE } from '@youre-on/shared/constants';
import { evaluateProposeTerms, proposeTermsReply } from '@youre-on/shared/judge/reply';
import { Pubkey, Uuid } from '@youre-on/shared/primitives';
import type { AppEnv, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody, readJsonBody } from '../http/body';
import { betIdParam } from '../lock/routes';
import { lifecycleOf } from '../lock/runtime';
import { readBet } from '../lock/common';
import { syncNoncePool } from '../lock/service';
import { displayCode } from '../lock/terms';
import { confirmAndLock, termsSink } from '../voice/tools';
import { toolSecretOk } from '../voice/tool-auth';
import { claimTokensOf, demoPartyKey } from './claim-tokens';

export const DEMO_KEY_HEADER = 'X-YO-Demo-Key';

/** A $1-each bottle flip, B performs (the Beat 2 bet, small enough for the demo wallets). */
export const DEMO_TERMS_ARGS = {
  type: 'skill',
  claim: 'Party B lands a water bottle flip upright on the table.',
  performer: 'B',
  yes_party: 'B',
  attempts: { count: 1, rule: 'single' },
  success_criteria: [
    'The bottle rotates at least once in the air.',
    'The bottle comes to rest standing upright on its base.',
  ],
  failure_criteria: ['The bottle ends on its side, upside down, or off the table.'],
  edge_cases: [
    { question: 'Does landing on the cap count?', answer: 'No. Only upright on its base counts.' },
  ],
  amount_usd: '1',
  market_side: 'none',
  deadline_minutes: 0,
} as const;

const DemoDeviceRequest = z.object({ device_pubkey: Pubkey });

export const requireDemo: MiddlewareHandler<AppEnv> = async (c, next) => {
  const env = c.get('deps').env;
  if (
    !env.DEMO_MODE ||
    !env.DEMO_ADMIN_TOKEN ||
    !toolSecretOk(c.req.header(DEMO_KEY_HEADER), [env.DEMO_ADMIN_TOKEN])
  )
    throw new HttpError('NOT_FOUND', 'Not found.');
  await next();
};

export const demoRoutes: RouteModule = {
  name: 'demo',
  register(app) {
    app.get('/v1/demo/health', requireDemo, async (c) => {
      const deps = c.get('deps');
      const t0 = performance.now();
      const pool = await deps.db
        .select({ status: noncePool.status, n: sql<number>`count(*)::int` })
        .from(noncePool)
        .groupBy(noncePool.status);
      const [last] = await deps.db
        .select({
          kind: chainTxs.kind,
          status: chainTxs.status,
          signature: chainTxs.signature,
          bet_id: chainTxs.bet_id,
          built_at: chainTxs.built_at,
          rpc_confirmed_at: chainTxs.rpc_confirmed_at,
          err: chainTxs.err,
        })
        .from(chainTxs)
        .orderBy(desc(chainTxs.built_at))
        .limit(1);
      const dbMs = performance.now() - t0;
      const counts = Object.fromEntries(pool.map((p) => [p.status, p.n])) as Record<string, number>;
      const rt = await lifecycleOf(deps).runtime();
      let feePayerSol: number | null = null;
      let rpcMs: number | null = null;
      let rpcError: string | null = null;
      if (rt) {
        const t1 = performance.now();
        try {
          feePayerSol = Number(await rt.client.lamports(rt.keys.feePayer.address)) / 1e9;
          rpcMs = Math.round(performance.now() - t1);
        } catch (err) {
          rpcError = String((err as Error).message ?? err).slice(0, 120);
        }
      }
      return c.json(
        {
          chain_configured: !!rt,
          lock_signer: deps.env.LOCK_SIGNER,
          rpc: rt?.client.label ?? null,
          fee_payer: rt?.keys.feePayer.address ?? null,
          fee_payer_pinned: rt?.feePayerPinned ?? null,
          fee_payer_sol: feePayerSol,
          judge: rt?.keys.judge?.address ?? null,
          custodial: { a: rt?.keys.demoA?.address ?? null, b: rt?.keys.demoB?.address ?? null },
          nonce_pool: {
            size: Object.values(counts).reduce((a, b) => a + b, 0),
            free: counts.free ?? 0,
            leased: counts.leased ?? 0,
            advancing: counts.advancing ?? 0,
            retired: counts.retired ?? 0,
          },
          last_tx: last ?? null,
          rpc_ms: rpcMs,
          rpc_error: rpcError,
          db_ms: Math.round(dbMs),
        },
        200,
      );
    });

    app.post('/v1/demo/reset', requireDemo, async (c) => {
      const deps = c.get('deps');
      const lc = lifecycleOf(deps);
      const rt = await lc.runtime();
      // 1. revoke every leased nonce (best effort): stored lock signatures become useless.
      if (rt) {
        const leased = await deps.db
          .select()
          .from(noncePool)
          .where(inArray(noncePool.status, ['leased']));
        for (const n of leased) {
          if (!n.leased_bet_id) continue;
          await lc.lock
            .revokeNonce(rt, n, n.leased_bet_id)
            .catch((err: unknown) =>
              deps.log.warn('demo.reset_revoke_failed', { seed_index: n.seed_index, err }),
            );
        }
      }
      await lc.idle();
      // 2. drop the pool's references to bets / txs about to be deleted.
      await deps.db
        .update(noncePool)
        .set({
          status: 'retired',
          retired_at: new Date(deps.now()),
          leased_bet_id: null,
          leased_tx_id: null,
          leased_at: null,
          advance_tx_id: null,
        })
        .where(inArray(noncePool.status, ['leased', 'advancing']));
      // 3. non-seed bets (chain_txs, bet_terms_versions, bet_events, voice_sessions, outbox cascade).
      const deleted = await deps.db
        .delete(bets)
        .where(sql`NOT ${bets.is_seed}`)
        .returning({ id: bets.id });
      // 4. re-read the pool from chain: every account that is fine is free again.
      let synced = 0;
      if (rt) {
        await deps.db
          .update(noncePool)
          .set({ status: 'free', retired_at: null, failures: 0 })
          .where(sql`${noncePool.status} = 'retired' AND ${noncePool.nonce_value} IS NOT NULL`);
        await deps.db.delete(noncePool).where(sql`${noncePool.status} = 'retired'`);
        synced = await syncNoncePool(deps, rt);
      }
      await deps.db.insert(auditLog).values({
        actor_kind: 'system',
        action: 'demo.reset',
        request_id: c.get('requestId'),
        details: { deleted_bets: deleted.length, nonces_synced: synced },
      });
      return c.json({ ok: true, deleted_bets: deleted.length, nonces_synced: synced }, 200);
    });

    app.post('/v1/demo/bets/:bet_id/terms', requireDemo, async (c) => {
      const deps = c.get('deps');
      const betId = betIdParam(c.req.param('bet_id'));
      const bet = await readBet(deps.db, betId);
      if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
      const over = (await readJsonBody(c)) as Record<string, unknown>;
      const args = { ...DEMO_TERMS_ARGS, ...over, bet_id: betId, conversation_id: 'demo' };
      const maxStake = deps.env.MAX_STAKE_MICRO ? BigInt(deps.env.MAX_STAKE_MICRO) : MAX_STAKE;
      const evaluation = evaluateProposeTerms(args, { maxStake, realWorldEnabled: false });
      const reply = proposeTermsReply(evaluation, { maxStake });
      if (evaluation.kind !== 'proposal' || evaluation.missing.length)
        return c.json({ ok: false, kind: evaluation.kind, reply }, 422);
      await termsSink.onEvaluated({
        deps,
        session: {
          voice_session_id: null,
          conversation_id: null,
          bet_id: betId,
          bet_state: bet.state,
          party_a_id: bet.party_a_id,
          party_b_id: bet.party_b_id,
          room_id: bet.room_id,
        },
        evaluation,
        reply,
        requestId: c.get('requestId'),
      });
      const after = await readBet(deps.db, betId);
      if (after?.state !== 'TERMS_PROPOSED' || !after.terms_hash)
        return c.json({ ok: false, kind: 'not_proposed', state: after?.state ?? null }, 409);
      return c.json(
        {
          ok: true,
          state: after.state,
          terms_hash: after.terms_hash,
          code: displayCode(after.terms_hash),
          say: reply.say,
        },
        200,
      );
    });

    app.get('/v1/demo/bets/:bet_id', requireDemo, async (c) => {
      const deps = c.get('deps');
      const betId = betIdParam(c.req.param('bet_id'));
      const bet = await readBet(deps.db, betId);
      if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
      const txs = await deps.db
        .select({
          id: chainTxs.id,
          kind: chainTxs.kind,
          status: chainTxs.status,
          signature: chainTxs.signature,
          err: chainTxs.err,
          sent_at: chainTxs.sent_at,
          rpc_confirmed_at: chainTxs.rpc_confirmed_at,
        })
        .from(chainTxs)
        .where(sql`${chainTxs.bet_id} = ${betId}`)
        .orderBy(chainTxs.built_at);
      return c.json(
        {
          bet_id: bet.id,
          state: bet.state,
          end_reason: bet.end_reason,
          onchain_status: bet.onchain_status,
          onchain_pending: bet.onchain_pending,
          pending_sig: bet.pending_sig,
          terms_hash: bet.terms_hash,
          party_a_wallet: bet.party_a_wallet,
          party_b_wallet: bet.party_b_wallet,
          appeal_deadline: bet.appeal_deadline,
          chain_txs: txs,
        },
        200,
      );
    });

    app.post('/v1/demo/claim-tokens', requireDemo, async (c) => {
      const deps = c.get('deps');
      const body = await readBody(c, DemoClaimTokenRequest);
      const key = demoPartyKey(deps.env, body.party);
      if (!key) {
        throw new HttpError(
          'INVALID_STATE',
          `Demo party ${body.party} has no key on this server.`,
          {
            reason: 'demo_key_missing',
            party: body.party,
          },
        );
      }
      key.seed.fill(0);
      const t = claimTokensOf(deps).issue({ party: body.party, display_name: body.display_name });
      await deps.db.insert(auditLog).values({
        actor_kind: 'system',
        action: 'demo.claim_token_issued',
        request_id: c.get('requestId'),
        details: {
          party: body.party,
          pubkey: key.pubkey,
          word: t.word,
          display_name: body.display_name ?? null,
          expires_at: new Date(t.entry.expires_at).toISOString(),
        },
      });
      const res: DemoClaimTokenResponse = {
        token: t.token,
        word: t.word,
        qr: t.qr,
        expires_at: new Date(t.entry.expires_at).toISOString(),
        party: body.party,
        pubkey: key.pubkey,
      };
      c.header('Cache-Control', 'no-store');
      return c.json(res, 201);
    });

    app.post('/v1/demo/users/:user_id/devices', requireDemo, async (c) => {
      const deps = c.get('deps');
      const userId = c.req.param('user_id');
      if (!Uuid.safeParse(userId).success) throw new HttpError('NOT_FOUND', 'No such user.');
      const body = await readBody(c, DemoDeviceRequest);
      const [user] = await deps.db
        .select({ id: users.id, wallet_pubkey: users.wallet_pubkey })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deleted_at)))
        .limit(1);
      if (!user) throw new HttpError('NOT_FOUND', 'No such user.');
      if (user.wallet_pubkey === body.device_pubkey)
        throw new HttpError('VALIDATION_FAILED', 'The device key must differ from the wallet.', {
          issues: [{ path: 'device_pubkey', message: 'must differ from wallet_pubkey' }],
        });
      const [existing] = await deps.db
        .select({ id: devices.id, user_id: devices.user_id })
        .from(devices)
        .where(eq(devices.device_pubkey, body.device_pubkey))
        .limit(1);
      if (existing) {
        if (existing.user_id !== user.id)
          throw new HttpError('INVALID_STATE', 'That device key belongs to someone else.', {
            reason: 'device_registered',
          });
        return c.json({ device_id: existing.id, user_id: user.id }, 200);
      }
      const [d] = await deps.db
        .insert(devices)
        .values({ user_id: user.id, platform: 'ios', device_pubkey: body.device_pubkey })
        .returning({ id: devices.id });
      await deps.db.insert(auditLog).values({
        actor_kind: 'system',
        action: 'demo.device_added',
        subject_user_id: user.id,
        request_id: c.get('requestId'),
        details: { device_id: d!.id },
      });
      return c.json({ device_id: d!.id, user_id: user.id }, 201);
    });

    app.post('/v1/demo/bets/:bet_id/confirm', requireDemo, async (c) => {
      const deps = c.get('deps');
      const betId = betIdParam(c.req.param('bet_id'));
      const r = await confirmAndLock(deps, betId, {
        heard: 'demo',
        requestId: c.get('requestId'),
        actor: 'system',
      });
      return c.json(r, r.ok ? 200 : 409);
    });
  },
};
