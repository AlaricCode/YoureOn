// The health report's `stream` block and the stream_silent warning (chain/health.ts
// streamHealth): only Stream deliveries count (rpc_poll rows never make the Stream look alive),
// a Stream copy of a tx rpc_poll stored first counts (chain_txs.stream_seen_at), and the warning
// needs a Stream token AND server sends in the last 10 min (an idle server never warns). Pure
// cases need no DB; the Postgres suite (own database: the query aggregates over whole tables)
// skips without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { chainEvents, chainTxs, createDb, type DbHandle } from '@youre-on/db';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import type { AppDeps } from '../src/context';
import { createDeps } from '../src/server';
import { lifecycleOf } from '../src/lock/runtime';
import { chainHealth, HEALTH, streamHealth, type StreamCounts } from '../src/chain/health';
import { betFacts, randomPubkey, randomSig } from './chain-fixtures';
import { mkBetRow, mkServerTx, mkUser } from './chain-db';
import { DB_URL, describeDb, ownDatabase, testEnv } from './helpers';

const NOW = 1_795_284_425_000;
const ago = (ms: number) => new Date(NOW - ms);
const row = (o: Partial<StreamCounts> = {}): StreamCounts => ({
  stream_last: null,
  seen_last: null,
  stream_hour: 0,
  rpc_poll_hour: 0,
  sent_window: 0,
  ...o,
});
const on = { nowMs: NOW, streamExpected: true };

describe('streamHealth (no DB)', () => {
  it('no Stream row: last_delivery_at null, rpc_poll counted apart', () => {
    const r = streamHealth(row({ rpc_poll_hour: '7' }), { nowMs: NOW, streamExpected: false });
    expect(r.stream).toEqual({
      last_delivery_at: null,
      events_last_hour: 0,
      rpc_poll_last_hour: 7,
    });
    expect(r.warning).toBeNull();
  });

  it('last_delivery_at = the newer of a Stream row and a stream_seen_at stamp (Date or string)', () => {
    const a = streamHealth(
      row({ stream_last: ago(90_000), seen_last: ago(30_000).toISOString() }),
      on,
    );
    expect(a.stream.last_delivery_at).toBe(ago(30_000).toISOString());
    const b = streamHealth(
      row({ stream_last: ago(5_000).toISOString(), seen_last: ago(60_000) }),
      on,
    );
    expect(b.stream.last_delivery_at).toBe(ago(5_000).toISOString());
    // An rpc_poll-first tx the Stream delivered later: only the stamp says the Stream is alive.
    const c = streamHealth(row({ seen_last: ago(20_000), stream_hour: 0, rpc_poll_hour: 2 }), on);
    expect(c.stream.last_delivery_at).toBe(ago(20_000).toISOString());
  });

  it('stream_silent: token set, sends in the window, no delivery in 10 min (or ever)', () => {
    const never = streamHealth(row({ sent_window: 2 }), on);
    expect(never.warning).toMatchObject({ code: 'stream_silent', level: 'warn' });
    expect(never.warning!.message).toContain('ever');
    const stale = streamHealth(
      row({ sent_window: 1, stream_last: ago(HEALTH.streamSilentMs + 1_000) }),
      on,
    );
    expect(stale.warning?.code).toBe('stream_silent');
  });

  it('no stream_silent: no token, an idle server, or a recent delivery', () => {
    expect(
      streamHealth(row({ sent_window: 3 }), { ...on, streamExpected: false }).warning,
    ).toBeNull();
    expect(streamHealth(row({ sent_window: 0 }), on).warning).toBeNull();
    expect(streamHealth(row({ sent_window: 3, stream_last: ago(120_000) }), on).warning).toBeNull();
    expect(streamHealth(row({ sent_window: 3, seen_last: ago(120_000) }), on).warning).toBeNull();
  });

  it('a missing row is an empty one', () => {
    expect(streamHealth(undefined, on)).toEqual({
      stream: { last_delivery_at: null, events_last_hour: 0, rpc_poll_last_hour: 0 },
      warning: null,
    });
  });
});

