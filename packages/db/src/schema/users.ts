// DATA-MODEL §5.1 users, §5.2 devices, §5.21 api_sessions.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { deviceRole, platform, walletKind } from './enums';
import { hex32Check, pubkeyCheck } from './checks';
import { bytea, tstz } from './types';
import { rooms } from './rooms';

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    display_name: text().notNull(),
    avatar_key: text(),
    wallet_pubkey: text().unique('users_wallet_pubkey_uq'),
    wallet_kind: walletKind().notNull().default('device_keypair'),
    age_attested_18plus: boolean().notNull().default(false),
    attested_at: tstz(),
    is_demo: boolean().notNull().default(false),
    demo_seed_ciphertext: bytea(),
    demo_seed_nonce: bytea(),
    created_at: tstz().notNull().defaultNow(),
    updated_at: tstz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deleted_at: tstz(),
  },
  () => [
    check('users_display_name_len', sql`char_length(display_name) BETWEEN 1 AND 32`),
    pubkeyCheck('users', 'wallet_pubkey'),
    check('users_attested_at', sql`NOT age_attested_18plus OR attested_at IS NOT NULL`),
    check(
      'users_wallet_required',
      sql`is_demo OR deleted_at IS NOT NULL OR wallet_pubkey IS NOT NULL`,
    ),
    check('users_demo_seed_demo_only', sql`is_demo OR demo_seed_ciphertext IS NULL`),
    check('users_demo_seed_pair', sql`(demo_seed_ciphertext IS NULL) = (demo_seed_nonce IS NULL)`),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: uuid()
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    platform: platform().notNull().default('ios'),
    push_provider: text().notNull().default('expo'),
    push_token: text(),
    device_pubkey: text(),
    role: deviceRole().notNull().default('phone'),
    app_version: text(),
    created_at: tstz().notNull().defaultNow(),
    last_seen_at: tstz().notNull().defaultNow(),
    revoked_at: tstz(),
  },
  (t) => [
    check('devices_push_provider', sql`push_provider IN ('expo','apns')`),
    pubkeyCheck('devices', 'device_pubkey'),
    uniqueIndex('devices_push_token_uq')
      .on(t.push_token)
      .where(sql`push_token IS NOT NULL`),
    uniqueIndex('devices_device_pubkey_uq')
      .on(t.device_pubkey)
      .where(sql`device_pubkey IS NOT NULL`),
    index('devices_user_idx')
      .on(t.user_id)
      .where(sql`revoked_at IS NULL`),
  ],
);

export const apiSessions = pgTable(
  'api_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    token_sha256: text().notNull().unique('api_sessions_token_sha256_uq'),
    user_id: uuid().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    device_id: uuid().references((): AnyPgColumn => devices.id, { onDelete: 'cascade' }),
    room_id: uuid().references((): AnyPgColumn => rooms.id, { onDelete: 'cascade' }),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{app}'::text[]`),
    created_at: tstz().notNull().defaultNow(),
    expires_at: tstz()
      .notNull()
      .default(sql`now() + interval '7 days'`),
    revoked_at: tstz(),
  },
  (t) => [
    hex32Check('api_sessions', 'token_sha256'),
    check('api_sessions_scopes_known', sql`scopes <@ ARRAY['app','stage','demo']::text[]`),
    check(
      'api_sessions_app_scope',
      sql`('app' = ANY(scopes)) = (user_id IS NOT NULL AND device_id IS NOT NULL)`,
    ),
    index('api_sessions_device_idx')
      .on(t.device_id)
      .where(sql`revoked_at IS NULL`),
  ],
);
