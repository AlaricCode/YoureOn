// QuickNode Streams receiver, no DB: HMAC verification (valid / invalid / stale / ms timestamps /
// gzip), the IDL decoder, the delivery parser (dedupe, ordering, rejections), and
// infra/quicknode/filter.js run in a sandbox on getBlock fixtures (emit_cpi! decode + the
// ESCROW §7.1 attribution rules).
//
// Ported from Verdict packages/backend/test/streams.test.ts (filter-in-a-vm, decode parity,
// HMAC cases), re-targeted at OUR contract (API-CONTRACT §5).
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import {
  decodeEventBytes,
  DecodeError,
  decodeIdlDefined,
  EVENT_IX_TAG_LE,
  IDL_EVENT_NAMES,
} from '../src/chain/decoder';
import {
  buildFilterConfig,
  eventAuthorityAddress,
  type FilterConfig,
} from '../src/chain/filter-config';
import {
  decompressBody,
  parseQnTimestampMs,
  QN_MAX_DECOMPRESSED_BYTES,
  quickNodeSignature,
  verifyQuickNodeSignature,
} from '../src/chain/quicknode';
import { parseStreamDelivery, StreamPayloadError } from '../src/chain/streams';
import { attributeEvents, chainOrder, type AttributionRow } from '../src/chain/projector';
import { isTransientDbError } from '../src/chain/routes';
import {
  ALL_EVENT_NAMES,
  block,
  encodeEvent,
  jsonTx,
  randomPubkey,
  randomSig,
  samplePayload,
  toJsonParsed,
} from './chain-fixtures';

const INFRA = (p: string) =>
  fileURLToPath(new URL(`../../../infra/quicknode/${p}`, import.meta.url));

interface FilterOutput {
  v: number;
  programId: string;
  network: string | null;
  dataset: string | null;
  batchStart: number | null;
  batchEnd: number | null;
  txs: {
    signature: string;
    blockHeight: number | null;
    parentSlot: number | null;
    blockTime: number | null;
    txIndex: number;
    events: { outerIx: number; innerIx: number; name: string | null; eventBase64: string }[];
  }[];
}
interface Filter {
  main(stream: unknown): FilterOutput | null;
  CONFIG: FilterConfig;
}

/** Loads filter.js with the host APIs the contract forbids shadowed to undefined. */
function loadFilter(): Filter {
  const module = { exports: {} as Filter };
  runInNewContext(readFileSync(INFRA('filter.js'), 'utf8'), {
    module,
    BigInt: undefined,
    atob: undefined,
    btoa: undefined,
    Buffer: undefined,
    TextDecoder: undefined,
    TextEncoder: undefined,
    require: undefined,
  });
  return module.exports;
}

const SECRET = 'qn-test-security-token';
const NOW = 1_795_284_425_000;
const enc = (s: string) => new TextEncoder().encode(s);

