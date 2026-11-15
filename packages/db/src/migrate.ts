// Programmatic migration runner (tests, CI, and `npm run db:migrate:node`).
// Uses the DIRECT url (DATABASE_URL_DIRECT), falling back to DATABASE_URL for local docker.
// `drizzle-kit migrate` (drizzle.config.ts) does the same thing from the CLI.
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function migrationUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DATABASE_URL_DIRECT || env.DATABASE_URL || undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = migrationUrl();
  if (!url) {
    console.error('Set DATABASE_URL_DIRECT (Neon direct URL) or DATABASE_URL (local docker).');
    process.exit(1);
  }
  runMigrations(url).then(
    () => console.log('migrations applied'),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
