// DATA-MODEL §5.16 gemini_markets and market_snapshots (migration 0007, Beat 6: the Gemini
// closer). One gemini_markets row per BTC 5-minute contract a bet touched; one market_snapshots
// row per BINDING quote (the snapshot fairStakes priced a bet's terms from: bets.pricing_snapshot_id).
//
// - Symbols are copied from Gemini's API, never built. Gemini's values are kept verbatim
//   (status = Gemini's status, settlement_value = the exact decimal string).
// - settlement_raw is the body of the GET /v1/prediction-markets/events/{eventTicker} response
//   that settled the contract, byte for byte; settlement_response_sha256 = sha256(it)
//   (CHECKed) = GeminiSettlementRecord.response_sha256. The per-bet hashed record itself lives on
//   the settlement `rulings` row (evidence_canonical; SCHEMAS X12), not here.
//
// Additions to DATA-MODEL, on purpose: market_snapshots.snapshot_canonical / snapshot_sha256
// (the JCS of the SCHEMAS GeminiMarketSnapshot the quote came from, and its sha256: the
// "binding quote hash" a reviewer can check against Terms.market), and contract_ticker is
// nullable (Gemini may omit it).
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { marketSide, marketStatus } from './enums';
import { hex32Check } from './checks';
import { tstz } from './types';

export const geminiMarkets = pgTable(
  'gemini_markets',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** e.g. BTC05M2611180240 */
    event_ticker: text().notNull(),
    /** e.g. GEMI-BTC05M2611180240-UP */
    instrument_symbol: text().notNull(),
    /** e.g. UP */
    contract_ticker: text(),
    series: text(),
    title: text(),
    /** strike.value, latched at the window start (never parsed from the ticker). */
    strike: numeric({ precision: 20, scale: 8 }),
    window_start: tstz(),
    expires_at: tstz().notNull(),
    status: marketStatus().notNull().default('active'),
    resolution_side: marketSide(),
    settlement_value: text(),
    resolved_at: tstz(),
    settlement_raw: text(),
    settlement_response_sha256: text(),
    event_raw: jsonb(),
    first_seen_at: tstz().notNull().defaultNow(),
    updated_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    // DATA-MODEL also lists UNIQUE (event_ticker, instrument_symbol): implied by this one.
    uniqueIndex('gemini_markets_symbol_uq').on(t.instrument_symbol),
    index('gemini_markets_open_idx')
      .on(t.expires_at)
      .where(sql.raw(`status IN ('active','closed')`)),
    check(
      'gemini_markets_settlement_pair',
      sql`(settlement_raw IS NULL) = (settlement_response_sha256 IS NULL)`,
    ),
    check(
      'gemini_markets_settlement_hash',
      sql`settlement_raw IS NULL
        OR settlement_response_sha256 = encode(sha256(convert_to(settlement_raw, 'UTF8')), 'hex')`,
    ),
    check('gemini_markets_resolution', sql.raw(`resolution_side IS NULL OR status = 'settled'`)),
    hex32Check('gemini_markets', 'settlement_response_sha256'),
  ],
);

export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    market_id: uuid()
      .notNull()
      .references((): AnyPgColumn => geminiMarkets.id, { onDelete: 'cascade' }),
    /** = snapshot observedAt. */
    captured_at: tstz().notNull().defaultNow(),
    exchange_ts: tstz(),
    source: text().notNull(),
    best_bid: numeric({ precision: 5, scale: 4 }),
    best_ask: numeric({ precision: 5, scale: 4 }),
    last_price: numeric({ precision: 5, scale: 4 }),
    index_price: numeric({ precision: 20, scale: 8 }),
    /** JCS of the SCHEMAS GeminiMarketSnapshot, byte for byte. */
    snapshot_canonical: text(),
    snapshot_sha256: text(),
  },
  (t) => [
    index('market_snapshots_idx').on(t.market_id, t.captured_at.desc()),
    check('market_snapshots_source', sql`source IN ('ws_book_ticker','rest_event')`),
    check(
      'market_snapshots_hash',
      sql`(snapshot_canonical IS NULL) = (snapshot_sha256 IS NULL)
        AND (snapshot_canonical IS NULL
          OR snapshot_sha256 = encode(sha256(convert_to(snapshot_canonical, 'UTF8')), 'hex'))`,
    ),
    hex32Check('market_snapshots', 'snapshot_sha256'),
  ],
);
