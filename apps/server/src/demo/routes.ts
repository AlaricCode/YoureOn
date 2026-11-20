// Demo ops for rehearsals and the pitch: health, reset, rebalance, sweeps, warm-up, runtime
// toggles, seeded head-to-head history, claim QRs, extra device keys for a demo account and
// fixture shortcuts for a bet. All sit behind DEMO_MODE=true + `X-YO-Demo-Key: <DEMO_ADMIN_TOKEN>`
// and answer 404 otherwise, so the surface does not exist outside the demo. The admin key alone
// gates them (no stage token needed); the read-only GET /v1/demo/health also takes the
// projector's stage session instead.
// Spec: docs/planning/API-CONTRACT.md §2.17.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import type { Context, MiddlewareHandler } from 'hono';
import { auditLog, chainTxs, devices, users } from '@youre-on/db';
import {
  DemoAppealRequest,
  DemoClaimTokenRequest,
  HDR,
  type DemoClaimTokenResponse,
} from '@youre-on/shared/api';
import { MAX_STAKE } from '@youre-on/shared/constants';
import { evaluateProposeTerms, proposeTermsReply } from '@youre-on/shared/judge/reply';
import { Pubkey, Uuid } from '@youre-on/shared/primitives';
import { chainHealth } from '../chain/health';
import { bootReconcile } from '../chain/reconcile';
import type { AppDeps, AppEnv, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody, readJsonBody } from '../http/body';
import { betIdParam } from '../lock/routes';
import { lifecycleOf } from '../lock/runtime';
import { readBet } from '../lock/common';
import { displayCode } from '../lock/terms';
import { confirmAndLock, termsSink } from '../voice/tools';
import { toolSecretOk } from '../voice/tool-auth';
import { bearerToken, resolveSession } from '../auth/sessions';
import { claimTokensOf, demoPartyKey } from './claim-tokens';
import { demoWallets, isDemoPlayer } from './players';
import { rebalanceDemoWallets } from './rebalance';
import { DemoResetRequest, resetDemo } from './reset';
import { SeedH2hRequest, seedHeadToHead } from './seed-h2h';
import { DemoTogglesRequest, togglesOf } from './toggles';
import { runWarmup, takeWarmupToken } from './warmup';
import { realWorldEnabled } from '../markets/quote';
import { settlementOf } from '../markets/settlement';

export const DEMO_KEY_HEADER = 'X-YO-Demo-Key';

/** A $1-each bottle flip, B performs (the demo's bet, small enough for the demo wallets). */
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

const demoKeyOk = (c: Context<AppEnv>): boolean => {
  const env = c.get('deps').env;
  return (
    env.DEMO_MODE &&
    !!env.DEMO_ADMIN_TOKEN &&
    toolSecretOk(c.req.header(DEMO_KEY_HEADER), [env.DEMO_ADMIN_TOKEN])
  );
};

export const requireDemo: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!demoKeyOk(c)) throw new HttpError('NOT_FOUND', 'Not found.');
  await next();
};

/**
 * The admin key, or the projector's own stage session: it carries the 'demo' scope only under
 * DEMO_MODE (stage/routes.ts). For the read-only health strip, so the projector needs no
 * all-powerful admin key in its URL fragment, history or sessionStorage.
 */
const requireDemoOrStage: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (demoKeyOk(c)) return next();
  const deps = c.get('deps');
  const token = bearerToken(c.req.header(HDR.authorization));
  const auth =
    deps.env.DEMO_MODE && token
      ? await resolveSession(deps.db, token, deps.now()).catch(() => null)
      : null;
  if (!auth?.scopes.includes('stage') || !auth.scopes.includes('demo'))
    throw new HttpError('NOT_FOUND', 'Not found.');
  await next();
};

/** Bet on Bitcoin: the Gemini relay and its settlement keeper, for the pre-show check. */
function geminiHealth(deps: AppDeps) {
  const m = deps.markets;
  const cur = m?.current(deps.now());
  return {
    feed: !!m,
    real_world_enabled: realWorldEnabled(deps),
    last_ok_at: m?.lastOkAt ? new Date(m.lastOkAt).toISOString() : null,
    last_error: m?.lastError ?? null,
    failures: m?.failures ?? 0,
    feed_mode: m?.feed ?? null,
    rollovers: m?.rollovers ?? 0,
    current: cur?.market
      ? {
          event_ticker: cur.market.eventTicker,
          expiry: cur.market.expiry,
          strike: cur.market.strike.value,
          lockable: cur.lockable,
          lockable_until: cur.lockable_until,
          refusal: cur.refusal,
        }
      : null,
    next_window_start: cur?.next_window_start ?? null,
    awaiting_market: settlementOf(deps).followed.length,
  };
}

