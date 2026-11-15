// drizzle-kit config. Migrations run over the DIRECT (non-pooled) URL (DATA-MODEL §12):
// DATABASE_URL_DIRECT on L's laptop (Neon), DATABASE_URL for the local docker Postgres.
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL || '';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
