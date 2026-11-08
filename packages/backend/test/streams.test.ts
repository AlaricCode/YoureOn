import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_DISCRIMINATORS, EVENT_NAMES, decodeEvent, encodeEvent, eventLogLine, type VerdictEvent, type VerdictEventName } from '@verdict/engine';
import { buildApp } from '../src/app.js';
import { defaultProgramId, requireIdl } from '../src/chain/idl.js';
import { MockChain } from '../src/chain/mock/index.js';
import { quickNodeSignature } from '../src/chain/quicknode.js';
import { startRpcWsSource, envelopesFromLogs, type LogsConnection } from '../src/chain/rpcWs.js';
import { parseProgramLogs } from '../src/chain/devnet.js';
import { ChainEventHandler, type ProcessedEventRecord } from '../src/chain/events.js';
import { JsonStore } from '../src/persistence/store.js';
import { DECODED_EVENT_FIELDS, eventSchemaError, streamEvents, unwrapStreamBody } from '../src/chain/streams.js';
import { loadConfig } from '../src/config/load.js';
import { createContext } from '../src/context.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { COLLECTIONS } from '../src/persistence/records.js';
import { eventLog } from '../src/routes/receipt.js';
import { ManualClock } from '../src/util/clock.js';
import { login } from './appHelpers.js';
import { testEnv } from './helpers.js';

const FILTER_PATH = fileURLToPath(new URL('../../../infra/quicknode/filter.js', import.meta.url));
const STREAM_PATH = fileURLToPath(new URL('../../../infra/quicknode/stream.json', import.meta.url));

interface Filter {
  main(stream: unknown): { stream: string; events: { signature: string; slot: number; block_time: number | null; index: number; name: string; data: Record<string, unknown> }[] } | null;
  decodeEventBase64(b64: string): { name: string; data: Record<string, unknown> } | null;
  VERDICT_PROGRAM_ID: string;
  EVENT_DISCRIMINATORS: Record<string, string>;
}

function loadFilter(): Filter {
  const module = { exports: {} as Filter };
  runInNewContext(readFileSync(FILTER_PATH, 'utf8'), { module, BigInt });
  return module.exports;
}

const key = () => generateKeypair().publicKey;
const hex = (b: number) => b.toString(16).padStart(2, '0').repeat(32);

/** A typed sample of every §9.5 event (bigints for u64/i64). */
function sample(name: VerdictEventName, seed = 1): VerdictEvent {
  const data: Record<string, unknown> = {};
  for (const [f, t] of DECODED_EVENT_FIELDS[name]) {
    switch (t) {
      case 'pubkey':
        data[f] = key();
        break;
      case 'hash':
        data[f] = hex(seed + f.length);
        break;
      case 'u8':
        data[f] = (seed * 7 + f.length) & 0xff;
        break;
      case 'u32':
        data[f] = 4_000_000_000 + seed;
        break;
      case 'dec':
        data[f] = f.endsWith('_at') || f.includes('deadline') ? -(2n ** 40n) - BigInt(seed) : 2n ** 63n + BigInt(seed);
        break;
      case 'bool':
        data[f] = seed % 2 === 1;
        break;
      case 'vec_pubkey':
        data[f] = [key(), key(), key()];
        break;
      case 'vec_dec':
        data[f] = [1n, 2n ** 64n - 1n, 10_000n];
        break;
      case 'u8x8':
        data[f] = [1, 255, 255, 0, 2, 255, 255, 255];
        break;
      case 'decx8':
        data[f] = [0n, 1n, 2n ** 64n - 1n, 4n, 5n, 6n, 7n, 8n];
        break;
    }
  }
  return { name, data } as unknown as VerdictEvent;
}

