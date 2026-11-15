// DATA-MODEL §5.17 outbox (added by migration 0002, rooms/challenge stream D0-J4).
// Rows are written in the same transaction as the state change; the push dispatcher
// (`SELECT … WHERE status='pending' AND next_attempt_at <= now() … FOR UPDATE SKIP LOCKED`)
// is the push stream's job (API-CONTRACT §7.4).
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { outboxStatus } from './enums';
import { tstz } from './types';
import { bets } from './bets';
import { users } from './users';

export const outbox = pgTable(
  'outbox',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    recipient_user_id: uuid()
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    bet_id: uuid().references((): AnyPgColumn => bets.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    /** Display data only. Never biometric data or keys. */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    dedupe_key: text().notNull().unique('outbox_dedupe_key_uq'),
    status: outboxStatus().notNull().default('pending'),
    attempts: smallint().notNull().default(0),
    next_attempt_at: tstz().notNull().defaultNow(),
    provider_ticket_id: text(),
    last_error: text(),
    created_at: tstz().notNull().defaultNow(),
    sent_at: tstz(),
  },
  (t) => [index('outbox_due_idx').on(t.next_attempt_at).where(sql.raw(`status = 'pending'`))],
);
