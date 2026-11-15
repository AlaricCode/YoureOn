// DATA-MODEL §5.9 chain_events (added by migration 0003, QuickNode Streams stream).
//
// Inbound, decoded Anchor `emit_cpi!` events. QuickNode Streams is the source of truth for
// money; `rpc_poll` rows are the degraded-mode backfill (§8.3). The single dedup key is
// UNIQUE (signature, outer_ix, inner_ix), shared with ESCROW §7.1 and SCHEMAS §10.1: the
// webhook inserts with ON CONFLICT DO NOTHING before any `bet_events.seq` is assigned.
//
// `bet_id` deliberately has NO foreign key (test scripts can emit events for bets that have
// no row, and a demo reset must not delete chain history). bet_events.chain_event_id gets its
// FK to this table in the same migration.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { chainEventSource } from './enums';
import { pubkeyCheck, txSigCheck } from './checks';
import { tstz } from './types';

export const chainEvents = pgTable(
  'chain_events',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    signature: text().notNull(),
    /** Index of the top-level instruction in the tx. */
    outer_ix: smallint().notNull(),
    /** Index of the emit_cpi! self-CPI within meta.innerInstructions[outer_ix]. */
    inner_ix: smallint().notNull(),
    /** NULL from Streams (getBlock objects carry no slot); set by rpc_poll. */
    slot: bigint({ mode: 'number' }),
    /** From the Streams block (blockHeight); NULL from rpc_poll. */
    block_height: bigint({ mode: 'number' }),
    tx_index: integer(),
    block_time: tstz(),
    commitment: text().notNull().default('confirmed'),
    /** Always ESCROW_ID (the filter requires it). */
    program_id: text().notNull(),
    /** IDL event name. Unknown names are stored but not applied. */
    event_name: text().notNull(),
    /** From the payload. No FK. NULL for Config events. */
    bet_id: uuid(),
    /** SCHEMAS ChainEvents.<name> minus ChainMeta (u64 → string, Pubkey → base58, [u8;32] → hex). */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Raw event bytes (discriminator ‖ Borsh), base64, kept for re-decoding. */
    raw_b64: text(),
    source: chainEventSource().notNull().default('stream'),
    /** Streams batch headers, for debugging. */
    delivery_id: text(),
    received_at: tstz().notNull().defaultNow(),
    applied_at: tstz(),
    apply_error: text(),
    finalized_at: tstz(),
  },
  (t) => [
    uniqueIndex('chain_events_dedupe_uq').on(t.signature, t.outer_ix, t.inner_ix),
    index('chain_events_bet_idx').on(t.bet_id, t.received_at),
    index('chain_events_unapplied')
      .on(t.received_at)
      .where(sql`applied_at IS NULL`),
    index('chain_events_recent').on(t.received_at.desc()),
    check('chain_events_commitment', sql.raw(`commitment IN ('confirmed','finalized')`)),
    check('chain_events_ix_nonneg', sql`outer_ix >= 0 AND inner_ix >= 0`),
    txSigCheck('chain_events', 'signature'),
    pubkeyCheck('chain_events', 'program_id'),
  ],
);
