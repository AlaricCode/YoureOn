// QuickNode Streams intake: turns a verified webhook body (the infra/quicknode/filter.js output,
// API-CONTRACT §5.2) into ordered, de-duplicated chain_events rows.
//
// Ported from Verdict packages/backend/src/chain/streams.ts (envelope validation, per-event
// schema validation with a `rejected` list, in-batch dedupe, stable ordering). Our contract
// differs and wins:
//   - events are emit_cpi! inner instructions, keyed (signature, outer_ix, inner_ix), not
//     (signature, index);
//   - the filter forwards raw `eventBase64` (disc ‖ borsh) and the server re-decodes it with the
//     compiled IDL (decoder.ts), ignoring the filter's `name` hint;
//   - there is no slot (getBlock objects carry none): order by blockHeight, then txIndex, then
//     (outerIx, innerIx), then delivery order;
//   - undecodable-but-attributed events are still stored (with apply_error) for the audit trail.
import { getBase58Encoder } from '@solana/kit';
import { z } from 'zod/v4';
import { ChainEvents, chainEventDedupKey, Signature, type ChainEventName } from '@youre-on/shared';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import {
  base64ToBytes,
  decodeEventBytes,
  DecodeError,
  EVENT_IX_TAG_LE,
  eventNameOf,
} from './decoder';

/** Envelope version the filter emits (`v`). */
export const STREAM_PAYLOAD_VERSION = 1;
/** smallint columns. */
const SMALLINT_MAX = 32_767;

const nonNegInt = z.number().int().nonnegative();
const optInt = nonNegInt.nullable().optional();

const StreamEvent = z.object({
  outerIx: nonNegInt.max(SMALLINT_MAX),
  innerIx: nonNegInt.max(SMALLINT_MAX),
  name: z.string().max(64).nullable().optional(),
  eventBase64: z.string().min(12).max(16_384),
});
const StreamTx = z.object({
  signature: Signature,
  blockHeight: optInt,
  parentSlot: optInt,
  blockTime: optInt,
  txIndex: optInt,
  events: z.array(z.unknown()).max(64),
});
const StreamEnvelope = z.object({
  v: z.literal(STREAM_PAYLOAD_VERSION),
  programId: z.string(),
  network: z.string().nullable().optional(),
  dataset: z.string().nullable().optional(),
  batchStart: z.number().int().nullable().optional(),
  batchEnd: z.number().int().nullable().optional(),
  txs: z.array(z.unknown()).max(10_000),
});

/** The body is not a filter envelope at all (bad JSON shape, wrong version or program). */
export class StreamPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamPayloadError';
  }
}

/** One event ready for `INSERT INTO chain_events` (DATA-MODEL §5.9). */
export interface ParsedChainEvent {
  signature: string;
  outer_ix: number;
  inner_ix: number;
  /** NULL from Streams (getBlock objects carry none); set by rpc_poll. */
  slot: number | null;
  block_height: number | null;
  tx_index: number | null;
  /** unix seconds, or null. */
  block_time_s: number | null;
  program_id: string;
  event_name: string;
  bet_id: string | null;
  payload: Record<string, unknown>;
  raw_b64: string;
  /** Set when the bytes are ours but can't be decoded or don't match SCHEMAS §10.2. */
  apply_error: string | null;
}

export interface StreamBatch {
  events: ParsedChainEvent[];
  /** Entries dropped before storage (malformed tx or event), with a short reason. */
  rejected: { key: string; reason: string }[];
  /** In-batch duplicates of (signature, outer_ix, inner_ix), dropped. */
  duplicates: number;
  /** The filter's name hint disagreed with the IDL decode (logged; the decode wins). */
  hintMismatches: number;
  batchStart: number | null;
  batchEnd: number | null;
}

const isConfigEvent = (name: string) => name === 'ConfigInitialized' || name === 'ConfigUpdated';
const knownChainEvent = (name: string): name is ChainEventName =>
  Object.prototype.hasOwnProperty.call(ChainEvents, name);

