// The Stream-gap reconciler over Postgres with a fake chain client (skips without DATABASE_URL):
// which server txs it polls (any sent status, oldest first, never starved by backed-off rows),
// that rpc_poll rows carry the block height the client found, and the retry pass that completes a
// parked (rejected) projection once the row is fixed. The LiteSVM end-to-end runs are in
// chain-projector-litesvm.test.ts. Runs in its own database (<DATABASE_URL db>_recon).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getBase58Decoder } from '@solana/kit';
import { bets, chainEvents, chainTxs, createDb, type DbHandle } from '@youre-on/db';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import type { AppDeps } from '../src/context';
import { createDeps } from '../src/server';
import { eventAuthorityAddress } from '../src/chain/filter-config';
import { createChainProjector } from '../src/chain/projector';
import { ingestChainEvents } from '../src/chain/ingest';
import { StreamGapReconciler } from '../src/chain/reconciler';
import { parseStreamDelivery, type RpcTransaction } from '../src/chain/streams';
import type { ChainRuntime } from '../src/chain/tx';
import { betFacts, delivery, encodeEvent, lifecycle, randomSig, TAG } from './chain-fixtures';
import {
  betRow,
  eventsOfBet,
  logOf,
  mkBetRow,
  mkLockTx,
  mkServerTx,
  mkUser,
  ownDatabase,
} from './chain-db';
import { DB_URL, describeDb, testEnv } from './helpers';

