// DATA-MODEL §5.7 bet_terms_versions, §5.8 chain_txs, §5.20 nonce_pool (migration 0004, the
// server chain lifecycle: terms -> atomic lock -> resolve -> payout).
//
// - bet_terms_versions: one row per TERMS_PROPOSED revision; `canonical_json` is the exact JCS
//   string of a strictly parsed SCHEMAS Terms and the DB re-checks its sha256.
// - chain_txs: one row per transaction the server builds. The atomic lock is ONE row
//   (kind 'atomic_lock'): the stored message bytes, both party signatures, the nonce it uses.
//   LockService is the only writer of lock rows (DATA-MODEL §8.1).
// - nonce_pool: the durable-nonce accounts (scripts/nonce-pool.ts creates them on chain and
//   upserts these rows: seed_index, nonce_account, authority, status, nonce_value, value_read_at).
//
// attempts / rulings / evidence are NOT here (judge slice, migration 0005).
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  jsonb,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { nonceStatus, onchainStatus, party, txKind, txStatus } from './enums';
import { hex32Check, pubkeyCheck, txSigCheck } from './checks';
import { tstz } from './types';
import { bets } from './bets';

export const betTermsVersions = pgTable(
  'bet_terms_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    bet_id: uuid()
      .notNull()
      .references((): AnyPgColumn => bets.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    schema_version: smallint().notNull().default(1),
    drafted_by: text().notNull().default('judge'),
    source_tool: text(),
    canonical_json: text().notNull(),
    terms: jsonb()
      .$type<Record<string, unknown>>()
      .generatedAlwaysAs(sql`canonical_json::jsonb`),
    terms_hash: text().notNull(),
    is_final: boolean().notNull().default(false),
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bet_terms_versions_bet_version_uq').on(t.bet_id, t.version),
    uniqueIndex('bet_terms_versions_final_uq')
      .on(t.bet_id)
      .where(sql`is_final`),
    check('bet_terms_versions_version_pos', sql`version >= 1`),
    check('bet_terms_versions_drafted_by', sql.raw(`drafted_by IN ('judge','party_a','party_b')`)),
    check(
      'bet_terms_versions_hash',
      sql.raw(`terms_hash = encode(sha256(convert_to(canonical_json, 'UTF8')), 'hex')`),
    ),
    hex32Check('bet_terms_versions', 'terms_hash'),
  ],
);