export const demoRoutes: RouteModule = {
  name: 'demo',
  register(app) {
    app.get('/v1/demo/health', requireDemoOrStage, async (c) => {
      // chain/health.ts: balances, nonce pool, RPC p50 / p95, keeper, stuck txs / bets, orphan
      // escrow, Stream, and `warnings` (+ `ok`: no critical warning); plus the Gemini relay.
      const deps = c.get('deps');
      c.header('Cache-Control', 'no-store');
      return c.json({ ...(await chainHealth(deps)), gemini: geminiHealth(deps) }, 200);
    });

    app.post('/v1/demo/reset', requireDemo, async (c) => {
      const deps = c.get('deps');
      const body = await readBody(c, DemoResetRequest);
      const result = await resetDemo(deps, {
        rebalance: body.rebalance,
        requestId: c.get('requestId'),
      });
      return c.json({ ok: true, ...result }, 200);
    });

    app.get('/v1/demo/toggles', requireDemo, (c) => {
      const deps = c.get('deps');
      c.header('Cache-Control', 'no-store');
      return c.json(togglesOf(deps).view(deps.env), 200);
    });

    // Runtime toggles (toggles.ts): the judge reads them at call time, so a change takes effect
    // on the next ruling, no restart. Every toggle the body names is audited.
    app.post('/v1/demo/toggles', requireDemo, async (c) => {
      const deps = c.get('deps');
      const body = await readBody(c, DemoTogglesRequest);
      const toggles = togglesOf(deps);
      const changed = toggles.apply(body, deps.env, deps.now());
      for (const ch of changed) {
        await deps.db.insert(auditLog).values({
          actor_kind: 'system',
          action: 'demo.toggle',
          request_id: c.get('requestId'),
          details: {
            ...ch,
            env_default: ch.toggle === 'checks' ? deps.env.CHECKS_ENABLED : deps.env.CACHED_RULING,
          },
        });
        deps.log.warn('demo.toggle', { ...ch });
      }
      c.header('Cache-Control', 'no-store');
      return c.json({ ok: true, toggles: toggles.view(deps.env), changed }, 200);
    });

    // One warm-up per 10 s (each is a paid Claude call): 429 RATE_LIMITED + Retry-After.
    app.post('/v1/demo/warmup', requireDemo, async (c) => {
      const deps = c.get('deps');
      takeWarmupToken(deps);
      const r = await runWarmup(deps, { requestId: c.get('requestId') });
      c.header('Cache-Control', 'no-store');
      return c.json(r, 200);
    });

    app.post('/v1/demo/seed-h2h', requireDemo, async (c) => {
      const deps = c.get('deps');
      const body = await readBody(c, SeedH2hRequest);
      const r = await seedHeadToHead(deps, body, { requestId: c.get('requestId') });
      return c.json({ ok: true, ...r }, 200);
    });

    // Every money sweep, now (before going on stage, or to see the orphan refunds go out): the
    // same idempotent passes the keeper runs, plus the orphan scan, then the health report.
    app.post('/v1/demo/sweep', requireDemo, async (c) => {
      const deps = c.get('deps');
      const report = await bootReconcile(deps, deps.now());
      const orphans = await lifecycleOf(deps).refund.sweepOrphans(deps.now());
      await lifecycleOf(deps).idle();
      return c.json({ ok: true, reconcile: report, orphans, health: await chainHealth(deps) }, 200);
    });

    app.post('/v1/demo/rebalance', requireDemo, async (c) => {
      const deps = c.get('deps');
      const lc = lifecycleOf(deps);
      const rt = await lc.runtime();
      if (!rt) throw new HttpError('RPC_UNAVAILABLE', 'The chain is not configured.');
      const r = await rebalanceDemoWallets(deps, rt, {
        requestId: c.get('requestId'),
        send: lc.sendOptions,
      });
      return c.json({ ok: true, ...r }, 200);
    });

    // Fixture terms through the same sink as the propose_terms tool, so a bet reaches
    // TERMS_PROPOSED without a voice session. The body may override any propose_terms arg.
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

    // State + chain_txs summary (scripts/cp1-drive.ts polls it).
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

    // A one-time QR for POST /v1/auth/demo-claim (10 min, single use); scripts/demo-claim-qr.ts
    // prints it.
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

    // A further device key of a demo account: the judge-cam iPhone is a device of A. The device
    // then signs in with POST /v1/auth/session and binds itself with PATCH /v1/devices/current.
    app.post('/v1/demo/users/:user_id/devices', requireDemo, async (c) => {
      const deps = c.get('deps');
      const userId = c.req.param('user_id');
      if (!Uuid.safeParse(userId).success) throw new HttpError('NOT_FOUND', 'No such user.');
      const body = await readBody(c, DemoDeviceRequest);
      const [user] = await deps.db
        .select({ id: users.id, wallet_pubkey: users.wallet_pubkey, is_demo: users.is_demo })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deleted_at)))
        .limit(1);
      if (!user) throw new HttpError('NOT_FOUND', 'No such user.');
      // Only the demo accounts (the judge cam is a device of demo A): a leaked admin key must
      // not be able to add a device to a real account and sign in as it.
      if (!isDemoPlayer(user, await demoWallets(deps)))
        throw new HttpError('INVALID_STATE', 'Only a demo account can get a device here.', {
          reason: 'not_demo_user',
        });
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

    // LOCK_SIGNER=server only: the losing demo party's appeal, signed custodially. The admin key
    // gates it, so it takes no token from the 3/h appeal bucket.
    app.post('/v1/demo/bets/:bet_id/appeal', requireDemo, async (c) => {
      const deps = c.get('deps');
      const betId = betIdParam(c.req.param('bet_id'));
      const body = await readBody(c, DemoAppealRequest);
      const res = await lifecycleOf(deps).appeal.appealAsDemo(betId, body.party, {
        requestId: c.get('requestId'),
      });
      return c.json(res, 202);
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
