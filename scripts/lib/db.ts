// Optional Postgres access for nonce-pool / smoke (`--database-url`). postgres.js 3.4.9, the
// driver packages/db uses (DATA-MODEL §12); prepared statements off for Neon's pooled URL.
import postgres from 'postgres';

export type Sql = postgres.Sql;

export const DB_OPTION = { 'database-url': { type: 'string' } } as const;

export function openDb(url: string): Sql {
  return postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
    connection: { TimeZone: 'UTC' },
  });
}

export async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const rows = await sql<
    { t: string | null }[]
  >`SELECT to_regclass(${`public.${table}`})::text AS t`;
  return rows[0]?.t != null;
}

/** A SQL string literal (values here are base58 / ISO strings, but quote properly anyway). */
export function lit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
