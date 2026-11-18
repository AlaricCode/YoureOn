// The chain projector over Postgres (skips without DATABASE_URL), driven through
// POST /webhooks/quicknode: the projection columns, idempotency with the LockService /
// PayoutService RPC-confirmed writes (already-LOCKED / already-PAID: no state change, no cue),
// the chain-wins reconcile of missed confirms, duplicates and out-of-order deliveries, unknown-bet
// parking, per-bet containment of a rejected write, mismatch audit rows, and the committed
// fixture (infra/quicknode/fixtures) through filter.js -> webhook -> projector.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { bets, chainEvents, createDb, type DbHandle } from '@youre-on/db';
import { buildApp } from '../src/app';
import type { App, AppDeps } from '../src/context';
import { createDeps } from '../src/server';
import { createChainRoutes, QUICKNODE_WEBHOOK_PATH } from '../src/chain/routes';
import { createChainProjector } from '../src/chain/projector';
import { ingestChainEvents } from '../src/chain/ingest';
import { parseStreamDelivery } from '../src/chain/streams';
import {
  betFacts,
  delivery,
  INFRA_QN,
  lifecycle,
  loadQnFilter,
  qnSignedHeaders,
  randomSig,
  type BetFacts,
  type DeliveryEvent,
} from './chain-fixtures';
import {
  auditOf,
  betRow,
  eventsOfBet,
  lockTxOf,
  logOf,
  mkBetRow,
  mkLockTx,
  mkServerTx,
  mkUser,
  outboxOf,
} from './chain-db';
import { describeDb, testEnv } from './helpers';

const TOKEN = 'qn-projector-token-' + randomBytes(8).toString('hex');
const NOW = 1_795_284_425_000;

type BetState = (typeof bets.$inferSelect)['state'];
const types = (log: { type: string }[]) => log.map((e) => e.type);
const cueOf = (log: { type: string; envelope: unknown }[]) =>
  log
    .filter((e) => e.type === 'judge.cue')
    .map((e) => (e.envelope as { payload: { cue: string; text: string } }).payload);
const stateOf = (log: { type: string; envelope: unknown }[]) =>
  log
    .filter((e) => e.type === 'bet.state')
    .map(
      (e) =>
        (
          e.envelope as {
            payload: { state: string; prev: string; chain_ack: string; reason: string | null };
          }
        ).payload,
    );

