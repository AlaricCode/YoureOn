// DATA-MODEL §5.6 bets (core columns) and §5.19 bet_events.
//
// Migration 0000 carries the core of `bets`. Columns that need later tables came with that
// stream's migration:
//   - gemini_market_id (FK gemini_markets), pricing_snapshot_id (FK market_snapshots),
//     CHECK bets_gemini_market and index bets_market_idx  -> Gemini closer, migration 0007 (§5.16)
//   (bet_events.chain_event_id FK -> chain_events landed with the Streams migration 0003, §5.9)
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  authorizationMethod,
  betEndReason,
  betState,
  challengeMethod,
  evidenceSource,
  lockMode,
  marketSide,
  onchainOutcome,
  onchainStatus,
  payoutVia,
} from './enums';
import { hex32Check, pubkeyCheck, txSigCheck } from './checks';
import { tstz } from './types';
import { rooms } from './rooms';
import { users } from './users';
import { chainEvents } from './chain';
import { geminiMarkets, marketSnapshots } from './markets';

const micro = () => bigint({ mode: 'bigint' });

export const bets = pgTable(
  'bets',
  {
    id: uuid().primaryKey().defaultRandom(),
    room_id: uuid().references((): AnyPgColumn => rooms.id),
    party_a_id: uuid()
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    party_b_id: uuid()
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    party_a_wallet: text(),
    party_b_wallet: text(),
    lock_mode: lockMode().notNull().default('atomic'),
    challenge_method: challengeMethod().notNull().default('face'),
    supersedes_bet_id: uuid().references((): AnyPgColumn => bets.id),
    title: text(),
    evidence_source: evidenceSource(),
    state: betState().notNull().default('DRAFTING'),
    end_reason: betEndReason(),
    refusal_category: text(),
    onchain_status: onchainStatus().notNull().default('none'),
    onchain_pending: onchainStatus(),
    pending_sig: text(),
    mint: text().notNull(),
    stake_a: micro(),
    stake_b: micro(),
    terms_hash: text(),
    bet_pda: text().unique('bets_bet_pda_uq'),
    vault: text().unique('bets_vault_uq'),
    /** The Gemini contract of a real_world bet (required when evidence_source = 'gemini'). */
    gemini_market_id: uuid().references((): AnyPgColumn => geminiMarkets.id),
    a_position: marketSide(),
    odds_p: numeric({ precision: 3, scale: 2 }),
    odds_source: text(),
    quoted_at: tstz(),
    /** The binding quote's snapshot (the one fairStakes priced odds_p from). */
    pricing_snapshot_id: bigint({ mode: 'bigint' }).references(
      (): AnyPgColumn => marketSnapshots.id,
    ),
    a_authorized_at: tstz(),
    b_authorized_at: tstz(),
    a_authorization_method: authorizationMethod(),
    b_authorization_method: authorizationMethod(),
    a_authorized_device_at: tstz(),
    b_authorized_device_at: tstz(),
    redo_count: smallint().notNull().default(0),
    accept_deadline: tstz(),
    resolve_deadline: tstz(),
    appeal_deadline: tstz(),
    appeal_resolve_deadline: tstz(),
    appealed_at: tstz(),
    evidence_hash: text(),
    ruling_hash: text(),
    appeal_ruling_hash: text(),
    outcome: onchainOutcome(),
    payout_a: micro(),
    payout_b: micro(),
    payout_via: payoutVia(),
    create_sig: text(),
    accept_sig: text(),
    resolve_sig: text(),
    appeal_sig: text(),
    payout_sig: text(),
    close_sig: text(),
    created_at: tstz().notNull().defaultNow(),
    terms_final_at: tstz(),
    locked_at: tstz(),
    resolved_at: tstz(),
    settled_at: tstz(),
    closed_at: tstz(),
    last_seq: integer().notNull().default(0),
    updated_at: tstz().notNull().defaultNow(), // set by the bets_guard trigger (0001)
    version: integer().notNull().default(0), // incremented by bets_guard
    is_seed: boolean().notNull().default(false),
  },
  (t) => [
    // §6.2
    check('bets_distinct_parties', sql`party_a_id <> party_b_id`),
    check('bets_stake_a_cap', sql`stake_a IS NULL OR stake_a BETWEEN 1 AND 20000000`),
    check('bets_stake_b_cap', sql`stake_b IS NULL OR stake_b BETWEEN 1 AND 20000000`),
    check(
      'bets_binding_set',
      sql.raw(`state < 'AWAITING_AUTHORIZATIONS' OR state IN ('CANCELLED','EXPIRED')
        OR (terms_hash IS NOT NULL AND stake_a IS NOT NULL AND stake_b IS NOT NULL AND evidence_source IS NOT NULL)`),
    ),
    check(
      'bets_onchain_binding',
      sql.raw(`onchain_status = 'none'
        OR (terms_hash IS NOT NULL AND stake_a IS NOT NULL AND stake_b IS NOT NULL)`),
    ),
    check(
      'bets_wallet_snapshot',
      sql.raw(`is_seed OR onchain_status = 'none' OR party_a_wallet IS NOT NULL`),
    ),
    check(
      'bets_auth_pairs',
      sql`(a_authorized_at IS NULL) = (a_authorization_method IS NULL)
        AND (b_authorized_at IS NULL) = (b_authorization_method IS NULL)`,
    ),
    check(
      'bets_locked_authorized',
      sql.raw(`is_seed OR onchain_status IN ('none','open','cancelled')
        OR (onchain_status = 'refunded' AND accept_sig IS NULL)
        OR (a_authorized_at IS NOT NULL AND b_authorized_at IS NOT NULL)`),
    ),
    check(
      'bets_end_reason',
      sql.raw(`(state IN ('CANCELLED','EXPIRED')) = (end_reason IS NOT NULL)`),
    ),
    check(
      'bets_refusal',
      sql.raw(`(end_reason IS NOT DISTINCT FROM 'refused') = (refusal_category IS NOT NULL)`),
    ),
    check('bets_pending_pair', sql`(onchain_pending IS NULL) = (pending_sig IS NULL)`),
    check(
      'bets_terminal_sig',
      sql.raw(`is_seed OR onchain_status < 'settled' OR payout_sig IS NOT NULL`),
    ),
    check(
      'bets_payout_rule',
      sql.raw(`onchain_status < 'settled' OR (
        outcome IS NOT NULL AND payout_a IS NOT NULL AND payout_b IS NOT NULL
        AND CASE onchain_status
          WHEN 'cancelled' THEN payout_b = 0 AND payout_a >= stake_a
          WHEN 'refunded'  THEN (payout_b = 0 AND payout_a >= stake_a)
                             OR (payout_a = stake_a AND payout_b >= stake_b)
          ELSE payout_a + payout_b >= stake_a + stake_b AND CASE outcome
            WHEN 'party_a' THEN payout_b = 0
            WHEN 'party_b' THEN payout_a = 0
            WHEN 'refund'  THEN payout_a = stake_a
            WHEN 'split'   THEN payout_a = (payout_a + payout_b) / 2
          END
        END)`),
    ),
    check(
      'bets_gemini_market',
      sql.raw(`evidence_source IS DISTINCT FROM 'gemini'
        OR (gemini_market_id IS NOT NULL AND a_position IS NOT NULL
            AND outcome IS DISTINCT FROM 'split')`),
    ),
    check('bets_redo_cap', sql`redo_count BETWEEN 0 AND 3`),
    check('bets_odds_source', sql`odds_source IS NULL OR odds_source IN ('mid','last_in_spread')`),
    check('bets_odds_p_range', sql`odds_p IS NULL OR odds_p BETWEEN 0 AND 1`),
    check(
      'bets_payout_nonneg',
      sql`(payout_a IS NULL OR payout_a >= 0) AND (payout_b IS NULL OR payout_b >= 0)`,
    ),
    // §1 format CHECKs
    pubkeyCheck('bets', 'party_a_wallet'),
    pubkeyCheck('bets', 'party_b_wallet'),
    pubkeyCheck('bets', 'mint'),
    pubkeyCheck('bets', 'bet_pda'),
    pubkeyCheck('bets', 'vault'),
    hex32Check('bets', 'terms_hash'),
    hex32Check('bets', 'evidence_hash'),
    hex32Check('bets', 'ruling_hash'),
    hex32Check('bets', 'appeal_ruling_hash'),
    txSigCheck('bets', 'pending_sig'),
    txSigCheck('bets', 'create_sig'),
    txSigCheck('bets', 'accept_sig'),
    txSigCheck('bets', 'resolve_sig'),
    txSigCheck('bets', 'appeal_sig'),
    txSigCheck('bets', 'payout_sig'),
    txSigCheck('bets', 'close_sig'),
    // §6.3
    index('bets_a_idx').on(t.party_a_id, t.created_at.desc()),
    index('bets_b_idx').on(t.party_b_id, t.created_at.desc()),
    index('bets_room_idx').on(t.room_id, t.created_at.desc()),
    index('bets_active_idx').on(t.state).where(sql.raw(`state < 'PAID'`)),
    index('bets_pending_idx')
      .on(t.updated_at)
      .where(sql`onchain_pending IS NOT NULL`),
    index('bets_market_idx')
      .on(t.gemini_market_id)
      .where(sql`gemini_market_id IS NOT NULL`),
    index('bets_h2h_idx')
      .on(t.party_a_id, t.party_b_id)
      .where(sql.raw(`onchain_status = 'settled'`)),
    index('bets_h2h_rev_idx')
      .on(t.party_b_id, t.party_a_id)
      .where(sql.raw(`onchain_status = 'settled'`)),
  ],
);

export const betEvents = pgTable(
  'bet_events',
  {
    bet_id: uuid()
      .notNull()
      .references((): AnyPgColumn => bets.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    type: text().notNull(),
    source: text().notNull(),
    envelope: jsonb().notNull(),
    chain_event_id: bigint({ mode: 'bigint' }).references((): AnyPgColumn => chainEvents.id), // FK added by migration 0003 (Streams)
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'bet_events_pk', columns: [t.bet_id, t.seq] }),
    check('bet_events_source', sql`source IN ('server','chain')`),
    check('bet_events_source_type', sql`(type LIKE 'chain.%') = (source = 'chain')`),
    check('bet_events_seq_positive', sql`seq >= 1`),
    uniqueIndex('bet_events_chain_uq')
      .on(t.chain_event_id)
      .where(sql`chain_event_id IS NOT NULL`),
  ],
);
