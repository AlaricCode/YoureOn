// POST /webhooks/quicknode against Postgres (skips without DATABASE_URL): signature gate,
// idempotent dedupe on (signature, outer_ix, inner_ix), attribution to OUR bets only, the
// projector's bet_events fan-out, out-of-order folding, and the ack rules (API-CONTRACT §5.3).
// The projection itself (columns, chain-wins state moves, reconcile) is chain-projector.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { bets, chainEvents, createDb, type DbHandle } from '@youre-on/db';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import { buildApp } from '../src/app';
import type { App, AppDeps } from '../src/context';
import { createDeps } from '../src/server';
import { createChainRoutes, QUICKNODE_WEBHOOK_PATH } from '../src/chain/routes';
import { createChainProjector, type ChainProjector } from '../src/chain/projector';
import { ingestChainEvents, refoldParkedInTx } from '../src/chain/ingest';
import { parseStreamDelivery } from '../src/chain/streams';
import {
  betFacts,
  delivery,
  lifecycle,
  qnSignedHeaders,
  randomPubkey,
  randomSig,
  samplePayload,
  type BetFacts,
} from './chain-fixtures';
import { betRow, logOf, mkBetRow, mkLockTx, mkUser, rowsOf } from './chain-db';
import { describeDb, testEnv } from './helpers';

const TOKEN = 'qn-test-token-' + randomBytes(8).toString('hex');
const NOW = 1_795_284_425_000;

const signedHeaders = (body: Uint8Array, o: { tsMs?: number; secret?: string } = {}) =>
  qnSignedHeaders(body, o.secret ?? TOKEN, o.tsMs ?? NOW);