describe('QuickNode signature (API-CONTRACT §5.3)', () => {
  const body = enc(JSON.stringify({ v: 1, txs: [] }));
  const sign = (ts: string, b: Uint8Array = body, secret = SECRET, nonce = 'n-1') => ({
    secret: SECRET,
    nonce,
    timestamp: ts,
    signature: quickNodeSignature(secret, nonce, ts, b),
    rawBody: b,
    nowMs: NOW,
  });
  const ts = String(NOW / 1000);

  it('accepts a valid HMAC over nonce + timestamp + body and returns the signed bytes', async () => {
    const r = await verifyQuickNodeSignature(sign(ts));
    expect(r.ok).toBe(true);
    expect(r.ok && Buffer.from(r.body).equals(Buffer.from(body))).toBe(true);
    // uppercase hex is the same signature
    const s = sign(ts);
    expect(
      (await verifyQuickNodeSignature({ ...s, signature: s.signature.toUpperCase() })).ok,
    ).toBe(true);
    // the known-answer value: hex HMAC-SHA256(token, nonce ‖ ts ‖ body)
    expect(quickNodeSignature('k', 'n', '1', enc('{}'))).toBe(
      createHmac('sha256', 'k').update('n1{}').digest('hex'),
    );
  });

  it('rejects a tampered body, a wrong secret, a wrong nonce and a malformed signature', async () => {
    const s = sign(ts);
    expect(await verifyQuickNodeSignature({ ...s, rawBody: enc('{"v":1,"txs":[1]}') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await verifyQuickNodeSignature(sign(ts, body, 'other'))).toMatchObject({ ok: false });
    expect(await verifyQuickNodeSignature({ ...s, nonce: 'n-2' })).toMatchObject({ ok: false });
    expect(await verifyQuickNodeSignature({ ...s, signature: 'zz' })).toMatchObject({
      reason: 'bad_signature',
    });
    expect(await verifyQuickNodeSignature({ ...s, signature: s.signature.slice(2) })).toMatchObject(
      {
        reason: 'bad_signature',
      },
    );
  });

  it('rejects missing headers and an unset secret', async () => {
    const s = sign(ts);
    expect(await verifyQuickNodeSignature({ ...s, nonce: undefined })).toMatchObject({
      reason: 'missing',
    });
    expect(await verifyQuickNodeSignature({ ...s, timestamp: '' })).toMatchObject({
      reason: 'missing',
    });
    expect(await verifyQuickNodeSignature({ ...s, signature: null })).toMatchObject({
      reason: 'missing',
    });
    expect(await verifyQuickNodeSignature({ ...s, secret: '' })).toMatchObject({
      reason: 'missing',
    });
  });

  it('enforces the 300 s skew window both ways (seconds, and ms when > 11 digits)', async () => {
    expect((await verifyQuickNodeSignature(sign(String(NOW / 1000 - 300)))).ok).toBe(true);
    expect(await verifyQuickNodeSignature(sign(String(NOW / 1000 - 301)))).toMatchObject({
      reason: 'stale',
    });
    expect(await verifyQuickNodeSignature(sign(String(NOW / 1000 + 301)))).toMatchObject({
      reason: 'stale',
    });
    expect((await verifyQuickNodeSignature(sign(String(NOW - 299_000)))).ok).toBe(true); // ms
    expect(await verifyQuickNodeSignature(sign(String(NOW - 301_000)))).toMatchObject({
      reason: 'stale',
    });
    expect(await verifyQuickNodeSignature(sign('17952844x5'))).toMatchObject({ reason: 'stale' });
    expect(parseQnTimestampMs('1795284425')).toBe(NOW);
    expect(parseQnTimestampMs('1795284425000')).toBe(NOW);
    expect(parseQnTimestampMs('-1')).toBeNull();
  });

  it('HMACs the decompressed body; gunzips only on the 1f 8b magic', async () => {
    const gz = new Uint8Array(gzipSync(body));
    const nonce = 'n-gz';
    // signed over the decompressed bytes, posted gzipped
    const r = await verifyQuickNodeSignature({
      secret: SECRET,
      nonce,
      timestamp: ts,
      signature: quickNodeSignature(SECRET, nonce, ts, body),
      rawBody: gz,
      nowMs: NOW,
    });
    expect(r.ok && Buffer.from(r.body).toString()).toBe(Buffer.from(body).toString());
    // signed over the gzip bytes: wrong per contract
    expect(
      (
        await verifyQuickNodeSignature({
          secret: SECRET,
          nonce,
          timestamp: ts,
          signature: quickNodeSignature(SECRET, nonce, ts, gz),
          rawBody: gz,
          nowMs: NOW,
        })
      ).ok,
    ).toBe(false);
    expect(await decompressBody(body)).toBe(body); // not gzip: untouched
    const broken = Uint8Array.from([0x1f, 0x8b, 1, 2, 3]);
    expect(await verifyQuickNodeSignature({ ...sign(ts, broken), rawBody: broken })).toMatchObject({
      reason: 'bad_body',
    });
    // a gzip bomb inflating past QN_MAX_DECOMPRESSED_BYTES is refused before the HMAC
    const bomb = new Uint8Array(gzipSync(new Uint8Array(QN_MAX_DECOMPRESSED_BYTES + 1)));
    expect(bomb.length).toBeLessThan(10_000);
    expect(await verifyQuickNodeSignature({ ...sign(ts, bomb), rawBody: bomb })).toMatchObject({
      reason: 'bad_body',
    });
  });
});

describe('IDL decoder (DATA-MODEL §5.9 payload encoding)', () => {
  it('EVENT_IX_TAG_LE is sha256("anchor:event")[0..8] reversed', () => {
    const h = createHash('sha256').update('anchor:event').digest().subarray(0, 8);
    expect([...h].reverse()).toEqual([...EVENT_IX_TAG_LE]);
  });

  it.each(ALL_EVENT_NAMES.map((n) => [n]))('round-trips %s exactly', (name) => {
    const p = samplePayload(name);
    const bytes = encodeEvent(name, p);
    expect(decodeEventBytes(bytes)).toEqual({ name, payload: p });
    // trailing bytes, truncation, unknown discriminator
    expect(() => decodeEventBytes(Uint8Array.from([...bytes, 0]))).toThrow(DecodeError);
    expect(() => decodeEventBytes(bytes.subarray(0, bytes.length - 1))).toThrow(DecodeError);
    expect(() => decodeEventBytes(new Uint8Array(24))).toThrow(/discriminator/);
  });

  it('covers every IDL event and rejects out-of-range enums and bools', () => {
    expect(IDL_EVENT_NAMES).toEqual(ALL_EVENT_NAMES);
    const bytes = encodeEvent('BetResolved', samplePayload('BetResolved'));
    const bad = Uint8Array.from(bytes);
    bad[8 + 16 + 32] = 9; // outcome byte
    expect(() => decodeEventBytes(bad)).toThrow(/variant 9/);
    const ar = encodeEvent('AppealResolved', samplePayload('AppealResolved'));
    const badBool = Uint8Array.from(ar);
    badBool[badBool.length - 1] = 2;
    expect(() => decodeEventBytes(badBool)).toThrow(/bool/);
  });

  it('decodes Borsh Option tags strictly: 0 = None, 1 = Some, anything else throws', () => {
    // UpdateConfigArgs: 8 × Option<scalar|pubkey>, Option<Vec<Pubkey>>, Option<bool>. All None:
    const none = new Uint8Array(10);
    expect(decodeIdlDefined(none, 'UpdateConfigArgs')).toMatchObject({
      new_admin: null,
      paused: null,
    });
    const somePaused = Uint8Array.from([...none.subarray(0, 9), 1, 1]);
    expect(decodeIdlDefined(somePaused, 'UpdateConfigArgs')).toMatchObject({ paused: true });
    const tag2 = Uint8Array.from([...none.subarray(0, 9), 2, 1]);
    expect(() => decodeIdlDefined(tag2, 'UpdateConfigArgs')).toThrow(/option tag 2/);
    expect(() => decodeIdlDefined(Uint8Array.from([255, ...none]), 'UpdateConfigArgs')).toThrow(
      /option tag 255/,
    );
  });
});

describe('parseStreamDelivery (filter output → chain_events rows)', () => {
  const b64 = (name: string, over: Record<string, unknown> = {}) =>
    Buffer.from(encodeEvent(name, samplePayload(name, over))).toString('base64');
  const env = (txs: unknown[]) => ({ v: 1, programId: ESCROW_ID, batchStart: 1, batchEnd: 5, txs });

  it('decodes with the IDL, ignores the name hint, dedupes and orders by (block, tx, outer, inner)', () => {
    const bet = randomUUID();
    const S1 = randomSig();
    const S2 = randomSig();
    const created = b64('BetCreated', { bet_id: bet });
    const accepted = b64('BetAccepted', { bet_id: bet });
    const resolved = b64('BetResolved', { bet_id: bet });
    const batch = parseStreamDelivery(
      env([
        {
          signature: S2,
          blockHeight: 11,
          txIndex: 0,
          blockTime: 1_795_284_500,
          events: [{ outerIx: 2, innerIx: 0, name: 'BetAccepted', eventBase64: resolved }],
        },
        {
          signature: S1,
          blockHeight: 10,
          txIndex: 3,
          blockTime: 1_795_284_425,
          events: [
            { outerIx: 4, innerIx: 0, name: 'BetAccepted', eventBase64: accepted },
            { outerIx: 3, innerIx: 0, name: 'BetCreated', eventBase64: created },
            { outerIx: 3, innerIx: 0, name: 'BetCreated', eventBase64: created }, // in-batch dup
          ],
        },
      ]),
    );
    expect(batch.events.map((e) => [e.signature, e.outer_ix, e.inner_ix, e.event_name])).toEqual([
      [S1, 3, 0, 'BetCreated'],
      [S1, 4, 0, 'BetAccepted'],
      [S2, 2, 0, 'BetResolved'], // the decode wins over the 'BetAccepted' hint
    ]);
    expect(batch.duplicates).toBe(1);
    expect(batch.hintMismatches).toBe(1);
    expect(batch.events.every((e) => e.bet_id === bet && e.apply_error === null)).toBe(true);
    expect(batch.events[0]).toMatchObject({
      slot: null,
      block_height: 10,
      tx_index: 3,
      block_time_s: 1_795_284_425,
      program_id: ESCROW_ID,
      raw_b64: created,
    });
  });

  it('rejects malformed entries individually; stores undecodable-but-attributed events with apply_error', () => {
    const sig = randomSig();
    const garbage = Buffer.from([
      ...encodeEvent('BetClosed', samplePayload('BetClosed')),
      7,
    ]).toString('base64');
    const unknownDisc = Buffer.from(new Uint8Array(40)).toString('base64');
    const created = encodeEvent('BetCreated', samplePayload('BetCreated'));
    const truncated = Buffer.from(created.subarray(0, created.length - 1)).toString('base64');
    const batch = parseStreamDelivery(
      env([
        { signature: 'not-a-sig', events: [] },
        {
          signature: sig,
          events: [
            { outerIx: -1, innerIx: 0, eventBase64: garbage },
            { outerIx: 0, innerIx: 0, eventBase64: '!!!not base64!!!' },
            { outerIx: 1, innerIx: 0, eventBase64: garbage },
            { outerIx: 2, innerIx: 0, eventBase64: unknownDisc },
            { outerIx: 3, innerIx: 0, eventBase64: truncated },
          ],
        },
      ]),
    );
    expect(batch.rejected.map((r) => r.key)).toEqual(['txs[0]', `${sig}:events[0]`, `${sig}:0:0`]);
    expect(batch.events.map((e) => [e.event_name, e.apply_error?.split(':')[0]])).toEqual([
      ['BetClosed', 'decode_failed'],
      ['Unknown', 'decode_failed'],
      ['BetCreated', 'decode_failed'],
    ]);
  });

  it('flags payloads that decode but break SCHEMAS §10.2 (e.g. a non-v4 bet_id)', () => {
    const batch = parseStreamDelivery(
      env([
        {
          signature: randomSig(),
          events: [
            {
              outerIx: 0,
              innerIx: 0,
              eventBase64: b64('BetResolved', { bet_id: '00000000-0000-0000-0000-000000000000' }),
            },
          ],
        },
      ]),
    );
    expect(batch.events[0]!.apply_error).toMatch(/^payload_invalid: bet_id/);
  });

  it('throws StreamPayloadError on a foreign envelope or program; null is an empty batch', () => {
    expect(() => parseStreamDelivery({ foo: 1 })).toThrow(StreamPayloadError);
    expect(() => parseStreamDelivery({ ...env([]), v: 2 })).toThrow(StreamPayloadError);
    expect(() => parseStreamDelivery({ ...env([]), programId: randomPubkey() })).toThrow(
      /not ESCROW_ID/,
    );
    expect(parseStreamDelivery(null).events).toEqual([]);
  });
});

describe('infra/quicknode/filter.js (ESCROW §7.1 rules 1-5)', () => {
  const filter = loadFilter();

  it('CONFIG equals the IDL + ESCROW_ID + derived event authority (no drift)', async () => {
    expect(JSON.parse(JSON.stringify(filter.CONFIG))).toEqual(await buildFilterConfig());
    expect(filter.CONFIG.programId).toBe(ESCROW_ID);
    expect(filter.CONFIG.eventAuthority).toBe(await eventAuthorityAddress());
  });

  it('stream.json matches API-CONTRACT §5.1', () => {
    const s = JSON.parse(readFileSync(INFRA('stream.json'), 'utf8'));
    expect(s).toMatchObject({
      name: 'youre-on-escrow-devnet',
      network: 'solana-devnet',
      dataset: 'block',
      filter_language: 'javascript',
      region: 'usa_east',
      dataset_batch_size: 5,
      elastic_batch_enabled: true,
      destination: 'webhook',
      destination_attributes: {
        compression: 'none',
        max_retry: 3,
        retry_interval_sec: 1,
        post_timeout_sec: 10,
      },
    });
    expect(s.destination_attributes.url).toMatch(/\/webhooks\/quicknode$/);
  });

  it('decodes an atomic lock (2 emit_cpi! events) on the fixture; the server re-decodes them', async () => {
    const ea = await eventAuthorityAddress();
    const bet = randomUUID();
    const created = samplePayload('BetCreated', { bet_id: bet });
    const accepted = samplePayload('BetAccepted', { bet_id: bet });
    const sig = randomSig();
    const lock = jsonTx({
      signature: sig,
      eventAuthority: ea,
      events: [
        { outer: 3, bytes: encodeEvent('BetCreated', created) },
        { outer: 4, bytes: encodeEvent('BetAccepted', accepted) },
      ],
    });
    const out = filter.main({
      data: [block([jsonTx({ eventAuthority: ea, events: [] }), lock])],
      metadata: {
        network: 'solana-devnet',
        dataset: 'block',
        batch_start_range: 519_807_088,
        batch_end_range: 519_807_092,
      },
    })!;
    expect(out).toMatchObject({
      v: 1,
      programId: ESCROW_ID,
      network: 'solana-devnet',
      dataset: 'block',
      batchStart: 519_807_088,
      batchEnd: 519_807_092,
    });
    expect(out.txs).toHaveLength(1);
    expect(out.txs[0]).toMatchObject({
      signature: sig,
      blockHeight: 400_118_207,
      parentSlot: 519_807_090,
      blockTime: 1_795_284_425,
      txIndex: 1,
    });
    expect(out.txs[0]!.events.map((e) => [e.outerIx, e.innerIx, e.name])).toEqual([
      [3, 0, 'BetCreated'],
      [4, 0, 'BetAccepted'],
    ]);
    // eventBase64 = disc ‖ borsh, which the server decodes back to the exact payloads
    const batch = parseStreamDelivery(JSON.parse(JSON.stringify(out)));
    expect(batch.rejected).toEqual([]);
    expect(batch.events.map((e) => e.payload)).toEqual([created, accepted]);
    expect(batch.events.every((e) => e.apply_error === null)).toBe(true);
  });

  it('same result for jsonParsed blocks and for keys behind an address lookup table', async () => {
    const ea = await eventAuthorityAddress();
    const p = samplePayload('BetFinalized');
    const evs = [{ outer: 0, bytes: encodeEvent('BetFinalized', p) }];
    const lut = jsonTx({ eventAuthority: ea, events: evs, viaLookupTable: true });
    const parsed = toJsonParsed(jsonTx({ eventAuthority: ea, events: evs }));
    const parsedLut = toJsonParsed(lut);
    for (const tx of [lut, parsed, parsedLut]) {
      const out = filter.main({ data: [block([tx])] })!;
      expect(out.txs[0]!.events).toHaveLength(1);
      const batch = parseStreamDelivery(out);
      expect(batch.events[0]!.payload).toEqual(p);
    }
  });

  it('drops failed txs, foreign programs, forged authorities, untagged data and top-level ixs', async () => {
    const ea = await eventAuthorityAddress();
    const bytes = encodeEvent('BetConceded', samplePayload('BetConceded'));
    const evil = randomPubkey();
    const txs = [
      // rule 1: failed tx still records inner ixs
      jsonTx({
        eventAuthority: ea,
        events: [{ outer: 0, bytes }],
        err: { InstructionError: [1, { Custom: 6000 }] },
      }),
      // rule 2a: same bytes from another program built from our IDL
      jsonTx({ eventAuthority: ea, events: [{ outer: 0, bytes, program: evil }] }),
      // rule 2c: right program, wrong first account
      jsonTx({ eventAuthority: ea, events: [{ outer: 0, bytes, firstAccount: evil }] }),
      // rule 2b: no event-ix tag
      jsonTx({ eventAuthority: ea, events: [{ outer: 0, bytes, noTag: true }] }),
      // rule 3: a top-level "event"
      jsonTx({ eventAuthority: ea, events: [], topLevel: bytes }),
    ];
    expect(filter.main({ data: [block(txs)] })).toBeNull();
    expect(filter.main({ data: [] })).toBeNull();
    expect(filter.main(null)).toBeNull();
    // and one good event next to them is the only one forwarded
    const good = jsonTx({
      eventAuthority: ea,
      events: [
        { outer: 2, bytes },
        { outer: 2, bytes },
      ],
    });
    const out = filter.main({ data: [block([...txs, good])] })!;
    expect(out.txs.map((t) => [t.txIndex, t.events.map((e) => [e.outerIx, e.innerIx])])).toEqual([
      [
        5,
        [
          [2, 0],
          [2, 1],
        ],
      ],
    ]);
  });

  it('forwards an unknown discriminator from our program with name null (stored, never applied)', async () => {
    const ea = await eventAuthorityAddress();
    const out = filter.main({
      data: [
        block([jsonTx({ eventAuthority: ea, events: [{ outer: 0, bytes: new Uint8Array(20) }] })]),
      ],
    })!;
    expect(out.txs[0]!.events[0]!.name).toBeNull();
    expect(parseStreamDelivery(out).events[0]).toMatchObject({
      event_name: 'Unknown',
      apply_error: expect.stringMatching(/^decode_failed/),
    });
  });

  it('the committed fixture decodes to its expected output', () => {
    const fx = JSON.parse(readFileSync(INFRA('fixtures/block-atomic-lock.json'), 'utf8'));
    const expected = JSON.parse(
      readFileSync(INFRA('fixtures/block-atomic-lock.expected.json'), 'utf8'),
    );
    const out = filter.main(fx);
    expect(out).toEqual(expected);
    const batch = parseStreamDelivery(out);
    expect(batch.events.map((e) => [e.event_name, e.apply_error])).toEqual([
      ['BetCreated', null],
      ['BetAccepted', null],
    ]);
  });
});

describe('DB error classification (ack rules)', () => {
  it('only an allowlist of transient conditions is retryable (503); everything else is 200', () => {
    for (const code of ['08006', '08001', '40001', '40P01', '53300', '57P01', '57P03', '55P03'])
      expect(isTransientDbError({ code }), code).toBe(true);
    expect(isTransientDbError({ message: 'Failed query', cause: { code: '40001' } })).toBe(true);
    for (const code of ['CONNECTION_CLOSED', 'CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED'])
      expect(isTransientDbError(Object.assign(new Error(code), { code })), code).toBe(true);
    // deterministic: integrity / data, a trigger RAISE (P0001), plain JS exceptions
    expect(isTransientDbError({ code: '23514' })).toBe(false);
    expect(isTransientDbError({ message: 'Failed query', cause: { code: '22P02' } })).toBe(false);
    expect(isTransientDbError({ code: 'P0001' })).toBe(false);
    expect(isTransientDbError({ code: '57014' })).toBe(false);
    expect(isTransientDbError(new Error('appendBetEvent: unknown bet'))).toBe(false);
    expect(isTransientDbError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});

describe('attributeEvents (ESCROW §5.1 / §7.1: bind events to OUR instance of a bet_id)', () => {
  let n = 0n;
  const row = (
    event_name: string,
    signature: string,
    block_height: number | null,
    tx_index: number | null = 0,
  ): AttributionRow => ({
    id: ++n,
    signature,
    event_name,
    block_height,
    tx_index,
    apply_error: null,
  });
  const LOCK = randomSig();
  const lock = row('BetCreated', LOCK, 100);

  it('chainOrder: same tx = 0; unknown without block heights or tx indexes', () => {
    expect(chainOrder(row('X', LOCK, null), lock)).toBe(0);
    expect(chainOrder(row('X', randomSig(), 99), lock)).toBe(-1);
    expect(chainOrder(row('X', randomSig(), 100, 1), lock)).toBe(1);
    expect(chainOrder(row('X', randomSig(), 100, null), lock)).toBeNull();
    expect(chainOrder(row('X', randomSig(), null), lock)).toBeNull();
  });

  it('accepts an uncontested rpc_poll row, and a server-sent one even when contested', () => {
    const polled = row('BetResolved', randomSig(), null);
    expect(attributeEvents([lock, polled], lock, new Set())(polled)).toBe(true);
    const close = row('BetClosed', randomSig(), 200);
    const serverSent = row('BetResolved', randomSig(), null);
    const stranger = row('BetRefunded', randomSig(), null);
    const ours = attributeEvents(
      [lock, close, serverSent, stranger],
      lock,
      new Set([serverSent.signature]),
    );
    expect([ours(close), ours(serverSent), ours(stranger)]).toEqual([true, true, false]);
  });

  it('rejects anything before our lock, after our close, or at/after a later foreign create', () => {
    const early = row('BetCancelled', randomSig(), 50);
    const mid = row('BetResolved', randomSig(), 150);
    const close = row('BetClosed', randomSig(), 200);
    const foreign = row('BetCreated', randomSig(), 300);
    const after = row('BetAccepted', randomSig(), 310);
    const ours = attributeEvents([lock, early, mid, close, foreign, after], lock, new Set());
    expect([early, mid, close, foreign, after].map(ours)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });
});