describeDb('chain projector over Postgres (webhook -> bets projection)', () => {
  let h: DbHandle;
  let deps: AppDeps;
  let app: App;
  let A: string, B: string;
  const db = () => h.db;

  const post = async (payload: unknown) => {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const res = await app.request(QUICKNODE_WEBHOOK_PATH, {
      method: 'POST',
      headers: qnSignedHeaders(json, TOKEN, NOW),
      body: json,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /** A bet the server locked (chain_txs atomic_lock = `lockSig`) in `state`. */
  async function bet(
    state: BetState,
    o: {
      pending?: boolean;
      end_reason?: (typeof bets.$inferSelect)['end_reason'];
      authorized?: boolean;
      facts?: Partial<BetFacts>;
      extra?: Partial<typeof bets.$inferInsert>;
    } = {},
  ) {
    const f = betFacts(o.facts);
    const lockSig = randomSig();
    await mkBetRow(db(), f, {
      partyA: A,
      partyB: B,
      state,
      end_reason: o.end_reason ?? null,
      authorized: o.authorized,
      pendingSig: o.pending ? lockSig : null,
      extra: o.extra,
    });
    const lockTx = await mkLockTx(db(), f.bet_id, lockSig);
    return { id: f.bet_id, f, L: lifecycle(f), lockSig, lockTx };
  }

  type Bet = Awaited<ReturnType<typeof bet>>;
  const lockTx = (b: Bet, blockHeight = 700_000): Parameters<typeof delivery>[0][number] => ({
    signature: b.lockSig,
    blockHeight,
    events: [
      { outerIx: 3, name: 'BetCreated', payload: b.L.created() },
      { outerIx: 4, name: 'BetAccepted', payload: b.L.accepted() },
    ],
  });
  const tx = (signature: string, blockHeight: number, events: DeliveryEvent[]) => ({
    signature,
    blockHeight,
    events,
  });

  beforeAll(async () => {
    const env = testEnv({ QN_STREAM_SECURITY_TOKEN: TOKEN });
    h = createDb({ url: env.DATABASE_URL, max: 4 });
    deps = createDeps({ env, dbHandle: h, rateLimit: false, now: () => NOW }).deps;
    app = buildApp(deps, [createChainRoutes()]);
    A = await mkUser(h.db, 'Logan');
    B = await mkUser(h.db, 'Jake');
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('confirming what the RPC path already wrote (idempotent: no state move, no cue)', () => {
    it('atomic lock on an RPC-LOCKED bet: columns, pending cleared, stream_seen_at, outbox bet_locked', async () => {
      const b = await bet('LOCKED', { pending: true });
      const info = vi.spyOn(deps.log, 'info');
      const r = await post(delivery([lockTx(b)]));
      expect(r.json).toMatchObject({ ok: true, inserted: 2, published: 2 });
      const row = await betRow(db(), b.id);
      expect(row).toMatchObject({
        state: 'LOCKED',
        onchain_status: 'locked',
        onchain_pending: null,
        pending_sig: null,
        create_sig: b.lockSig,
        accept_sig: b.lockSig,
        bet_pda: b.f.bet,
        vault: b.f.vault,
        accept_deadline: new Date((b.f.t0 + 300) * 1000),
        locked_at: new Date(b.f.t0 * 1000),
        resolve_deadline: new Date((b.f.t0 + 3600) * 1000),
      });
      expect(types(await logOf(db(), b.id))).toEqual(['chain.BetCreated', 'chain.BetAccepted']);
      expect((await lockTxOf(db(), b.lockTx)).stream_seen_at).toEqual(new Date(NOW));
      // the Streams lane latency is logged once, when the lock is first seen
      expect(info).toHaveBeenCalledWith(
        'chain.stream_seen',
        expect.objectContaining({
          bet_id: b.id,
          kind: 'atomic_lock',
          send_to_stream_ms: expect.any(Number),
        }),
      );
      expect(info).toHaveBeenCalledWith(
        'chain.delivery',
        expect.objectContaining({ block_to_webhook_ms: NOW - 1_795_284_425_000 }),
      );
      info.mockRestore();
      // the lock row's status is the LockService's (its sweep releases the nonce from it)
      expect((await lockTxOf(db(), b.lockTx)).status).toBe('confirmed');
      const pushes = await outboxOf(db(), b.id);
      expect(pushes.map((p) => [p.kind, p.recipient_user_id])).toEqual([
        ['bet_locked', A],
        ['bet_locked', B],
      ]);
      expect(pushes[0]!.dedupe_key).toBe(`${b.id}:bet_locked:${b.lockSig}:${A}`);
      expect(await auditOf(db(), b.id, 'chain.mismatch')).toEqual([]);
    });

    it('lock -> resolve -> concede + close after the RPC path ruled and paid: chain columns only', async () => {
      const b = await bet('LOCKED', { pending: true });
      await post(delivery([lockTx(b)]));
      // PayoutService.markRuled at its own `confirmed` (values read back from the Bet account)
      const resolved = b.L.resolved('PartyA');
      await db()
        .update(bets)
        .set({
          state: 'RULED',
          outcome: 'party_a',
          evidence_hash: resolved.evidence_hash,
          ruling_hash: resolved.ruling_hash,
          appeal_deadline: new Date(resolved.appeal_deadline * 1000),
        })
        .where(eq(bets.id, b.id));
      const resolveSig = randomSig();
      await mkServerTx(db(), b.id, 'resolve', resolveSig);
      expect(
        (
          await post(
            delivery([
              tx(resolveSig, 700_100, [{ outerIx: 1, name: 'BetResolved', payload: resolved }]),
            ]),
          )
        ).json,
      ).toMatchObject({ inserted: 1, published: 1 });
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'RULED',
        onchain_status: 'resolved',
        resolve_sig: resolveSig,
        resolved_at: new Date((b.f.t0 + 60) * 1000),
      });

      // PayoutService.settle at its own `confirmed`: PAID, payout_via
      await db()
        .update(bets)
        .set({ state: 'PAID', payout_via: 'concede' })
        .where(eq(bets.id, b.id));
      const paySig = randomSig();
      await mkServerTx(db(), b.id, 'concede', paySig);
      const before = await logOf(db(), b.id);
      const r = await post(
        delivery([
          tx(paySig, 700_200, [
            { outerIx: 2, name: 'BetConceded', payload: b.L.conceded('PartyA') },
            { outerIx: 3, name: 'BetClosed', payload: b.L.closed('Settled') },
          ]),
        ]),
      );
      expect(r.json).toMatchObject({ inserted: 2, published: 2 });
      const row = await betRow(db(), b.id);
      expect(row).toMatchObject({
        state: 'PAID',
        onchain_status: 'settled',
        outcome: 'party_a',
        payout_a: 10_000_000n,
        payout_b: 0n,
        payout_via: 'concede',
        payout_sig: paySig,
        close_sig: paySig,
        settled_at: new Date((b.f.t0 + 66) * 1000),
        closed_at: new Date((b.f.t0 + 72) * 1000),
      });
      const log = await logOf(db(), b.id);
      expect(types(log.slice(before.length))).toEqual(['chain.BetConceded', 'chain.BetClosed']);
      expect(cueOf(log)).toEqual([]); // the RPC path voiced PAID; the Stream never repeats it
      expect(stateOf(log)).toEqual([]);
      expect((await outboxOf(db(), b.id)).map((p) => p.kind)).toEqual([
        'bet_locked',
        'bet_locked',
        'payout',
        'payout',
      ]);
      expect(await auditOf(db(), b.id, 'chain.mismatch')).toEqual([]);

      // a full replay of every delivery (Stream retry, rpc_poll copies): nothing changes at all
      const version = row.version;
      const again = await post(
        delivery([
          lockTx(b),
          tx(resolveSig, 700_100, [{ outerIx: 1, name: 'BetResolved', payload: resolved }]),
          tx(paySig, 700_200, [
            { outerIx: 2, name: 'BetConceded', payload: b.L.conceded('PartyA') },
            { outerIx: 3, name: 'BetClosed', payload: b.L.closed('Settled') },
          ]),
        ]),
      );
      expect(again.json).toMatchObject({ inserted: 0, duplicates: 5, published: 0 });
      expect((await betRow(db(), b.id)).version).toBe(version);
      expect(await logOf(db(), b.id)).toHaveLength(log.length);
    });
  });

  describe('reconcile: the chain is ahead of a missed RPC confirm (the chain wins)', () => {
    it('AWAITING_LOCK -> LOCKED with bet.state (chain_ack stream) and the LOCKED cue', async () => {
      const b = await bet('AWAITING_LOCK');
      const publishUser = vi.spyOn(deps.hub, 'publishToUser');
      publishUser.mockClear();
      const r = await post(delivery([lockTx(b)]));
      expect(r.json).toMatchObject({ inserted: 2, published: 4 });
      const log = await logOf(db(), b.id);
      expect(types(log)).toEqual([
        'chain.BetCreated',
        'chain.BetAccepted',
        'bet.state',
        'judge.cue',
      ]);
      expect(stateOf(log)).toEqual([
        {
          state: 'LOCKED',
          prev: 'AWAITING_LOCK',
          chain_ack: 'stream',
          reason: null,
          onchain_status: 'Locked',
          pending_tx: null,
        },
      ]);
      expect(cueOf(log)[0]).toMatchObject({ cue: 'LOCKED', speak: true });
      expect(cueOf(log)[0]!.text).toContain('[EVENT] LOCKED pot=$10 a=Logan b=Jake');
      // both parties' user channels get every envelope too (as lock/common fanout does)
      expect(new Set(publishUser.mock.calls.map(([u]) => u))).toEqual(new Set([A, B]));
      expect(publishUser).toHaveBeenCalledTimes(8);
      publishUser.mockRestore();
      expect(await betRow(db(), b.id)).toMatchObject({ state: 'LOCKED', onchain_status: 'locked' });
    });

    it('FINALIZED (confirm timed out) -> PAID with the PAID cue; a Refund outcome -> VOIDED', async () => {
      for (const [outcome, final, cue] of [
        ['PartyB', 'PAID', 'PAID'],
        ['Refund', 'VOIDED', 'VOIDED'],
      ] as const) {
        const b = await bet('LOCKED', { pending: true });
        await post(delivery([lockTx(b)]));
        const resolved = b.L.resolved(outcome);
        const resolveSig = randomSig();
        await post(
          delivery([
            tx(resolveSig, 700_100, [{ outerIx: 1, name: 'BetResolved', payload: resolved }]),
          ]),
        );
        expect((await betRow(db(), b.id)).state).toBe('RULED'); // the resolve confirm was missed too
        // the finalize was sent (FINALIZED) but its confirm never came back
        await db().update(bets).set({ state: 'FINALIZED' }).where(eq(bets.id, b.id));
        const paySig = randomSig();
        await mkServerTx(db(), b.id, 'finalize', paySig, 'sent');
        const before = (await logOf(db(), b.id)).length;
        await post(
          delivery([
            tx(paySig, 700_300, [
              { outerIx: 2, name: 'BetFinalized', payload: b.L.finalized(outcome) },
              { outerIx: 3, name: 'BetClosed', payload: b.L.closed('Settled') },
            ]),
          ]),
        );
        const log = (await logOf(db(), b.id)).slice(before);
        expect(types(log)).toEqual([
          'chain.BetFinalized',
          'chain.BetClosed',
          'bet.state',
          'judge.cue',
        ]);
        expect(stateOf(log)[0]).toMatchObject({
          state: final,
          prev: 'FINALIZED',
          reason: 'finalize',
        });
        expect(cueOf(log)[0]!.cue).toBe(cue);
        if (cue === 'PAID') expect(cueOf(log)[0]!.text).toContain('winner=Jake amount=$10');
        else expect(cueOf(log)[0]!.text).toContain('a=$5 b=$5');
        expect(await betRow(db(), b.id)).toMatchObject({
          state: final,
          onchain_status: 'settled',
          payout_via: 'finalize',
          payout_sig: paySig,
          outcome: outcome === 'Refund' ? 'refund' : 'party_b',
        });
      }
    });

    it('a lock that landed after the bet EXPIRED revives it (EXPIRED -> LOCKED, end_reason cleared)', async () => {
      const b = await bet('EXPIRED', { end_reason: 'accept_timeout' });
      await post(delivery([lockTx(b)]));
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'LOCKED',
        end_reason: null,
        onchain_status: 'locked',
      });
      const s = stateOf(await logOf(db(), b.id));
      expect(s).toMatchObject([{ state: 'LOCKED', prev: 'EXPIRED' }]);
    });

    it('timeout_refund from Locked -> EXPIRED (resolve_timeout) with the EXPIRED cue', async () => {
      const b = await bet('ATTEMPT', { pending: true });
      await post(delivery([lockTx(b)]));
      const refundSig = randomSig();
      await post(
        delivery([
          tx(refundSig, 704_000, [
            { outerIx: 1, name: 'BetRefunded', payload: b.L.refunded('Locked') },
            { outerIx: 2, name: 'BetClosed', payload: b.L.closed('Refunded') },
          ]),
        ]),
      );
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'EXPIRED',
        end_reason: 'resolve_timeout',
        onchain_status: 'refunded',
        outcome: 'refund',
        payout_a: 5_000_000n,
        payout_b: 5_000_000n,
        payout_via: 'timeout_refund',
      });
      const log = await logOf(db(), b.id);
      expect(stateOf(log)).toMatchObject([{ state: 'EXPIRED', reason: 'resolve_timeout' }]);
      expect(cueOf(log).map((c) => c.cue)).toEqual(['EXPIRED']);
      const refunds = (await outboxOf(db(), b.id)).filter((p) => p.kind === 'payout');
      expect(refunds.map((p) => [p.recipient_user_id, p.payload])).toEqual([
        [A, expect.objectContaining({ title: '$5 refunded', amount: '5000000' })],
        [B, expect.objectContaining({ title: '$5 refunded', amount: '5000000' })],
      ]);
    });

    it('appeal overturned: APPEAL_RESOLVED -> PAID, outcome flips without a mismatch', async () => {
      const b = await bet('LOCKED', { pending: true });
      await post(delivery([lockTx(b)]));
      await db().update(bets).set({ state: 'RULED', outcome: 'party_a' }).where(eq(bets.id, b.id));
      await post(
        delivery([
          tx(randomSig(), 700_100, [
            { outerIx: 1, name: 'BetResolved', payload: b.L.resolved('PartyA') },
          ]),
          tx(randomSig(), 700_150, [
            { outerIx: 1, name: 'BetAppealed', payload: b.L.appealed('PartyA') },
          ]),
        ]),
      );
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'APPEALED',
        onchain_status: 'appealed',
        appealed_at: new Date((b.f.t0 + 65) * 1000),
      });
      await db().update(bets).set({ state: 'APPEAL_RESOLVED' }).where(eq(bets.id, b.id));
      await post(
        delivery([
          tx(randomSig(), 700_400, [
            { outerIx: 2, name: 'AppealResolved', payload: b.L.appealResolved('PartyB', 'PartyA') },
            { outerIx: 3, name: 'BetClosed', payload: b.L.closed('Settled') },
          ]),
        ]),
      );
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'PAID',
        outcome: 'party_b',
        payout_a: 0n,
        payout_b: 10_000_000n,
        payout_via: 'resolve_appeal',
        appeal_ruling_hash: 'ef'.repeat(32),
      });
      expect(await auditOf(db(), b.id, 'chain.mismatch')).toEqual([]);
    });
  });

  describe('delivery order and duplicates', () => {
    it('reverse-order delivery folds to the same projection as in-order delivery', async () => {
      const proj = async (order: 'forward' | 'reverse') => {
        const b = await bet('LOCKED', { pending: true });
        const steps = [
          delivery([lockTx(b, 800_000)]),
          delivery([
            tx(randomSig(), 800_100, [
              { outerIx: 1, name: 'BetResolved', payload: b.L.resolved('PartyA') },
            ]),
          ]),
          delivery([
            tx(randomSig(), 800_200, [
              { outerIx: 2, name: 'BetFinalized', payload: b.L.finalized('PartyA') },
              { outerIx: 3, name: 'BetClosed', payload: b.L.closed('Settled') },
            ]),
          ]),
        ];
        for (const s of order === 'forward' ? steps : [...steps].reverse()) await post(s);
        const row = await betRow(db(), b.id);
        const log = await logOf(db(), b.id);
        const chain = log.filter((e) => e.type.startsWith('chain.')).map((e) => e.type);
        return { row, chain, states: stateOf(log).map((s) => s.state) };
      };
      const fwd = await proj('forward');
      const rev = await proj('reverse');
      const cols = (r: typeof fwd.row) => ({
        state: r.state,
        onchain_status: r.onchain_status,
        outcome: r.outcome,
        payout_a: r.payout_a,
        payout_b: r.payout_b,
        payout_via: r.payout_via,
        resolved_at: r.resolved_at,
        appeal_deadline: r.appeal_deadline,
        settled_at: r.settled_at,
        closed_at: r.closed_at,
        onchain_pending: r.onchain_pending,
      });
      expect(cols(rev.row)).toEqual(cols(fwd.row));
      expect(fwd.row).toMatchObject({ state: 'PAID', onchain_status: 'settled' });
      // reversed: the parked events are pushed in CHAIN order once the lock arrives
      expect(rev.chain).toEqual(fwd.chain);
      expect(rev.chain).toEqual([
        'chain.BetCreated',
        'chain.BetAccepted',
        'chain.BetResolved',
        'chain.BetFinalized',
        'chain.BetClosed',
      ]);
      expect(fwd.states).toEqual(['RULED', 'PAID']);
      expect(rev.states).toEqual(['PAID']); // one fold, one move
    });

    it('a stream copy then an rpc_poll copy of the same events is a no-op', async () => {
      const b = await bet('LOCKED', { pending: true });
      const body = delivery([lockTx(b)]);
      await post(body);
      const version = (await betRow(db(), b.id)).version;
      const polled = parseStreamDelivery(body).events.map((e) => ({
        ...e,
        block_height: null,
        tx_index: null,
      }));
      const r = await ingestChainEvents(deps, createChainProjector(), polled, {
        deliveryId: null,
        source: 'rpc_poll',
      });
      expect(r).toMatchObject({ inserted: 0, duplicates: 2, published: 0 });
      expect((await betRow(db(), b.id)).version).toBe(version);
    });

    it('an rpc_poll lock (no block height) projects like the stream copy, without stream_seen_at', async () => {
      const b = await bet('AWAITING_LOCK');
      const polled = parseStreamDelivery(delivery([lockTx(b)])).events.map((e) => ({
        ...e,
        block_height: null,
        tx_index: null,
      }));
      const r = await ingestChainEvents(deps, createChainProjector(), polled, {
        deliveryId: null,
        source: 'rpc_poll',
      });
      expect(r).toMatchObject({ inserted: 2, published: 4 });
      expect(await betRow(db(), b.id)).toMatchObject({ state: 'LOCKED', onchain_status: 'locked' });
      expect((await lockTxOf(db(), b.lockTx)).stream_seen_at).toBeNull();
      const env = (await logOf(db(), b.id))[0]!.envelope as { payload: { observed_via: string } };
      expect(env.payload.observed_via).toBe('rpc_poll');
    });

    it('rpc_poll stored the lock first: the late Stream copy backfills its block position, so a third party’s payout still attributes', async () => {
      const b = await bet('RULED', { pending: true });
      const body = delivery([lockTx(b, 820_000)]);
      const polled = parseStreamDelivery(body).events.map((e) => ({
        ...e,
        block_height: null,
        tx_index: null,
      }));
      await ingestChainEvents(deps, createChainProjector(), polled, {
        deliveryId: null,
        source: 'rpc_poll',
      });
      expect((await eventsOfBet(db(), b.id)).map((e) => e.block_height)).toEqual([null, null]);
      // the resumed Stream delivers its copy: a duplicate, but it fills in what rpc_poll lacked
      expect((await post(body)).json).toMatchObject({ inserted: 0, published: 0 });
      expect((await eventsOfBet(db(), b.id)).map((e) => [e.block_height, e.tx_index])).toEqual([
        [820_000, 0],
        [820_000, 0],
      ]);
      expect((await lockTxOf(db(), b.lockTx)).stream_seen_at).toEqual(new Date(NOW));
      // someone else's resolve + finalize + close (permissionless, never in chain_txs): with
      // the lock's position known, the BetClosed no longer makes them ambiguous
      const fin = randomSig();
      const r = await post(
        delivery([
          tx(randomSig(), 820_100, [
            { outerIx: 1, name: 'BetResolved', payload: b.L.resolved('PartyA') },
          ]),
          tx(fin, 820_200, [
            { outerIx: 2, name: 'BetFinalized', payload: b.L.finalized('PartyA') },
            { outerIx: 3, name: 'BetClosed', payload: b.L.closed('Settled') },
          ]),
        ]),
      );
      expect(r.json).toMatchObject({ inserted: 3 });
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'PAID',
        onchain_status: 'settled',
        payout_sig: fin,
      });
      expect((await eventsOfBet(db(), b.id)).every((e) => e.apply_error === null)).toBe(true);
    });
  });

  describe('parking, containment and audit', () => {
    it('unknown bet: parked as unknown_bet, applied when a later copy finds the row', async () => {
      const f = betFacts();
      const L = lifecycle(f);
      const lockSig = randomSig();
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
      expect((await eventsOfBet(db(), f.bet_id)).map((r) => r.apply_error)).toEqual([
        'unknown_bet',
        'unknown_bet',
      ]);
      // the row appears (e.g. restored after a demo reset) and the sweep replays the lock
      await mkBetRow(db(), f, { partyA: A, partyB: B, state: 'AWAITING_LOCK' });
      await mkLockTx(db(), f.bet_id, lockSig);
      const r = await post(body);
      expect(r.json).toMatchObject({ inserted: 0, duplicates: 2, published: 4 });
      expect(await betRow(db(), f.bet_id)).toMatchObject({
        state: 'LOCKED',
        onchain_status: 'locked',
      });
      expect(
        (await eventsOfBet(db(), f.bet_id)).every((e) => e.apply_error === null && e.applied_at),
      ).toBe(true);
    });

    it('a rejected write (CHECK) is contained to its bet: events still pushed, audit + no state move', async () => {
      // bets_locked_authorized: an onchain lock without both authorizations recorded
      const bad = await bet('AWAITING_LOCK', { authorized: false });
      const good = await bet('AWAITING_LOCK');
      const r = await post(delivery([lockTx(bad, 900_000), lockTx(good, 900_001)]));
      expect(r).toMatchObject({ status: 200, json: { ok: true, inserted: 4 } });
      expect(await betRow(db(), good.id)).toMatchObject({
        state: 'LOCKED',
        onchain_status: 'locked',
      });
      expect(await betRow(db(), bad.id)).toMatchObject({
        state: 'AWAITING_LOCK',
        onchain_status: 'none',
      });
      expect(types(await logOf(db(), bad.id))).toEqual(['chain.BetCreated', 'chain.BetAccepted']);
      const [audit] = await auditOf(db(), bad.id, 'chain.projection_rejected');
      expect(audit!.details).toMatchObject({
        code: '23514',
        constraint: 'bets_locked_authorized',
        events: ['BetCreated', 'BetAccepted'],
        onchain_status: 'locked',
        state: 'LOCKED',
      });
      // parked as projection_rejected (already pushed), not as applied
      expect(
        (await eventsOfBet(db(), bad.id)).map((e) => [e.apply_error, e.applied_at !== null]),
      ).toEqual([
        ['projection_rejected', true],
        ['projection_rejected', true],
      ]);
      // a duplicate copy retries it: still rejected -> no second audit row, nothing re-pushed
      expect((await post(delivery([lockTx(bad, 900_000)]))).json).toMatchObject({
        inserted: 0,
        published: 0,
      });
      expect(await auditOf(db(), bad.id, 'chain.projection_rejected')).toHaveLength(1);
      expect(types(await logOf(db(), bad.id))).toEqual(['chain.BetCreated', 'chain.BetAccepted']);
      // fixed by hand: the bet's next event re-attempts the projection from the full set
      const at = new Date();
      await db()
        .update(bets)
        .set({
          a_authorized_at: at,
          a_authorization_method: 'faceid_hold',
          b_authorized_at: at,
          b_authorization_method: 'faceid_hold',
        })
        .where(eq(bets.id, bad.id));
      await post(
        delivery([
          tx(randomSig(), 900_100, [
            { outerIx: 1, name: 'BetResolved', payload: bad.L.resolved('PartyA') },
          ]),
        ]),
      );
      expect(await betRow(db(), bad.id)).toMatchObject({
        state: 'RULED',
        onchain_status: 'resolved',
        create_sig: bad.lockSig,
      });
      // the lock rows are applied now, and were pushed exactly once
      expect((await eventsOfBet(db(), bad.id)).every((e) => e.apply_error === null)).toBe(true);
      expect(types(await logOf(db(), bad.id))).toEqual([
        'chain.BetCreated',
        'chain.BetAccepted',
        'chain.BetResolved',
        'bet.state',
      ]);
    });

    it('a rejected terminal projection is retried by a duplicate copy once fixed (no later event needed)', async () => {
      // bets_locked_authorized rejects the whole history (lock .. payout) in one delivery
      const b = await bet('AWAITING_LOCK', { authorized: false });
      const fin = randomSig();
      const payout = tx(fin, 700_200, [
        { outerIx: 2, name: 'BetFinalized', payload: b.L.finalized('PartyA') },
        { outerIx: 3, name: 'BetClosed', payload: b.L.closed('Settled') },
      ]);
      await post(
        delivery([
          lockTx(b),
          tx(randomSig(), 700_100, [
            { outerIx: 1, name: 'BetResolved', payload: b.L.resolved('PartyA') },
          ]),
          payout,
        ]),
      );
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'AWAITING_LOCK',
        onchain_status: 'none',
      });
      // the last events a bet ever emits: no later event will come to retry it
      const at = new Date();
      await db()
        .update(bets)
        .set({
          a_authorized_at: at,
          a_authorization_method: 'faceid_hold',
          b_authorized_at: at,
          b_authorization_method: 'faceid_hold',
        })
        .where(eq(bets.id, b.id));
      // the Stream retries / the reconciler's copy arrives: the projection goes through
      const again = await post(delivery([payout]));
      expect(again.json).toMatchObject({ inserted: 0, published: 2 }); // bet.state + judge.cue
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'PAID',
        onchain_status: 'settled',
        payout_sig: fin,
        payout_a: 10_000_000n,
      });
      const log = await logOf(db(), b.id);
      expect(types(log).filter((t) => t.startsWith('chain.'))).toEqual([
        'chain.BetCreated',
        'chain.BetAccepted',
        'chain.BetResolved',
        'chain.BetFinalized',
        'chain.BetClosed',
      ]);
      expect(cueOf(log).map((c) => c.cue)).toEqual(['PAID']);
      expect((await eventsOfBet(db(), b.id)).every((e) => e.apply_error === null)).toBe(true);
    });

    it('a chain value that disagrees with the row is applied (chain wins) and audited once', async () => {
      const b = await bet('LOCKED', { pending: true });
      const wrong = 'aa'.repeat(32);
      const body = delivery([
        {
          signature: b.lockSig,
          blockHeight: 950_000,
          events: [
            { outerIx: 3, name: 'BetCreated', payload: { ...b.L.created(), terms_hash: wrong } },
            { outerIx: 4, name: 'BetAccepted', payload: { ...b.L.accepted(), terms_hash: wrong } },
          ],
        },
      ]);
      const log = vi.spyOn(deps.log, 'error');
      await post(body);
      expect((await betRow(db(), b.id)).onchain_status).toBe('locked');
      const audits = await auditOf(db(), b.id, 'chain.mismatch');
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({
        mismatches: [
          { field: 'terms_hash', chain: wrong, db: b.f.terms_hash, event: 'BetCreated' },
        ],
      });
      expect(log).toHaveBeenCalledWith('chain.mismatch', expect.objectContaining({ alert: true }));
      log.mockRestore();
      // the next event does not re-audit the old disagreement
      await post(
        delivery([
          tx(randomSig(), 950_100, [
            { outerIx: 1, name: 'BetResolved', payload: b.L.resolved('PartyA') },
          ]),
        ]),
      );
      expect(await auditOf(db(), b.id, 'chain.mismatch')).toHaveLength(1);
    });

    it('a terminal row keeps its money columns when a later event disagrees', async () => {
      const b = await bet('LOCKED', { pending: true });
      await post(delivery([lockTx(b)]));
      await post(
        delivery([
          tx(randomSig(), 700_100, [
            { outerIx: 1, name: 'BetResolved', payload: b.L.resolved('PartyA') },
          ]),
          tx(randomSig(), 700_200, [
            { outerIx: 2, name: 'BetFinalized', payload: b.L.finalized('PartyA') },
          ]),
        ]),
      );
      const paid = await betRow(db(), b.id);
      expect(paid).toMatchObject({
        state: 'PAID',
        onchain_status: 'settled',
        payout_a: 10_000_000n,
      });
      // a second terminal event for the same instance (it cannot happen onchain): no change to
      // the settled money, the disagreement is audited
      await post(
        delivery([
          tx(randomSig(), 700_300, [
            { outerIx: 1, name: 'BetRefunded', payload: b.L.refunded('Locked') },
          ]),
        ]),
      );
      expect(await betRow(db(), b.id)).toMatchObject({
        state: 'PAID',
        onchain_status: 'settled',
        payout_a: 10_000_000n,
        payout_b: 0n,
        payout_via: 'finalize',
      });
      const [audit] = await auditOf(db(), b.id, 'chain.mismatch');
      expect(audit!.details).toMatchObject({
        mismatches: [{ field: 'onchain_status', chain: 'refunded', db: 'settled' }],
      });
    });
  });

  it('the committed fixture (infra/quicknode/fixtures) through filter.js -> webhook -> projector', async () => {
    const filter = loadQnFilter();
    const fx = JSON.parse(readFileSync(INFRA_QN('fixtures/block-atomic-lock.json'), 'utf8'));
    const out = filter.main(fx)!;
    const parsed = parseStreamDelivery(out);
    const created = parsed.events.find((e) => e.event_name === 'BetCreated')!;
    const p = created.payload as Record<string, string>;
    // fixed ids: clear what an earlier run of this suite left behind
    await db().delete(bets).where(eq(bets.id, p.bet_id!));
    await db()
      .delete(chainEvents)
      .where(inArray(chainEvents.signature, [created.signature]));
    const f = betFacts({
      bet_id: p.bet_id!,
      party_a: p.party_a!,
      party_b: p.party_b!,
      mint: p.mint!,
      stake_a: p.stake_a!,
      stake_b: p.stake_b!,
      terms_hash: p.terms_hash!,
    });
    await mkBetRow(db(), f, {
      partyA: A,
      partyB: B,
      state: 'LOCKED',
      pendingSig: created.signature,
    });
    const lockTxId = await mkLockTx(db(), f.bet_id, created.signature);
    const r = await post(out);
    expect(r.json).toMatchObject({ ok: true, received: 2, inserted: 2, published: 2 });
    expect(await betRow(db(), f.bet_id)).toMatchObject({
      state: 'LOCKED',
      onchain_status: 'locked',
      create_sig: created.signature,
      accept_sig: created.signature,
      onchain_pending: null,
      bet_pda: p.bet,
      vault: p.vault,
    });
    expect((await lockTxOf(db(), lockTxId)).stream_seen_at).not.toBeNull();
    expect(await auditOf(db(), f.bet_id, 'chain.mismatch')).toEqual([]);
  });
});
