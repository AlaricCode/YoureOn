// A database of a suite's own next to DATABASE_URL's (`<db>_<suffix>`), created and migrated on
// first use. For suites that own a shared table (nonce_pool: the lock service leases from it), so
// they can run in parallel with lifecycle.test.ts, which owns it in the shared database.
import { sql } from 'drizzle-orm';
import { createDb, runMigrations } from '@youre-on/db';

export async function ownDatabase(url: string, suffix: string): Promise<string> {
  const u = new URL(url);
  const name = `${u.pathname.replace(/^\//, '')}_${suffix}`;
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`unsupported database name ${name}`);
  const admin = createDb({ url, max: 1 });
  try {
    const found = await admin.db.execute(
      sql`SELECT 1 AS ok FROM pg_database WHERE datname = ${name}`,
    );
    if (found.length === 0) {
      try {
        await admin.db.execute(sql.raw(`CREATE DATABASE ${name}`));
      } catch (e) {
        const code =
          (e as { code?: string; cause?: { code?: string } }).code ??
          (e as { cause?: { code?: string } }).cause?.code;
        if (code !== '42P04') throw e; // duplicate_database: a concurrent run made it
      }
    }
  } finally {
    await admin.close();
  }
  u.pathname = `/${name}`;
  await runMigrations(u.toString());
  return u.toString();
}