/**
 * Validates a decoded payload against SCHEMAS ChainEvents.<name> (with a placeholder ChainMeta,
 * since the meta is added at fan-out). Returns null if valid, else a short reason.
 */
export function payloadSchemaError(name: string, payload: Record<string, unknown>): string | null {
  if (isConfigEvent(name)) return null; // store-only; no SCHEMAS shape
  if (!knownChainEvent(name)) return `unknown event ${name}`;
  const r = ChainEvents[name].safeParse({
    signature: '1'.repeat(64),
    slot: null,
    block_height: null,
    outer_ix: 0,
    inner_ix: 0,
    block_time: null,
    observed_via: 'quicknode_stream',
    ...payload,
  });
  if (r.success) return null;
  const i = r.error.issues[0];
  return `${i?.path.join('.') || '(root)'}: ${i?.message ?? 'invalid'}`;
}

function decodeOne(tx: z.infer<typeof StreamTx>, ev: z.infer<typeof StreamEvent>) {
  const bytes = base64ToBytes(ev.eventBase64); // throws DecodeError on non-canonical base64
  let name: string;
  let payload: Record<string, unknown> = {};
  let apply_error: string | null = null;
  try {
    const d = decodeEventBytes(bytes);
    name = d.name;
    payload = d.payload;
    const bad = payloadSchemaError(name, payload);
    if (bad) apply_error = `payload_invalid: ${bad}`;
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    name = eventNameOf(bytes) ?? 'Unknown';
    apply_error = `decode_failed: ${e.message}`;
  }
  const bet_id =
    typeof payload['bet_id'] === 'string' && /^[0-9a-f-]{36}$/.test(payload['bet_id'])
      ? payload['bet_id']
      : null;
  const out: ParsedChainEvent = {
    signature: tx.signature,
    outer_ix: ev.outerIx,
    inner_ix: ev.innerIx,
    slot: null,
    block_height: tx.blockHeight ?? null,
    tx_index: tx.txIndex ?? null,
    block_time_s: tx.blockTime ?? null,
    program_id: ESCROW_ID,
    event_name: name,
    bet_id,
    payload,
    raw_b64: ev.eventBase64,
    apply_error,
  };
  return { out, hintMismatch: ev.name != null && ev.name !== name };
}

/**
 * Parses, validates, de-duplicates and orders a verified webhook body. Throws
 * StreamPayloadError when the body is not our filter's envelope; individual bad txs/events
 * go to `rejected` instead, so one bad entry never blocks the rest of the batch.
 * A `null` body (the filter returned null) is an empty batch.
 */
