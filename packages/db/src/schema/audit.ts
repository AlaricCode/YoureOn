// DATA-MODEL §5.18 audit_log. Append-only (trigger) and the biometric-key tripwire CHECK
// live in the custom migration 0001_triggers_views_grants (DATA-MODEL §12).
import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { actorKind } from './enums';
import { tstz } from './types';

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz().notNull().defaultNow(),
    actor_kind: actorKind().notNull(),
    actor_user_id: uuid(), // no FK, by design
    action: text().notNull(),
    bet_id: uuid(), // no FK
    subject_user_id: uuid(), // no FK
    request_id: text(),
    details: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('audit_bet_idx')
      .on(t.bet_id, t.at)
      .where(sql`bet_id IS NOT NULL`),
    index('audit_subject_idx')
      .on(t.subject_user_id, t.at)
      .where(sql`subject_user_id IS NOT NULL`),
  ],
);