describeDb('chainHealth stream block over Postgres', () => {
  let h: DbHandle;
  /** With and without QN_STREAM_SECURITY_TOKEN (a Stream expected or not). */
  let depsOn: AppDeps, depsOff: AppDeps;
  let partyA: string, partyB: string;

  const event = (signature: string, source: 'stream' | 'rpc_poll', receivedMsAgo: number) => ({
    signature,
    outer_ix: 0,
    inner_ix: 0,
    program_id: ESCROW_ID,
    event_name: 'BetCreated',
    bet_id: randomUUID(),
    payload: {},
    source,
    received_at: ago(receivedMsAgo),
  });

  /** A confirmed server tx sent `sentMsAgo` before NOW. */
  const sent = async (sentMsAgo: number, signature = randomSig()) => {
    const f = betFacts();
    await mkBetRow(h.db, f, { partyA, partyB, state: 'LOCKED' });
    const id = await mkServerTx(h.db, f.bet_id, 'finalize', signature);
    await h.db
      .update(chainTxs)
      .set({ sent_at: ago(sentMsAgo) })
      .where(eq(chainTxs.id, id));
    return signature;
  };

  const health = (token: boolean) => chainHealth(token ? depsOn : depsOff);

  beforeAll(async () => {
    const url = await ownDatabase(DB_URL!, 'health_stream');
    h = createDb({ url, max: 2 });
    const mk = (over: Record<string, string>) =>
      createDeps({
        env: testEnv({ DATABASE_URL: url, ...over }),
        dbHandle: h,
        rateLimit: false,
        now: () => NOW,
      }).deps;
    depsOn = mk({ QN_STREAM_SECURITY_TOKEN: 'qn-test-token' });
    depsOff = mk({});
    partyA = await mkUser(h.db);
    partyB = await mkUser(h.db);
  });
  beforeEach(async () => {
    await h.db.execute(sql`TRUNCATE ${chainEvents}, ${chainTxs} CASCADE`);
  });
  afterAll(async () => {
    for (const d of [depsOn, depsOff]) if (d) lifecycleOf(d).stop();
    await h?.close();
  });

  it('rpc_poll rows alone: last_delivery_at null; a sent tx and a token make stream_silent', async () => {
    const sig = await sent(3 * 60_000);
    await h.db.insert(chainEvents).values(event(sig, 'rpc_poll', 2 * 60_000));
    const r = await health(true);
    expect(r.stream).toEqual({
      last_delivery_at: null,
      events_last_hour: 0,
      rpc_poll_last_hour: 1,
    });
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: 'stream_silent' }));
    expect((await health(false)).warnings.map((w) => w.code)).not.toContain('stream_silent');
  });

  it('a Stream copy of an rpc_poll-first tx (stream_seen_at) counts as a delivery', async () => {
    const sig = await sent(3 * 60_000);
    await h.db.insert(chainEvents).values(event(sig, 'rpc_poll', 2 * 60_000));
    await h.db
      .update(chainTxs)
      .set({ stream_seen_at: ago(100_000) })
      .where(eq(chainTxs.signature, sig));
    const r = await health(true);
    expect(r.stream.last_delivery_at).toBe(ago(100_000).toISOString());
    expect(r.warnings.map((w) => w.code)).not.toContain('stream_silent');
  });

  it('Stream rows: last_delivery_at and the hour count; an idle server never warns', async () => {
    await h.db
      .insert(chainEvents)
      .values([
        event(randomSig(), 'stream', 2 * 3_600_000),
        event(randomSig(), 'stream', 15 * 60_000),
      ]);
    const idle = await health(true);
    expect(idle.stream).toEqual({
      last_delivery_at: ago(15 * 60_000).toISOString(),
      events_last_hour: 1,
      rpc_poll_last_hour: 0,
    });
    expect(idle.warnings.map((w) => w.code)).not.toContain('stream_silent');
    // A send inside the 60 s grace does not count yet; one older than it does.
    await sent(HEALTH.streamGraceMs / 2);
    expect((await health(true)).warnings.map((w) => w.code)).not.toContain('stream_silent');
    await sent(HEALTH.streamGraceMs * 2);
    expect((await health(true)).warnings.map((w) => w.code)).toContain('stream_silent');
  });

  it('a nonce_advance send (no escrow event, never in the Stream filter) does not count', async () => {
    const f = betFacts();
    await mkBetRow(h.db, f, { partyA, partyB, state: 'LOCKED' });
    // As lock/service.ts inserts it: fee payer, a nonce account, status 'sent'.
    const msg = randomBytes(80);
    await h.db.insert(chainTxs).values({
      bet_id: f.bet_id,
      kind: 'nonce_advance',
      signer_role: 'fee_payer',
      message_b64: msg.toString('base64'),
      message_sha256: createHash('sha256').update(msg).digest('hex'),
      nonce_account: randomPubkey(),
      signature: randomSig(),
      expected_status: 'none',
      status: 'sent',
      sent_at: ago(2 * 60_000),
    });
    const r = await health(true);
    expect(r.stream.last_delivery_at).toBeNull();
    expect(r.warnings.map((w) => w.code)).not.toContain('stream_silent');
  });
});
