// DATA-MODEL §5.4 rooms, §5.5 room_members.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { joinMethod, roomKind } from './enums';
import { tstz } from './types';
import { users } from './users';

export const rooms = pgTable(
  'rooms',
  {
    id: uuid().primaryKey().defaultRandom(),
    code: text().notNull().unique('rooms_code_uq'),
    name: text(),
    kind: roomKind().notNull().default('session'),
    join_method: joinMethod().notNull().default('code'),
    created_by: uuid().references((): AnyPgColumn => users.id),
    is_demo: boolean().notNull().default(false),
    created_at: tstz().notNull().defaultNow(),
    expires_at: tstz()
      .notNull()
      .default(sql`now() + interval '12 hours'`),
    closed_at: tstz(),
  },
  (t) => [
    check('rooms_code_fmt', sql`code ~ '^[A-HJ-NP-Z2-9]{6}$'`),
    check(
      'rooms_expiry',
      sql`expires_at > created_at AND expires_at <= created_at + interval '14 days'`,
    ),
    index('rooms_active_idx')
      .on(t.expires_at)
      .where(sql`closed_at IS NULL`),
  ],
);

export const roomMembers = pgTable(
  'room_members',
  {
    room_id: uuid()
      .notNull()
      .references((): AnyPgColumn => rooms.id, { onDelete: 'cascade' }),
    user_id: uuid()
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    joined_via: joinMethod().notNull(),
    joined_at: tstz().notNull().defaultNow(),
    last_seen_at: tstz().notNull().defaultNow(),
    left_at: tstz(),
  },
  (t) => [
    primaryKey({ name: 'room_members_pk', columns: [t.room_id, t.user_id] }),
    index('room_members_user_idx')
      .on(t.user_id)
      .where(sql`left_at IS NULL`),
  ],
);