describe('infra/quicknode/filter.js', () => {
  const filter = loadFilter();

  it('uses the program id and discriminators of the engine/IDL', () => {
    expect(filter.VERDICT_PROGRAM_ID).toBe(defaultProgramId());
    for (const n of EVENT_NAMES) expect(filter.EVENT_DISCRIMINATORS[n]).toBe(Buffer.from(EVENT_DISCRIMINATORS[n]).toString('hex'));
    const stream = JSON.parse(readFileSync(STREAM_PATH, 'utf8'));
    expect(stream).toMatchObject({ dataset: 'block', network: 'solana-devnet', destination: 'webhook' });
    expect(stream.destination_attributes.url).toMatch(/\/v1\/webhooks\/quicknode$/);
  });

  it.each(EVENT_NAMES.map((n) => [n]))('decodes %s exactly like engine.decodeEvent', (name) => {
    const ev = sample(name as VerdictEventName, 3);
    const bytes = encodeEvent(ev.name, ev.data as never);
    const b64 = Buffer.from(bytes).toString('base64');
    const mine = filter.decodeEventBase64(b64);
    expect(mine).toEqual(JSON.parse(JSON.stringify(decodeEvent(bytes))));
    expect(eventSchemaError(name, mine!.data)).toBeNull();
    // trailing bytes / truncation / unknown discriminator ⇒ null
    expect(filter.decodeEventBase64(Buffer.from([...bytes, 0]).toString('base64'))).toBeNull();
    expect(filter.decodeEventBase64(Buffer.from(bytes.subarray(0, bytes.length - 1)).toString('base64'))).toBeNull();
    expect(filter.decodeEventBase64(Buffer.from(new Uint8Array(16)).toString('base64'))).toBeNull();
  });

  it('main(): keeps successful txs mentioning the program; innermost-program rule; per-tx index', () => {
    const pid = filter.VERDICT_PROGRAM_ID;
    const other = key();
    const e1 = sample('Funded', 1);
    const e2 = sample('Funded', 2);
    const e3 = sample('PreRuled', 1);
    const block = {
      slot: 500,
      blockTime: 1_700_000_000,
      transactions: [
        {
          transaction: { signatures: ['SIG_A'], message: { accountKeys: [key(), pid] } },
          meta: {
            err: null,
            logMessages: [
              `Program ${pid} invoke [1]`,
              `Program ${other} invoke [2]`,
              eventLogLine(sample('Settled')), // emitted by the inner (non-Verdict) program: ignored
              `Program ${other} success`,
              eventLogLine(e1),
              eventLogLine(e2),
              `Program ${pid} success`,
            ],
          },
        },
        {
          transaction: { signatures: ['SIG_FAILED'], message: { accountKeys: [pid] } },
          meta: { err: { InstructionError: [0, 'Custom'] }, logMessages: [`Program ${pid} invoke [1]`, eventLogLine(e3), `Program ${pid} failed`] },
        },
        {
          transaction: { signatures: ['SIG_OTHER'], message: { accountKeys: [other] } },
          meta: { err: null, logMessages: [`Program ${other} invoke [1]`, eventLogLine(e3), `Program ${other} success`] },
        },
        {
          transaction: { signatures: ['SIG_B'], message: { accountKeys: [{ pubkey: pid }] } },
          meta: { err: null, logMessages: [`Program ${pid} invoke [1]`, 'Program log: hi', eventLogLine(e3), `Program ${pid} success`] },
        },
      ],
    };
    const out = filter.main({ data: [block], metadata: {} })!;
    expect(out.stream).toBe('verdict-devnet');
    expect(out.events.map((e) => [e.signature, e.index, e.name, e.slot, e.block_time])).toEqual([
      ['SIG_A', 0, 'Funded', 500, 1_700_000_000],
      ['SIG_A', 1, 'Funded', 500, 1_700_000_000],
      ['SIG_B', 0, 'PreRuled', 500, 1_700_000_000],
    ]);
    expect(out.events[0]!.data['amount']).toBe((e1.data as { amount: bigint }).amount.toString());
    expect(filter.main({ data: [{ ...block, transactions: [block.transactions[2]] }] })).toBeNull();
    // slot fallback from batch metadata when the block omits it
    const { slot: _s, ...noSlot } = block;
    expect(filter.main({ data: [noSlot], metadata: { batch_start_range: 900 } })!.events[0]!.slot).toBe(900);
  });
});

describe('stream intake (chain/streams.ts)', () => {
  const ev = (signature: string, slot: number, index: number, name: string, data: Record<string, unknown>) => ({ signature, slot, block_time: null, index, name, data });
  const funded = () => JSON.parse(JSON.stringify(decodeEvent(encodeEvent('Funded', sample('Funded').data as never)).data));

  it('unwraps destination envelopes, validates schemas, dedups and orders by slot', () => {
    expect(unwrapStreamBody({ data: [{ stream: 's', events: [] }] })).toHaveLength(1);
    expect(unwrapStreamBody([{ events: [] }, { events: [] }])).toHaveLength(2);
    expect(() => unwrapStreamBody({ foo: 1 })).toThrow();
    const d = funded();
    const batch = streamEvents({
      stream: 'verdict-devnet',
      events: [
        ev('S2', 20, 1, 'Funded', d),
        ev('S2', 20, 0, 'Funded', d),
        ev('S1', 10, 0, 'Funded', d),
        ev('S1', 10, 0, 'Funded', d), // duplicate
        ev('S3', 30, 0, 'Funded', { ...d, amount: 5 }), // u64 must be a decimal string
        ev('S4', 30, 0, 'Mystery', {}),
      ],
    });
    expect(batch.events.map((e) => `${e.signature}:${e.index}`)).toEqual(['S1:0', 'S2:0', 'S2:1']);
    expect(batch.rejected).toEqual([
      { key: 'S3:0', reason: 'Funded.amount' },
      { key: 'S4:0', reason: 'unknown event Mystery' },
    ]);
    expect(() => streamEvents({ events: [{ signature: '', slot: 1, index: 0, name: 'Funded', data: {} }] })).toThrow();
  });
});

