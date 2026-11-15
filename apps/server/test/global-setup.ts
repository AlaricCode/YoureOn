// Runs once per `vitest run`: applies packages/db migrations to the test database.
import { runMigrations } from '@youre-on/db';

export async function setup(): Promise<void> {
  // Migrate exactly the database the tests connect to (DATABASE_URL), never
  // DATABASE_URL_DIRECT: on L's laptop that is the Neon direct URL.
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn(
      '[db] DATABASE_URL is not set: DB-backed tests are SKIPPED. Start one with\n' +
        '     docker compose up -d db && export DATABASE_URL=postgres://yo:yo@localhost:54329/youre_on',
    );
    return;
  }
  await runMigrations(url);
}