export const chainTxs = pgTable(
  'chain_txs',
  {
    /** For a lock this is AuthorizeRequest.lock_request_id. */
    id: uuid().primaryKey().defaultRandom(),
    bet_id: uuid()
      .notNull()
      .references((): AnyPgColumn => bets.id, { onDelete: 'cascade' }),
    kind: txKind().notNull(),
    bundled_close: boolean().notNull().default(false),
    signer_role: text().notNull(),
    /** Exact message bytes (base64) the parties sign; never rebuilt after a signature. */
    message_b64: text(),
    message_sha256: text().notNull(),
    nonce_account: text(),
    nonce_value: text(),
    /** base58 ed25519 party signatures over message_b64. Stored only here; never logged. */
    a_signature: text(),
    b_signature: text(),
    a_signed_at: tstz(),
    b_signed_at: tstz(),
    first_signer: party(),
    expires_at: tstz(),
    revoked_by_tx_id: uuid().references((): AnyPgColumn => chainTxs.id),
    simulated_cu: integer(),
    cu_limit: integer(),
    /** = the fee payer's signature (the tx id). */
    signature: text().unique('chain_txs_signature_uq'),
    expected_status: onchainStatus().notNull(),
    status: txStatus().notNull().default('built'),
    last_valid_block_height: bigint({ mode: 'bigint' }),
    err: text(),
    built_at: tstz().notNull().defaultNow(),
    sent_at: tstz(),
    rpc_processed_at: tstz(),
    rpc_confirmed_at: tstz(),
    stream_seen_at: tstz(),
  },
  (t) => [
    index('chain_txs_bet_idx').on(t.bet_id, t.built_at),
    uniqueIndex('chain_txs_inflight_uq')
      .on(t.bet_id, t.kind)
      .where(sql.raw(`status IN ('built','signed','sent')`)),
    uniqueIndex('chain_txs_lock_nonce_uq')
      .on(t.nonce_account, t.nonce_value)
      .where(sql.raw(`kind = 'atomic_lock'`)),
    index('chain_txs_open_idx')
      .on(t.status, t.expires_at)
      .where(sql.raw(`status IN ('built','signed','sent')`)),
    check(
      'chain_txs_signer_role',
      sql.raw(
        `signer_role IN ('party_a','party_b','both_parties','judge','appeal','fee_payer','crank')`,
      ),
    ),
    check(
      'chain_txs_message_sha',
      sql.raw(
        `message_b64 IS NULL OR message_sha256 = encode(sha256(decode(message_b64, 'base64')), 'hex')`,
      ),
    ),
    check(
      'chain_txs_lock_shape',
      sql.raw(`kind <> 'atomic_lock' OR (message_b64 IS NOT NULL AND nonce_account IS NOT NULL
        AND nonce_value IS NOT NULL AND expires_at IS NOT NULL AND signer_role = 'both_parties')`),
    ),
    check(
      'chain_txs_lock_fully_signed',
      sql.raw(`kind <> 'atomic_lock' OR status NOT IN ('sent','confirmed')
        OR (a_signature IS NOT NULL AND b_signature IS NOT NULL)`),
    ),
    check(
      'chain_txs_nonce_advance_shape',
      sql.raw(
        `kind <> 'nonce_advance' OR (nonce_account IS NOT NULL AND signer_role = 'fee_payer')`,
      ),
    ),
    check('chain_txs_revoked_kind', sql.raw(`status <> 'revoked' OR kind = 'atomic_lock'`)),
    check('chain_txs_revoked_by', sql.raw(`(status = 'revoked') = (revoked_by_tx_id IS NOT NULL)`)),
    check(
      'chain_txs_first_signer',
      sql`(first_signer IS NULL) = (a_signature IS NULL AND b_signature IS NULL)`,
    ),
    check(
      'chain_txs_cu',
      sql`cu_limit IS NULL OR simulated_cu IS NULL OR cu_limit >= simulated_cu`,
    ),
    hex32Check('chain_txs', 'message_sha256'),
    pubkeyCheck('chain_txs', 'nonce_account'),
    txSigCheck('chain_txs', 'a_signature'),
    txSigCheck('chain_txs', 'b_signature'),
    txSigCheck('chain_txs', 'signature'),
  ],
);

export const noncePool = pgTable(
  'nonce_pool',
  {
    seed_index: smallint().primaryKey(),
    nonce_account: text().notNull().unique('nonce_pool_nonce_account_uq'),
    authority: text().notNull(),
    status: nonceStatus().notNull().default('free'),
    nonce_value: text(),
    value_read_at: tstz(),
    leased_bet_id: uuid().references((): AnyPgColumn => bets.id),
    leased_tx_id: uuid().references((): AnyPgColumn => chainTxs.id),
    leased_at: tstz(),
    advance_tx_id: uuid().references((): AnyPgColumn => chainTxs.id),
    last_advanced_at: tstz(),
    uses: integer().notNull().default(0),
    failures: smallint().notNull().default(0),
    created_at: tstz().notNull().defaultNow(),
    retired_at: tstz(),
  },
  (t) => [
    uniqueIndex('nonce_pool_leased_bet_uq')
      .on(t.leased_bet_id)
      .where(sql`leased_bet_id IS NOT NULL`),
    check('nonce_pool_seed_range', sql`seed_index BETWEEN 0 AND 15`),
    check(
      'nonce_pool_leased',
      sql.raw(`(status = 'leased') = (leased_bet_id IS NOT NULL AND leased_tx_id IS NOT NULL)`),
    ),
    check('nonce_pool_advancing', sql.raw(`(status = 'advancing') = (advance_tx_id IS NOT NULL)`)),
    check('nonce_pool_retired', sql.raw(`(status = 'retired') = (retired_at IS NOT NULL)`)),
    check('nonce_pool_free_value', sql.raw(`status <> 'free' OR nonce_value IS NOT NULL`)),
    pubkeyCheck('nonce_pool', 'nonce_account'),
    pubkeyCheck('nonce_pool', 'authority'),
  ],
);