describeDb('StreamGapReconciler over Postgres', () => {
  let h: DbHandle;
  let deps: AppDeps;
  let A: string, B: string;
  let ea: string;
  /** What the fake chain returns for getTransaction, by signature. */
  const chain = new Map<string, RpcTransaction>();
  const asked: string[] = [];
  const rt = {
    client: {
      transaction: async (sig: string) => {
        asked.push(sig);
        return chain.get(sig) ?? null;
      },
    },
  } as unknown as ChainRuntime;

  /** A landed tx carrying `events` as emit_cpi! inner instructions of ESCROW_ID. */
  function landed(
    signature: string,
    events: { outer: number; name: string; payload: Record<string, unknown> }[],
    blockHeight: number | null = 777_000,
  ): RpcTransaction {
    // the Anchor event tag ‖ the event bytes, base58 as getTransaction (json) returns it
    const data = (bytes: Uint8Array) =>
      getBase58Decoder().decode(Uint8Array.from([...TAG, ...bytes]));
    return {
      signature,
      slot: 9_000_000,
      blockHeight,
      blockTime: 1_795_284_425,
      err: null,
      accountKeys: ['11111111111111111111111111111111', ESCROW_ID, ea],
      innerInstructions: events.map((e) => ({
        index: e.outer,
        instructions: [
          {
            programIdIndex: 1,
            accounts: [2],
            data: data(encodeEvent(e.name, e.payload)),
          },
        ],
      })),
    };
  }

  beforeAll(async () => {
    // its own database (<db>_recon): the reconciler's candidate query is global, and other
    // suites running in parallel leave unseen server txs in the shared one
    const env = testEnv({ DATABASE_URL: await ownDatabase(DB_URL!, 'recon') });
    h = createDb({ url: env.DATABASE_URL, max: 4 });
    deps = createDeps({ env, dbHandle: h, rateLimit: false }).deps;
    // this database is the suite's own: start from no bets / txs / events (earlier runs)
    await h.db.delete(bets); // cascades chain_txs, bet_events, outbox
    await h.db.delete(chainEvents);
    A = await mkUser(h.db, 'Logan');
    B = await mkUser(h.db, 'Jake');
    ea = await eventAuthorityAddress();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('polls any sent status (an "expired" lock that landed is still ours) and stores the block height', async () => {
    const f = betFacts();
    const L = lifecycle(f);
    await mkBetRow(h.db, f, {
      partyA: A,
      partyB: B,
      state: 'EXPIRED',
      end_reason: 'accept_timeout',
    });
    const lockSig = randomSig();
    await mkLockTx(h.db, f.bet_id, lockSig, 'expired');
    chain.set(
      lockSig,
      landed(lockSig, [
        { outer: 3, name: 'BetCreated', payload: L.created() },
        { outer: 4, name: 'BetAccepted', payload: L.accepted() },
      ]),
    );
    const r = await new StreamGapReconciler().run(deps, rt, Date.now() + 6_000);
    expect(r.ingested).toBeGreaterThanOrEqual(2);
    expect(await betRow(h.db, f.bet_id)).toMatchObject({
      state: 'LOCKED', // the chain wins: the lock landed after the bet expired
      end_reason: null,
      onchain_status: 'locked',
    });
    expect((await eventsOfBet(h.db, f.bet_id)).map((e) => [e.source, e.block_height])).toEqual([
      ['rpc_poll', 777_000],
      ['rpc_poll', 777_000],
    ]);
  });

  it('backed-off signatures never starve newer ones; the oldest unseen tx goes first', async () => {
    const f = betFacts();
    await mkBetRow(h.db, f, { partyA: A, partyB: B, state: 'RULED' });
    // three resolve-like txs the chain never shows (dropped), sent long ago
    const old = [randomSig(), randomSig(), randomSig()];
    for (const sig of old) {
      const id = await mkServerTx(h.db, f.bet_id, 'resolve', sig, 'sent');
      await h.db
        .update(chainTxs)
        .set({ sent_at: new Date(Date.now() - 20 * 60_000), status: 'expired' })
        .where(eq(chainTxs.id, id));
    }
    const fresh = randomSig();
    await mkServerTx(h.db, f.bet_id, 'concede', fresh, 'sent');
    const gaps = new StreamGapReconciler({ batch: 2 });
    const now = Date.now() + 6_000;
    asked.length = 0;
    await gaps.run(deps, rt, now);
    const first = [...asked].filter((s) => old.includes(s) || s === fresh);
    expect(first.every((s) => old.includes(s))).toBe(true); // oldest first
    await gaps.run(deps, rt, now); // same instant: the two backed-off ones are skipped in SQL
    await gaps.run(deps, rt, now);
    expect(asked).toContain(fresh);
  });

  it('retries a parked (rejected) projection once the row is fixed: no later event needed', async () => {
    const f = betFacts();
    const L = lifecycle(f);
    await mkBetRow(h.db, f, { partyA: A, partyB: B, state: 'AWAITING_LOCK', authorized: false });
    const lockSig = randomSig();
    await mkLockTx(h.db, f.bet_id, lockSig, 'sent');
    const events = parseStreamDelivery(
      delivery([
        {
          signature: lockSig,
          events: [
            { outerIx: 3, name: 'BetCreated', payload: L.created() },
            { outerIx: 4, name: 'BetAccepted', payload: L.accepted() },
          ],
        },
      ]),
    ).events;
    await ingestChainEvents(deps, createChainProjector(), events, { deliveryId: null });
    expect((await eventsOfBet(h.db, f.bet_id)).map((e) => e.apply_error)).toEqual([
      'projection_rejected',
      'projection_rejected',
    ]);
    const gaps = new StreamGapReconciler({ refoldRetryMs: 60_000 });
    // still broken: retried, still parked, nothing re-pushed
    expect(await gaps.retryRejected(deps, Date.now())).toBeGreaterThanOrEqual(1);
    expect((await betRow(h.db, f.bet_id)).state).toBe('AWAITING_LOCK');
    // fixed by hand; the next retry is due a minute later
    const at = new Date();
    await h.db
      .update(bets)
      .set({
        a_authorized_at: at,
        a_authorization_method: 'faceid_hold',
        b_authorized_at: at,
        b_authorization_method: 'faceid_hold',
      })
      .where(eq(bets.id, f.bet_id));
    await gaps.retryRejected(deps, Date.now()); // backed off: not yet
    expect((await betRow(h.db, f.bet_id)).state).toBe('AWAITING_LOCK');
    await gaps.retryRejected(deps, Date.now() + 61_000);
    expect(await betRow(h.db, f.bet_id)).toMatchObject({
      state: 'LOCKED',
      onchain_status: 'locked',
    });
    expect((await logOf(h.db, f.bet_id)).map((e) => e.type)).toEqual([
      'chain.BetCreated',
      'chain.BetAccepted',
      'bet.state',
      'judge.cue',
    ]);
    expect((await eventsOfBet(h.db, f.bet_id)).every((e) => e.apply_error === null)).toBe(true);
  });

  it('a projector bug on the rpc_poll path keeps the rows (projector_failed); the retry finishes them', async () => {
    const f = betFacts();
    const L = lifecycle(f);
    await mkBetRow(h.db, f, { partyA: A, partyB: B, state: 'AWAITING_LOCK' });
    const lockSig = randomSig();
    await mkLockTx(h.db, f.bet_id, lockSig, 'sent');
    chain.set(
      lockSig,
      landed(lockSig, [
        { outer: 3, name: 'BetCreated', payload: L.created() },
        { outer: 4, name: 'BetAccepted', payload: L.accepted() },
      ]),
    );
    const buggy = new StreamGapReconciler({
      projector: {
        apply: async () => {
          throw new TypeError('bug in this build');
        },
      },
    });
    await buggy.run(deps, rt, Date.now() + 6_000);
    expect((await eventsOfBet(h.db, f.bet_id)).map((e) => [e.source, e.apply_error])).toEqual([
      ['rpc_poll', 'projector_failed'],
      ['rpc_poll', 'projector_failed'],
    ]);
    // the fixed build's keeper: nothing to poll any more (the rows exist), the retry pass applies
    const fixed = new StreamGapReconciler();
    const r = await fixed.run(deps, rt, Date.now() + 7_000);
    expect(r.refolded).toBeGreaterThanOrEqual(1);
    expect(await betRow(h.db, f.bet_id)).toMatchObject({
      state: 'LOCKED',
      onchain_status: 'locked',
    });
    expect((await logOf(h.db, f.bet_id)).map((e) => e.type)).toEqual([
      'chain.BetCreated',
      'chain.BetAccepted',
      'bet.state',
      'judge.cue',
    ]);
  });

  it('fallbackMs: with a Stream configured (30 s) rpc_poll leaves the Stream its lag', async () => {
    const f = betFacts();
    const L = lifecycle(f);
    await mkBetRow(h.db, f, { partyA: A, partyB: B, state: 'LOCKED' });
    const lockSig = randomSig();
    await mkLockTx(h.db, f.bet_id, lockSig, 'confirmed');
    chain.set(
      lockSig,
      landed(lockSig, [
        { outer: 3, name: 'BetCreated', payload: L.created() },
        { outer: 4, name: 'BetAccepted', payload: L.accepted() },
      ]),
    );
    const sentAt = (
      await h.db.select().from(chainTxs).where(eq(chainTxs.signature, lockSig))
    )[0]!.sent_at!.getTime();
    const gaps = new StreamGapReconciler({ fallbackMs: 30_000 });
    asked.length = 0;
    await gaps.run(deps, rt, sentAt + 6_000); // the 5 s default would poll here
    expect(asked).not.toContain(lockSig);
    expect(await eventsOfBet(h.db, f.bet_id)).toEqual([]);
    await gaps.run(deps, rt, sentAt + 31_000);
    expect(asked).toContain(lockSig);
    expect((await eventsOfBet(h.db, f.bet_id)).map((e) => e.source)).toEqual([
      'rpc_poll',
      'rpc_poll',
    ]);
  });

  it('without a chain runtime the gap-fill pass is skipped (the retry pass still runs)', async () => {
    const r = await new StreamGapReconciler().run(deps, null, Date.now() + 6_000);
    expect(r).toMatchObject({ polled: 0, ingested: 0, missing: 0 });
  });
});
