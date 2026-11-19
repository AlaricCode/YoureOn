// Camera checks (SAM 3.1, predicate set p1; migration 0009). Non-binding: the CheckSpec is NOT in
// the hashed Terms. The server compiles it from the bet's terms (judge/compile-checks.ts) and keeps
// it here, keyed by the terms_hash it was compiled from; at ruling time the checks can only turn a
// decisive verdict into REDO (shared checks/report.ts checksVeto).
//
// - bet_checks: one row per bet, the compile for the bet's CURRENT terms_hash. A new terms version
//   (a revised card, an odds recompose) recompiles and overwrites it; the ruling uses the row only
//   when its terms_hash equals bets.terms_hash.
// - attempt_checks: the CheckReport of one attempt (status ok | unavailable), stored whether or not
//   it vetoed; report_hash = hashJcs(report).
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { hex32Check } from './checks';
import { tstz } from './types';
import { bets } from './bets';

export const betChecks = pgTable(
  'bet_checks',
  {
    bet_id: uuid()
      .primaryKey()
      .references(() => bets.id, { onDelete: 'cascade' }),
    /** The terms the spec was compiled from (= bets.terms_hash while current). */
    terms_hash: text().notNull(),
    /** 'checks' (spec set) | 'judge_only' (spec null). */
    decision: text().notNull(),
    /** A canonical shared CheckSpec (p1), or null for judge_only. */
    spec: jsonb().$type<Record<string, unknown>>(),
    /** The compiler's one-line reason (or the fallback's). */
    why: text().notNull().default(''),
    /** describeChecks(spec): what the confirm card / stage can show. */
    readback: text().notNull(),
    /** "anthropic/<served model>"; null when no call was needed. */
    model: text(),
    prompt_version: text().notNull(),
    /** 'ok' | 'fallback' (the compiler failed: judge_only). */
    status: text().notNull(),
    created_at: tstz().notNull().defaultNow(),
  },
  () => [
    hex32Check('bet_checks', 'terms_hash'),
    check('bet_checks_decision', sql.raw(`decision IN ('checks','judge_only')`)),
    check('bet_checks_spec', sql.raw(`(decision = 'checks') = (spec IS NOT NULL)`)),
    check('bet_checks_status', sql.raw(`status IN ('ok','fallback')`)),
    check('bet_checks_readback_len', sql.raw(`char_length(readback) <= 400`)),
  ],
);

export const attemptChecks = pgTable(
  'attempt_checks',
  {
    bet_id: uuid()
      .notNull()
      .references(() => bets.id, { onDelete: 'cascade' }),
    attempt_no: integer().notNull(),
    /** 'ok' | 'unavailable' (SAM error, timeout or unreadable reply: no veto). */
    status: text().notNull(),
    /** The shared CheckReport (strict, schema_version 1). */
    report: jsonb().$type<Record<string, unknown>>().notNull(),
    report_hash: text().notNull(),
    /** Wall time of the SAM call (retry included); null when no call was made. */
    sam_ms: integer(),
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.bet_id, t.attempt_no] }),
    hex32Check('attempt_checks', 'report_hash'),
    check('attempt_checks_status', sql.raw(`status IN ('ok','unavailable')`)),
    check('attempt_checks_attempt_no', sql.raw(`attempt_no >= 1`)),
    check('attempt_checks_sam_ms', sql.raw(`sam_ms IS NULL OR sam_ms >= 0`)),
  ],
);