export function parseStreamDelivery(body: unknown): StreamBatch {
  const batch: StreamBatch = {
    events: [],
    rejected: [],
    duplicates: 0,
    hintMismatches: 0,
    batchStart: null,
    batchEnd: null,
  };
  if (body === null) return batch;
  const env = StreamEnvelope.safeParse(body);
  if (!env.success) {
    const i = env.error.issues[0];
    throw new StreamPayloadError(
      `payload: ${i?.path.join('.') || '(root)'}: ${i?.message ?? 'invalid'}`,
    );
  }
  if (env.data.programId !== ESCROW_ID)
    throw new StreamPayloadError(`payload: programId ${env.data.programId} is not ESCROW_ID`);
  batch.batchStart = env.data.batchStart ?? null;
  batch.batchEnd = env.data.batchEnd ?? null;

  const seen = new Set<string>();
  const ordered: { ev: ParsedChainEvent; seq: number }[] = [];
  let seq = 0;
  env.data.txs.forEach((rawTx, ti) => {
    const tx = StreamTx.safeParse(rawTx);
    if (!tx.success) {
      batch.rejected.push({ key: `txs[${ti}]`, reason: tx.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    tx.data.events.forEach((rawEv, ei) => {
      const ev = StreamEvent.safeParse(rawEv);
      if (!ev.success) {
        batch.rejected.push({
          key: `${tx.data.signature}:events[${ei}]`,
          reason: ev.error.issues[0]?.message ?? 'invalid',
        });
        return;
      }
      const key = chainEventDedupKey({
        signature: tx.data.signature,
        outer_ix: ev.data.outerIx,
        inner_ix: ev.data.innerIx,
      });
      if (seen.has(key)) {
        batch.duplicates++;
        return;
      }
      seen.add(key);
      try {
        const { out, hintMismatch } = decodeOne(tx.data, ev.data);
        if (hintMismatch) batch.hintMismatches++;
        ordered.push({ ev: out, seq: seq++ });
      } catch (e) {
        if (!(e instanceof DecodeError)) throw e;
        batch.rejected.push({ key, reason: e.message });
      }
    });
  });

  const h = (x: number | null) => (x === null ? Number.MAX_SAFE_INTEGER : x);
  ordered.sort(
    (a, b) =>
      h(a.ev.block_height) - h(b.ev.block_height) ||
      (a.ev.signature === b.ev.signature
        ? a.ev.outer_ix - b.ev.outer_ix || a.ev.inner_ix - b.ev.inner_ix
        : h(a.ev.tx_index) - h(b.ev.tx_index) || a.seq - b.seq),
  );
  batch.events = ordered.map((x) => x.ev);
  return batch;
}

// ---- rpc_poll (DATA-MODEL §8.3 "Gaps": the reconciler's getTransaction copy) -----------------

/** One confirmed transaction as getTransaction (encoding json) returns it, normalized. */
export interface RpcTransaction {
  signature: string;
  slot: number | null;
  /** The block's height (getBlock), when the client could get it: attribution orders by it. */
  blockHeight?: number | null;
  /** unix seconds, or null. */
  blockTime: number | null;
  /** meta.err (null = success). */
  err: unknown;
  /** Static keys, then meta.loadedAddresses.writable, then .readonly (the runtime's index order). */
  accountKeys: readonly string[];
  innerInstructions: readonly {
    index: number;
    instructions: readonly { programIdIndex: number; accounts: readonly number[]; data: string }[];
  }[];
}

const b58 = getBase58Encoder();

/**
 * The rpc_poll twin of infra/quicknode/filter.js (ESCROW §7.1 rules 1-5) over one getTransaction
 * result: drop a failed tx; take INNER instructions of ESCROW_ID whose first account is the
 * event-authority PDA and whose data starts with the Anchor event tag; never top-level ones. The
 * events then go through the same envelope parser as a Stream delivery, so a row has the same
 * dedup key (signature, outer_ix, inner_ix) and payload whichever source stores it first. `slot`
 * is set, block_height when the client fetched it; tx_index stays null (a later Stream copy
 * backfills both, ingest.ts).
 */
export function eventsFromRpcTransaction(tx: RpcTransaction, eventAuthority: string): StreamBatch {
  if (tx.err !== null && tx.err !== undefined) return parseStreamDelivery(null);
  const events: { outerIx: number; innerIx: number; eventBase64: string }[] = [];
  for (const g of tx.innerInstructions)
    g.instructions.forEach((ix, innerIx) => {
      if (tx.accountKeys[ix.programIdIndex] !== ESCROW_ID) return;
      const first = ix.accounts[0];
      if (first === undefined || tx.accountKeys[first] !== eventAuthority) return;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(b58.encode(ix.data));
      } catch {
        return;
      }
      if (bytes.length < 16 || !EVENT_IX_TAG_LE.every((b, i) => bytes[i] === b)) return;
      events.push({
        outerIx: g.index,
        innerIx,
        eventBase64: Buffer.from(bytes.subarray(8)).toString('base64'),
      });
    });
  if (events.length === 0) return parseStreamDelivery(null);
  const batch = parseStreamDelivery({
    v: STREAM_PAYLOAD_VERSION,
    programId: ESCROW_ID,
    txs: [
      {
        signature: tx.signature,
        blockHeight: tx.blockHeight ?? null,
        blockTime: tx.blockTime,
        txIndex: null,
        events,
      },
    ],
  });
  for (const e of batch.events) e.slot = tx.slot;
  return batch;
}
