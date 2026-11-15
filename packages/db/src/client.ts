// Postgres connection for the app (DATA-MODEL §12).
//
// Driver: postgres.js (`postgres` 3.4.9), as DATA-MODEL §12 picks. The app connects to
// Neon's *pooled* URL (PgBouncer, transaction mode), so prepared statements are off
// (`prepare: false`) and LISTEN/NOTIFY is never used (fan-out is in-process).
// Migrations use the *direct* URL (drizzle.config.ts / migrate.ts).
// 3.4.9 rather than 4.x: 4.0.0 shipped 2026-10-29 and Drizzle 0.45.4's postgres-js
// adapter was built and tested against 3.x.
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;
export type Sql = postgres.Sql;

export interface DbHandle {
  db: Db;
  sql: Sql;
  /** Stops the keepalive (if started) and closes the pool. */
  close(): Promise<void>;
  /** Starts the Neon keepalive (`SELECT 1` every `intervalMs`, default 60 s). Idempotent. */
  startKeepalive(intervalMs?: number, onError?: (err: unknown) => void): void;
}

export interface CreateDbOptions {
  url: string;
  /** Pool size; Fly runs one machine, so a small pool is enough. */
  max?: number;
  /** Silence NOTICE messages (e.g. "relation already exists, skipping"). Default true. */
  quietNotices?: boolean;
}

export const KEEPALIVE_MS = 60_000;

export function createDb(opts: CreateDbOptions): DbHandle {
  const sql = postgres(opts.url, {
    max: opts.max ?? 10,
    prepare: false,
    idle_timeout: 0,
    connect_timeout: 10,
    onnotice: opts.quietNotices === false ? undefined : () => {},
    connection: { TimeZone: 'UTC' },
  });
  const db = drizzle(sql, { schema });
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    db,
    sql,
    startKeepalive(intervalMs = KEEPALIVE_MS, onError) {
      if (timer) return;
      // Neon scales to zero after 5 min idle and that can't be disabled (DATA-MODEL §12).
      timer = setInterval(() => {
        sql`SELECT 1`.catch((err: unknown) => onError?.(err));
      }, intervalMs);
      timer.unref();
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await sql.end({ timeout: 5 });
    },
  };
}