describeDb('POST /webhooks/quicknode over Postgres', () => {
  let h: DbHandle;
  let deps: AppDeps;
  let app: App;
  let partyA: string, partyB: string;

  const post = async (
    payload: unknown,
    o: { tsMs?: number; secret?: string; gzip?: boolean } = {},
  ) => {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const headers = signedHeaders(json, o);
    const body = o.gzip ? new Uint8Array(gzipSync(json)) : json;
    const res = await app.request(QUICKNODE_WEBHOOK_PATH, { method: 'POST', headers, body });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /**
   * A bet the server locked: chain_txs holds its atomic_lock signature (`lockSig`), unless null
   * (the "Stream beat the signature write" case). `pending` also sets the RPC-confirm columns.
   */
  const mkBet = async (
    lockSig: string | null,
    o: {
      state?: (typeof bets.$inferSelect)['state'];
      end_reason?: 'resolve_timeout' | null;
      pending?: boolean;
    } = {},
  ): Promise<{ betId: string; f: BetFacts; L: ReturnType<typeof lifecycle> }> => {
    const f = betFacts();
    await mkBetRow(h.db, f, {
      partyA,
      partyB,
      state: o.state ?? 'LOCKED',
      end_reason: o.end_reason ?? null,
      pendingSig: o.pending && lockSig ? lockSig : null,
    });
    if (lockSig) await mkLockTx(h.db, f.bet_id, lockSig);
    return { betId: f.bet_id, f, L: lifecycle(f) };
  };

  const db = () => h.db;

  beforeAll(async () => {
    const env = testEnv({ QN_STREAM_SECURITY_TOKEN: TOKEN });
    h = createDb({ url: env.DATABASE_URL, max: 4 });
    deps = createDeps({ env, dbHandle: h, rateLimit: false, now: () => NOW }).deps;
    app = buildApp(deps, [createChainRoutes()]);
    partyA = await mkUser(h.db);
    partyB = await mkUser(h.db);
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('signature gate (401) and configuration', () => {
    const body = delivery([]);
    it('rejects missing headers, a bad HMAC, a wrong token and a stale timestamp with 401', async () => {
      const r0 = await app.request(QUICKNODE_WEBHOOK_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(r0.status).toBe(401);
      expect(await r0.json()).toMatchObject({
        error: { code: 'SIGNATURE_INVALID', details: { reason: 'missing' } },
      });

      const json = new TextEncoder().encode(JSON.stringify(body));
      const tampered = await app.request(QUICKNODE_WEBHOOK_PATH, {
        method: 'POST',
        headers: signedHeaders(json),
        body: JSON.stringify({ ...body, batchEnd: 1 }),
      });
      expect(tampered.status).toBe(401);
      expect((await post(body, { secret: 'not-the-token' })).status).toBe(401);
      const stale = await post(body, { tsMs: NOW - 301_000 });
      expect(stale.status).toBe(401);
      expect(stale.json).toMatchObject({ error: { details: { reason: 'stale' } } });
      expect((await post(body, { tsMs: NOW - 299_000 })).status).toBe(200);
    });

    it('is 404 when QN_STREAM_SECURITY_TOKEN is unset', async () => {
      const d2 = createDeps({ env: testEnv(), dbHandle: h, rateLimit: false }).deps;
      const a2 = buildApp(d2, [createChainRoutes()]);
      const json = new TextEncoder().encode('{}');
      const r = await a2.request(QUICKNODE_WEBHOOK_PATH, {
        method: 'POST',
        headers: signedHeaders(json),
        body: json,
      });
      expect(r.status).toBe(404);
    });

    it('accepts the signed `null` body (the filter matched nothing) as an empty batch', async () => {
      // scripts/qn-stream.ts probes the deployed server exactly like this before creating a Stream.
      expect(await post(null)).toMatchObject({
        status: 200,
        json: { ok: true, received: 0, inserted: 0 },
      });
    });
  });

  it('stores an atomic lock once, applies it to OUR bet, fans out chain.* in order; a replay is a no-op', async () => {
    const sig = randomSig();
    const { betId, L } = await mkBet(sig, { pending: true });
    const publish = vi.spyOn(deps.hub, 'publishBetEvent');
    publish.mockClear();
    const body = delivery([
      {
        signature: sig,
        events: [
          { outerIx: 4, name: 'BetAccepted', payload: L.accepted() },
          { outerIx: 3, name: 'BetCreated', payload: L.created() },
        ],
      },
    ]);
    const r = await post(body);
    expect(r).toMatchObject({
      status: 200,
      json: { ok: true, received: 2, inserted: 2, duplicates: 0, published: 2 },
    });
    const rows = await rowsOf(db(), sig);
    expect(rows.map((x) => [x.outer_ix, x.event_name, x.bet_id, x.apply_error])).toEqual([
      [3, 'BetCreated', betId, null],
      [4, 'BetAccepted', betId, null],
    ]);
    expect(rows.every((x) => x.applied_at !== null && x.source === 'stream')).toBe(true);
    expect(rows[0]).toMatchObject({
      slot: null,
      block_height: 400_118_207,
      program_id: ESCROW_ID,
      delivery_id: '519807088-519807092:block',
      block_time: new Date(1_795_284_425_000),
    });
    const log = await logOf(db(), betId);
    expect(log.map((e) => [e.seq, e.type, e.source, e.chain_event_id])).toEqual([
      [1, 'chain.BetCreated', 'chain', rows[0]!.id],
      [2, 'chain.BetAccepted', 'chain', rows[1]!.id],
    ]);
    expect(log[0]!.envelope).toMatchObject({
      type: 'chain.BetCreated',
      payload: {
        signature: sig,
        slot: null,
        outer_ix: 3,
        inner_ix: 0,
        observed_via: 'quicknode_stream',
        bet_id: betId,
      },
    });
    expect(publish.mock.calls.map(([env]) => (env as { type: string }).type)).toEqual([
      'chain.BetCreated',
      'chain.BetAccepted',
    ]);
    // the RPC path already said LOCKED: the Stream only confirms it (chain_ack -> stream)
    expect(await betRow(db(), betId)).toMatchObject({
      state: 'LOCKED',
      onchain_status: 'locked',
      onchain_pending: null,
      pending_sig: null,
      create_sig: sig,
      accept_sig: sig,
    });

    // QuickNode retry (new nonce, same body): UNIQUE dedupe, no new seq, nothing published
    publish.mockClear();
    const version = (await betRow(db(), betId)).version;
    const again = await post(body);
    expect(again.json).toMatchObject({ ok: true, inserted: 0, duplicates: 2, published: 0 });
    expect(await logOf(db(), betId)).toHaveLength(2);
    expect(await rowsOf(db(), sig)).toHaveLength(2);
    expect((await betRow(db(), betId)).version).toBe(version);
    expect(publish).not.toHaveBeenCalled();

    // gzip transport of a later event for the same bet (a resolve whose RPC confirm was missed)
    const res = randomSig();
    const gz = await post(
      delivery([
        {
          signature: res,
          blockHeight: 400_118_300,
          events: [{ outerIx: 1, name: 'BetResolved', payload: L.resolved('PartyB') }],
        },
      ]),
      { gzip: true },
    );
    expect(gz.json).toMatchObject({ ok: true, inserted: 1, published: 2 });
    expect((await logOf(db(), betId)).map((e) => e.type)).toEqual([
      'chain.BetCreated',
      'chain.BetAccepted',
      'chain.BetResolved',
      'bet.state',
    ]);
    expect(await betRow(db(), betId)).toMatchObject({ state: 'RULED', resolve_sig: res });
    publish.mockRestore();
  });

  it('orphans get apply_error unknown_bet; Config events are stored only', async () => {
    const sig = randomSig();
    const r = await post(
      delivery([
        {
          signature: sig,
          events: [
            {
              outerIx: 0,
              name: 'BetResolved',
              payload: samplePayload('BetResolved', { bet_id: randomUUID() }),
            },
            { outerIx: 1, name: 'ConfigUpdated', payload: samplePayload('ConfigUpdated') },
          ],
        },
      ]),
    );
    expect(r.json).toMatchObject({ ok: true, inserted: 2, published: 0 });
    const rows = await rowsOf(db(), sig);
    expect(rows.map((x) => [x.event_name, x.apply_error, x.applied_at !== null])).toEqual([
      ['BetResolved', 'unknown_bet', false],
      ['ConfigUpdated', null, true],
    ]);
    expect(rows[1]!.bet_id).toBeNull();
    expect(rows[1]!.payload).toMatchObject({ paused: true, max_stake: '20000000' });
  });

  it('never applies events to a bet whose lock signature does not match (not ours); folds once it does', async () => {
    const lockSig = randomSig();
    // the server built + sent the lock (chain_txs), the bet is AWAITING_LOCK
    const { betId, L } = await mkBet(lockSig, { state: 'AWAITING_LOCK' });
    const resolveSig = randomSig();
    // out of order: the resolve arrives before the lock
    const first = await post(
      delivery([
        {
          signature: resolveSig,
          blockHeight: 400_118_400,
          events: [{ outerIx: 2, name: 'BetResolved', payload: L.resolved('PartyA') }],
        },
      ]),
    );
    expect(first.json).toMatchObject({ inserted: 1, published: 0 });
    expect((await rowsOf(db(), resolveSig))[0]!.apply_error).toBe('not_ours');

    // a BetCreated for this bet under a DIFFERENT signature (someone else's tx): still not ours
    const spoofSig = randomSig();
    const spoof = await post(
      delivery([
        {
          signature: spoofSig,
          events: [{ outerIx: 0, name: 'BetCreated', payload: L.created() }],
        },
      ]),
    );
    expect(spoof.json).toMatchObject({ inserted: 1, published: 0 });
    expect(await logOf(db(), betId)).toHaveLength(0);
    expect((await betRow(db(), betId)).onchain_status).toBe('none');

    // the real lock lands: every parked event of the bet is folded, in chain order
    const lock = await post(
      delivery([
        {
          signature: lockSig,
          blockHeight: 400_118_300,
          events: [
            { outerIx: 3, name: 'BetCreated', payload: L.created() },
            { outerIx: 4, name: 'BetAccepted', payload: L.accepted() },
          ],
        },
      ]),
    );
    expect(lock.json).toMatchObject({ inserted: 2 });
    const log = await logOf(db(), betId);
    const sigOf = (e: { envelope: unknown }) =>
      (e.envelope as { payload: { signature?: string } }).payload.signature;
    expect(log.slice(0, 3).map((e) => [e.seq, sigOf(e), e.type])).toEqual([
      [1, lockSig, 'chain.BetCreated'],
      [2, lockSig, 'chain.BetAccepted'],
      [3, resolveSig, 'chain.BetResolved'],
    ]);
    // AWAITING_LOCK -> RULED in one fold: the chain is two steps ahead of the RPC path
    expect(log.slice(3).map((e) => e.type)).toEqual(['bet.state']);
    expect(lock.json).toMatchObject({ published: 4 });
    expect((await rowsOf(db(), resolveSig))[0]).toMatchObject({ apply_error: null });
    // the squatter's BetCreated is never pushed, and is no longer re-folded
    expect((await rowsOf(db(), spoofSig))[0]).toMatchObject({
      apply_error: 'not_ours_lock',
      applied_at: null,
    });
  });

  it('valid HMAC + malformed or foreign envelope → 200 (a retry cannot fix it), nothing stored', async () => {
    expect(await post({ hello: 'world' })).toMatchObject({
      status: 200,
      json: { ok: false, reason: 'invalid_payload' },
    });
    expect(await post({ ...delivery([]), programId: randomPubkey() })).toMatchObject({
      status: 200,
      json: { ok: false, reason: 'invalid_payload' },
    });
    const sig = randomSig();
    const bad = delivery([
      {
        signature: sig,
        events: [{ outerIx: 0, name: 'BetClosed', payload: samplePayload('BetClosed') }],
      },
    ]);
    bad.txs[0]!.events[0]!.eventBase64 = Buffer.from(new Uint8Array(30)).toString('base64');
    const r = await post(bad);
    expect(r.json).toMatchObject({ ok: true, inserted: 1, published: 0 });
    expect((await rowsOf(db(), sig))[0]).toMatchObject({
      event_name: 'Unknown',
      apply_error: expect.stringMatching(/^decode_failed/),
      applied_at: null,
    });
  });

  it('transient DB errors → 503 and nothing stored; deterministic failures → 200 + rows kept as projector_failed', async () => {
    const failing = (err: unknown): ChainProjector => ({
      apply: async () => {
        throw err;
      },
    });
    const coded = (code: string) => Object.assign(new Error('boom'), { code });
    for (const [label, err, status] of [
      ['08006', coded('08006'), 503],
      ['40001', coded('40001'), 503],
      ['CONNECTION_CLOSED', coded('CONNECTION_CLOSED'), 503],
      ['23514', coded('23514'), 200],
      ['P0001 (trigger RAISE)', coded('P0001'), 200],
      ['plain Error', new Error('appendBetEvent: unknown bet'), 200],
      ['TypeError', new TypeError('x is undefined'), 200],
    ] as const) {
      const a = buildApp(deps, [createChainRoutes({ projector: failing(err) })]);
      const sig = randomSig();
      const good = samplePayload('BetResolved', { bet_id: randomUUID() });
      const d = delivery([
        {
          signature: sig,
          events: [
            { outerIx: 0, name: 'BetResolved', payload: good },
            { outerIx: 1, name: 'BetClosed', payload: samplePayload('BetClosed') },
          ],
        },
      ]);
      d.txs[0]!.events[1]!.eventBase64 = Buffer.from(new Uint8Array(30)).toString('base64');
      const json = new TextEncoder().encode(JSON.stringify(d));
      const res = await a.request(QUICKNODE_WEBHOOK_PATH, {
        method: 'POST',
        headers: signedHeaders(json),
        body: json,
      });
      expect(res.status, label).toBe(status);
      const rows = await rowsOf(db(), sig);
      if (status === 503) {
        expect(rows, label).toHaveLength(0); // rolled back; QuickNode retries
        continue;
      }
      expect(await res.json(), label).toMatchObject({
        ok: false,
        reason: 'projector_failed',
        stored: 2,
        failed: 0,
      });
      // the valid event is kept for audit / replay; the undecodable one keeps its own error
      expect(
        rows.map((x) => [x.outer_ix, x.apply_error, x.applied_at]),
        label,
      ).toEqual([
        [0, 'projector_failed', null],
        [1, expect.stringMatching(/^decode_failed/), null],
      ]);
    }
  });

  it('a projector_failed row is re-folded by the next event of its bet', async () => {
    const lockSig = randomSig();
    const { betId, L } = await mkBet(lockSig);
    const broken = buildApp(deps, [
      createChainRoutes({
        projector: {
          apply: async () => {
            throw new TypeError('bug in this build');
          },
        },
      }),
    ]);
    const body = delivery([
      {
        signature: lockSig,
        events: [
          { outerIx: 3, name: 'BetCreated', payload: L.created() },
          { outerIx: 4, name: 'BetAccepted', payload: L.accepted() },
        ],
      },
    ]);
    const json = new TextEncoder().encode(JSON.stringify(body));
    const r = await broken.request(QUICKNODE_WEBHOOK_PATH, {
      method: 'POST',
      headers: signedHeaders(json),
      body: json,
    });
    expect(await r.json()).toMatchObject({ ok: false, reason: 'projector_failed', stored: 2 });
    // the fixed build: the next delivery for the bet folds the stored rows too
    const res = randomSig();
    const next = await post(
      delivery([
        {
          signature: res,
          blockHeight: 400_118_500,
          events: [{ outerIx: 1, name: 'BetResolved', payload: L.resolved('PartyA') }],
        },
      ]),
    );
    expect(next.json).toMatchObject({ ok: true, inserted: 1 });
    expect((await logOf(db(), betId)).map((e) => e.type)).toEqual([
      'chain.BetCreated',
      'chain.BetAccepted',
      'chain.BetResolved',
      'bet.state',
    ]);
    expect((await rowsOf(db(), lockSig)).every((x) => x.apply_error === null && x.applied_at)).toBe(
      true,
    );
  });

  it('binds events to OUR instance of a bet_id: nothing after our BetClosed or a later foreign BetCreated is pushed', async () => {
    const lockSig = randomSig();
    // the RPC path already paid it out (PAID): the Stream only confirms
    const { betId, L } = await mkBet(lockSig, { state: 'PAID' });
    const settleSig = randomSig();
    const publish = vi.spyOn(deps.hub, 'publishBetEvent');
    publish.mockClear();
    // our lifecycle: lock, then concede + close in one tx (the server sends both together)
    const ours = await post(
      delivery([
        {
          signature: lockSig,
          blockHeight: 500_000,
          events: [
            { outerIx: 3, name: 'BetCreated', payload: L.created() },
            { outerIx: 4, name: 'BetAccepted', payload: L.accepted() },
          ],
        },
        {
          signature: settleSig,
          blockHeight: 500_100,
          events: [
            { outerIx: 0, name: 'BetConceded', payload: L.conceded('PartyA') },
            { outerIx: 1, name: 'BetClosed', payload: L.closed('Settled') },
          ],
        },
      ]),
    );
    expect(ours.json).toMatchObject({ inserted: 4, published: 4 });

    // close_bet freed the PDA: someone creates an independent bet with the same bet_id
    const ev = (outerIx: number, name: string) => ({
      outerIx,
      name,
      payload: samplePayload(name, { bet_id: betId }),
    });
    const foreignLock = randomSig();
    const foreignLater = randomSig();
    const theirs = await post(
      delivery([
        {
          signature: foreignLock,
          blockHeight: 500_200,
          events: [ev(3, 'BetCreated'), ev(4, 'BetAccepted')],
        },
        {
          signature: foreignLater,
          blockHeight: 500_300,
          events: [ev(0, 'BetResolved'), ev(1, 'BetClosed')],
        },
      ]),
    );
    expect(theirs.json).toMatchObject({ inserted: 4, published: 0 });
    expect(publish).toHaveBeenCalledTimes(4);
    expect((await logOf(db(), betId)).map((e) => e.type)).toEqual([
      'chain.BetCreated',
      'chain.BetAccepted',
      'chain.BetConceded',
      'chain.BetClosed',
    ]);
    for (const sig of [foreignLock, foreignLater])
      expect((await rowsOf(db(), sig)).map((r) => [r.apply_error, r.applied_at])).toEqual([
        ['not_ours_lock', null],
        ['not_ours_lock', null],
      ]);
    // the foreign instance never touched our projection
    expect(await betRow(db(), betId)).toMatchObject({
      state: 'PAID',
      onchain_status: 'settled',
      payout_sig: settleSig,
      close_sig: settleSig,
    });

    // an rpc_poll row (no block height) the server never sent is ambiguous once the bet_id has
    // been closed / re-created: not pushed either, and parked (its order is unknown), not
    // ruled out for good
    const polled = parseStreamDelivery(
      delivery([{ signature: randomSig(), events: [ev(0, 'BetRefunded')] }]),
    ).events.map((e) => ({ ...e, block_height: null, tx_index: null }));
    const r = await ingestChainEvents(deps, createChainProjector(), polled, {
      deliveryId: null,
      source: 'rpc_poll',
    });
    expect(r).toMatchObject({ inserted: 1, published: 0 });
    expect(
      (await rowsOf(db(), polled[0]!.signature)).map((x) => [x.apply_error, x.applied_at]),
    ).toEqual([['not_ours', null]]);
    publish.mockRestore();
  });

  it('a foreign BetCreated arriving BEFORE our close still bounds our instance (out-of-order delivery)', async () => {
    const lockSig = randomSig();
    const { betId, L } = await mkBet(lockSig, { state: 'EXPIRED', end_reason: 'resolve_timeout' });
    const ev = (outerIx: number, name: string) => ({
      outerIx,
      name,
      payload: samplePayload(name, { bet_id: betId }),
    });
    const foreign = randomSig();
    const foreignAccept = randomSig();
    const closeSig = randomSig();
    const r = await post(
      delivery([
        { signature: foreign, blockHeight: 600_200, events: [ev(0, 'BetCreated')] },
        { signature: foreignAccept, blockHeight: 600_250, events: [ev(0, 'BetAccepted')] },
        {
          signature: lockSig,
          blockHeight: 600_000,
          events: [
            { outerIx: 3, name: 'BetCreated', payload: L.created() },
            { outerIx: 4, name: 'BetAccepted', payload: L.accepted() },
          ],
        },
        {
          signature: closeSig,
          blockHeight: 600_100,
          events: [
            { outerIx: 0, name: 'BetRefunded', payload: L.refunded('Locked') },
            { outerIx: 1, name: 'BetClosed', payload: L.closed('Refunded') },
          ],
        },
      ]),
    );
    expect(r.json).toMatchObject({ inserted: 6, published: 4 });
    expect((await rowsOf(db(), foreignAccept))[0]!.apply_error).toBe('not_ours_lock');
    expect(await betRow(db(), betId)).toMatchObject({
      state: 'EXPIRED',
      onchain_status: 'refunded',
      payout_via: 'timeout_refund',
      outcome: 'refund',
    });
  });

  it('un-parks a lock the Stream delivered before the signature was recorded, when the rpc_poll copy arrives', async () => {
    const lockSig = randomSig();
    const { betId, L } = await mkBet(null); // no chain_txs, no pending_sig yet
    const body = delivery([
      {
        signature: lockSig,
        events: [
          { outerIx: 3, name: 'BetCreated', payload: L.created() },
          { outerIx: 4, name: 'BetAccepted', payload: L.accepted() },
        ],
      },
    ]);
    expect((await post(body)).json).toMatchObject({ inserted: 2, published: 0 });
    expect((await rowsOf(db(), lockSig)).map((r) => r.apply_error)).toEqual([
      'not_ours',
      'not_ours',
    ]);

    // the tx sender records the lock at its RPC `confirmed` (the pending_sig fallback lookup)
    await h.db
      .update(bets)
      .set({ onchain_pending: 'locked', pending_sig: lockSig })
      .where(eq(bets.id, betId));
    // the reconciler's getTransaction copy is a pure duplicate, yet it un-parks the lock
    const polled = parseStreamDelivery(body).events.map((e) => ({ ...e, block_height: null }));
    const r = await ingestChainEvents(deps, createChainProjector(), polled, {
      deliveryId: null,
      source: 'rpc_poll',
    });
    expect(r).toMatchObject({ inserted: 0, duplicates: 2, published: 2 });
    expect((await logOf(db(), betId)).map((e) => e.type)).toEqual([
      'chain.BetCreated',
      'chain.BetAccepted',
    ]);
    expect((await rowsOf(db(), lockSig)).every((x) => x.applied_at && x.apply_error === null)).toBe(
      true,
    );
    // pending cleared; later events still attribute (the applied BetCreated is the verified lock)
    expect(await betRow(db(), betId)).toMatchObject({ onchain_pending: null, pending_sig: null });
    const res = randomSig();
    const later = await post(
      delivery([
        {
          signature: res,
          blockHeight: 400_119_000,
          events: [{ outerIx: 1, name: 'BetResolved', payload: L.resolved('PartyA') }],
        },
      ]),
    );
    expect(later.json).toMatchObject({ inserted: 1, published: 2 });
  });

  it('refoldParkedInTx applies parked rows when the lock signature is recorded (LockService hook)', async () => {
    const lockSig = randomSig();
    const { betId, L } = await mkBet(null);
    await post(
      delivery([
        {
          signature: lockSig,
          events: [{ outerIx: 3, name: 'BetCreated', payload: L.created() }],
        },
      ]),
    );
    const fan = await h.db.transaction(async (tx) => {
      await mkLockTx(tx as never, betId, lockSig, 'sent');
      return refoldParkedInTx(tx, createChainProjector(), [betId], NOW);
    });
    expect(fan.map((f) => f.envelope.type)).toEqual(['chain.BetCreated']);
  });

  it('the dedupe key is UNIQUE in the table itself', async () => {
    const sig = randomSig();
    const row = {
      signature: sig,
      outer_ix: 1,
      inner_ix: 0,
      program_id: ESCROW_ID,
      event_name: 'BetClosed',
      payload: {},
    };
    await h.db.insert(chainEvents).values(row);
    await expect(h.db.insert(chainEvents).values(row)).rejects.toThrow();
    const n = await h.db
      .select()
      .from(chainEvents)
      .where(and(eq(chainEvents.signature, sig), eq(chainEvents.outer_ix, 1)));
    expect(n).toHaveLength(1);
  });
});
