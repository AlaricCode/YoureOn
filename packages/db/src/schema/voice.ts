// DATA-MODEL §5.10 voice_sessions (added by migration 0002, rooms/challenge stream D0-J4).
//
// Deviation (reported): `bet_id` is NULLABLE here although DATA-MODEL §5.10 says NOT NULL.
// API-CONTRACT §2.6 has `POST /v1/voice/tokens` store the row when the token is pre-minted on
// the scan screen, before any bet exists (`bet_id?` is optional there), and §2.5 then binds
// `voice_sessions(el_conversation_id -> bet_id)` at `POST /v1/bets`. A NOT NULL bet_id cannot
// hold the pre-mint row. The CHECK below keeps the spirit: only an `active`, not-yet-bound
// pre-mint row may lack a bet.
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sessionStatus, voicePurpose } from './enums';
import { hex32Check } from './checks';
import { tstz } from './types';
import { bets } from './bets';
import { devices, users } from './users';

export const voiceSessions = pgTable(
  'voice_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    bet_id: uuid().references((): AnyPgColumn => bets.id, { onDelete: 'cascade' }),
    user_id: uuid()
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    device_id: uuid().references((): AnyPgColumn => devices.id, { onDelete: 'set null' }),
    purpose: voicePurpose().notNull(),
    el_agent_id: text().notNull(),
    el_conversation_id: text().notNull().unique('voice_sessions_el_conversation_id_uq'),
    status: sessionStatus().notNull().default('active'),
    started_at: tstz().notNull().defaultNow(),
    ended_at: tstz(),
    first_audio_ms: integer(),
    transcript_key: text(),
    transcript_sha256: text(),
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    check('voice_sessions_bet_bound', sql`bet_id IS NOT NULL OR status = 'active'`),
    hex32Check('voice_sessions', 'transcript_sha256'),
    index('voice_sessions_bet_idx').on(t.bet_id),
  ],
);