describe('POST /webhooks/quicknode (§12.5)', () => {
  const SECRET = 'qn-test-secret';
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function quicknodeApp() {
    const clock = new ManualClock(1_760_000_000_000);
    const config = loadConfig(testEnv({ SOLANA_MODE: 'devnet', CHAIN_EVENTS_SOURCE: 'quicknode', QUICKNODE_SECRET: SECRET, PROVER: 'snarkjs' }));
    const idl = requireIdl();
    const chain = new MockChain({
      idl,
      programId: config.programId,
      clock,
      feePayer: config.keys.feePayer,
      oracle: config.keys.oracle,
      extraSigners: config.keys.judges,
      persistPath: null,
    });
    const ctx = createContext(config, { clock, inMemory: true, chain });
    const app = await buildApp(ctx, { startKeeper: false });
    await app.ready();
    close = () => app.close();
    return { app, ctx, clock };
  }

  function signed(body: string, nowMs: number, secret = SECRET) {
    const nonce = 'n-' + Math.random().toString(36).slice(2);
    const ts = String(Math.floor(nowMs / 1000));
    return {
      'content-type': 'application/json',
      'x-qn-nonce': nonce,
      'x-qn-timestamp': ts,
      'x-qn-signature': quickNodeSignature(secret, nonce, ts, Buffer.from(body)),
    };
  }

  it('verifies the HMAC, applies events in order once, and feeds triggers + notifications', async () => {
    const { app, ctx, clock } = await quicknodeApp();
    const alice = await login(app, 'alex@example.com');
    const bob = await login(app, 'maya@example.com');
    const bet = key();
    const created = sample('BetCreated');
    Object.assign(created.data, { bet, creator: alice.wallet.publicKey, participants: [alice.wallet.publicKey, bob.wallet.publicKey] });
    const disputed = sample('Disputed');
    Object.assign(disputed.data, { bet });
    const j = (e: VerdictEvent) => JSON.parse(JSON.stringify(decodeEvent(encodeEvent(e.name, e.data as never)).data));
    const seen: string[] = [];
    ctx.events.on('*', (e) => {
      seen.push(e.name);
    });
    const notes: string[] = [];
    const orig = ctx.hub.notify.bind(ctx.hub);
    ctx.hub.notify = (u, title, id) => {
      notes.push(`${u === bob.user.id ? 'bob' : 'alice'}:${title}:${id === bet}`);
      return orig(u, title, id);
    };
    const body = JSON.stringify({
      stream: 'verdict-devnet',
      events: [
        { signature: 'SIG2', slot: 11, block_time: null, index: 0, name: 'Disputed', data: j(disputed) },
        { signature: 'SIG1', slot: 10, block_time: 1_700_000_000, index: 0, name: 'BetCreated', data: j(created) },
      ],
    });
    const url = '/v1/webhooks/quicknode';
    const res = await app.inject({ method: 'POST', url, payload: body, headers: signed(body, clock.nowMs()) });
    expect(res.statusCode).toBe(204);
    await ctx.events.idle();
    expect(seen).toEqual(['BetCreated', 'Disputed']);
    expect(notes).toEqual(['bob:Bet offered:true']); // Disputed: bet not on chain ⇒ no participants
    expect(eventLog(ctx).of(bet).map((e) => e.name)).toEqual(['BetCreated', 'Disputed']);
    expect(ctx.store.collection(COLLECTIONS.chainEvents).size).toBe(2);

    // replay: idempotent on (signature, index)
    const again = await app.inject({ method: 'POST', url, payload: body, headers: signed(body, clock.nowMs()) });
    expect(again.statusCode).toBe(204);
    await ctx.events.idle();
    expect(seen).toHaveLength(2);

    // bad signature / stale timestamp / wrong secret / missing headers
    const h = signed(body, clock.nowMs());
    expect((await app.inject({ method: 'POST', url, payload: body + ' ', headers: h })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload: body, headers: signed(body, clock.nowMs() - 301_000) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload: body, headers: signed(body, clock.nowMs(), 'other') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    // malformed envelope (valid HMAC) ⇒ 400
    const bad = JSON.stringify({ nope: true });
    expect((await app.inject({ method: 'POST', url, payload: bad, headers: signed(bad, clock.nowMs()) })).statusCode).toBe(400);
  });

  it('the filter output posted verbatim is accepted end to end', async () => {
    const { app, ctx, clock } = await quicknodeApp();
    const filter = loadFilter();
    const pid = ctx.config.programId;
    expect(pid).toBe(filter.VERDICT_PROGRAM_ID);
    const ev = sample('BetEnded');
    const out = filter.main({
      data: [{ slot: 77, blockTime: 1_700_000_100, transactions: [{ transaction: { signatures: ['SIGX'], message: { accountKeys: [pid] } }, meta: { err: null, logMessages: [`Program ${pid} invoke [1]`, eventLogLine(ev), `Program ${pid} success`] } }] }],
    })!;
    const body = JSON.stringify(out);
    const names: string[] = [];
    ctx.events.on('BetEnded', (e) => {
      names.push(`${e.name}:${e.slot}:${e.data['bet']}`);
    });
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/quicknode', payload: body, headers: signed(body, clock.nowMs()) })).statusCode).toBe(204);
    await ctx.events.idle();
    expect(names).toEqual([`BetEnded:77:${(ev.data as { bet: string }).bet}`]);
  });
});

describe('rpc_ws source (logsSubscribe)', () => {
  it('feeds successful program logs to the handler and unsubscribes on stop', async () => {
    const pid = defaultProgramId();
    let cb: ((logs: { signature: string; err: unknown; logs: string[] }, ctx: { slot: number }) => void) | null = null;
    const removed: number[] = [];
    const conn: LogsConnection = {
      onLogs: (filter, callback) => {
        expect(filter.toBase58()).toBe(pid);
        cb = callback as never;
        return 42;
      },
      removeOnLogsListener: async (id) => {
        removed.push(id);
      },
    };
    const handled: string[] = [];
    const src = startRpcWsSource({
      connection: conn,
      programId: pid,
      handler: {
        handleEnvelopes: async (envs) => {
          for (const e of envs) handled.push(`${e.signature}:${e.index}:${e.event.name}:${e.slot}`);
          return envs.length;
        },
      },
    });
    expect(src.subscriptionId).toBe(42);
    const lines = (evs: VerdictEvent[]) => [`Program ${pid} invoke [1]`, ...evs.map(eventLogLine), `Program ${pid} success`];
    cb!({ signature: 'A', err: null, logs: lines([sample('Funded'), sample('Funded', 2)]) }, { slot: 5 });
    cb!({ signature: 'B', err: { x: 1 }, logs: lines([sample('Settled')]) }, { slot: 6 });
    cb!({ signature: 'C', err: null, logs: ['Program log: nothing'] }, { slot: 7 });
    cb!({ signature: 'D', err: null, logs: lines([sample('Refunded')]) }, { slot: 8 });
    await src.idle();
    expect(handled).toEqual(['A:0:Funded:5', 'A:1:Funded:5', 'D:0:Refunded:8']);
    expect(envelopesFromLogs({ signature: 'E', err: null, logs: lines([sample('BetCancelled')]) }, 9, pid)[0]!.block_time).toBeNull();
    await src.stop();
    expect(removed).toEqual([42]);
  });

  it('handles a backend-submitted tx once when both DevnetChain.submit and logsSubscribe deliver it', async () => {
    // DevnetChain.submit feeds its fetched events (fetchEvents → parseProgramLogs) to the onEvents
    // listeners, and with CHAIN_EVENTS_SOURCE=rpc_ws the same tx also arrives via logsSubscribe.
    // ChainEventHandler dedups on eventKey(signature, index), so the overlap is harmless.
    const pid = defaultProgramId();
    const logs = [`Program ${pid} invoke [1]`, eventLogLine(sample('Funded')), eventLogLine(sample('PreRuled', 2)), `Program ${pid} success`];
    const fromSubmit = parseProgramLogs(logs, pid).map((event, index) => ({ signature: 'SIG', slot: 11, block_time: 1_700_000_000, index, event }));
    const fromLogs = envelopesFromLogs({ signature: 'SIG', err: null, logs }, 11, pid);
    expect(fromLogs.map((e) => `${e.signature}:${e.index}:${e.event.name}`)).toEqual(fromSubmit.map((e) => `${e.signature}:${e.index}:${e.event.name}`));
    const store = new JsonStore({ dataDir: null });
    const handler = new ChainEventHandler({ processed: store.collection<ProcessedEventRecord>(COLLECTIONS.chainEvents), hub: null, nowMs: () => 0 });
    const fired: string[] = [];
    handler.on('*', (e) => {
      fired.push(`${e.signature}:${e.index}:${e.name}`);
    });
    expect(await handler.handleEnvelopes(fromSubmit)).toBe(2);
    expect(await handler.handleEnvelopes(fromLogs)).toBe(0);
    expect(fired).toEqual(['SIG:0:Funded', 'SIG:1:PreRuled']);
  });
});
